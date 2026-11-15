/** THROWAWAY. Adapted semantics: exmach b92773f receipts.ts and thread.ts mutate().
 * Reserve result capacity; durable intent -> dispatch marker -> result -> reply.
 * Unlike exmach, distinguish undispatched intent on recovery. No automatic replay.
 */
import { createHash } from 'node:crypto';
import { Journal } from './journal.js';
import { Refusal, type Receipt, type Worker } from './types.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function requestHash(request: Record<string, unknown>): string {
  const { request_id: _requestId, ...operation } = request;
  return createHash('sha256').update(canonical(operation)).digest('hex');
}
export class ReceiptStore {
  readonly all = new Map<string, Receipt>();
  private inFlight = new Map<string, { hash: string; operation: Receipt['operation']; promise: Promise<Receipt> }>();
  constructor(readonly journal: Journal, readonly maxCount = 512, readonly maxResultBytes = 16 * 1024) {
    for (const record of journal.records) if (record.kind === 'receipt') {
      const receipt = record.value as Receipt;
      this.all.set(receipt.command_id, receipt);
    }
  }
  put(receipt: Receipt): Receipt {
    const prior = this.all.get(receipt.command_id);
    if (prior && ['delivered', 'rejected', 'outcome_unknown'].includes(prior.state)) throw new Error('receipt is final');
    if (Buffer.byteLength(JSON.stringify(receipt)) > this.maxResultBytes) throw new Error('receipt exceeds reserved bound');
    this.journal.append('receipt', receipt);
    this.all.set(receipt.command_id, receipt);
    return receipt;
  }
  update(command_id: string, patch: Partial<Receipt>): Receipt {
    const current = this.all.get(command_id);
    if (!current) throw new Error('receipt missing');
    return this.put({ ...current, ...patch });
  }
  recover(): void {
    const workers = new Map<string, Worker>();
    for (const record of this.journal.records) if (record.kind === 'worker') {
      const worker = record.value.worker as Worker; workers.set(worker.worker_id, worker);
    }
    for (const r of this.all.values()) {
      // Legacy automatic intent_ready records are not owner authorization either.
      const ownerReady = r.worker_id && workers.get(r.worker_id)?.resolutions?.some(x => x.command_id === r.command_id && x.disposition === 'keep');
      if (r.state === 'intent' || r.state === 'queued' || r.state === 'queue_ready' || (r.state === 'intent_ready' && !ownerReady)) this.update(r.command_id, { state: 'intent_recovered', stage: 'recovery_pending', effect: 'no_effect', error: 'restart before dispatch; eligible once after owner resolution, never auto-replayed' });
      else if (r.state === 'accepted') this.unknown(r.command_id);
    }
  }
  readyQueued(id: string): Receipt {
    if (this.all.get(id)?.state !== 'queued') throw new Refusal('not_a_live_queued_intent');
    return this.update(id, { state: 'queue_ready', stage: 'reserved', effect: 'no_effect' });
  }
  resolveIntent(id: string, disposition: 'keep' | 'abandon' | 'observed'): Receipt {
    const r = this.all.get(id);
    if (!r || !['intent_recovered', 'queued', 'queue_ready', 'intent_ready'].includes(r.state)) throw new Refusal('not_a_recovered_or_queued_intent');
    if (disposition === 'observed') throw new Refusal('undispatched_intent_has_no_execution_evidence');
    return this.update(id, disposition === 'keep'
      ? { state: 'intent_ready', stage: 'recovery_pending', effect: 'no_effect', error: 'owner resolved; exact request may dispatch once, never auto-replayed' }
      : { state: 'rejected', stage: 'refused', effect: 'no_effect', disposition: 'abandoned_without_dispatch' });
  }
  unknown(id: string): Receipt {
    const prior = this.all.get(id);
    if (!prior) throw new Error('receipt missing');
    return prior.state === 'accepted' ? this.update(id, { state: 'outcome_unknown', stage: 'unknown', effect: 'unknown' }) : prior;
  }
  run(command_id: string, operation: Receipt['operation'], request: Record<string, unknown>, effect: (receipt: Receipt) => Promise<Partial<Receipt>>, validate: () => void = () => {}): Promise<Receipt> {
    const hash = requestHash({ ...request, operation });
    const pending = this.inFlight.get(command_id);
    const prior = this.all.get(command_id);
    if (pending || prior) {
      if ((pending?.operation ?? prior!.operation) !== operation || (pending?.hash ?? prior!.request_hash) !== hash) throw new Refusal('command_id_conflict');
      if (pending || !['intent_ready', 'queue_ready'].includes(prior!.state)) return pending?.promise ?? Promise.resolve(prior!);
    }
    const result = Promise.resolve().then(async () => {
      // Validate and reserve atomically with the synchronous pre-dispatch part of
      // effect(). Refusals here have no durable receipt and consume no capacity.
      validate();
      if (this.journal.failed) throw new Refusal('journal_failed', 'no_effect');
      const recoveryAndControl = new Set<Receipt['operation']>(['workers.stop', 'executions.cancel', 'executions.interrupt', 'sessions.resolve_unknown', 'children.report']);
      const ordinary = [...this.all.values()].filter(r => !recoveryAndControl.has(r.operation)).length;
      // Control/recovery never deadlock behind ordinary count quota. The byte cap still applies.
      if (!prior && !recoveryAndControl.has(operation) && ordinary >= this.maxCount) throw new Refusal('receipt_capacity');
      if (!this.journal.reserve(command_id, this.maxResultBytes + 1024)) throw new Refusal('journal_result_capacity');
      const intent = this.put({ command_id, operation, request_hash: hash, ...(typeof request.worker_id === 'string' ? { worker_id: request.worker_id } : {}), state: 'intent', stage: 'reserved', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: prior?.created_at ?? new Date().toISOString() });
      try {
        const patch = await effect(intent);
        const current = this.all.get(command_id)!;
        // Exit may have finalized an accepted command while request() awaited.
        if (['delivered', 'rejected', 'outcome_unknown'].includes(current.state)) return current;
        return this.put({ ...current, ...patch });
      } catch (error) {
        if (this.journal.failed) throw new Refusal('journal_failed_after_intent', 'unknown', command_id);
        const current = this.all.get(command_id)!;
        if (['delivered', 'rejected', 'outcome_unknown'].includes(current.state)) return current;
        const noEffect = (error instanceof Refusal && error.effect === 'no_effect') || current.state === 'intent';
        return this.update(command_id, { state: noEffect ? 'rejected' : 'outcome_unknown', stage: noEffect ? 'refused' : 'unknown', effect: noEffect ? 'no_effect' : 'unknown', ...(noEffect ? { admission: 'rejected' as const } : {}), ...(error instanceof Refusal && error.uncertain_command_id ? { uncertain_command_id: error.uncertain_command_id } : {}), error: error instanceof Error ? error.message.slice(0, 1024) : 'unknown failure' });
      }
    }).finally(() => { this.inFlight.delete(command_id); });
    this.inFlight.set(command_id, { hash, operation, promise: result });
    return result;
  }
  dispatch(command_id: string, patch: Partial<Receipt> = {}): Receipt {
    if (!['intent', 'intent_ready', 'queue_ready'].includes(this.all.get(command_id)?.state ?? '')) throw new Error('dispatch requires fresh intent; recovered intent needs owner resolution');
    return this.update(command_id, { ...patch, state: 'accepted', stage: 'dispatch_recorded', effect: 'unknown' });
  }
}
