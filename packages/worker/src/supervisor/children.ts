/**
 * Children core, unsandboxed (P1-11): typed launch specs, child reports and the missing-report parent fence.
 * Rewritten from A0 `src/supervisor.ts` (`validateLaunch`, `onReport`, `report`, the child part of `recover`); P2 adds
 * bwrap and the parent channel on top, so a sandboxed launch spec is refused here.
 *
 * - A typed child (`workers.create` with `parent` and `launch_spec`) has a launch spec that is a subset of its
 *   environment's methods, of the creating caller's grant, and of its parent's spec (methods, environment methods,
 *   tools, denials, resources). The parent must be writable (no fence, no move), name its current binding and its
 *   running execution, and its creating grant must still be active. Every check runs before any record or spawn.
 * - Lineage (`parent`, `parent_worker_id`, `parent_launch_command_id`) is in the child's starting row, durable before
 *   its dispatch record and spawn (lifecycle.ts). An unknown child create fences the parent on that command.
 * - A typed child's only report authority is its inherited FD 3 (host.ts). Each report becomes a `children.report`
 *   receipt (outside the count quota), rechecked against the child's spec and the child's and parent's creating
 *   grants; a duplicate report id returns the same receipt and notifies once. A report is a claim, never proof.
 * - Recovery: a child whose launch may have run and that has no durable non-`help` report fences its parent on the
 *   launch command, until the owner resolves it. A `help` report never discharges that fence (invariant 4a).
 */
import { Refusal } from '../b2/errors.js';
import { authority, currentGuard } from '../grants/authority.js';
import type { ChildReport } from '../host/host.js';
import type { Receipt } from '../receipts/receipts.js';
import type { Fence } from './fence.js';
import type { Input } from './input.js';
import type { Lifecycle } from './lifecycle.js';
import type { Create, Live, SupervisorState, Worker } from './state.js';

export type Report = import('../generated/api.js').components['schemas']['Report'];
export type ChildClaim = import('../generated/api.js').components['schemas']['ChildClaim'];

const subset = (child: readonly string[], parent: readonly string[]) => child.every(x => parent.includes('*') || parent.includes(x));

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
  }

  /** A creating grant recorded on a worker must still be active (a revocation stops what it authorized). */
  private active(grantId: string | undefined): void {
    if (!grantId || !this.s.grants) return;
    if (this.s.grants.read(grantId).revoked) throw new Refusal('grant_revoked');
  }

  /** The typed launch checks, all before any record (refusals are `no_effect`). */
  validate(c: Create): void {
    const spec = c.launch_spec;
    if (c.parent && !spec) throw new Refusal('child_launch_spec_required');
    if (!spec) return;
    // P1 children run unsandboxed (plan D5); bwrap and the parent channel land in P2-4 and P2-8.
    if (spec.environment.filesystem === 'bwrap') throw new Refusal('sandboxed_children_not_supported_before_p2');
    const caller = currentGuard();
    if (!subset(spec.grant_methods, spec.environment.allowed_methods) || (caller?.methods && !subset(spec.grant_methods, caller.methods))) throw new Refusal('child_grant_not_subset');
    if (spec.tools.some(t => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(t)) || spec.tools.some(t => spec.denied_tools.includes(t))) throw new Refusal('invalid_tool_allowlist');
    if ([...spec.resources.extensions, ...spec.resources.skills].some(p => !p.startsWith('/'))) throw new Refusal('resource_path_must_be_absolute');
    if (!c.parent) return;
    const parent = this.s.require(c.parent.worker_id);
    this.input.writable(parent);
    this.s.binding(parent, { ...c.parent, command_id: c.command_id });
    if (parent.worker.status !== 'ready' || parent.worker.execution?.execution_id !== c.parent.execution_id || parent.worker.execution.state === 'settled') {
      throw new Refusal('stale_parent_execution');
    }
    const p = parent.worker.launch_spec;
    if (
      !p ||
      !subset(spec.grant_methods, p.grant_methods) ||
      !subset(spec.environment.allowed_methods, p.environment.allowed_methods) ||
      !subset(spec.tools, p.tools) ||
      !subset(p.denied_tools, spec.denied_tools) ||
      !subset(spec.resources.extensions, p.resources.extensions) ||
      !subset(spec.resources.skills, p.resources.skills)
    ) {
      throw new Refusal('child_authority_not_subset');
    }
    this.active(parent.worker.grant_source_id);
  }

  /** An uncertain child launch fences its parent durably (the parent cannot simply replace the child). */
  fenceParent(parentId: string, commandId: string): void {
    const parent = this.s.workers.get(parentId);
    if (parent && this.fence.latch(parent, commandId)) this.s.persist(parent, 'fence.latch');
  }

  /** `children.report`: a child's claim to its parent, allowed under a fence. Never proof of anything. */
  async report(id: string, r: Report): Promise<Receipt> {
    let live!: Live;
    const receipt = await this.s.receipts.run(
      r.command_id,
      'children.report',
      { ...r, worker_id: id },
      async () => {
        this.s.receipts.dispatch(r.command_id, { worker_id: id });
        return {
          state: 'delivered',
          stage: 'forwarded',
          effect: 'observed',
          result: { task_id: r.task_id, result_digest: r.result_digest, ...(r.kind ? { kind: r.kind, message: r.message ?? '' } : {}), claim_not_verified: true },
        };
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, r);
        if (live.worker.parent && r.task_id !== live.worker.parent.task_id) throw new Refusal('wrong_child_task');
        if (r.kind && (typeof r.message !== 'string' || Buffer.byteLength(r.message) > 8192)) throw new Refusal('report_message_invalid');
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
   * A report from a typed child's FD 3. It must be granted by the child's spec, and the child's and the parent's
   * creating grants must still be active, rechecked as the report is recorded. Anything else faults only the child.
   */
  private onReport(live: Live, report: ChildReport): void {
    const w = live.worker;
    const parent = w.parent;
    if (!parent || !w.session_id) {
      this.lifecycle.fault(live, new Error('report_before_binding'));
      return;
    }
    const guard = Object.assign(
      () => {
        if (!w.launch_spec?.grant_methods.includes('children.report')) throw new Refusal('report_not_granted');
        this.active(w.grant_source_id);
        this.active(this.s.workers.get(parent.worker_id)?.worker.grant_source_id);
      },
      { ...(w.grant_source_id ? { grant_id: w.grant_source_id } : {}) },
    );
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
    void authority.run(guard, () => this.report(w.worker_id, request)).catch(error => this.lifecycle.fault(live, error));
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
      const launch = child.worker.parent_launch_command_id;
      const parentId = child.worker.parent_worker_id;
      if (!launch || !parentId) continue;
      const receipt = this.s.receipts.all.get(launch);
      if (!receipt || receipt.effect === 'no_effect') continue;
      const parent = this.s.workers.get(parentId);
      if (!parent || (parent.worker.resolutions ?? []).some(r => r.command_id === launch)) continue;
      const task = child.worker.parent?.task_id ?? launch;
      const reported = [...this.s.receipts.all.values()].some(
        r => r.operation === 'children.report' && r.worker_id === child.worker.worker_id && r.state === 'delivered' && r.result?.task_id === task && r.result?.kind !== 'help',
      );
      if (!reported) this.fenceParent(parentId, launch);
    }
  }
}
