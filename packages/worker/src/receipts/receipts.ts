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
import type { Journal } from '../journal/journal.js';
import type { DurableLabel } from '../journal/labels.js';

export type Receipt = components['schemas']['Receipt'];
export type Operation = Receipt['operation'];
export type ReceiptPatch = Partial<Omit<Receipt, 'command_id' | 'operation' | 'request_hash' | 'evidence' | 'created_at'>>;

const FINAL = new Set<Receipt['state']>(['delivered', 'rejected', 'outcome_unknown']);
/** Control and recovery never deadlock behind the ordinary count quota (the byte cap still applies). */
export const QUOTA_EXEMPT = new Set<Operation>(['workers.stop', 'executions.cancel', 'executions.interrupt', 'sessions.resolve_unknown', 'children.report']);

export const isFinal = (receipt: Receipt | undefined): boolean => receipt !== undefined && FINAL.has(receipt.state);

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
  private inFlight = new Map<string, { hash: string; operation: Operation; promise: Promise<Receipt> }>();

  constructor(
    readonly journal: Journal,
    readonly maxCount = 512,
    readonly maxResultBytes = 16 * 1024,
  ) {
    for (const record of journal.records) {
      if (record.kind !== 'receipt') continue;
      const receipt = record.value as Receipt;
      this.all.set(receipt.command_id, receipt);
    }
  }

  /** Appends a receipt record; a final record consumes the command's own reservation. */
  put(receipt: Receipt, label: DurableLabel): Receipt {
    const prior = this.all.get(receipt.command_id);
    if (isFinal(prior)) throw new Error('receipt is final');
    if (Buffer.byteLength(JSON.stringify(receipt)) > this.maxResultBytes) throw new Error('receipt exceeds reserved bound');
    const final = FINAL.has(receipt.state);
    this.journal.append('receipt', receipt, label, final ? receipt.command_id : undefined);
    if (final) this.journal.release(receipt.command_id);
    this.all.set(receipt.command_id, receipt);
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
    const result = Promise.resolve()
      .then(async () => {
        // Validation and reservation run atomically with the synchronous pre-dispatch part of effect().
        validate();
        if (this.journal.failed) throw new Refusal('journal_failed', 'no_effect');
        const ordinary = [...this.all.values()].filter(r => !QUOTA_EXEMPT.has(r.operation)).length;
        if (!prior && !QUOTA_EXEMPT.has(operation) && ordinary >= this.maxCount) throw new Refusal('receipt_capacity');
        if (!this.journal.reserve(commandId, this.maxResultBytes + 1024)) throw new Refusal('journal_result_capacity');
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
              created_at: prior?.created_at ?? new Date().toISOString(),
            },
            'receipt.intent',
          );
        } catch (error) {
          this.journal.release(commandId);
          throw error;
        }
        try {
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
