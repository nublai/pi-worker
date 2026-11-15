/** THROWAWAY. Adapted semantics: exmach b92773f receipts.ts and thread.ts mutate().
 * Reserve result capacity; durable intent -> dispatch marker -> result -> reply.
 * Unlike exmach, distinguish undispatched intent on recovery. No automatic replay.
 */
import { createHash } from 'node:crypto';
import { Journal } from './journal.js';
import { Refusal, type Receipt } from './types.js';
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
  private inFlight = new Map<string, Promise<Receipt>>();
  constructor(readonly journal: Journal, readonly maxCount = 512, readonly maxResultBytes = 16 * 1024) {
    for (const record of journal.records) if (record.kind === 'receipt') {
      const receipt = record.value as Receipt;
      this.all.set(receipt.command_id, receipt);
    }
  }
  put(receipt: Receipt): Receipt {
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
    for (const r of this.all.values()) {
      if (r.state === 'intent') this.update(r.command_id, { state: 'rejected', stage: 'refused', effect: 'no_effect', error: 'restart before dispatch; owner must resolve, never auto-replayed' });
      else if (r.state === 'accepted') this.unknown(r.command_id);
    }
  }
  unknown(id: string): Receipt { return this.update(id, { state: 'outcome_unknown', stage: 'unknown', effect: 'unknown' }); }
  run(command_id: string, operation: Receipt['operation'], request: Record<string, unknown>, effect: (receipt: Receipt) => Promise<Partial<Receipt>>): Promise<Receipt> {
    const hash = requestHash({ ...request, operation });
    const prior = this.all.get(command_id);
    if (prior) {
      if (prior.operation !== operation || prior.request_hash !== hash) throw new Refusal('command_id_conflict');
      return this.inFlight.get(command_id) ?? Promise.resolve(prior);
    }
    if (this.journal.failed) throw new Refusal('journal_failed', 'unknown');
    if (this.all.size >= this.maxCount) throw new Refusal('receipt_capacity');
    // No unexpired eviction. Each command reserves the full bounded receipt allocation.
    if ((this.all.size + 1) * this.maxResultBytes > 8 * 1024 * 1024) throw new Refusal('receipt_bytes_capacity');
    const intent = this.put({ command_id, operation, request_hash: hash, state: 'intent', stage: 'reserved', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: new Date().toISOString() });
    const result = Promise.resolve().then(async () => {
      try {
        const patch = await effect(intent);
        return this.put({ ...this.all.get(command_id)!, ...patch });
      } catch (error) {
        if (this.journal.failed) throw new Refusal('journal_failed_after_intent', 'unknown', command_id);
        const noEffect = error instanceof Refusal && error.effect === 'no_effect';
        return this.update(command_id, { state: noEffect ? 'rejected' : 'outcome_unknown', stage: noEffect ? 'refused' : 'unknown', effect: noEffect ? 'no_effect' : 'unknown', admission: 'rejected', error: error instanceof Error ? error.message.slice(0, 1024) : 'unknown failure' });
      } finally { this.inFlight.delete(command_id); }
    });
    this.inFlight.set(command_id, result);
    return result;
  }
  dispatch(command_id: string, patch: Partial<Receipt> = {}): Receipt {
    return this.update(command_id, { ...patch, state: 'accepted', stage: 'dispatch_recorded', effect: 'unknown' });
  }
}
