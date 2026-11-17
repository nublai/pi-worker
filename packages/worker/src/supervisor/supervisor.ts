/**
 * The supervisor facade the B2 handlers call. Each domain lives in its own module over the shared state
 * (state.ts): lifecycle (create, stop, exit, recovery) and input (prompt, steer, follow-up queue, cancel,
 * interrupt) fence (latch, resolve_unknown) and
 * bindings (rebind, sessions.new, native moves).
 */
import { Refusal } from '../b2/errors.js';
import type { EventHub, Send, SubscribeOptions, Subscription } from '../events/hub.js';
import type { components } from '../generated/api.js';
import type { HistoryPage } from '../history/session-index.js';
import type { Journal } from '../journal/journal.js';
import type { Receipt, ReceiptStore } from '../receipts/receipts.js';
import { Bindings, type Rebind } from './binding.js';
import { Fence, type Resolve } from './fence.js';
import { Children, type Report } from './children.js';
import type { GrantStore } from '../grants/store.js';
import { Interactions, type Answer, type Interaction } from '../interactions/interactions.js';
import { Input } from './input.js';
import { Features, type Configure, type InventoryFactory } from './features.js';
import { SessionCommands, type Compact, type Invoke } from './session-commands.js';
import { Attachments, type StageRequest } from '../attachments/attachments.js';
import { Lifecycle } from './lifecycle.js';
import { activity } from './activity.js';
import { SupervisorState, type Binding, type Control, type Create, type FollowUp, type HostFactory, type Prompt, type Steer, type Worker, type ChildLaunch } from './state.js';

export type HistoryItem = components['schemas']['HistoryItem'];
/** items.read's cap on one entry's raw line (1 MiB, within the client's 2 MiB response limit). */
export const ITEM_MAX_BYTES = 1024 * 1024;

export interface SupervisorOptions {
  readonly journal: Journal;
  readonly receipts: ReceiptStore;
  readonly supervisorEpoch: string;
  readonly stateDir: string;
  readonly factory: HostFactory;
  /** The grant registry: a typed child's reports and children recheck the grants that created it and its parent. */
  readonly grants?: GrantStore;
  /** A short-lived pi process for `models.list` and `commands.list` by cwd (P1-14). */
  readonly inventory?: InventoryFactory;
}

export class Supervisor {
  readonly state: SupervisorState;
  readonly lifecycle: Lifecycle;
  readonly input: Input;
  readonly fence: Fence;
  readonly bindings: Bindings;
  readonly interactions: Interactions;
  readonly children: Children;
  readonly features: Features;
  readonly commands: SessionCommands;
  readonly attachments: Attachments;

  constructor(options: SupervisorOptions) {
    this.state = new SupervisorState(options.journal, options.receipts, options.supervisorEpoch, options.stateDir, options.factory);
    this.lifecycle = new Lifecycle(this.state);
    this.input = new Input(this.state, this.lifecycle);
    this.fence = new Fence(this.state, this.lifecycle, this.input);
    this.bindings = new Bindings(this.state, this.lifecycle, this.input, this.fence);
    this.interactions = new Interactions(options.journal, options.receipts, {
      changed: workerId => {
        const live = this.state.workers.get(workerId);
        if (!live) return;
        this.state.events.publish('interactions.changed', { worker_id: workerId, execution_id: live.worker.execution?.execution_id ?? null, data: { interactions: this.interactions.list(workerId) } });
        this.state.publishChanged(live);
      },
      // An uncertain answer or release fences the session durably before its receipt is returned (invariant 3).
      fence: (workerId, commandId) => {
        const live = this.state.require(workerId);
        if (this.fence.latch(live, commandId)) this.state.persist(live, 'fence.latch');
      },
    });
    this.state.interactions = this.interactions;
    if (options.grants) this.state.grants = options.grants;
    this.children = new Children(this.state, this.lifecycle, this.input, this.fence);
    this.state.childClaims = w => this.children.claims(w);
    this.features = new Features(this.state, this.lifecycle, this.input, this.fence);
    if (options.inventory) this.features.inventory = options.inventory;
    this.commands = new SessionCommands(this.state, this.input, this.fence);
    this.attachments = new Attachments(options.journal, options.receipts, options.stateDir);
    // Every journaled attachment record is a durable `attachment.updated` for its worker (P1-19).
    this.attachments.onRecord = (value, appended) =>
      this.state.events.publish('attachment.updated', { worker_id: value.worker_id, execution_id: null, data: { attachment: structuredClone(value) }, appended });
    this.input.attachments = this.attachments;
    activity(this.state, this.lifecycle);
  }

  /**
   * `attachments.stage`: the worker must be live at the epoch the caller names. Staging writes no session, so a fence
   * does not refuse it (the prompt that uses the attachment is refused instead).
   */
  stageAttachment(request: StageRequest, body: AsyncIterable<Uint8Array>): Promise<Receipt> {
    return this.attachments.stage(request, body, () => {
      const live = this.state.require(request.worker_id);
      if (live.worker.worker_epoch !== request.worker_epoch) throw new Refusal('stale_binding');
      if (!['starting', 'ready'].includes(live.worker.status) || live.faulted) throw new Refusal('worker_not_ready');
    });
  }

  compact(id: string, c: Compact): Promise<Receipt> {
    return this.commands.compact(id, c);
  }

  reload(id: string, b: Binding): Promise<Receipt> {
    return this.commands.reload(id, b);
  }

  invoke(id: string, v: Invoke): Promise<Receipt> {
    return this.commands.invoke(id, v);
  }

  configure(id: string, c: Configure): Promise<Receipt> {
    return this.features.configure(id, c);
  }

  get receipts(): ReceiptStore {
    return this.state.receipts;
  }

  /** Recovery after a restart, before the socket listens. Never adopts or relaunches a host; never replays. */
  async recover(): Promise<void> {
    // The owner's durable `keep` of a recovered intent survives restarts; any other intent_ready does not.
    const kept = (r: Receipt) => !!r.worker_id && (this.state.workers.get(r.worker_id)?.worker.resolutions ?? []).some(x => x.command_id === r.command_id && x.disposition === 'keep');
    this.state.receipts.recover(kept);
    // Staged bytes without a staged record, and unfinished uploads, are removed: no record, no attachment.
    this.attachments.sweep();
    // No resolver survives a restart: open interactions become `interrupted`, never re-opened.
    this.interactions.recover();
    await this.lifecycle.recover();
    // A child whose launch may have run and that left no durable result report fences its parent (invariant 4a).
    this.children.recover();
  }

  /**
   * One worker row, refreshed from its session file. A read failure faults the worker in memory only. A refresh that
   * changed a derived field (history marker, leaf) is published once as an in-memory `worker.updated`.
   */
  get(id: string): Worker {
    const live = this.state.require(id);
    this.lifecycle.guarded(live, () => this.state.refresh(live), true);
    this.state.publishChanged(live);
    return this.state.view(live);
  }

  get events(): EventHub {
    return this.state.events;
  }

  /**
   * Attaches one subscriber to the supervisor-wide stream at its synchronous barrier: the rows are read (refreshing
   * each worker, which may publish derived changes before the barrier), then the snapshot, then later events only.
   */
  subscribe(send: Send, options: SubscribeOptions = {}): Subscription {
    return this.state.events.subscribe(() => this.list(), send, options);
  }

  /** One history page of the worker's bound session, pinned at a watermark (the current leaf by default). */
  history(id: string, q: { watermark?: string; after?: string; limit?: number }): HistoryPage {
    const live = this.state.require(id);
    this.get(id);
    if (q.after !== undefined && q.watermark === undefined) throw new Refusal('after_requires_watermark', 'no_effect', undefined, {}, 400);
    const page = live.index.page(q.watermark === undefined ? null : { watermark: q.watermark, after: q.after ?? null }, q.limit ?? 50);
    // The cursor values are the caller's; the refusal names the problem, never the value.
    if ('error' in page) throw new Refusal('history_cursor_not_on_session_path', 'no_effect', undefined, {}, 400);
    return page;
  }

  /** One whole entry of the worker's bound session (items.read), up to ITEM_MAX_BYTES of its raw line. */
  item(id: string, entryId: string): HistoryItem {
    const live = this.state.require(id);
    this.get(id);
    const item = live.index.item(entryId, ITEM_MAX_BYTES);
    if (item === null) throw new Refusal('unknown_entry');
    if ('error' in item) throw new Refusal(item.error);
    return { entry: item.entry, bytes: item.bytes, evidence: 'pi_session_file' };
  }

  list(): Worker[] {
    return [...this.state.workers.keys()].map(id => this.get(id));
  }

  create(c: Create): Promise<Receipt> {
    return this.lifecycle.create(c);
  }

  stop(id: string, b: Binding): Promise<Receipt> {
    return this.lifecycle.stop(id, b);
  }

  prompt(id: string, p: Prompt): Promise<Receipt> {
    return this.input.prompt(id, p);
  }

  steer(id: string, r: Steer): Promise<Receipt> {
    return this.input.steer(id, r);
  }

  followUp(id: string, f: FollowUp): Promise<Receipt> {
    return this.input.followUp(id, f);
  }

  control(id: string, b: Control, interrupt: boolean): Promise<Receipt> {
    return this.input.control(id, b, interrupt);
  }

  /** Live interaction cards of a worker, with their payload (memory only). */
  interactionList(id: string): Interaction[] {
    this.state.require(id);
    return this.interactions.list(id);
  }

  interactionStatus(id: string, interactionId: string): Interaction {
    this.state.require(id);
    return this.interactions.status(id, interactionId);
  }

  /**
   * Answers an interaction if it is current. The worker must be live and writable (no fence, no move in flight);
   * `actor` is the bridge's opaque device reference and the answering grant, journaled with the outcome. A session
   * command in flight does not refuse it: an extension command may wait on its own dialog, and the answer is the only
   * way that command finishes. Each request to pi is one whole line on its stdin, so the two never interleave.
   */
  answer(id: string, a: Answer, actor: { caller?: string; grant_id?: string } = {}): Promise<Receipt> {
    const live = this.state.require(id);
    return this.interactions.answer(
      live.worker,
      a,
      () => {
        this.input.writable(live);
        if (live.faulted || !live.host || !['starting', 'ready'].includes(live.worker.status)) throw new Refusal('worker_not_ready');
      },
      actor,
    );
  }

  /** `children.launch`: an untyped child queued under the parent's running execution. */
  launchChild(id: string, request: ChildLaunch): Promise<Receipt> {
    return this.input.launchChild(id, request);
  }

  /** `children.report`: a child's claim, allowed under a fence; never proof. */
  report(id: string, r: Report): Promise<Receipt> {
    return this.children.report(id, r);
  }

  resolveUnknown(id: string, r: Resolve): Promise<Receipt> {
    return this.fence.resolve(id, r);
  }

  rebind(id: string, b: Rebind): Promise<Receipt> {
    return this.bindings.rebind(id, b);
  }

  newSession(id: string, b: Binding): Promise<Receipt> {
    return this.bindings.newSession(id, b);
  }

  /** A native move that never binds is reconciled from pi's state after this delay (15 s). */
  get nativeMoveTimeoutMs(): number {
    return this.bindings.nativeMoveTimeoutMs;
  }

  set nativeMoveTimeoutMs(ms: number) {
    this.bindings.nativeMoveTimeoutMs = ms;
  }

  shutdown(): Promise<void> {
    return this.lifecycle.shutdown();
  }
}
