/**
 * The fence: one latch per worker that every uncertainty joins, and `sessions.resolve_unknown`, the only write that
 * lifts it. Rewritten from A0 `src/supervisor.ts` (`fence`, `resolveUnknown`, the fence part of `recover`).
 *
 * - An uncertain command (an `outcome_unknown` session-directed mutation, or an execution that can no longer settle)
 *   latches the fence. A new uncertainty raises the generation; the same one never does. The latch is durable
 *   before any reply or refusal it causes.
 * - Under a fence, session writes refuse `session_fenced` naming the uncertain command; cancel, interrupt and stop
 *   stay allowed and never lift it. Queued follow-ups pause.
 * - `resolve_unknown(generation, disposition)` names one uncertainty and the current generation: `keep` resumes
 *   (a recovered intent may then dispatch once on its exact retry), `abandon` drops queued input, `observed` needs
 *   exact settlement evidence (a journaled `agent_settled` or the session file's settlement entry for that
 *   execution and command). Resolving never claims an external effect was undone.
 * - A create that binds an existing session (create-with-resume) is a session write too: its unknown outcome fences
 *   the target, which the worker holds as its session.
 * - After a restart, an unsettled execution and every unresolved `outcome_unknown` session-directed receipt fence
 *   again; a resolved duplicate stays read-only.
 */
import { Refusal } from '../b2/errors.js';
import type { Receipt } from '../receipts/receipts.js';
import type { Input } from './input.js';
import type { Lifecycle } from './lifecycle.js';
import type { Live, SupervisorState, Worker } from './state.js';

export type Resolve = import('../generated/api.js').components['schemas']['Resolve'];

/** Session-directed operations whose unknown outcome fences the session. */
export const SESSION_DIRECTED = new Set<Receipt['operation']>([
  'sessions.prompt',
  'sessions.follow_up',
  'sessions.steer',
  'sessions.rebind',
  'sessions.new',
  'children.launch',
  'interactions.answer_if_current',
  'interactions.release',
]);

/**
 * Operations that write a session only when the request names an existing one: `workers.create` with
 * `resume_session_id`. Their unknown outcome fences that session (the worker holds it as its own).
 */
export const BINDS_EXISTING_SESSION = new Set<Receipt['operation']>(['workers.create']);

/** Whether this worker's `outcome_unknown` receipt fences its session. */
export function fencesWhenUnknown(r: Receipt, live: Live): boolean {
  if (SESSION_DIRECTED.has(r.operation)) return true;
  return BINDS_EXISTING_SESSION.has(r.operation) && live.create?.command_id === r.command_id && Boolean(live.create.resume_session_id);
}

export class Fence {
  constructor(
    readonly s: SupervisorState,
    readonly lifecycle: Lifecycle,
    readonly input: Input,
  ) {
    input.latch = (live, commandId) => this.latch(live, commandId);
    input.resolved = (live, commandId) => this.resolved(live.worker, commandId);
    lifecycle.latch = (live, commandId) => this.latch(live, commandId);
    lifecycle.recoverers.push(live => this.recover(live));
  }

  resolved(w: Worker, commandId: string): boolean {
    return (w.resolutions ?? []).some(r => r.command_id === commandId);
  }

  /** Joins `commandId` to the worker's fence (in memory; the caller persists before replying). True if it changed. */
  latch(live: Live, commandId: string): boolean {
    const w = live.worker;
    const before = JSON.stringify([w.fence, w.execution, w.foreground, w.queued]);
    const prior = w.fence;
    if (!prior) w.fence = { command_id: commandId, fence_generation: (w.fence_generation ?? 0) + 1, uncertain_command_ids: [commandId] };
    else if (!(prior.uncertain_command_ids ?? [prior.command_id]).includes(commandId)) {
      // Every uncertainty is kept; recovery of the same item never changes the generation.
      prior.uncertain_command_ids = [...(prior.uncertain_command_ids ?? [prior.command_id]), commandId];
      prior.fence_generation++;
    }
    w.fence_generation = w.fence!.fence_generation;
    for (const q of w.queued ?? []) if (q.state === 'queued') q.state = 'paused';
    if (w.execution?.command_id === commandId && w.execution.state !== 'settled') w.execution.state = 'outcome_unknown';
    w.foreground = 'unknown';
    return JSON.stringify([w.fence, w.execution, w.foreground, w.queued]) !== before;
  }

  /** After a restart: the owner's durable resolutions re-apply; unresolved unknown session writes fence again. */
  private recover(live: Live): void {
    const w = live.worker;
    for (const resolution of w.resolutions ?? []) {
      if (this.s.receipts.all.get(resolution.command_id)?.state === 'intent_recovered') this.s.receipts.resolveIntent(resolution.command_id, resolution.disposition);
    }
    for (const r of this.s.receipts.all.values()) {
      if (r.worker_id === w.worker_id && r.state === 'outcome_unknown' && fencesWhenUnknown(r, live) && !this.resolved(w, r.command_id)) this.latch(live, r.command_id);
    }
  }

  /** Exact settlement evidence for (execution, command) on this worker's current session. */
  private settled(live: Live, executionId: string, commandId: string): boolean {
    const w = live.worker;
    const journaled = this.s.journal.records.some(
      record =>
        record.kind === 'settlement' &&
        record.value.worker_id === w.worker_id &&
        record.value.session_id === w.session_id &&
        record.value.execution_id === executionId &&
        record.value.command_id === commandId &&
        record.value.source === 'pi.agent_settled',
    );
    return journaled || live.index.hasSettlement(executionId, commandId);
  }

  async resolve(id: string, r: Resolve): Promise<Receipt> {
    let live!: Live;
    let uncertain = '';
    return this.s.receipts.run(
      r.command_id,
      'sessions.resolve_unknown',
      { ...r, worker_id: id },
      async () => {
        const w = live.worker;
        this.s.receipts.dispatch(r.command_id, { worker_id: id });
        const resolution = { command_id: uncertain, disposition: r.disposition, fence_generation: r.fence_generation };
        (w.resolutions ??= []).push(resolution);
        const remaining = (w.fence?.uncertain_command_ids ?? (w.fence ? [w.fence.command_id] : [])).filter(x => x !== uncertain);
        w.fence = remaining.length ? { command_id: remaining[0]!, uncertain_command_ids: remaining, fence_generation: (w.fence_generation ?? 0) + 1 } : null;
        if (w.fence) w.fence_generation = w.fence.fence_generation;
        else {
          w.foreground = live.host && live.observedIdle === false ? 'running' : 'idle';
          if (r.disposition !== 'abandon') for (const q of w.queued ?? []) if (q.state === 'paused') q.state = 'queued';
        }
        if (r.disposition === 'abandon') this.input.dropQueued(live, 'resolve_abandon');
        // The durable resolution tombstone comes before any receipt it clears or authorizes.
        this.s.persist(live, 'fence.resolve');
        const target = this.s.receipts.all.get(uncertain);
        if (target && ['intent_recovered', 'intent_ready'].includes(target.state)) this.s.receipts.resolveIntent(uncertain, r.disposition);
        if (r.disposition !== 'abandon') setImmediate(() => void this.input.flush(live));
        return { state: 'delivered', stage: 'resolved', effect: 'observed', result: { ...resolution, external_effects_undone: false, fence: w.fence } };
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, r);
        const w = live.worker;
        if (Boolean(r.uncertain_command_id) === Boolean(r.execution_id)) throw new Refusal('name_exactly_one_uncertain_command_or_execution');
        uncertain =
          r.uncertain_command_id ??
          [...this.s.receipts.all.values()].find(x => x.worker_id === id && x.execution_id === r.execution_id)?.command_id ??
          (w.execution && w.execution.execution_id === r.execution_id ? w.execution.command_id : '');
        const target = this.s.receipts.all.get(uncertain);
        const recovered = target?.worker_id === id && ['intent_recovered', 'intent_ready'].includes(target.state);
        if (r.fence_generation !== (w.fence?.fence_generation ?? w.fence_generation ?? 0)) throw new Refusal('wrong_fence_generation', 'no_effect', w.fence?.command_id);
        if (w.fence ? !(w.fence.uncertain_command_ids ?? [w.fence.command_id]).includes(uncertain) : !recovered) throw new Refusal('uncertainty_not_current');
        if (r.disposition === 'observed') {
          const execution = r.execution_id ?? target?.execution_id ?? (w.execution?.command_id === uncertain ? w.execution.execution_id : undefined);
          // Admission is not settlement: exact worker, session, execution and command attribution only.
          if (!execution || !this.settled(live, execution, uncertain)) throw new Refusal('execution_settlement_not_in_session_file_or_fsynced_record');
        }
      },
    );
  }
}
