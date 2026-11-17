/**
 * Receipts: the command flow and its recovery buckets. Ported from A0 `src/receipts.ts` (adapted from exmach
 * `receipts.ts` and `thread.ts` `mutate()`).
 *
 * Flow per command: validate and reserve result room (no record) → durable `intent` → durable dispatch marker
 * (`accepted`) → the write to pi → durable result → reply. Recovery: an intent never dispatched is
 * `intent_recovered` and `no_effect`; a dispatched command without a result is `outcome_unknown`. Nothing is ever
 * replayed automatically: a duplicate `command_id` returns the stored receipt, and a recovered intent may dispatch
 * once only after the owner resolved it `keep` (`intent_ready`).
 *
 * After the dispatch record, a failure is `outcome_unknown` unless the effect throws `ProvenNoEffect` with evidence
 * that nothing happened; a default `Refusal` after dispatch is not that proof (A0 Gate 1, D2).
 */
import { createHash } from 'node:crypto';
import type { components } from '../generated/api.js';
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import { fenceKey, type Journal } from '../journal/journal.js';
import type { DurableLabel } from '../journal/labels.js';
import { DEFAULT_RETENTION, goalFor, mayBeForgotten, planCompaction, readForgotten, type CompactionGoal, type ExpiredId, type ForgottenIds, type RetentionLimits } from '../journal/retention.js';
import { recheck } from '../grants/authority.js';
import type { JournalAppended } from '../generated/events.js';

export type Receipt = components['schemas']['Receipt'];
export type Operation = Receipt['operation'];
export type ReceiptPatch = Partial<Omit<Receipt, 'command_id' | 'operation' | 'request_hash' | 'evidence' | 'created_at'>>;

const FINAL = new Set<Receipt['state']>(['delivered', 'rejected', 'outcome_unknown']);
/**
 * Control and recovery never deadlock behind the ordinary count quota. The byte cap still applies, but they may use the
 * journal's control reserve, which ordinary commands may not.
 */
export const QUOTA_EXEMPT = new Set<Operation>(['workers.stop', 'executions.cancel', 'executions.interrupt', 'sessions.resolve_unknown', 'children.report', 'attachments.release']);

export const isFinal = (receipt: Receipt | undefined): boolean => receipt !== undefined && FINAL.has(receipt.state);

/** Room for a command's records before its final one (intent, dispatch marker, queue steps). */
const RECEIPT_STEP_BYTES = 2048;

/**
 * The room an ordinary command's other records need (supervisor/state.ts): the worker rows, settlement and
 * interaction records it can emit, reserved under `key` with its receipt, before dispatch; `control`, the room a
 * worker it creates needs for its own control records, which it must leave free; and `fence`, the row that fences its
 * session if its outcome becomes unknown, reserved under `fenceKey(command_id)` until that row is durable.
 */
export interface Budget {
  readonly key: string;
  readonly bytes: number;
  readonly control: number;
  readonly fence: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical idempotency hash of a request: key order and the transport `request_id` do not matter. */
export function requestHash(request: Record<string, unknown>): string {
  const { request_id: _requestId, ...operation } = request;
  return createHash('sha256').update(canonical(operation)).digest('hex');
}

export type Effect = (intent: Receipt) => Promise<ReceiptPatch>;

export class ReceiptStore {
  readonly all = new Map<string, Receipt>();
  /** Ids of receipts retention evicted: a reuse is refused `receipt_expired`, never run again. */
  readonly expired = new Map<string, ExpiredId>();
  /** What the expired ids that rolled over leave behind: an id that may be one of them is refused, never run. */
  forgotten: ForgottenIds | null = null;
  /** The fsynced append of each receipt's latest record in this process (a durable event's proof). */
  readonly appended = new Map<string, JournalAppended>();
  private inFlight = new Map<string, { hash: string; operation: Operation; promise: Promise<Receipt> }>();
  /** The retention bounds this store enforces (and `hello` advertises). */
  readonly limits: RetentionLimits;
  /** The clock for `created_at` and the retention age; tests move it. */
  now: () => number = Date.now;
  /** Called after each receipt record is fsynced (the supervisor publishes `receipt.updated`); never throws into the flow. */
  onRecord: (receipt: Receipt, appended: JournalAppended) => void = () => {};
  /** The budget an ordinary command reserves for its other records (set by the supervisor; none without one). */
  budget: (operation: Operation, request: Record<string, unknown>) => Budget | null = () => null;
  /** The journal size right after the last compaction, and the last attempt (to not rewrite for nothing). */
  private compactedBytes = 0;
  private attempted: { records: number; at: number } | null = null;

  constructor(
    readonly journal: Journal,
    readonly maxCount = DEFAULT_RETENTION.receipts,
    readonly maxResultBytes = 16 * 1024,
    retention: Partial<Omit<RetentionLimits, 'receipts' | 'journalBytes'>> = {},
  ) {
    this.limits = { ...DEFAULT_RETENTION, ...retention, receipts: maxCount, journalBytes: journal.maxBytes };
    journal.controlReserveBytes = this.limits.controlReserveBytes;
    this.load();
    this.compactedBytes = journal.isClosed ? 0 : journal.size();
    journal.onCompacted(() => this.load());
  }

  /** The receipt table and the expired ids, from the journal (each receipt's latest record, in first-appearance order). */
  private load(): void {
    this.all.clear();
    this.expired.clear();
    this.forgotten = null;
    for (const record of this.journal.records) {
      if (record.kind === 'receipt') {
        const receipt = record.value as Receipt;
        this.all.set(receipt.command_id, receipt);
      } else if (record.kind === 'receipt_expired') {
        // SAFETY: a `receipt_expired` record is written only by planCompaction from an ExpiredId (checksummed).
        const id = record.value as unknown as ExpiredId;
        this.expired.set(id.command_id, id);
      } else if (record.kind === 'forgotten_ids') this.forgotten = readForgotten(record.value);
    }
    for (const id of [...this.appended.keys()]) if (!this.all.has(id)) this.appended.delete(id);
  }

  /**
   * Compacts the journal (journal/retention.ts) when the receipt bound or the journal's compaction threshold is
   * reached: evicts the oldest evictable receipts toward three quarters of the bound and rewrites the journal to its
   * retained records. Skipped when nothing could change since the last attempt. A compaction that fails before its
   * rename leaves the journal as it was; the admission checks that follow then refuse if there is still no room.
   */
  private retain(need: number, headroom: number): void {
    const j = this.journal;
    if (j.isClosed) return; // The reservation that follows refuses.
    const size = j.size();
    const countDue = this.all.size >= this.maxCount;
    const roomDue = size + j.reservedBytes + need + headroom > j.maxBytes;
    const bytesDue = roomDue || size >= Math.max(j.maxBytes / 2, this.compactedBytes + j.maxBytes / 4);
    if (!countDue && !bytesDue) return;
    const now = this.now();
    if (this.attempted && this.attempted.records === j.records.length && now - this.attempted.at < 60_000) return;
    try {
      this.compact({ rewrite: bytesDue });
    } catch {
      // Only a failure after the rename reaches here: the journal is failed, and this command has written nothing.
      throw new Refusal('journal_failed', 'no_effect');
    }
  }

  /**
   * Plans a compaction toward `goal` (the retention goal by default) and rewrites the journal when it evicts anything
   * (or `rewrite`); returns the evicted ids.
   */
  compact(options: { rewrite?: boolean; goal?: CompactionGoal } = {}): string[] {
    const j = this.journal;
    const rewrite = options.rewrite ?? false;
    const plan = planCompaction(j.records, {
      limits: this.limits,
      goal: options.goal ?? goalFor(this.limits),
      now: this.now(),
      inFlight: new Set(this.inFlight.keys()),
    });
    this.attempted = { records: j.records.length, at: this.now() };
    if (plan.evicted.length === 0 && !rewrite) return [];
    try {
      j.compact(plan.entries);
    } catch (error) {
      if (j.failed) throw error;
      return [];
    }
    this.compactedBytes = j.size();
    this.attempted = { records: j.records.length, at: this.now() };
    return plan.evicted;
  }

  /** Appends a receipt record; a final record consumes the command's own reservation. */
  put(receipt: Receipt, label: DurableLabel): Receipt {
    const prior = this.all.get(receipt.command_id);
    if (isFinal(prior)) throw new Error('receipt is final');
    if (Buffer.byteLength(JSON.stringify(receipt)) > this.maxResultBytes) throw new Error('receipt exceeds reserved bound');
    const final = FINAL.has(receipt.state);
    // Every record of a command consumes its own reservation; a quota-exempt command's are control records, and so are
    // uncertainty, recovery and owner dispositions (their labels; labels.ts).
    const { appended } = this.journal.append('receipt', receipt, label, { budget: [receipt.command_id], ...(QUOTA_EXEMPT.has(receipt.operation) ? { control: true } : {}) });
    this.appended.set(receipt.command_id, appended);
    if (final) this.journal.release(receipt.command_id);
    this.all.set(receipt.command_id, receipt);
    this.onRecord(receipt, appended);
    return receipt;
  }

  update(commandId: string, patch: ReceiptPatch, label: DurableLabel): Receipt {
    const current = this.all.get(commandId);
    if (!current) throw new Error('receipt missing');
    return this.put({ ...current, ...patch }, label);
  }

  /**
   * After a restart: undispatched intents (and queued items, and `intent_ready` without an owner `keep`) become
   * `intent_recovered`/`no_effect`; dispatched commands without a result become `outcome_unknown`. Idempotent.
   * `ownerKept` says whether the owner's durable resolution kept a command (from the worker records).
   */
  recover(ownerKept: (receipt: Receipt) => boolean = () => false): void {
    for (const r of this.all.values()) {
      // Legacy automatic intent_ready records are not owner authorization either.
      if (r.state === 'intent' || r.state === 'queued' || r.state === 'queue_ready' || (r.state === 'intent_ready' && !ownerKept(r))) {
        this.update(
          r.command_id,
          { state: 'intent_recovered', stage: 'recovery_pending', effect: 'no_effect', error: 'restart before dispatch; eligible once after owner resolution, never auto-replayed' },
          'receipt.recover',
        );
      } else if (r.state === 'accepted') this.unknown(r.command_id, 'receipt.recover');
    }
  }

  /** An automatic queue flush: never owner authorization (recovers as `intent_recovered`). */
  readyQueued(commandId: string): Receipt {
    if (this.all.get(commandId)?.state !== 'queued') throw new Refusal('not_a_live_queued_intent');
    return this.update(commandId, { state: 'queue_ready', stage: 'reserved', effect: 'no_effect' }, 'receipt.queue_ready');
  }

  /** The owner's disposition of a recovered or queued intent: keep makes it dispatchable once; abandon ends it. */
  resolveIntent(commandId: string, disposition: 'keep' | 'abandon' | 'observed'): Receipt {
    const r = this.all.get(commandId);
    if (!r || !['intent_recovered', 'queued', 'queue_ready', 'intent_ready'].includes(r.state)) throw new Refusal('not_a_recovered_or_queued_intent');
    if (disposition === 'observed') throw new Refusal('undispatched_intent_has_no_execution_evidence');
    return this.update(
      commandId,
      disposition === 'keep'
        ? { state: 'intent_ready', stage: 'recovery_pending', effect: 'no_effect', error: 'owner resolved; exact request may dispatch once, never auto-replayed' }
        : { state: 'rejected', stage: 'refused', effect: 'no_effect', disposition: 'abandoned_without_dispatch' },
      'receipt.resolve_intent',
    );
  }

  /** A dispatched command whose result will never come: `outcome_unknown`. Other states are returned unchanged. */
  unknown(commandId: string, label: DurableLabel = 'receipt.unknown'): Receipt {
    const prior = this.all.get(commandId);
    if (!prior) throw new Error('receipt missing');
    return prior.state === 'accepted' ? this.update(commandId, { state: 'outcome_unknown', stage: 'unknown', effect: 'unknown' }, label) : prior;
  }

  /**
   * Runs a command once. `validate` runs first and its refusal leaves no record and uses no capacity. A duplicate
   * `command_id` with the same operation and request returns the stored (or in-flight) receipt; a different one is
   * `command_id_conflict`. Only `intent_ready` (owner kept) and `queue_ready` may run again, exactly once.
   */
  run(commandId: string, operation: Operation, request: Record<string, unknown>, effect: Effect, validate: () => void = () => {}): Promise<Receipt> {
    const hash = requestHash({ ...request, operation });
    const pending = this.inFlight.get(commandId);
    const prior = this.all.get(commandId);
    if (pending || prior) {
      if ((pending?.operation ?? prior!.operation) !== operation || (pending?.hash ?? prior!.request_hash) !== hash) throw new Refusal('command_id_conflict');
      if (pending || !['intent_ready', 'queue_ready'].includes(prior!.state)) return pending?.promise ?? Promise.resolve(prior!);
    }
    // An evicted receipt's command never runs again: its outcome is no longer readable, so it is unknown.
    const gone = pending || prior ? undefined : this.expired.get(commandId);
    if (gone) {
      if (gone.operation !== operation || gone.request_hash !== hash) throw new Refusal('command_id_conflict');
      throw new Refusal('receipt_expired', 'unknown', commandId, {}, 409);
    }
    // An id whose expired record rolled over is not proof of a fresh command (contract rule "no replay past
    // retention"): an id that may be one the worker forgot is refused before anything is written.
    if (!pending && !prior && mayBeForgotten(this.forgotten, commandId)) throw new Refusal('command_id_beyond_retention', 'no_effect', undefined, {}, 409);
    let extra: Budget | null = null;
    const result = Promise.resolve()
      .then(async () => {
        // Validation and reservation run atomically with the synchronous pre-dispatch part of effect().
        validate();
        if (this.journal.failed) throw new Refusal('journal_failed', 'no_effect');
        const exempt = QUOTA_EXEMPT.has(operation);
        // An ordinary command reserves room for every record it can emit (its receipts, and its worker's rows,
        // settlements and interactions) and leaves the journal's floor free: the control reserve and the room each
        // worker's own control records need, its new worker's included. A control command may use that room.
        extra = exempt ? null : this.budget(operation, request);
        const receiptBytes = this.maxResultBytes + 1024 + RECEIPT_STEP_BYTES;
        const headroom = exempt ? 0 : this.journal.floor() + (extra?.control ?? 0);
        this.retain(receiptBytes + (extra?.bytes ?? 0) + (extra?.fence ?? 0), headroom);
        const ordinary = [...this.all.values()].filter(r => !QUOTA_EXEMPT.has(r.operation)).length;
        if (!prior && !exempt && ordinary >= this.maxCount) throw new Refusal('receipt_capacity');
        // Its own receipts and the row that would fence its session are reserved for it alone: whatever control
        // traffic does meanwhile, an admitted command can always reach a terminal receipt and, if unknown, its fence.
        const wants = [
          { key: commandId, bytes: receiptBytes },
          ...(extra ? [{ key: extra.key, bytes: extra.bytes }] : []),
          ...(extra?.fence ? [{ key: fenceKey(commandId), bytes: extra.fence }] : []),
        ];
        if (!this.journal.reserveAll(wants, headroom)) throw new Refusal('journal_result_capacity');
        let intent: Receipt;
        try {
          intent = this.put(
            {
              command_id: commandId,
              operation,
              request_hash: hash,
              ...(typeof request.worker_id === 'string' ? { worker_id: request.worker_id } : {}),
              state: 'intent',
              stage: 'reserved',
              effect: 'no_effect',
              evidence: 'supervisor_journal_fsynced',
              created_at: prior?.created_at ?? new Date(this.now()).toISOString(),
            },
            'receipt.intent',
          );
        } catch (error) {
          this.journal.release(commandId);
          throw error;
        }
        try {
          // The caller's grant is rechecked at dispatch, after the intent and before any effect: a revocation since the
          // request arrived (or since a queued item was admitted) ends the command rejected `no_effect`.
          recheck();
          const patch = await effect(intent);
          const current = this.all.get(commandId)!;
          // An exit may have finalized an accepted command while the effect awaited.
          if (isFinal(current)) return current;
          return this.put({ ...current, ...patch }, 'receipt.result');
        } catch (error) {
          if (this.journal.failed) throw new Refusal('journal_failed_after_intent', 'unknown', commandId);
          const current = this.all.get(commandId)!;
          if (isFinal(current)) return current;
          // Before the dispatch record nothing ran. After it, only explicit proof (ProvenNoEffect) is no_effect; a
          // default Refusal is not that proof.
          const noEffect = current.state === 'intent' || error instanceof ProvenNoEffect;
          return this.update(
            commandId,
            {
              state: noEffect ? 'rejected' : 'outcome_unknown',
              stage: noEffect ? 'refused' : 'unknown',
              effect: noEffect ? 'no_effect' : 'unknown',
              ...(noEffect ? { admission: 'rejected' as const } : {}),
              ...(error instanceof Refusal && error.uncertain_command_id ? { uncertain_command_id: error.uncertain_command_id } : {}),
              error: error instanceof Error ? error.message.slice(0, 256) : 'unknown failure',
            },
            'receipt.result',
          );
        }
      })
      .finally(() => {
        this.inFlight.delete(commandId);
        // The fence row's room stays reserved for an unknown outcome until that row is durable (supervisor/state.ts).
        if (this.all.get(commandId)?.state !== 'outcome_unknown') this.journal.release(fenceKey(commandId));
        // A budget its command did not hand to a worker (a create that never made one) is released.
        if (extra?.key.startsWith('create:')) this.journal.release(extra.key);
      });
    this.inFlight.set(commandId, { hash, operation, promise: result });
    return result;
  }

  /** The durable dispatch marker. Only a fresh intent, an owner-kept intent or a queue-ready item may dispatch. */
  dispatch(commandId: string, patch: ReceiptPatch = {}): Receipt {
    if (!['intent', 'intent_ready', 'queue_ready'].includes(this.all.get(commandId)?.state ?? '')) {
      throw new Error('dispatch requires fresh intent; recovered intent needs owner resolution');
    }
    return this.update(commandId, { ...patch, state: 'accepted', stage: 'dispatch_recorded', effect: 'unknown' }, 'receipt.dispatch');
  }

  /**
   * Records the dispatch marker, then performs the write. The marker is durable before any byte reaches pi, so a
   * crash between them recovers `outcome_unknown`, never `no_effect` with an effect.
   */
  async dispatchThen<T>(commandId: string, patch: ReceiptPatch, write: () => Promise<T>): Promise<T> {
    this.dispatch(commandId, patch);
    return write();
  }
}
