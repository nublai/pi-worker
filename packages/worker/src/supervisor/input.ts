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
import type { PiRecord, PiResponse } from '../host/host.js';
import { authority, currentGuard } from '../grants/authority.js';
import type { Receipt, ReceiptPatch } from '../receipts/receipts.js';
import { budgetKey } from '../journal/journal.js';
import type { Lifecycle } from './lifecycle.js';
import type { ChildLaunch, Control, Create, FollowUp, Live, Prompt, Queued, Steer, SupervisorState } from './state.js';
import type { Attachments } from '../attachments/attachments.js';
import { ATTACHMENTS_PER_MESSAGE, ATTACHMENTS_TOTAL_BYTES } from '../b2/hello.js';

export const QUEUE_CAP = 32;

/** A prompt's staged images, checked (attachments.ts forPrompt). */
type Images = ReturnType<Attachments['forPrompt']>;

/**
 * A worker row's `recent_settlements` cap (P1-19). Every snapshot, `worker.updated` and journal row carries the list,
 * so it stays small (about 250 bytes an entry); executions settle one at a time, so eight covers a reconnect gap of
 * eight turns. A larger `settle_count` gap tells the caller to read the session history.
 */
export const RECENT_SETTLEMENTS = 8;

/**
 * Records the worker's execution as settled in its row (memory; the caller persists the row): newest first, one entry
 * per execution, at most RECENT_SETTLEMENTS. Returns the disposition `execution.settled` carries.
 */
export function recordSettlement(w: Live['worker'], disposition: string): string {
  const e = w.execution!;
  const list = w.recent_settlements ?? [];
  // A second settlement report for the same execution keeps the first entry.
  if (list.some(s => s.execution_id === e.execution_id)) return disposition;
  w.recent_settlements = [{ execution_id: e.execution_id, command_id: e.command_id, disposition, settled_at: new Date().toISOString() }, ...list].slice(0, RECENT_SETTLEMENTS);
  return disposition;
}

export class Input {
  /** Joins a command to the worker's fence (fence.ts); returns whether anything changed. In memory only. */
  latch: (live: Live, commandId: string) => boolean = () => false;
  /** Whether the owner already resolved this command (a resolved duplicate never relatches). */
  resolved: (live: Live, commandId: string) => boolean = () => false;
  /** Staged attachments a prompt may name (P1-16). */
  attachments?: Attachments;

  constructor(
    readonly s: SupervisorState,
    readonly lifecycle: Lifecycle,
  ) {
    lifecycle.observers.push((live, event) => this.observe(live, event));
    lifecycle.writable = live => this.writable(live);
    lifecycle.onUncertain = (live, commandId, label) => this.uncertain(live, commandId, label);
    lifecycle.recoverers.push(live => this.recover(live));
    lifecycle.firstPrompt = (live, c, created) => this.first(live, c, created);
  }

  /**
   * `workers.create` with `first_prompt` (FirstPrompt in the spec), once the new worker is ready: its first execution,
   * under the create's command id and receipt. A refusal at admission (the checks of `sessions.prompt`) records and
   * sends nothing: the receipt is the created worker plus `admission: rejected` and the typed refusal. Otherwise the
   * execution id joins the create's receipt, durably, before any byte of the prompt reaches pi. After that record a
   * failure fences the new session on the create, durably, then throws: the create ends `outcome_unknown`.
   */
  async first(live: Live, c: Create, created: ReceiptPatch): Promise<ReceiptPatch> {
    const first = c.first_prompt!;
    const id = live.worker.worker_id;
    const rejected = (error: Refusal): ReceiptPatch => ({ ...created, admission: 'rejected', error: error.message.slice(0, 256) });
    let images: Images = [];
    try {
      this.writable(live);
      this.ready(live);
      if (first.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_use_typed_methods');
      if (first.attachments?.length) {
        if (!this.attachments) throw new Refusal('attachments_unavailable');
        images = this.attachments.forPrompt(id, first.attachments.map(a => a.attachment_id), { count: ATTACHMENTS_PER_MESSAGE, bytes: ATTACHMENTS_TOTAL_BYTES });
      }
      if (live.command || live.worker.foreground !== 'idle') throw new Refusal('worker_busy');
    } catch (error) {
      if (error instanceof Refusal && error.effect === 'no_effect') return rejected(error);
      throw error;
    }
    try {
      const patch = await this.execute(live, c.command_id, first.message, images, (executionId, write) => {
        // The first prompt's dispatch record: the create's receipt names the execution (and the worker it made).
        this.s.receipts.update(c.command_id, { execution_id: executionId, ...(created.result ? { result: created.result } : {}) }, 'receipt.dispatch');
        return write();
      });
      if (images.length) this.attachments?.releaseNow(images.map(i => i.id), c.command_id);
      return { ...created, ...patch, result: { ...created.result, ...patch.result } };
    } catch (error) {
      // pi's explicit refusal before any input hook: nothing ran, the worker stays created and idle.
      if (error instanceof ProvenNoEffect) return rejected(error);
      // The prompt may have reached pi: its session is fenced before the receipt says so (invariant 3).
      if (this.s.receipts.all.get(c.command_id)?.execution_id && this.latch(live, c.command_id)) this.s.persist(live, 'execution.unknown');
      throw error;
    }
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
      recordSettlement(w, 'no_effect_before_dispatch');
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
        const appended = this.s.persist(live, 'execution.start');
        this.s.events.publish('execution.started', { worker_id: w.worker_id, execution_id: w.execution.execution_id, data: { command_id: w.execution.command_id }, appended });
      }
    }
    if (event.type === 'agent_settled') {
      w.foreground = w.fence ? 'unknown' : 'idle';
      live.observedIdle = true;
      // The phone's finished-unseen counter (contract 8.1): every settlement pi reports for this worker.
      w.settle_count = (w.settle_count ?? 0) + 1;
      const settled = w.execution;
      const disposition = settled ? recordSettlement(w, settled.disposition ?? 'agent_settled') : null;
      if (w.execution) {
        w.execution.state = 'settled'; // Observed in memory even if persistence fails.
        this.s.journal.append(
          'settlement',
          { worker_id: w.worker_id, session_id: w.session_id, execution_id: w.execution.execution_id, command_id: w.execution.command_id, source: 'pi.agent_settled' },
          'settlement.record',
          { budget: [budgetKey(w.worker_id)] },
        );
      }
      this.s.refresh(live);
      this.s.persist(live, 'execution.settle');
      if (settled) this.s.events.publish('execution.settled', { worker_id: w.worker_id, execution_id: settled.execution_id, data: { command_id: settled.command_id, disposition: disposition! } });
      setImmediate(() => void this.flush(live));
    }
  }

  async prompt(id: string, p: Prompt, operation: 'sessions.prompt' | 'sessions.follow_up' = 'sessions.prompt'): Promise<Receipt> {
    let live!: Live;
    let busy: 'steer' | 'follow_up' | undefined;
    let images: Images = [];
    const receipt = await this.s.receipts.run(
      p.command_id,
      operation,
      { ...p, worker_id: id },
      async () => {
        if (busy === 'follow_up') return this.enqueued(live, operation, p);
        if (busy === 'steer') return this.dispatchSteer(live, p.command_id, p.message);
        return this.execute(live, p.command_id, p.message, images, (executionId, write) => this.s.receipts.dispatchThen(p.command_id, { worker_id: id, execution_id: executionId }, write));
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, p);
        this.writable(live);
        this.ready(live);
        this.s.refresh(live);
        if (p.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_use_typed_methods');
        if (p.attachments?.length) {
          if (!this.attachments) throw new Refusal('attachments_unavailable');
          images = this.attachments.forPrompt(id, p.attachments.map(a => a.attachment_id), { count: ATTACHMENTS_PER_MESSAGE, bytes: ATTACHMENTS_TOTAL_BYTES });
        }
        // A session command or configure in flight occupies the worker: no second session write meanwhile.
        if (live.command) throw new Refusal('worker_busy');
        if (live.worker.foreground !== 'idle') {
          const mode = operation === 'sessions.follow_up' ? 'reject' : (p.if_busy ?? 'reject');
          if (mode === 'reject' || !live.worker.execution) throw new Refusal('worker_busy');
          // A steer joins the running turn as text only: images go with a new turn or a follow-up.
          if (mode === 'steer' && images.length) throw new Refusal('attachments_need_idle_or_follow_up');
          if (mode === 'follow_up') this.checkQueue(live);
          busy = mode;
        }
      },
    );
    if (receipt.state === 'outcome_unknown' && receipt.worker_id && !this.resolved(this.s.require(id), p.command_id)) this.uncertain(this.s.require(id), p.command_id);
    // A delivered prompt's images are in pi's session file now (blobs.read serves them): its staged copies go.
    if (receipt.state === 'delivered' && receipt.admission === 'accepted' && p.attachments?.length) {
      this.attachments?.releaseNow(p.attachments.map(a => a.attachment_id), p.command_id);
    }
    return receipt;
  }

  /**
   * One execution on an idle worker: the admitted row, the dispatch record (`dispatch` makes it durable, then `write`
   * sends the input to pi), and pi's reply. A reply proving nothing ran throws ProvenNoEffect; any other failure after
   * the dispatch record throws, and the command is `outcome_unknown`.
   */
  private async execute(
    live: Live,
    commandId: string,
    message: string,
    images: Images,
    dispatch: (executionId: string, write: () => Promise<PiResponse>) => Promise<PiResponse>,
  ): Promise<ReceiptPatch> {
    const w = live.worker;
    const id = w.worker_id;
    w.execution = { execution_id: randomUUID(), command_id: commandId, state: 'admitted' };
    w.foreground = 'running';
    live.observedIdle = false;
    const admitted = this.s.persist(live, 'execution.admit');
    this.s.events.publish('execution.admitted', { worker_id: id, execution_id: w.execution.execution_id, data: { command_id: commandId }, appended: admitted });
    const response = await dispatch(w.execution.execution_id, () =>
      // The command and execution ids go with the input: the child stamps them into pi's session file.
      live.host!.request({
        type: 'prompt',
        message,
        command_id: commandId,
        execution_id: w.execution!.execution_id,
        // Staged images by path and hash; the child reads and checks them and sends real image blocks.
        ...(images.length ? { images: images.map(i => ({ path: i.path, sha256: i.sha256, mime_type: i.mime_type, bytes: i.bytes })) } : {}),
      }),
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
      recordSettlement(w, disposition);
      w.foreground = w.fence ? 'unknown' : 'idle';
      live.observedIdle = true;
    }
    this.s.refresh(live);
    this.s.persist(live, 'execution.reply');
    if (disposition === 'handled') this.s.events.publish('execution.settled', { worker_id: id, execution_id: w.execution!.execution_id, data: { command_id: commandId, disposition } });
    const patch: ReceiptPatch = {
      state: 'delivered',
      stage: 'forwarded',
      effect: 'observed',
      admission: 'accepted',
      disposition,
      history_lag: w.history.lag,
      // The worker's interrupt marker (S-5): whether pi got it in front of this input; with attachments, the
      // number of images pi put in the message (pi may drop one it cannot convert).
      result: {
        interrupt_marker: response.data?.interrupt_marker === true,
        ...(images.length ? { accepted_images: typeof response.data?.accepted_images === 'number' ? response.data.accepted_images : null } : {}),
      },
    };
    return patch;
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

  /**
   * `children.launch`: an untyped child queued under the parent's named execution. Like a follow-up it pauses under
   * a fence and dispatches when the parent is idle; its dispatch record precedes the child's own create, and the
   * child's starting row carries the lineage before any spawn. A typed child goes through `workers.create`.
   */
  launchChild(id: string, request: ChildLaunch): Promise<Receipt> {
    let live!: Live;
    return this.s.receipts.run(
      request.command_id,
      'children.launch',
      { ...request, worker_id: id },
      async () => this.enqueued(live, 'children.launch', request),
      () => {
        live = this.s.require(id);
        this.s.binding(live, request);
        this.writable(live);
        if (live.worker.launch_spec || request.launch.parent || request.launch.launch_spec) throw new Refusal('typed_children_use_workers_create');
        // A child of this parent just ended and its missing-report check has not run: no replacement yet (4a).
        if (this.s.childEnding.has(id)) throw new Refusal('child_end_unsettled');
        this.ready(live);
        if (request.execution_id !== live.worker.execution?.execution_id) throw new Refusal('stale_execution');
        this.checkQueue(live);
      },
    );
  }

  private enqueued(live: Live, operation: Queued['operation'], request: Queued['request']): ReceiptPatch {
    const guard = currentGuard();
    (live.pending ??= new Map()).set(request.command_id, { operation, request, ...(guard ? { guard } : {}) });
    (live.worker.queued ??= []).push({ command_id: request.command_id, kind: operation === 'children.launch' ? 'child' : 'follow_up', state: 'queued' });
    this.s.persist(live, 'queue.add');
    setImmediate(() => void this.flush(live));
    return { state: 'queued', stage: 'reserved', effect: 'no_effect', admission: 'queued', worker_id: live.worker.worker_id };
  }

  /**
   * A due child launch: its dispatch record, then the child's own create (lineage in its starting row). The launch's
   * result is the child's create outcome; an unknown child launch fences the parent.
   */
  private async dispatchChild(live: Live, id: string, request: ChildLaunch): Promise<Receipt> {
    const parentId = live.worker.worker_id;
    this.s.receipts.dispatch(id, { worker_id: parentId });
    let child: Receipt;
    try {
      child = await this.lifecycle.create(request.launch, { parent_worker_id: parentId, parent_launch_command_id: id });
    } catch (error) {
      // A refusal of the child's own create (validation) happened before any of its records: nothing launched.
      if (error instanceof Refusal && error.effect === 'no_effect' && !this.s.receipts.all.has(request.launch.command_id)) {
        return this.s.receipts.update(id, { state: 'rejected', stage: 'refused', effect: 'no_effect', error: error.message.slice(0, 256) }, 'receipt.result');
      }
      child = this.s.receipts.unknown(id);
      this.lifecycle.fenceParent(parentId, id);
      return child;
    }
    const uncertain = child.effect === 'unknown' || child.state === 'outcome_unknown';
    const result = this.s.receipts.update(
      id,
      {
        state: uncertain ? 'outcome_unknown' : child.effect === 'no_effect' ? 'rejected' : 'delivered',
        stage: uncertain ? 'unknown' : 'forwarded',
        effect: uncertain ? 'unknown' : child.effect === 'no_effect' ? 'no_effect' : 'observed',
        result: { child_command_id: child.command_id, ...(child.worker_id ? { child_worker_id: child.worker_id } : {}) },
      },
      'receipt.result',
    );
    if (uncertain) this.lifecycle.fenceParent(parentId, id);
    return result;
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
    if (w.fence || live.rebinding || live.nativeRebinding || live.command || live.faulted || w.status !== 'ready' || w.foreground !== 'idle') return;
    for (const [id, item] of live.pending ?? []) {
      if (w.fence || w.foreground !== 'idle' || live.command) return;
      if (this.s.receipts.all.get(id)?.state !== 'queued') continue;
      live.pending!.delete(id);
      const q = w.queued?.find(x => x.command_id === id);
      try {
        this.s.binding(live, item.request);
        this.writable(live);
        // The grant that admitted it is rechecked before anything is written for this dispatch.
        item.guard?.();
        // An automatic flush is never owner authorization: a crash here recovers the intent no_effect.
        this.s.receipts.readyQueued(id);
        // The dispatch runs under the admitting grant, so the receipt flow rechecks it again at the dispatch point.
        const run = () => (item.operation === 'children.launch' ? this.dispatchChild(live, id, item.request as ChildLaunch) : this.prompt(w.worker_id, { ...item.request } as Prompt, item.operation));
        const r = await (item.guard ? authority.run(item.guard, run) : run());
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
        // Live dialogs are cancelled at their exact resolvers (Escape semantics), never answered.
        if (live.host && !live.exited) await this.s.interactions?.cancelAll(id, live.host);
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
