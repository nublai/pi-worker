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
 *   changed paths, the pin's identity and the provenance. Whether that is acceptable is the caller's check. The
 *   worktree state is judged on the complete status, before its list is bounded; owner Git refuses index state that
 *   hides tracked changes (assume-unchanged, skip-worktree, stat-trusting config), so that is never `clean`, and trusts
 *   neither an entry's recorded stat data nor the index's cache tree (it hashes every tracked file).
 * - **Off the event loop, bounded.** Owner Git is synchronous (it copies a snapshot and waits for Git), so each
 *   inspection runs it in a child process of its own (`artifacts-child.ts`, its own process group, the owner environment
 *   only, a private directory per inspection in the state's `git-snapshots`), never on the supervisor's event loop: hello, stop, cancel and
 *   every other caller keep being answered. An inspection that outlives its budget (`ARTIFACT_INSPECTION_BUDGET_MS`)
 *   has its whole process group killed and refuses `artifact_inspection_timeout`. At most `ARTIFACT_INSPECTIONS_MAX`
 *   run at once, at most `ARTIFACT_INSPECTIONS_PER_CALLER_MAX` per grant; past either the call refuses
 *   `artifact_inspections_busy` at once, before anything runs. All `no_effect`: an inspection only reads.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal } from '../b2/errors.js';
import type { components } from '../generated/api.js';
import { artifactSubject } from '../owner-git/artifact.js';
import { gitDiff, gitMergeBase, gitRevParse, gitStatus, gitVersion, type GitCheckout, type GitFailure, type GitPin, type OwnerGit } from '../owner-git/git-safe.js';
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
/** How long one inspection may run before its process group is killed. */
export const ARTIFACT_INSPECTION_BUDGET_MS = 60_000;
/** The most inspections running at once, supervisor-wide and for one grant. */
export const ARTIFACT_INSPECTIONS_MAX = 4;
export const ARTIFACT_INSPECTIONS_PER_CALLER_MAX = 2;
/** The most bytes the child may print (its lists are bounded far below this). */
const OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const CHILD = fileURLToPath(new URL('./artifacts-child.js', import.meta.url));
/** The refusals a child may report; anything else it says is `inspection_failed`. */
const CHILD_REFUSALS = new Set(['artifact_inspection_unavailable', 'artifact_pin_mismatch', 'artifact_object_missing']);

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

/** `git merge-base` exits 1 and prints nothing when two commits share no history: that exit, no signal, no stderr. */
const noCommonAncestor = (error: unknown): boolean => {
  if (!(error instanceof Error) || error instanceof Refusal) return false;
  const failed = error as Error & Partial<GitFailure>;
  return failed.command === 'merge-base' && failed.status === 1 && failed.signal === null && failed.stderr === '';
};

/** `artifact_inspection_unavailable` naming `detail`. */
const unavailable = (detail: string) => new Refusal('artifact_inspection_unavailable', 'no_effect', undefined, { detail });
const busy = (detail: string) => new Refusal('artifact_inspections_busy', 'no_effect', undefined, { detail });

/** What the inspection child is given: the values `Artifacts.inspect` checked, never a caller's raw input. */
export interface InspectionJob {
  /** The owner environment, and the inspection's own private directory as the state its snapshots are made in. */
  readonly owner: OwnerGit;
  readonly root: string;
  /** The worker's saved launch pin. */
  readonly pin: GitPin;
  readonly worker_id: string;
  readonly worker_epoch: string;
  /** Checked by `revision`. */
  readonly commit: string;
  readonly base?: string;
}

/** The child's one output: the facts, or a typed refusal. */
export type InspectionResult = { readonly facts: ArtifactFacts } | { readonly refusal: { readonly error: string; readonly detail?: string } };

/**
 * The inspection itself, in the child (`artifacts-child.ts`): owner Git's synchronous calls on the saved pin, every
 * failure a typed refusal.
 */
export function readFacts(job: InspectionJob): ArtifactFacts {
  const { owner, root, pin, commit, base } = job;
  const at: GitCheckout = { owner, root, pin };
  // Name the objects first: every one must be in the store (a sandbox can remove objects). A peel (`^{commit}`,
  // `^{tree}`) reads the object it names, so `rev-parse --verify` of one fails when that object is gone.
  const commitId = step(true, () => gitRevParse(at, `${commit}^{commit}`));
  const baseId = base === undefined ? undefined : step(true, () => gitRevParse(at, `${base}^{commit}`));
  const treeId = step(true, () => gitRevParse(at, `${commitId}^{tree}`));
  const headId = step(true, () => gitRevParse(at, 'HEAD'));
  // The subject as P2-6 defines it, of the resolved ids (an owner's own artifactSubject on its pin computes the same).
  const subject = step(false, () => artifactSubject(owner, root, commitId, baseId, pin));
  // The state is the complete status's, before the list is bounded: a conflict past the cut is still a conflict.
  const status = step(false, () => statusEntries(gitStatus(at)));
  let state: ArtifactFacts['worktree']['state'] = 'clean';
  if (status.length) state = 'dirty';
  if (status.some(e => UNMERGED.has(e.code))) state = 'conflicted';
  const entries = bounded(status, e => Buffer.byteLength(JSON.stringify(e.path)));
  const gitVersionText = subject.diff_digest?.git_version ?? step(false, () => gitVersion(owner));
  const facts: ArtifactFacts = {
    worker_id: job.worker_id,
    worker_epoch: job.worker_epoch,
    commit: { requested: commit, commit_id: commitId, tree_id: treeId },
    head: { ref: headRef(pin), commit_id: headId, matches_commit: headId === commitId },
    worktree: { state, entries: entries.list, truncated: entries.truncated },
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
      requested: base!,
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

/** The facts or the typed refusal a child printed; anything else is `inspection_failed`. */
function outcome(out: Buffer): ArtifactFacts {
  let result: InspectionResult | undefined;
  try {
    result = JSON.parse(out.toString('utf8')) as InspectionResult;
  } catch {
    throw unavailable('inspection_failed');
  }
  if (result && typeof result === 'object' && 'facts' in result && result.facts) return result.facts;
  const refused = result && typeof result === 'object' && 'refusal' in result ? result.refusal : undefined;
  if (!refused || !CHILD_REFUSALS.has(refused.error)) throw unavailable('inspection_failed');
  if (refused.error !== 'artifact_inspection_unavailable') throw new Refusal(refused.error);
  throw unavailable(typeof refused.detail === 'string' && /^[a-z0-9_]{1,128}$/.test(refused.detail) ? refused.detail : 'owner_git_refused');
}

/** One running inspection: whose it is, how to end it, and when it has ended. */
interface Running {
  readonly caller: string;
  readonly stop: (why: Refusal) => void;
  readonly done: Promise<unknown>;
}

export class Artifacts {
  /** The environment owner Git takes PATH and the locale from (nothing else in it reaches Git or the child). */
  env: Readonly<Record<string, string | undefined>>;
  /** The time budget and the caps (the constants; tests lower them). */
  budgetMs = ARTIFACT_INSPECTION_BUDGET_MS;
  maxInFlight = ARTIFACT_INSPECTIONS_MAX;
  maxPerCaller = ARTIFACT_INSPECTIONS_PER_CALLER_MAX;
  private readonly running = new Set<Running>();

  constructor(private readonly s: SupervisorState) {
    this.env = Object.fromEntries(ENV_KEEP.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  }

  /** `caller`: the grant the call came with (the per-caller cap's key). */
  async inspect(id: string, request: ArtifactInspect, caller = ''): Promise<ArtifactFacts> {
    const live = this.s.require(id);
    const w = live.worker;
    if (request.worker_epoch !== w.worker_epoch) throw new Refusal('stale_binding');
    // The pin the launch validated, and only that: never one read now from metadata the sandbox can write. Only a
    // sandboxed worker in a linked worktree has one (P2-5).
    const pin = live.gitPin;
    if (!pin) throw new Refusal('artifact_inspection_unavailable', 'no_effect', undefined, { detail: 'no_saved_launch_pin' });
    const commit = revision(request.commit, pin);
    const base = request.base === undefined ? undefined : revision(request.base, pin);
    // Admission and the slot are taken in one synchronous step: no other call runs in between.
    this.admit(caller);
    return this.run(caller, { root: w.cwd, pin, worker_id: w.worker_id, worker_epoch: w.worker_epoch, commit, ...(base === undefined ? {} : { base }) });
  }

  /** Ends every running inspection (its process group killed) and waits until each has ended. */
  async close(): Promise<void> {
    const all = [...this.running];
    for (const r of all) r.stop(unavailable('supervisor_stopping'));
    await Promise.allSettled(all.map(r => r.done));
  }

  private admit(caller: string): void {
    let mine = 0;
    for (const r of this.running) if (r.caller === caller) mine++;
    if (mine >= this.maxPerCaller) throw busy('per_caller_limit');
    if (this.running.size >= this.maxInFlight) throw busy('supervisor_limit');
  }

  /**
   * Runs the inspection child in its own process group with the owner environment only, and a private directory for
   * its snapshots (removed when it ends, whatever ended it). Past the budget, the output bound or at `close`, the
   * whole group is killed and the call refuses.
   */
  private run(caller: string, job: Omit<InspectionJob, 'owner'>): Promise<ArtifactFacts> {
    // Inside owner Git's own private snapshot directory (the state's `git-snapshots`, mode 0700): the child makes its
    // snapshots below this one, and whatever a killed child leaves goes with it.
    const parent = join(this.s.stateDir, 'git-snapshots');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(parent, 'inspect-'));
    const env = Object.fromEntries(Object.entries(this.env).filter((e): e is [string, string] => e[1] !== undefined));
    let ended: Refusal | undefined;
    let finished = false;
    let settle!: (fn: () => ArtifactFacts) => void;
    const result = new Promise<ArtifactFacts>((resolve, reject) => {
      settle = fn => {
        try {
          resolve(fn());
        } catch (error) {
          reject(error);
        }
      };
    });
    const child: ChildProcess = spawn(process.execPath, [CHILD], { cwd: '/', env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const stop = (why: Refusal) => {
      ended ??= why;
      if (finished || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let markDone!: () => void;
    const done = new Promise<void>(resolve => (markDone = resolve));
    const entry: Running = { caller, stop, done };
    this.running.add(entry);
    const timer = setTimeout(() => stop(new Refusal('artifact_inspection_timeout')), this.budgetMs);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.running.delete(entry);
      rmSync(dir, { recursive: true, force: true });
      markDone();
      settle(() => {
        if (ended) throw ended;
        return outcome(Buffer.concat(chunks));
      });
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_MAX_BYTES) stop(unavailable('inspection_output_too_large'));
      else chunks.push(chunk);
    });
    child.stdin!.on('error', () => stop(unavailable('inspection_failed')));
    child.once('error', () => {
      stop(unavailable('inspection_failed'));
      if (child.pid === undefined) finish();
    });
    child.once('close', finish);
    child.stdin!.end(JSON.stringify({ ...job, owner: { stateDir: dir, env } } satisfies InspectionJob));
    return result;
  }
}
