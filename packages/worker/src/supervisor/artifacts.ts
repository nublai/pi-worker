/**
 * `artifacts.inspect` (P3-6): owner-Git facts about a worker's checkout, for an orchestrator's checks (nubl
 * `.pi/plan/p3-worker-provider.md` section 6, root decision Q1). It runs only P2-6's typed owner-Git functions
 * (owner-git/git-safe.ts, `artifactSubject`), with the worker's SAVED launch pin (`Live.gitPin`, the metadata its
 * launch validated) and the supervisor's private snapshot directory; never a pin read now from metadata the sandbox can
 * write, never a caller's path, pathspec or option.
 *
 * - **Values.** The caller names the worker's current epoch (`stale_binding` otherwise) and a commit (and optionally a
 *   base), each a full object id or a branch `refs/heads/<ns>/<leaf>` in the worker's own namespace, the namespace of
 *   its pinned symbolic HEAD (`artifact_ref_outside_namespace`; a detached worker has none). The schema says the same;
 *   this module checks again, so no other value can reach owner Git.
 * - **Fail closed.** The object store is shared and writable by the sandbox, so nothing is assumed: no saved pin (an
 *   unsandboxed worker, a root that is not a linked worktree, a supervisor restarted since the launch) or owner Git
 *   refusing the checkout is `artifact_inspection_unavailable` (`detail` names owner Git's code); metadata that differs
 *   from the pin is `artifact_pin_mismatch`; a commit, base or tree not in the store is `artifact_object_missing`.
 *   A dirty or conflicted checkout is reported as such (`worktree.state`), never cleaned or ignored.
 * - **Facts, not verdicts.** The reply is what Git says at the pin: subject (commit and native tree), HEAD, status,
 *   changed paths, the pin's identity and the provenance. Whether that is acceptable is the caller's check.
 *
 * Named limit: owner Git runs synchronously, so an inspection holds the supervisor's event loop for its Git runs.
 */
import { createHash } from 'node:crypto';
import { Refusal } from '../b2/errors.js';
import type { components } from '../generated/api.js';
import { artifactSubject } from '../owner-git/artifact.js';
import { gitDiff, gitMergeBase, gitRevParse, gitStatus, gitVersion, type GitCheckout, type GitPin, type OwnerGit } from '../owner-git/git-safe.js';
import type { SupervisorState } from './state.js';

export type ArtifactInspect = components['schemas']['ArtifactInspect'];
export type ArtifactFacts = components['schemas']['ArtifactFacts'];
type Change = components['schemas']['ArtifactChange'];
type StatusEntry = components['schemas']['ArtifactStatusEntry'];

const OBJECT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^refs\/heads\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_-]+$/;
/** The most entries, and the most path bytes, one listed group (status, changes) carries. */
const LIST_MAX_ENTRIES = 10_000;
const LIST_MAX_PATH_BYTES = 1024 * 1024;
/** `git status --porcelain` unmerged pairs. */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES'];

/** The branch a pin's symbolic HEAD names (`ref: refs/heads/<ns>/<leaf>`), or null when detached. */
const headRef = (pin: GitPin): string | null => (pin.head === null ? null : pin.head.trim().slice('ref: '.length));

/** The pin's identity: SHA-256 of its canonical JSON (keys sorted). */
export function pinSha256(pin: GitPin): string {
  // Code-unit order of the (ASCII) keys.
  const sorted = Object.fromEntries(Object.keys(pin).sort().map(k => [k, pin[k as keyof GitPin]]));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * A requested revision: a full object id, or a branch in the worker's own namespace. Anything else refuses before
 * owner Git runs (the router's schema refuses it first; this is the same check, for every other caller).
 */
function revision(value: string, pin: GitPin): string {
  if (typeof value === 'string' && OBJECT_ID.test(value)) return value;
  const ns = typeof value === 'string' ? BRANCH.exec(value)?.[1] : undefined;
  if (ns === undefined) throw new Refusal('request_schema_mismatch', 'no_effect', undefined, {}, 400);
  const own = headRef(pin);
  const ownNs = own === null ? undefined : BRANCH.exec(own)?.[1];
  if (ownNs === undefined || ns !== ownNs) throw new Refusal('artifact_ref_outside_namespace');
  return value;
}

/** Owner Git's refusal code (its message up to any `:`), safe to name in `detail`. */
const codeOf = (error: Refusal): string => {
  const code = error.message.split(':', 1)[0]!.trim();
  return /^[a-z0-9_]{1,128}$/.test(code) ? code : 'owner_git_refused';
};

/**
 * Maps an owner-Git failure to this operation's refusal. `resolving`: the failure came from naming an object (rev-parse,
 * cat-file) after the snapshot matched the pin, so the object is not in the store.
 */
function refusalOf(error: unknown, resolving: boolean): Refusal {
  if (error instanceof Refusal) {
    const code = codeOf(error);
    if (code === 'git_metadata_changed_since_launch') return new Refusal('artifact_pin_mismatch');
    return new Refusal('artifact_inspection_unavailable', 'no_effect', undefined, { detail: code });
  }
  if (resolving) return new Refusal('artifact_object_missing');
  return new Refusal('artifact_inspection_unavailable', 'no_effect', undefined, { detail: 'git_failed' });
}

/** Runs `step`, mapping any failure to a typed refusal. */
function step<T>(resolving: boolean, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw refusalOf(error, resolving);
  }
}

/** Adds entries up to the entry and path-byte bounds; says whether any was left out. */
function bounded<T>(items: readonly T[], bytes: (item: T) => number): { list: T[]; truncated: boolean } {
  const list: T[] = [];
  let used = 0;
  for (const item of items) {
    used += bytes(item);
    if (list.length >= LIST_MAX_ENTRIES || used > LIST_MAX_PATH_BYTES) return { list, truncated: true };
    list.push(item);
  }
  return { list, truncated: false };
}

/** `git status --porcelain` (v1) lines: `XY rest`. */
function statusEntries(text: string): StatusEntry[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => ({ code: line.slice(0, 2), path: line.slice(3) }));
}

/** `git diff --name-status -z`: `S\0path\0`, or `R<score>\0from\0to\0` for a rename or copy. */
function changes(out: Buffer): Change[] {
  const fields = out.toString('utf8').split('\0');
  const list: Change[] = [];
  for (let i = 0; i + 1 < fields.length; ) {
    const status = fields[i]!;
    if (!status) break;
    if (/^[RC]/.test(status)) {
      list.push({ status, from_path: fields[i + 1]!, path: fields[i + 2]! });
      i += 3;
    } else {
      list.push({ status, path: fields[i + 1]! });
      i += 2;
    }
  }
  return list;
}

/** `git merge-base` exits 1 and prints nothing when two commits share no history. */
const noCommonAncestor = (error: unknown): boolean => error instanceof Error && !(error instanceof Refusal) && error.message === 'git merge-base failed: ';

export class Artifacts {
  /** The environment owner Git takes PATH and the locale from (nothing else in it reaches Git). */
  env: Readonly<Record<string, string | undefined>>;

  constructor(private readonly s: SupervisorState) {
    this.env = Object.fromEntries(ENV_KEEP.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  }

  inspect(id: string, request: ArtifactInspect): ArtifactFacts {
    const live = this.s.require(id);
    const w = live.worker;
    if (request.worker_epoch !== w.worker_epoch) throw new Refusal('stale_binding');
    // The pin the launch validated, and only that: never one read now from metadata the sandbox can write. Only a
    // sandboxed worker in a linked worktree has one (P2-5).
    const pin = live.gitPin;
    if (!pin) throw new Refusal('artifact_inspection_unavailable', 'no_effect', undefined, { detail: 'no_saved_launch_pin' });
    const commit = revision(request.commit, pin);
    const base = request.base === undefined ? undefined : revision(request.base, pin);
    const owner: OwnerGit = { stateDir: this.s.stateDir, env: this.env };
    const at: GitCheckout = { owner, root: w.cwd, pin };
    // Name the objects first: every one must be in the store (a sandbox can remove objects). A peel (`^{commit}`,
    // `^{tree}`) reads the object it names, so `rev-parse --verify` of one fails when that object is gone.
    const commitId = step(true, () => gitRevParse(at, `${commit}^{commit}`));
    const baseId = base === undefined ? undefined : step(true, () => gitRevParse(at, `${base}^{commit}`));
    const treeId = step(true, () => gitRevParse(at, `${commitId}^{tree}`));
    const headId = step(true, () => gitRevParse(at, 'HEAD'));
    // The subject as P2-6 defines it, of the resolved ids (an owner's own artifactSubject on its pin computes the same).
    const subject = step(false, () => artifactSubject(owner, w.cwd, commitId, baseId, pin));
    const entries = bounded(
      step(false, () => statusEntries(gitStatus(at))),
      e => Buffer.byteLength(JSON.stringify(e.path)),
    );
    const all = entries.list;
    let state: ArtifactFacts['worktree']['state'] = 'clean';
    if (all.length || entries.truncated) state = 'dirty';
    if (all.some(e => UNMERGED.has(e.code))) state = 'conflicted';
    const gitVersionText = subject.diff_digest?.git_version ?? step(false, () => gitVersion(owner));
    const facts: ArtifactFacts = {
      worker_id: w.worker_id,
      worker_epoch: w.worker_epoch,
      commit: { requested: request.commit, commit_id: commitId, tree_id: treeId },
      head: { ref: headRef(pin), commit_id: headId, matches_commit: headId === commitId },
      worktree: { state, entries: all, truncated: entries.truncated },
      pin: { kind: 'linked', sha256: pinSha256(pin), head_ref: headRef(pin) },
      provenance: { evidence: 'owner_git_launch_pin', git_version: gitVersionText, replace_objects: 'disabled', inspected_at: new Date().toISOString() },
    };
    if (baseId !== undefined && subject.diff_digest) {
      let mergeBase: string | null;
      try {
        mergeBase = gitMergeBase(at, baseId, commitId);
      } catch (error) {
        if (!noCommonAncestor(error)) throw refusalOf(error, false);
        mergeBase = null;
      }
      const changed = bounded(
        step(false, () => changes(gitDiff(at, { kind: 'revisions', from: baseId, to: commitId }, { format: 'name-status' }))),
        c => Buffer.byteLength(JSON.stringify(c.path)) + (c.from_path === undefined ? 0 : Buffer.byteLength(JSON.stringify(c.from_path))),
      );
      facts.base = {
        requested: request.base!,
        base_id: baseId,
        merge_base_id: mergeBase,
        is_ancestor: mergeBase === baseId,
        changed: changed.list,
        changed_truncated: changed.truncated,
        // artifactSubject's digest is always advisory sha256; the reply states both as constants.
        diff_digest: { advisory: true, git_version: subject.diff_digest.git_version, algorithm: 'sha256', definition: subject.diff_digest.definition, value: subject.diff_digest.value },
      };
    }
    return facts;
  }
}
