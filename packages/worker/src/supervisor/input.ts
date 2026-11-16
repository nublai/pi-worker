/**
 * Input and executions: `sessions.prompt` (with `if_busy`), `sessions.steer`, `sessions.follow_up` and the
 * supervisor-owned follow-up queue, `executions.cancel` and `executions.interrupt`. Rewritten from A0
 * `src/supervisor.ts` (`prompt`, `enqueue`, `flushPending`, `control`).
 *
 * An execution moves admitted (the supervisor admitted it and dispatched it) → started (pi's `agent_start`) →
 * settled (pi's `agent_settled`, journaled as settlement evidence). pi's admission reply is not settlement. Every
 * session-directed mutation names the binding it saw (`stale_binding`, `no_effect`). After the dispatch record, a
 * lost reply is `outcome_unknown` and is never replayed: the execution becomes `outcome_unknown` and (P1-6) fences
 * the session.
 */
import { randomUUID } from 'node:crypto';
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import type { PiRecord } from '../host/host.js';
import type { Receipt, ReceiptPatch } from '../receipts/receipts.js';
import type { Lifecycle } from './lifecycle.js';
import type { Control, FollowUp, Live, Prompt, Queued, Steer, SupervisorState } from './state.js';

export const QUEUE_CAP = 32;

export class Input {
  /** Joins a command to the worker's fence (fence.ts); returns whether anything changed. In memory only. */
  latch: (live: Live, commandId: string) => boolean = () => false;
  /** Whether the owner already resolved this command (a resolved duplicate never relatches). */
  resolved: (live: Live, commandId: string) => boolean = () => false;

  constructor(
    readonly s: SupervisorState,
    readonly lifecycle: Lifecycle,
  ) {
    lifecycle.observers.push((live, event) => this.observe(live, event));
    lifecycle.onUncertain = (live, commandId, label) => this.uncertain(live, commandId, label);
    lifecycle.recoverers.push(live => this.recover(live));
  }

  /**
   * After a restart: queued input is `recovered` (its intent is `no_effect` and may dispatch once only after the
   * owner keeps it). An execution whose receipt never reached its dispatch record ran nothing; any other unsettled
   * execution's outcome is unknown.
   */
  private recover(live: Live): void {
    const w = live.worker;
    for (const q of w.queued ?? []) if (!['dropped', 'dispatched'].includes(q.state)) q.state = 'recovered';
    if (!w.execution || w.execution.state === 'settled') return;
    const receipt = this.s.receipts.all.get(w.execution.command_id);
    if (receipt?.effect === 'no_effect' && (receipt.state === 'intent_recovered' || receipt.state === 'rejected')) {
      w.execution.state = 'settled';
      w.execution.disposition = 'no_effect_before_dispatch';
      w.foreground = 'idle';
    } else if (!this.resolved(live, w.execution.command_id) || ['ready', 'starting'].includes(w.status)) {
      // A kept live run that was still running at the crash is a NEW uncertainty: it relatches.
      this.uncertain(live, w.execution.command_id, 'worker.recover');
    }
  }

  /** Writes allowed: not fenced and no binding change in flight. P1-6 adds the fence latch here. */
  writable(live: Live): void {
    if (live.worker.fence) throw new Refusal('session_fenced', 'no_effect', live.worker.fence.command_id);
    if (live.rebinding || live.nativeRebinding) throw new Refusal('binding_change_in_progress');
  }

  private ready(live: Live): void {
    if (live.worker.status !== 'ready' || !live.host || live.faulted) throw new Refusal('worker_not_ready');
  }

  /**
   * An execution whose outcome can no longer be observed: its row says `outcome_unknown`, durably, before any reply
   * or refusal that depends on it. The fence latch (P1-6) extends this.
   */
  uncertain(live: Live, commandId: string, label: 'execution.unknown' | 'worker.exit' | 'worker.fault' | 'worker.recover' = 'execution.unknown'): void {
    const w = live.worker;
    // A dispatched command whose reply can no longer come is outcome_unknown (a no-op for any other state).
    if (this.s.receipts.all.get(commandId)?.state === 'accepted') this.s.receipts.unknown(commandId);
    if (w.execution?.command_id === commandId && w.execution.state !== 'settled') w.execution.state = 'outcome_unknown';
    w.foreground = 'unknown';
    this.latch(live, commandId);
    if (label === 'execution.unknown') this.s.persist(live, label);
  }

  private observe(live: Live, event: PiRecord): void {
    const w = live.worker;
    if (event.type === 'agent_start') {
      live.observedIdle = false;
      w.foreground = w.fence ? 'unknown' : 'running';
      if (w.execution?.state === 'admitted') {
        w.execution.state = 'started';
        this.s.persist(live, 'execution.start');
      }
    }
    if (event.type === 'agent_settled') {
      w.foreground = w.fence ? 'unknown' : 'idle';
      live.observedIdle = true;
      if (w.execution) {
        w.execution.state = 'settled'; // Observed in memory even if persistence fails.
        this.s.journal.append(
          'settlement',
          { worker_id: w.worker_id, session_id: w.session_id, execution_id: w.execution.execution_id, command_id: w.execution.command_id, source: 'pi.agent_settled' },
          'settlement.record',
        );
      }
      this.s.refresh(live);
      this.s.persist(live, 'execution.settle');
      setImmediate(() => void this.flush(live));
    }
  }

  async prompt(id: string, p: Prompt, operation: 'sessions.prompt' | 'sessions.follow_up' = 'sessions.prompt'): Promise<Receipt> {
    let live!: Live;
    let busy: 'steer' | 'follow_up' | undefined;
    const receipt = await this.s.receipts.run(
      p.command_id,
      operation,
      { ...p, worker_id: id },
      async () => {
        if (busy === 'follow_up') return this.enqueued(live, operation, p);
        if (busy === 'steer') return this.dispatchSteer(live, p.command_id, p.message);
        const w = live.worker;
        w.execution = { execution_id: randomUUID(), command_id: p.command_id, state: 'admitted' };
        w.foreground = 'running';
        live.observedIdle = false;
        this.s.persist(live, 'execution.admit');
        const response = await this.s.receipts.dispatchThen(p.command_id, { worker_id: id, execution_id: w.execution.execution_id }, () =>
          live.host!.request({ type: 'prompt', message: p.message }),
        );
        if (live.faulted) throw new Error('worker fault during prompt');
        if (!response.success) {
          // pi runs input hooks before its own refusals, so a negative reply is no proof that nothing happened: only
          // the child's explicit refusal before any input hook is (D2). Anything else stays outcome_unknown.
          if (response.refused !== 'before_input') throw new Error(`pi_prompt_failed_after_dispatch: ${String(response.error ?? 'negative_reply').slice(0, 64)}`);
          w.execution = null;
          w.foreground = 'idle';
          live.observedIdle = true;
          this.s.persist(live, 'execution.reply');
          throw new ProvenNoEffect(`pi_refused_prompt: ${String(response.error).slice(0, 64)}`, 'host_refused_before_input_hooks');
        }
        const disposition = String(response.data?.disposition);
        if (disposition !== 'started' && disposition !== 'handled') throw new Error('unexpected prompt disposition');
        w.execution!.disposition = disposition;
        if (disposition === 'handled' && w.execution!.state === 'admitted') {
          w.execution!.state = 'settled';
          w.foreground = w.fence ? 'unknown' : 'idle';
          live.observedIdle = true;
        }
        this.s.refresh(live);
        this.s.persist(live, 'execution.reply');
        const patch: ReceiptPatch = { state: 'delivered', stage: 'forwarded', effect: 'observed', admission: 'accepted', disposition, history_lag: w.history.lag };
        return patch;
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, p);
        this.writable(live);
        this.ready(live);
        this.s.refresh(live);
        if (p.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_use_typed_methods');
        if (live.worker.foreground !== 'idle') {
          const mode = operation === 'sessions.follow_up' ? 'reject' : (p.if_busy ?? 'reject');
          if (mode === 'reject' || !live.worker.execution) throw new Refusal('worker_busy');
          if (mode === 'follow_up') this.checkQueue(live);
          busy = mode;
        }
      },
    );
    if (receipt.state === 'outcome_unknown' && receipt.worker_id && !this.resolved(this.s.require(id), p.command_id)) this.uncertain(this.s.require(id), p.command_id);
    return receipt;
  }

  /** Steers the named running execution; delivered to pi's steering queue, after its current turn. */
  async steer(id: string, r: Steer): Promise<Receipt> {
    let live!: Live;
    const receipt = await this.s.receipts.run(
      r.command_id,
      'sessions.steer',
      { ...r, worker_id: id },
      async () => this.dispatchSteer(live, r.command_id, r.message),
      () => {
        live = this.s.require(id);
        this.s.binding(live, r);
        this.writable(live);
        this.ready(live);
        if (r.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_use_typed_methods');
        const execution = live.worker.execution;
        if (!execution || execution.execution_id !== r.execution_id) throw new Refusal('stale_execution');
        if (execution.state === 'settled' || live.worker.foreground !== 'running') throw new Refusal('no_running_execution');
      },
    );
    if (receipt.state === 'outcome_unknown' && receipt.worker_id && !this.resolved(this.s.require(id), r.command_id)) this.uncertain(this.s.require(id), r.command_id);
    return receipt;
  }

  private async dispatchSteer(live: Live, commandId: string, message: string): Promise<ReceiptPatch> {
    const executionId = live.worker.execution!.execution_id;
    const response = await this.s.receipts.dispatchThen(commandId, { worker_id: live.worker.worker_id, execution_id: executionId }, () =>
      live.host!.request({ type: 'steer', message }),
    );
    // A steer runs pi's input hooks and queues; only an explicit refusal before them proves no effect.
    if (!response.success && response.refused === 'before_input') throw new ProvenNoEffect(`pi_refused_steer: ${String(response.error).slice(0, 64)}`, 'host_refused_before_input_hooks');
    if (!response.success) throw new Error(`pi_steer_failed_after_dispatch: ${String(response.error ?? 'negative_reply').slice(0, 64)}`);
    const disposition = String(response.data?.disposition);
    if (disposition !== 'queued' && disposition !== 'handled') throw new Error('unexpected steer disposition');
    return { state: 'delivered', stage: 'forwarded', effect: 'observed', admission: 'accepted', disposition };
  }

  /** Queues a follow-up of the named execution; it dispatches after that execution settles, never under a fence. */
  followUp(id: string, f: FollowUp): Promise<Receipt> {
    let live!: Live;
    return this.s.receipts.run(
      f.command_id,
      'sessions.follow_up',
      { ...f, worker_id: id },
      async () => this.enqueued(live, 'sessions.follow_up', f),
      () => {
        live = this.s.require(id);
        this.s.binding(live, f);
        this.writable(live);
        this.ready(live);
        if (f.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_use_typed_methods');
        if (f.execution_id !== live.worker.execution?.execution_id) throw new Refusal('stale_execution');
        this.checkQueue(live);
      },
    );
  }

  private checkQueue(live: Live): void {
    if ((live.pending?.size ?? 0) >= QUEUE_CAP) throw new Refusal('queue_capacity');
  }

  private enqueued(live: Live, operation: Queued['operation'], request: Prompt | FollowUp): ReceiptPatch {
    (live.pending ??= new Map()).set(request.command_id, { operation, request });
    (live.worker.queued ??= []).push({ command_id: request.command_id, kind: 'follow_up', state: 'queued' });
    this.s.persist(live, 'queue.add');
    setImmediate(() => void this.flush(live));
    return { state: 'queued', stage: 'reserved', effect: 'no_effect', admission: 'queued', worker_id: live.worker.worker_id };
  }

  /** Drops every queued input (cancel, interrupt, a binding change, an abandon); their intents end `no_effect`. */
  dropQueued(live: Live, _reason: string): void {
    const active = (live.worker.queued ?? []).filter(q => ['queued', 'paused', 'recovered'].includes(q.state));
    const ids = new Set([...(live.pending?.keys() ?? []), ...active.map(q => q.command_id)]);
    for (const id of ids) {
      const r = this.s.receipts.all.get(id);
      if (r && ['queued', 'queue_ready', 'intent_ready', 'intent_recovered'].includes(r.state)) this.s.receipts.resolveIntent(id, 'abandon');
    }
    live.pending?.clear();
    for (const q of active) q.state = 'dropped';
  }

  /** Dispatches due queued input one at a time; every item rechecks fence, binding and readiness at dispatch. */
  async flush(live: Live): Promise<void> {
    const w = live.worker;
    if (w.fence || live.rebinding || live.nativeRebinding || live.faulted || w.status !== 'ready' || w.foreground !== 'idle') return;
    for (const [id, item] of live.pending ?? []) {
      if (w.fence || w.foreground !== 'idle') return;
      if (this.s.receipts.all.get(id)?.state !== 'queued') continue;
      live.pending!.delete(id);
      const q = w.queued?.find(x => x.command_id === id);
      try {
        this.s.binding(live, item.request);
        this.writable(live);
        // An automatic flush is never owner authorization: a crash here recovers the intent no_effect.
        this.s.receipts.readyQueued(id);
        const r = await this.prompt(w.worker_id, { ...item.request } as Prompt, item.operation);
        if (q) q.state = r.effect === 'no_effect' ? 'dropped' : 'dispatched';
      } catch (error) {
        const current = this.s.receipts.all.get(id);
        if (current && ['queued', 'queue_ready'].includes(current.state)) {
          this.s.receipts.update(id, { state: 'rejected', stage: 'refused', effect: 'no_effect', error: error instanceof Error ? error.message.slice(0, 256) : 'queued_input_refused' }, 'receipt.result');
        }
        if (q) q.state = 'dropped';
      }
      try {
        this.s.persist(live, 'queue.flush');
      } catch (error) {
        this.lifecycle.fault(live, error);
        return;
      }
    }
  }

  /**
   * Cancel and interrupt: drop queued input, then ask pi to clear its own queue and abort. Allowed under a fence
   * and never lifting it. The reply says what was requested and what was observed; stopping external effects of
   * running tools is never claimed.
   */
  control(id: string, b: Control, interrupt: boolean): Promise<Receipt> {
    let live!: Live;
    return this.s.receipts.run(
      b.command_id,
      interrupt ? 'executions.interrupt' : 'executions.cancel',
      { ...b, worker_id: id },
      async () => {
        this.s.receipts.dispatch(b.command_id, { worker_id: id, ...(live.worker.execution ? { execution_id: live.worker.execution.execution_id } : {}) });
        this.dropQueued(live, interrupt ? 'interrupt' : 'cancel');
        if (!live.host || live.exited || live.worker.status !== 'ready') {
          this.s.persist(live, 'control.done');
          return { state: 'delivered', stage: 'requested', effect: 'observed', result: { requested: true, disposition: 'unknown', profile: 'no_live_host' } };
        }
        await live.host.request({ type: 'clear_queue' }); // abort alone may continue pi-owned queued input
        const aborted = await live.host.request({ type: 'abort' });
        this.s.persist(live, 'control.done');
        const settled = live.worker.execution?.state === 'settled';
        return {
          state: aborted.success ? 'delivered' : 'outcome_unknown',
          stage: 'requested',
          effect: aborted.success ? 'observed' : 'unknown',
          result: { requested: true, disposition: settled ? 'settled' : 'unknown', external_effects_stopped: 'unproven' },
        };
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, b);
        if (b.execution_id && live.worker.execution?.execution_id !== b.execution_id) throw new Refusal('stale_execution');
      },
    );
  }
}
