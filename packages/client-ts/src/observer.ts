/**
 * The opt-in owned observer (P3-3, suite C3): one supervisor-wide event stream, reconnected from a snapshot after
 * every break, diffed against retained state so a consumer learns each missed interaction, settlement and child report
 * exactly once.
 *
 * Rules:
 * - It only reads: `events.subscribe` (a GET/SSE stream) and, past a settlement gap, `receipts.get` through
 *   `reconcile`. It never sends a mutation and never resends one.
 * - Controls are gated (`controls` false, `binding` undefined, every handle stale) from the moment a stream breaks
 *   (disconnect, overflow, a malformed frame, a refusal) until the next stream's snapshot passed its schema.
 * - A reconnect sends the last cursor as `Last-Event-ID`, and `resync=overflow` after an overflow until a stream that
 *   asked for it delivers its snapshot (an attempt that fails first keeps it owed). The worker never
 *   replays; whatever its `resync_reason` (fresh, current, gap, epoch, ahead, evicted, overflow) the snapshot is
 *   diffed against retained state.
 * - A cold start (no restored state) seeds silently from the first snapshot. Afterwards a missed interaction surfaces
 *   once by `interaction_id`, a settlement once by `execution_id` and a child report once by its report command id.
 *   The same snapshot twice surfaces nothing new. A worker missing from a snapshot is removed and one whose epoch,
 *   session or binding revision moved is rebound: handles taken before are no longer current.
 * - Snapshots carry at most eight `recent_settlements`. A `settle_count` gap larger than the list means settlements
 *   exist only in session history. `settle_count` counts only executions pi settled, while an input handled without a
 *   run is listed too, so a full list whose oldest entry the observer never saw may also have pushed one out unseen.
 *   Either way the observer surfaces `settlement_gap` and reconciles the consumer's pending commands absent from the
 *   list by their receipts. It never invents a settlement it did not see.
 * - Notices reach `deliver` in batches together with the state that already counts them as surfaced. A consumer
 *   persists both atomically with its outbox and passes the state back as `restored` after a process restart, which
 *   is then a diff, not a cold seed: what a crash kept from the outbox surfaces again, and nothing persisted is lost.
 *   A failed `deliver` stops the observer; the state it was given is never assumed persisted.
 * - Reconnects back off exponentially up to `maxMs`. Authorization failures and refusals stop at once, and so does a
 *   stream whose authority ended (a terminal `overflow`, `resync_required` false: a grant revoked, a parent channel
 *   retired), with `refused` and its code, never reconnecting; protocol failures (malformed frames, wrong media type,
 *   a stream not starting with a snapshot, an overflow included) stop after `maxProtocolFailures` consecutive streams;
 *   a socket that is missing or refuses connections stops as `unreachable` after `maxConnectFailures` consecutive
 *   attempts. Aborting `signal` closes the stream, clears the backoff timer and
 *   delivers nothing more, so the consumer's persisted state stays a prefix the next run diffs from.
 */
import { ClientFailure, ResyncRequired, streamRefused, type Client, type Cursor, type EventFrame } from './client.js';
import { reconcile, type Expected, type Reconciliation } from './reconcile.js';
import type { components } from './generated/api.js';

type Worker = components['schemas']['Worker'];
type Interaction = components['schemas']['Interaction'];
type Snapshot = Extract<EventFrame, { type: 'snapshot' }>;
export type ResyncReason = Snapshot['resync_reason'];

export const OBSERVER_STATE_VERSION = 1;

/** A worker's binding: what a control names. Stale once the worker is removed or rebound, or while gated. */
export interface Binding {
  worker_id: string;
  worker_epoch: string;
  session_id: string | null;
  binding_revision: number;
}

/** One worker in the persisted state: its binding, settle count and the identities already surfaced. */
export interface RetainedWorker {
  worker_epoch: string;
  session_id: string | null;
  binding_revision: number;
  settle_count: number;
  interactions: string[];
  settlements: string[];
  reports: string[];
}

/** The observer's semantic identities, plain JSON. Persist it with the outbox entries of the same batch. */
export interface ObserverState {
  version: typeof OBSERVER_STATE_VERSION;
  cursor: Cursor | null;
  workers: Record<string, RetainedWorker>;
}

export type NoticeSource = 'live' | 'snapshot';

export type Notice =
  | { kind: 'interaction'; worker_id: string; interaction_id: string; interaction: Interaction; source: NoticeSource }
  | { kind: 'settlement'; worker_id: string; execution_id: string; command_id: string; disposition: string; source: NoticeSource }
  /** A child's report reached its durable receipt: a wake-up to reread it, a claim, never proof. */
  | { kind: 'child_report'; worker_id: string; report_command_id: string; report_kind?: 'result' | 'help'; source: NoticeSource }
  | { kind: 'worker_added'; worker_id: string; binding: Binding }
  | { kind: 'worker_rebound'; worker_id: string; previous: Binding; binding: Binding }
  | { kind: 'worker_removed'; worker_id: string; previous: Binding }
  /**
   * Settlements may exist only in the session history (`history.page`); never synthesized as settlements.
   * `cause` `settle_count`: `missed` (the growth of `settle_count`, which counts executions pi settled) exceeds the
   * `listed` entries of `recent_settlements`, so some are certainly missing. `retention`: the list is full and its
   * oldest entry was never seen, so an entry may have been pushed out unseen (an input handled without a run is listed
   * but not counted); possibly nothing is missing.
   */
  | { kind: 'settlement_gap'; worker_id: string; cause: 'settle_count' | 'retention'; missed: number; listed: number; history: Worker['history'] }
  /** After a settlement gap: one receipt read (`reconcile`) of a pending command whose settlement was not seen. */
  | { kind: 'receipt'; worker_id: string; expected: Expected; reconciliation: Reconciliation };

export interface ObserverBatch {
  notices: Notice[];
  /** The state counting every notice of this batch (and all before it) as surfaced. */
  state: ObserverState;
  /** Present for the batch of a snapshot: why the worker sent it. */
  resync?: ResyncReason;
  /** True for the cold-start snapshot that seeded the state silently. */
  seeded?: boolean;
}

export type ObserverStop =
  | { reason: 'aborted' }
  /** The grant is unreadable or the worker refused it (HTTP 401/403). */
  | { reason: 'unauthorized'; error: Error }
  /**
   * The worker refused the subscription (another 4xx, 501), or ended an open stream because its authority ended (a
   * terminal `overflow`: `error` is a ClientFailure whose message is the refusal code, `grant_revoked`,
   * `parent_channel_retired`, ...). Never retried.
   */
  | { reason: 'refused'; error: Error }
  /** `maxConnectFailures` consecutive attempts found the socket missing or refusing connections. */
  | { reason: 'unreachable'; error: Error }
  /** `maxProtocolFailures` consecutive streams ended on a malformed frame or reply. */
  | { reason: 'protocol'; error: Error }
  /** `deliver` failed: the batch's state is not persisted, and nothing after it is delivered. */
  | { reason: 'delivery_failed'; error: Error };

/** What `Timers.set` returns and `Timers.clear` takes: Node's Timeout, or a test's own token. */
export type TimerHandle = object | number;

export interface Timers {
  set(callback: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export interface ObserverOptions {
  client: Client;
  signal: AbortSignal;
  /** Receives notices with the state to persist with them, in order; the next batch waits for it. */
  deliver: (batch: ObserverBatch) => void | Promise<void>;
  /** The last state a batch delivered and the consumer persisted. Absent: a cold start that seeds silently. */
  restored?: ObserverState;
  workerIds?: string[];
  /** The consumer's commands still awaiting their outcome (from its outbox), reconciled after a settlement gap. */
  pending?: () => readonly Expected[];
  onControls?: (enabled: boolean) => void;
  /**
   * `maxConnectFailures` (default 10, about a minute of backoff at the default delays): consecutive attempts whose
   * socket is missing or refuses connections before the observer stops as `unreachable`.
   */
  backoff?: { initialMs?: number; maxMs?: number; maxProtocolFailures?: number; maxConnectFailures?: number };
  /** Deliveries waiting for `deliver` before the stream is dropped and later resynced. Default 64. */
  maxPendingBatches?: number;
  timers?: Timers;
  random?: () => number;
}

export class ObserverStateInvalid extends Error {
  constructor(readonly at: string) {
    super(`restored observer state is invalid at ${at}`);
  }
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every(isId);

/**
 * Checks a state a consumer restored. A state it cannot trust throws ObserverStateInvalid (naming the field, never a
 * value) rather than becoming a cold start that would seed silently over pending outcomes.
 */
export function parseObserverState(value: unknown): ObserverState {
  const o = value as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new ObserverStateInvalid('state');
  if (o.version !== OBSERVER_STATE_VERSION) throw new ObserverStateInvalid('version');
  const cursor = o.cursor as Record<string, unknown> | null;
  if (cursor !== null && (typeof cursor !== 'object' || !isId(cursor.transport_epoch) || !isCount(cursor.seq))) throw new ObserverStateInvalid('cursor');
  const workers = o.workers as Record<string, Record<string, unknown>> | null;
  if (workers === null || typeof workers !== 'object' || Array.isArray(workers)) throw new ObserverStateInvalid('workers');
  for (const [id, w] of Object.entries(workers)) {
    const at = `workers[${Object.keys(workers).indexOf(id)}]`;
    if (!isId(id) || w === null || typeof w !== 'object') throw new ObserverStateInvalid(at);
    if (!isId(w.worker_epoch) || !(w.session_id === null || isId(w.session_id)) || !isCount(w.binding_revision) || !isCount(w.settle_count)) throw new ObserverStateInvalid(`${at}.binding`);
    if (!isIds(w.interactions) || !isIds(w.settlements) || !isIds(w.reports)) throw new ObserverStateInvalid(`${at}.identities`);
  }
  return structuredClone(value) as ObserverState;
}

const bindingOf = (id: string, w: Pick<RetainedWorker, 'worker_epoch' | 'session_id' | 'binding_revision'>): Binding => ({
  worker_id: id,
  worker_epoch: w.worker_epoch,
  session_id: w.session_id,
  binding_revision: w.binding_revision,
});
const sameBinding = (a: Pick<Binding, 'worker_epoch' | 'session_id' | 'binding_revision'>, b: Pick<Binding, 'worker_epoch' | 'session_id' | 'binding_revision'>) =>
  a.worker_epoch === b.worker_epoch && a.session_id === b.session_id && a.binding_revision === b.binding_revision;

/** Typed interactions only: a summary has no `interaction_id` yet and surfaces once it is admitted. */
function typedInteractions(list: readonly unknown[]): Interaction[] {
  return list.filter((i): i is Interaction => typeof (i as { interaction_id?: unknown }).interaction_id === 'string');
}

/** A stream end the observer recovers from by reconnecting, or a reason to stop. */
type Ending = { retry: 'transient' | 'protocol' | 'unreachable'; error?: Error } | { stop: Exclude<ObserverStop, { reason: 'aborted' }> };

/** Connect errors of a socket that is missing or refusing connections (the supervisor or channel is gone). */
const UNREACHABLE = new Set(['ENOENT', 'ECONNREFUSED']);

const PROTOCOL_REASONS = new Set(['invalid_frame', 'frame_too_large', 'invalid_content_type']);

/** A worker row's `recent_settlements` cap (B2 `Worker.recent_settlements` maxItems). */
const RECENT_SETTLEMENTS = 8;

/**
 * Why a snapshot row may hide settlements the observer never saw, or undefined when it provably does not. A list that is
 * not full evicted nothing; a full one is complete only when its oldest entry was already seen (everything settled
 * after it is listed, everything before it was seen earlier).
 */
function gapCause(row: Worker, prev: RetainedWorker | undefined): 'settle_count' | 'retention' | undefined {
  const listed = row.recent_settlements ?? [];
  if ((row.settle_count ?? 0) - (prev?.settle_count ?? 0) > listed.length) return 'settle_count';
  const oldest = listed.at(-1);
  if (listed.length >= RECENT_SETTLEMENTS && oldest && !prev?.settlements.includes(oldest.execution_id)) return 'retention';
  return undefined;
}

function classify(error: unknown): Ending {
  const e = error instanceof Error ? error : new Error('observer_failure');
  if (error instanceof ResyncRequired) {
    if (error.status !== undefined) {
      if (error.status === 401 || error.status === 403) return { stop: { reason: 'unauthorized', error: e } };
      if (error.status >= 500 && error.status !== 501) return { retry: 'transient' };
      return { stop: { reason: 'refused', error: e } };
    }
    return PROTOCOL_REASONS.has(error.reason) ? { retry: 'protocol' } : { retry: 'transient' };
  }
  if (error instanceof ClientFailure) {
    // A refusal the worker sent (here: an open stream whose authority ended, a terminal overflow) never gets better by
    // reconnecting; a new subscription would be refused with the same code, or find no socket.
    if (error.phase === 'http') return { stop: { reason: 'refused', error: e } };
    // The grant file is read before anything is sent; an unreadable or invalid one never gets better by retrying.
    return error.message.startsWith('grant_file_') ? { stop: { reason: 'unauthorized', error: e } } : { retry: 'transient' };
  }
  // A socket that is missing or refusing: the supervisor may be (re)starting, so retry, within maxConnectFailures.
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && UNREACHABLE.has(code)) return { retry: 'unreachable', error: new Error(code) };
  return { retry: 'transient' };
}

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Observer {
  private state: ObserverState | null;
  private gated = true;
  private overflowed = false;
  private chain: Promise<void> = Promise.resolve();
  private pendingBatches = 0;
  private deliveryError: Error | undefined;
  private stream: AbortController | undefined;
  private readonly rows = new Map<string, Worker>();
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly maxProtocolFailures: number;
  private readonly maxConnectFailures: number;
  private readonly maxPendingBatches: number;
  private readonly timers: Timers;
  private readonly random: () => number;

  constructor(private readonly options: ObserverOptions) {
    this.state = options.restored === undefined ? null : parseObserverState(options.restored);
    this.initialMs = options.backoff?.initialMs ?? 250;
    this.maxMs = options.backoff?.maxMs ?? 30_000;
    this.maxProtocolFailures = options.backoff?.maxProtocolFailures ?? 3;
    this.maxConnectFailures = options.backoff?.maxConnectFailures ?? 10;
    this.maxPendingBatches = options.maxPendingBatches ?? 64;
    this.timers = options.timers ?? defaultTimers;
    this.random = options.random ?? Math.random;
  }

  /** True only after a validated snapshot on the current stream. */
  get controls(): boolean {
    return !this.gated;
  }

  /** A worker's current binding, or undefined while gated or when the observer does not know the worker. */
  binding(workerId: string): Binding | undefined {
    const w = this.gated ? undefined : this.state?.workers[workerId];
    return w ? bindingOf(workerId, w) : undefined;
  }

  /** Whether a handle still names the worker's current binding (false while gated, after removal or a rebind). */
  isCurrent(handle: Binding): boolean {
    const w = this.gated ? undefined : this.state?.workers[handle.worker_id];
    return w !== undefined && sameBinding(w, handle);
  }

  /** The latest row of each worker this stream has seen (for display; never a control). */
  row(workerId: string): Worker | undefined {
    return this.rows.get(workerId);
  }

  /** Runs until `signal` aborts or a failure that retrying cannot fix. Never rejects. */
  async run(): Promise<ObserverStop> {
    const { client, signal } = this.options;
    let attempt = 0;
    let protocolFailures = 0;
    let connectFailures = 0;
    while (!signal.aborted) {
      const stream = new AbortController();
      this.stream = stream;
      const forward = () => stream.abort();
      signal.addEventListener('abort', forward, { once: true });
      let snapshot = false;
      let unordered = false;
      let ending: Ending | undefined;
      try {
        await client.watch(
          frame => {
            // Every attach starts with a snapshot; a stream that does not is not applied to retained state.
            if (!snapshot && frame.type !== 'snapshot') {
              unordered = true;
              return false;
            }
            snapshot = true;
            this.onFrame(frame);
          },
          { ...(this.options.workerIds ? { workerIds: this.options.workerIds } : {}), ...(this.state?.cursor ? { since: this.state.cursor } : {}), overflowResync: this.overflowed, signal: stream.signal },
        );
        // Resolved: aborted by the caller, dropped here because deliveries fell behind (resync next), or unordered.
        ending = { retry: unordered ? 'protocol' : 'transient' };
        // The overflow resync is owed until a stream that asked for it got its snapshot.
        if (snapshot) this.overflowed = false;
      } catch (error) {
        // A stream whose first frame is an overflow (the worker could not send a valid snapshot) is a protocol
        // failure like any stream without a snapshot, so a snapshot that stays invalid stops after the bound. A
        // terminal overflow first (the authority ended before the snapshot) still stops at once: it is a refusal.
        ending = unordered && streamRefused(error) === undefined ? { retry: 'protocol' } : classify(error);
        if (error instanceof ResyncRequired && error.reason === 'overflow') this.overflowed = true;
        else if (snapshot) this.overflowed = false;
      } finally {
        signal.removeEventListener('abort', forward);
        this.stream = undefined;
        this.setGated(true);
      }
      await this.chain;
      if (this.deliveryError) return { reason: 'delivery_failed', error: this.deliveryError };
      if (signal.aborted) break;
      if ('stop' in ending) return ending.stop;
      protocolFailures = ending.retry === 'protocol' ? protocolFailures + 1 : 0;
      if (protocolFailures >= this.maxProtocolFailures) return { reason: 'protocol', error: new Error('protocol_failures_exhausted') };
      connectFailures = ending.retry === 'unreachable' ? connectFailures + 1 : 0;
      if (connectFailures >= this.maxConnectFailures) return { reason: 'unreachable', error: ending.error ?? new Error('unreachable') };
      if (snapshot) attempt = 0;
      const ceiling = Math.min(this.maxMs, this.initialMs * 2 ** Math.min(attempt, 30));
      attempt++;
      await this.sleep(ceiling / 2 + (this.random() * ceiling) / 2);
    }
    await this.chain;
    if (this.deliveryError) return { reason: 'delivery_failed', error: this.deliveryError };
    return { reason: 'aborted' };
  }

  private sleep(ms: number): Promise<void> {
    const { signal } = this.options;
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      const done = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const handle = this.timers.set(done, ms);
      const onAbort = () => {
        this.timers.clear(handle);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private setGated(gated: boolean): void {
    if (this.gated === gated) return;
    this.gated = gated;
    this.options.onControls?.(!gated);
  }

  /** Queues one batch behind the earlier ones; drops the stream (a resync follows) when deliveries fall behind. */
  private enqueue(make: () => Promise<ObserverBatch>): void {
    this.pendingBatches++;
    if (this.pendingBatches > this.maxPendingBatches) this.stream?.abort();
    this.chain = this.chain.then(async () => {
      try {
        // After an abort nothing more is delivered: the consumer's persisted state stays a prefix, and the next run
        // diffs from it.
        if (this.deliveryError || this.options.signal.aborted) return;
        const batch = await make();
        if (this.options.signal.aborted) return;
        await this.options.deliver(batch);
      } catch (error) {
        this.deliveryError ??= error instanceof Error ? error : new Error('delivery_failed');
        this.stream?.abort();
      } finally {
        this.pendingBatches--;
      }
    });
  }

  private onFrame(frame: EventFrame): void {
    if (this.deliveryError) return;
    if (frame.type === 'snapshot') return this.onSnapshot(frame);
    const state = this.state;
    if (!state) return;
    state.cursor = frame.cursor;
    const notices: Notice[] = [];
    const id = 'worker_id' in frame ? frame.worker_id : undefined;
    const w = id === undefined ? undefined : state.workers[id];
    switch (frame.type) {
      case 'worker.updated':
        this.onRow(frame.data.worker, notices, 'live');
        break;
      case 'session.rebound':
        if (w && id) this.rebind(id, w, { worker_epoch: w.worker_epoch, session_id: frame.data.session_id, binding_revision: frame.data.binding_revision }, notices);
        break;
      case 'execution.settled':
        if (w && id) surface(w.settlements, frame.execution_id, () => notices.push({ kind: 'settlement', worker_id: id, execution_id: frame.execution_id, command_id: frame.data.command_id, disposition: frame.data.disposition, source: 'live' }));
        break;
      case 'interactions.changed':
        if (w && id) w.interactions = this.interactions(id, w.interactions, frame.data.interactions, notices, 'live');
        break;
      case 'child.reported':
        if (w && id) {
          const report_kind = frame.data.kind;
          surface(w.reports, frame.data.report_command_id, () =>
            notices.push({ kind: 'child_report', worker_id: id, report_command_id: frame.data.report_command_id, ...(report_kind ? { report_kind } : {}), source: 'live' }),
          );
        }
        break;
      default:
        break;
    }
    if (notices.length === 0) return;
    const persisted = structuredClone(state);
    this.enqueue(async () => ({ notices, state: persisted }));
  }

  /** The snapshot that ends a resync: seeds silently on a cold start, otherwise diffs against retained state. */
  private onSnapshot(frame: Snapshot): void {
    const cold = this.state === null;
    const before = this.state?.workers ?? {};
    const workers: Record<string, RetainedWorker> = {};
    const notices: Notice[] = [];
    const gaps: { row: Worker; cause: 'settle_count' | 'retention'; missed: number }[] = [];
    this.rows.clear();
    this.state = { version: OBSERVER_STATE_VERSION, cursor: frame.cursor, workers };
    for (const row of frame.workers) {
      const id = row.worker_id;
      const prev = before[id];
      this.rows.set(id, row);
      if (cold) {
        workers[id] = retain(row);
        continue;
      }
      const w = prev ? { ...structuredClone(prev) } : retain(row, true);
      workers[id] = w;
      if (!prev) notices.push({ kind: 'worker_added', worker_id: id, binding: bindingOf(id, w) });
      const cause = gapCause(row, prev);
      this.onRow(row, notices, 'snapshot');
      if (cause) gaps.push({ row, cause, missed: (row.settle_count ?? 0) - (prev?.settle_count ?? 0) });
    }
    if (!cold) for (const [id, prev] of Object.entries(before)) if (!workers[id]) notices.push({ kind: 'worker_removed', worker_id: id, previous: bindingOf(id, prev) });
    // Controls open only now: the snapshot passed its schema and the retained state is the snapshot's.
    this.setGated(false);
    const persisted = structuredClone(this.state);
    const pending = this.options.pending;
    const client = this.options.client;
    this.enqueue(async () => {
      for (const { row, cause, missed } of gaps) {
        const id = row.worker_id;
        const listed = row.recent_settlements ?? [];
        notices.push({ kind: 'settlement_gap', worker_id: id, cause, missed, listed: listed.length, history: row.history });
        // Each pending command of this worker whose settlement is not listed: read its receipt (P3-2), never resend.
        for (const expected of pending?.() ?? []) {
          if (this.options.signal.aborted) break;
          if (expected.worker_id !== id || listed.some(s => s.command_id === expected.command_id)) continue;
          notices.push({ kind: 'receipt', worker_id: id, expected, reconciliation: await reconcile(client, expected) });
        }
      }
      return { notices, state: persisted, resync: frame.resync_reason, ...(cold ? { seeded: true } : {}) };
    });
  }

  /** A full worker row (a snapshot's or `worker.updated`): binding, settle count and new identities. */
  private onRow(row: Worker, notices: Notice[], source: NoticeSource): void {
    const state = this.state!;
    const id = row.worker_id;
    this.rows.set(id, row);
    let w = state.workers[id];
    if (!w) {
      w = retain(row, true);
      state.workers[id] = w;
      notices.push({ kind: 'worker_added', worker_id: id, binding: bindingOf(id, w) });
    } else this.rebind(id, w, row, notices);
    w.settle_count = row.settle_count ?? w.settle_count;
    w.interactions = this.interactions(id, w.interactions, row.pending_interactions, notices, source);
    if (row.recent_settlements) {
      // Oldest first, so notices keep the order the executions settled in.
      for (const s of [...row.recent_settlements].reverse()) {
        surface(w.settlements, s.execution_id, () =>
          notices.push({ kind: 'settlement', worker_id: id, execution_id: s.execution_id, command_id: s.command_id, disposition: s.disposition, source }),
        );
      }
      // Bounded: an execution leaves the list only when newer ones push it out, and never comes back.
      w.settlements = row.recent_settlements.map(s => s.execution_id);
    }
    if (row.child_reports) {
      for (const r of row.child_reports) surface(w.reports, r.command_id, () => notices.push({ kind: 'child_report', worker_id: id, report_command_id: r.command_id, report_kind: r.kind, source }));
      w.reports = row.child_reports.map(r => r.command_id);
    }
  }

  /** Surfaces new typed interactions; returns the identities to retain (the list is the worker's whole live set). */
  private interactions(id: string, seen: string[], list: readonly unknown[], notices: Notice[], source: NoticeSource): string[] {
    const typed = typedInteractions(list);
    for (const i of typed) surface(seen, i.interaction_id, () => notices.push({ kind: 'interaction', worker_id: id, interaction_id: i.interaction_id, interaction: i, source }));
    // Summaries carry no id: keep what was seen until a typed list replaces it.
    return typed.length === list.length ? typed.map(i => i.interaction_id) : seen;
  }

  private rebind(id: string, w: RetainedWorker, next: Pick<Binding, 'worker_epoch' | 'session_id' | 'binding_revision'>, notices: Notice[]): void {
    if (sameBinding(w, next)) return;
    const previous = bindingOf(id, w);
    w.worker_epoch = next.worker_epoch;
    w.session_id = next.session_id;
    w.binding_revision = next.binding_revision;
    notices.push({ kind: 'worker_rebound', worker_id: id, previous, binding: bindingOf(id, w) });
  }
}

/** Calls `notify` once per identity: only when `seen` does not hold it yet, then records it. */
function surface(seen: string[], identity: string, notify: () => void): void {
  if (seen.includes(identity)) return;
  seen.push(identity);
  notify();
}

/**
 * A worker's retained entry. Seeded (`fresh` false): every identity it carries counts as surfaced. Fresh: nothing does
 * yet, so the caller's diff surfaces them.
 */
function retain(row: Worker, fresh = false): RetainedWorker {
  return {
    worker_epoch: row.worker_epoch,
    session_id: row.session_id,
    binding_revision: row.binding_revision,
    settle_count: fresh ? 0 : (row.settle_count ?? 0),
    interactions: fresh ? [] : typedInteractions(row.pending_interactions).map(i => i.interaction_id),
    settlements: fresh ? [] : (row.recent_settlements ?? []).map(s => s.execution_id),
    reports: fresh ? [] : (row.child_reports ?? []).map(r => r.command_id),
  };
}
