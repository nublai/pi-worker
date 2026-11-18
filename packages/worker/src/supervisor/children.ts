/**
 * Children core, unsandboxed (P1-11): typed launch specs, child reports and the missing-report parent fence.
 * Rewritten from A0 `src/supervisor.ts` (`validateLaunch`, `onReport`, `report`, the child part of `recover`). P2-4
 * adds the bwrap profile for typed children (sandbox/); P2-8 adds sandboxed parents and their parent channel
 * (channel.ts, b2/channel.ts).
 *
 * - A typed child (`workers.create` with `parent` and `launch_spec`) has a launch spec that is a subset of its
 *   environment's methods, of the creating caller's grant, and of its parent's spec (methods, environment methods,
 *   tools, denials, resources), and its environment stays inside the parent's tree: its `environment.root` and its
 *   cwd resolve (realpath) under the parent's `environment.root`, or the parent's cwd when it has none. The parent
 *   must be writable (no fence, no move), name its current binding and its running execution, and its creating grant
 *   must still be active. Every check runs before any record or spawn.
 * - A sandboxed parent (P2-8) needs a parent channel to be served. Its child is sandboxed and runs in an
 *   owner-prepared slot: its cwd is exactly `PARENT/.piw-slots/<name>`, opened with O_NOFOLLOW from the parent root
 *   (sandbox.ts `openSlot`), never resolved. The child's Git metadata, when it has any, is the parent's own pinned
 *   repository: its pinned common dir equals the parent's (a parent with no Git root has children with none), so a
 *   gitfile the parent points at another repository, or at a repository it made inside its root, refuses. Its launch
 *   spec names resources in its own staged profile (`CHILD/.piw-agent/…`) for the parent's (`PARENT/.piw-agent/…`).
 *   Parents get no Git administrative writes: the owner prepares the slots.
 * - Lineage (`parent`, `parent_worker_id`, `parent_launch_command_id`) is in the child's starting row, durable before
 *   its dispatch record and spawn (lifecycle.ts). An unknown child create fences the parent on that command.
 * - A typed child's only report authority is its inherited FD 3 (host.ts): B2 `children.report` naming a typed child
 *   is refused `typed_child_reports_through_fd3_only`, whatever grant sends it. Each report becomes a
 *   `children.report` receipt (outside the count quota) naming its channel (`fd3` or `b2`). Every report path
 *   rechecks, as the report is recorded, the child's spec (`children.report` granted) and the child's and the parent's
 *   creating grants. A duplicate report id returns the same receipt and notifies once. A report is a claim, never proof.
 * - A child whose launch may have run and that has no durable non-`help` report fences its parent on the launch
 *   command, until the owner resolves it: live, as soon as the child's process ends (exit or fault, after its FD 3
 *   channel drained), and again on recovery after a restart. A `help` report never discharges that fence (invariant 4a), and for
 *   a typed child only a report its own FD 3 delivered does. An untyped child (`children.launch`) has no FD 3: its B2
 *   report, under the same grant rechecks, still discharges (the frozen invariants case).
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { Refusal } from '../b2/errors.js';
import { authority, currentGuard } from '../grants/authority.js';
import { dischargesLaunch } from '../journal/retention.js';
import type { ChildReport } from '../host/host.js';
import type { Receipt } from '../receipts/receipts.js';
import type { Fence } from './fence.js';
import type { Input } from './input.js';
import type { Lifecycle } from './lifecycle.js';
import type { Create, Live, SupervisorState, Worker } from './state.js';
import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_DIR, openSlot, sandboxed, sandboxRoot } from '../sandbox/sandbox.js';
import type { GitPin } from '../sandbox/git-sandbox.js';
import { channelAvailable } from './channel.js';

export type Report = import('../generated/api.js').components['schemas']['Report'];
export type ChildClaim = import('../generated/api.js').components['schemas']['ChildClaim'];

const subset = (child: readonly string[], parent: readonly string[]) => child.every(x => parent.includes('*') || parent.includes(x));

/** `path` is `root` or below it; both are real paths. */
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

/** The real path of an existing directory (symlinks and `..` resolved), or the refusal. */
function realDir(path: string, refusal: string): string {
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    return realpathSync(path);
  } catch {
    throw new Refusal(refusal);
  }
}

export class Children {
  /** Report receipts already announced (`child.reported` once per receipt). */
  private readonly notified = new Set<string>();

  constructor(
    readonly s: SupervisorState,
    readonly lifecycle: Lifecycle,
    readonly input: Input,
    readonly fence: Fence,
  ) {
    lifecycle.typedLaunch = c => this.validate(c);
    lifecycle.onReport = (live, report) => this.onReport(live, report);
    lifecycle.fenceParent = (parentId, commandId) => this.fenceParent(parentId, commandId);
    lifecycle.childEnded = live => this.ended(live);
  }

  /**
   * A child's process ended. Once every report still in its FD 3 pipe was handled (bounded by the host), a child with
   * no durable result report fences its parent durably: the parent cannot launch a replacement (invariant 4a, live).
   */
  private ended(live: Live): void {
    const parentId = live.worker.parent_worker_id;
    if (!live.worker.parent_launch_command_id || !parentId) return;
    // Until the check below runs, the parent may not launch another child (it could be a replacement).
    this.s.childEnding.set(parentId, (this.s.childEnding.get(parentId) ?? 0) + 1);
    const settled = live.host?.reportsSettled?.() ?? Promise.resolve();
    void settled
      // Reports emitted while the pipe drained are recorded by a chain of microtasks; let those finish first.
      .then(() => new Promise<void>(resolve => setImmediate(resolve)))
      .then(() => {
        const launch = this.unreported(live);
        if (launch) this.fenceParent(live.worker.parent_worker_id!, launch);
      })
      .catch(() => {
        /* storage failure: the journal refuses every write; recovery fences the parent from the durable records */
      })
      .finally(() => {
        const n = (this.s.childEnding.get(parentId) ?? 1) - 1;
        if (n > 0) this.s.childEnding.set(parentId, n);
        else this.s.childEnding.delete(parentId);
      });
  }

  /**
   * The launch command a child leaves uncertain: its launch may have run (receipt not `no_effect`), its parent has not
   * resolved it, and it has no durable non-`help` report for its task (for a typed child, from its own FD 3).
   */
  private unreported(child: Live): string | null {
    const launch = child.worker.parent_launch_command_id;
    const parentId = child.worker.parent_worker_id;
    if (!launch || !parentId) return null;
    const receipt = this.s.receipts.all.get(launch);
    if (!receipt || receipt.effect === 'no_effect') return null;
    const parent = this.s.workers.get(parentId);
    if (!parent || (parent.worker.resolutions ?? []).some(r => r.command_id === launch)) return null;
    // A report for the launch task; a typed child's launch is discharged only by its own FD 3 result report. Retention
    // keeps such a report with the launch (journal/retention.ts uses the same rule).
    const reported = [...this.s.receipts.all.values()].some(r => dischargesLaunch(child.worker, r));
    return reported ? null : launch;
  }

  /** A creating grant recorded on a worker must still be active (a revocation stops what it authorized). */
  private active(grantId: string | undefined): void {
    if (!grantId || !this.s.grants) return;
    if (this.s.grants.read(grantId).revoked) throw new Refusal('grant_revoked');
  }

  /**
   * The typed launch checks, all before any record (refusals are `no_effect`). A sandboxed launch returns the Git pin its
   * root's checks accepted (sandbox/git-sandbox.ts), which its spawn must still find.
   */
  validate(c: Create): GitPin | null | undefined {
    const spec = c.launch_spec;
    if (c.parent && !spec) throw new Refusal('child_launch_spec_required');
    if (!spec) return undefined;
    let gitPin: GitPin | null | undefined;
    // A sandboxed parent's child runs in a slot below its root, opened with no link followed, before anything resolves
    // the path (P2-8).
    const family = c.parent ? this.s.workers.get(c.parent.worker_id) : undefined;
    if (family && sandboxed(family.worker.launch_spec) && sandboxed(spec)) closeSync(openSlot(family.worker.cwd, c.cwd));
    // A sandboxed worker (P2-4): its root equals its cwd and overlaps no control path (sandbox.ts). A sandboxed root
    // worker (a parent) needs a parent channel (P2-8).
    if (sandboxed(spec)) {
      if (!c.parent) channelAvailable(this.s);
      if (c.resume_session_id) throw new Refusal('sandboxed_child_resume_unsupported');
      gitPin = sandboxRoot(c, { stateDir: this.s.stateDir, paths: this.s.sandboxControls }).gitPin;
    }
    const caller = currentGuard();
    if (!subset(spec.grant_methods, spec.environment.allowed_methods) || (caller?.methods && !subset(spec.grant_methods, caller.methods))) throw new Refusal('child_grant_not_subset');
    if (spec.tools.some(t => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(t)) || spec.tools.some(t => spec.denied_tools.includes(t))) throw new Refusal('invalid_tool_allowlist');
    if ([...spec.resources.extensions, ...spec.resources.skills].some(p => !p.startsWith('/'))) throw new Refusal('resource_path_must_be_absolute');
    if (!c.parent) return gitPin;
    const parent = this.s.require(c.parent.worker_id);
    this.input.writable(parent);
    if (this.s.childEnding.has(parent.worker.worker_id)) throw new Refusal('child_end_unsettled');
    this.s.binding(parent, { ...c.parent, command_id: c.command_id });
    if (parent.worker.status !== 'ready' || parent.worker.execution?.execution_id !== c.parent.execution_id || parent.worker.execution.state === 'settled') {
      throw new Refusal('stale_parent_execution');
    }
    const p = parent.worker.launch_spec;
    // A sandboxed parent's children are sandboxed too: a child never runs with more filesystem than its parent.
    if (sandboxed(p) && !sandboxed(spec)) throw new Refusal('child_filesystem_cannot_widen');
    if (sandboxed(p)) this.sameRepository(parent, gitPin);
    // A sandboxed child of a sandboxed parent names a resource in its staged profile for the parent's same path.
    const staged = sandboxed(p) ? join(c.cwd, AGENT_DIR) : null;
    const asParent = (path: string) => (staged && path.startsWith(`${staged}/`) ? join(parent.worker.cwd, AGENT_DIR, path.slice(staged.length + 1)) : path);
    if (
      !p ||
      !subset(spec.grant_methods, p.grant_methods) ||
      !subset(spec.environment.allowed_methods, p.environment.allowed_methods) ||
      !subset(spec.tools, p.tools) ||
      !subset(p.denied_tools, spec.denied_tools) ||
      !subset(spec.resources.extensions.map(asParent), p.resources.extensions) ||
      !subset(spec.resources.skills.map(asParent), p.resources.skills)
    ) {
      throw new Refusal('child_authority_not_subset');
    }
    // The child's environment is inside the parent's tree: its environment root (when given) and its cwd resolve, with
    // symlinks and `..`, under the parent's root (its environment.root, else its cwd), and the cwd under its own root.
    const tree = realDir(p.environment.root ?? parent.worker.cwd, 'parent_root_not_directory');
    const root = spec.environment.root === undefined ? tree : realDir(spec.environment.root, 'child_root_not_directory');
    const cwd = realDir(c.cwd, 'cwd_not_directory');
    if (!within(tree, root) || !within(root, cwd)) throw new Refusal('child_environment_outside_parent');
    this.active(parent.worker.grant_source_id);
    return gitPin;
  }

  /**
   * A sandboxed parent's child (P2-8): its Git metadata (`gitPin`, its root's as its validation read it) is the parent's
   * own pinned repository: the same common dir. A child root with no Git metadata has no Git dirs at all.
   */
  private sameRepository(parent: Live, gitPin: GitPin | null | undefined): void {
    const own = parent.gitPin?.common_dir ?? null;
    if (gitPin && gitPin.common_dir !== own) throw new Refusal('parent_channel_child_git_not_parent_repository');
  }

  /** An uncertain child launch fences its parent durably (the parent cannot simply replace the child). */
  fenceParent(parentId: string, commandId: string): void {
    const parent = this.s.workers.get(parentId);
    if (parent && this.fence.latch(parent, commandId)) this.s.persist(parent, 'fence.latch');
  }

  /**
   * `children.report`: a child's claim to its parent, allowed under a fence. Never proof of anything. `channel` is
   * where it came from: `b2` (the public route) or `fd3` (the child's inherited report descriptor, onReport below).
   */
  async report(id: string, r: Report, channel: 'b2' | 'fd3' = 'b2'): Promise<Receipt> {
    let live!: Live;
    const receipt = await this.s.receipts.run(
      r.command_id,
      'children.report',
      { ...r, worker_id: id, channel },
      async () => {
        this.s.receipts.dispatch(r.command_id, { worker_id: id });
        return {
          state: 'delivered',
          stage: 'forwarded',
          effect: 'observed',
          result: { task_id: r.task_id, result_digest: r.result_digest, ...(r.kind ? { kind: r.kind, message: r.message ?? '' } : {}), channel, claim_not_verified: true },
        };
      },
      () => {
        live = this.s.require(id);
        const w = live.worker;
        this.s.binding(live, r);
        if (w.parent && r.task_id !== w.parent.task_id) throw new Refusal('wrong_child_task');
        if (r.kind && (typeof r.message !== 'string' || Buffer.byteLength(r.message) > 8192)) throw new Refusal('report_message_invalid');
        // A typed child's only report authority is its own FD 3: no grant may report (or discharge a fence) for it.
        if (channel !== 'fd3' && (w.parent || w.launch_spec)) throw new Refusal('typed_child_reports_through_fd3_only');
        // Every path, as the report is recorded: the spec grants reports, and the grants that created the child and its
        // parent are still active (a revocation stops what it authorized).
        if (w.launch_spec && !w.launch_spec.grant_methods.includes('children.report')) throw new Refusal('report_not_granted');
        this.active(w.grant_source_id);
        if (w.parent_worker_id) this.active(this.s.workers.get(w.parent_worker_id)?.worker.grant_source_id);
      },
    );
    if (receipt.state === 'delivered' && !this.notified.has(r.command_id)) {
      this.notified.add(r.command_id);
      const appended = this.s.receipts.appended.get(r.command_id);
      if (appended) {
        this.s.events.publish('child.reported', {
          worker_id: id,
          execution_id: null,
          data: { report_command_id: r.command_id, task_id: r.task_id, parent_worker_id: live.worker.parent_worker_id ?? null, ...(r.kind ? { kind: r.kind } : {}), claim_not_verified: true },
          appended,
        });
      }
    }
    return receipt;
  }

  /**
   * A report from a typed child's FD 3. The shared checks in report() (spec grants it, the child's and the parent's
   * creating grants still active) run as the report is recorded. Anything else faults only the child.
   */
  private onReport(live: Live, report: ChildReport): void {
    const w = live.worker;
    const parent = w.parent;
    if (!parent || !w.session_id) {
      this.lifecycle.fault(live, new Error('report_before_binding'));
      return;
    }
    // The report runs as the child's creating grant (not as whatever request happens to be current).
    const guard = Object.assign(() => {}, { ...(w.grant_source_id ? { grant_id: w.grant_source_id } : {}) });
    const request: Report = {
      command_id: `fd-${w.worker_id}-${report.report_id}`,
      worker_epoch: w.worker_epoch,
      session_id: w.session_id,
      binding_revision: w.binding_revision,
      task_id: parent.task_id,
      result_digest: 'unverified-claim',
      kind: report.kind,
      message: report.message,
    };
    void authority.run(guard, () => this.report(w.worker_id, request, 'fd3')).catch(error => this.lifecycle.fault(live, error));
  }

  /** The claims a child's delivered reports made, for its row. */
  claims(w: Worker): ChildClaim[] {
    return [...this.s.receipts.all.values()]
      .filter(r => r.worker_id === w.worker_id && r.operation === 'children.report' && r.state === 'delivered' && typeof r.result?.kind === 'string')
      .map(r => ({ command_id: r.command_id, kind: r.result!.kind as ChildClaim['kind'], message: String(r.result!.message ?? ''), claim_not_verified: true as const }));
  }

  /**
   * After a restart: every child whose launch may have run (its receipt is not `no_effect`) and that has no durable
   * non-`help` report for its task fences its parent on the launch command, unless the owner already resolved it.
   */
  recover(): void {
    for (const child of this.s.workers.values()) {
      const launch = this.unreported(child);
      if (launch) this.fenceParent(child.worker.parent_worker_id!, launch);
    }
  }
}
