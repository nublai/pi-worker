/** Live questions + durable metadata/outcomes. Payloads, answers AND answer hashes are
 * deliberately absent from journal/receipts/events. Restart never recreates resolvers. */
import { randomUUID } from 'node:crypto';
import { Journal } from './journal.js';
import { ReceiptStore } from './receipts.js';
import type { SessionHost, PiRecord } from './host.js';
import { Refusal, type Worker, type Receipt } from './types.js';
import type { DialogKind, UIAnswer } from './resolvers.js';
export type AnswerGuard = (() => void) & { actor?: string; grant_id?: string; grant_state_dir?: string };
export type Answer = { command_id: string; answer_id: string; worker_epoch: string; session_id: string; binding_revision: number; interaction_id: string; revision: number; kind: DialogKind } & UIAnswer;
export type Interaction = { interaction_id: string; native_id: string; worker_id: string; worker_epoch: string; session_id: string | null; binding_revision: number; revision: number; kind: DialogKind; source: 'pi.extension_ui' | 'pi.tool_gate'; evidence: 'supervisor_journal_fsynced'; deadline: number; status: string; answer_id?: string; answer_command_id?: string; actor?: string; grant_id?: string; answer_stage?: number; outcome?: string; resolver_outcome?: string; approval?: Record<string, unknown>; release_command_id?: string };
type Live = { record: Interaction; payload: Record<string, unknown>; options?: string[]; timer?: NodeJS.Timeout; guard?: AnswerGuard; host: SessionHost; worker: Worker };
export class Interactions {
  readonly records = new Map<string, Interaction>();
  private live = new Map<string, Live>();
  // Comparison in memory only. An answer_id has no value hash in durable storage.
  private answers = new Map<string, { command: string; signature: string }>();
  private attempts = new Map<string, string>();
  constructor(readonly journal: Journal, readonly receipts: ReceiptStore, readonly changed: (workerId: string) => void, readonly fence: (workerId: string, commandId: string) => void, readonly now = Date.now) {
    for (const r of journal.records) if (r.kind === 'interaction') { const i = structuredClone(r.value) as Interaction; this.records.set(i.interaction_id, i); }
  }
  recover(): void {
    for (const r of this.records.values()) if ((['pending', 'accepted'].includes(r.status) || (r.kind === 'tool_approval' && ['forwarded', 'consumed'].includes(r.status)))) { r.status = 'interrupted'; this.save(r); }
  }
  private save(r: Interaction): void { this.journal.append('interaction', r); this.records.set(r.interaction_id, r); }
  private notify(l: Live): void { this.changed(l.record.worker_id); }
  list(workerId: string): (Interaction & Record<string, unknown>)[] {
    return [...this.live.values()].filter(l => l.record.worker_id === workerId && l.record.status === 'pending').map(l => ({ ...structuredClone(l.record), ...structuredClone(l.payload), payload_evidence: 'observed_memory' }));
  }
  status(workerId: string, id: string): Interaction {
    const r = this.records.get(id); if (!r || r.worker_id !== workerId) throw new Refusal('unknown_interaction'); return structuredClone(r);
  }
  open(worker: Worker, host: SessionHost, event: PiRecord): void {
    if ([...this.live.values()].filter(l => l.record.worker_id === worker.worker_id).length >= 32) throw new Error('interaction_capacity');
    if ([...this.live.values()].some(l => l.record.worker_id === worker.worker_id && l.record.native_id === event.id)) throw new Error('duplicate_native_interaction');
    const deadline = typeof event.deadline === 'number' ? event.deadline : this.now() + (typeof event.timeout === 'number' && event.timeout > 0 ? Math.min(event.timeout, 30000) : 30000);
    const kind = String(event.method) as DialogKind;
    const record: Interaction = { interaction_id: randomUUID(), native_id: String(event.id), worker_id: worker.worker_id, worker_epoch: worker.worker_epoch, session_id: worker.session_id, binding_revision: worker.binding_revision, revision: 1, kind, source: kind === 'tool_approval' ? 'pi.tool_gate' : 'pi.extension_ui', evidence: 'supervisor_journal_fsynced', deadline, status: 'pending', ...(kind === 'tool_approval' ? { approval: event.approval as Record<string, unknown> } : {}) };
    const options = kind === 'select' ? event.options as string[] : undefined;
    const payload = Object.fromEntries(['title', 'message', 'placeholder', 'prefill'].filter(k => event[k] !== undefined).map(k => [k, event[k]]));
    if (options) payload.options = options.map((label, i) => ({ option_id: String(i), label }));
    const l: Live = { record, payload, options, host, worker }; this.live.set(record.interaction_id, l);
    this.save(record); this.notify(l);
    l.timer = setTimeout(() => { try { this.close(l, 'timeout', true); } catch { try { this.fence(worker.worker_id, 'interaction-timeout-' + record.interaction_id); } catch { /* Storage failure cannot throw from a timer. */ } } }, Math.max(1, deadline - this.now())); l.timer.unref();
  }
  summaries(workerId: string): Interaction[] { return [...this.live.values()].filter(l => l.record.worker_id === workerId && l.record.status === 'pending').map(l => structuredClone(l.record)); }
  private close(l: Live, reason: string, cancel = false): void {
    if (l.record.status !== 'pending') return;
    l.record.status = reason; l.record.outcome = reason; clearTimeout(l.timer); this.save(l.record); this.live.delete(l.record.interaction_id); this.notify(l);
    if (cancel) {
      // Write-ahead cancellation marker. No consumption claim is made from a flush.
      this.journal.append('interaction_effect', { interaction_id: l.record.interaction_id, worker_id: l.record.worker_id, operation: 'cancel', reason });
      void l.host.cancelUI(l.record.native_id).catch(() => { try { this.fence(l.record.worker_id, 'interaction-cancel-' + l.record.interaction_id); } catch { /* Storage may already be closed; no durable claim. */ } });
    }
  }
  invalidate(workerId: string, reason: string): void {
    for (const l of this.live.values()) if (l.record.worker_id === workerId) {
      if (l.record.status === 'pending') this.close(l, reason);
      else { l.record.status = reason; clearTimeout(l.timer); this.save(l.record); this.live.delete(l.record.interaction_id); this.notify(l); }
    }
  }
  async cancelAll(workerId: string, host: SessionHost, legacy: { native_id: string }[]): Promise<void> {
    // Pending summaries deliberately omit accepted answers and consumed approvals.
    // Those still own native resolvers/gates and must be cancelled before a move.
    const ids = new Set([...legacy.map(r => r.native_id), ...[...this.live.values()].filter(l => l.record.worker_id === workerId).map(l => l.record.native_id)]);
    this.invalidate(workerId, 'interrupted');
    for (const id of ids) await host.cancelUI(id);
  }
  resolverClosed(workerId: string, nativeId: string, outcome: string): void {
    const l = [...this.live.values()].find(l => l.record.worker_id === workerId && l.record.native_id === nativeId);
    if (!l) return;
    if (l.record.status === 'pending') this.close(l, outcome);
    else l.record.resolver_outcome = outcome;
  }
  async answer(worker: Worker, a: Answer, guard: AnswerGuard, writable: () => void): Promise<Receipt> {
    const known = this.answers.get(a.answer_id);
    const signature = JSON.stringify({ outcome: a.outcome, value: a.value, option_id: a.option_id });
    if (known && known.signature !== signature) throw new Refusal('answer_id_conflict');
    const attempting = this.attempts.get(a.command_id);
    if (attempting !== undefined && attempting !== signature) throw new Refusal('answer_id_conflict');
    const recorded = [...this.records.values()].find(r => r.answer_id === a.answer_id);
    if (recorded) {
      if (recorded.interaction_id !== a.interaction_id || recorded.worker_id !== worker.worker_id || recorded.worker_epoch !== a.worker_epoch || recorded.session_id !== a.session_id || recorded.binding_revision !== a.binding_revision || recorded.revision !== a.revision || recorded.kind !== a.kind) throw new Refusal('answer_id_conflict');
      const prior = recorded.answer_command_id && this.receipts.all.get(recorded.answer_command_id);
      if (prior && !this.attempts.has(recorded.answer_command_id!)) return structuredClone(prior);
    }
    // All comparisons involving answer content are live-only. Metadata hash never includes it.
    const { value: _value, option_id: _option, outcome: _outcome, ...metadata } = a;
    let l: Live;
    this.attempts.set(a.command_id, signature);
    let result: Receipt;
    try { result = await this.receipts.run(a.command_id, 'interactions.answer_if_current', { ...metadata, worker_id: worker.worker_id }, async () => {
      guard(); writable();
      l.record.status = 'accepted'; l.record.answer_id = a.answer_id; l.record.answer_command_id = a.command_id; l.record.answer_stage = 1;
      this.answers.set(a.answer_id, { command: a.command_id, signature }); l.guard = guard;
      l.record.actor = guard.actor; l.record.grant_id = guard.grant_id;
      clearTimeout(l.timer); this.save(l.record); this.notify(l);
      this.receipts.update(a.command_id, { stage: 'answer_accepted', answer_stage: 1 });
      guard(); writable();
      if (this.now() >= l.record.deadline) throw new Refusal('interaction_deadline_passed');
      this.receipts.dispatch(a.command_id, { answer_stage: 1 });
      if (!l.host.answerUI) throw new Error('host_answer_unsupported');
      const fenceGeneration = worker.fence_generation ?? 0;
      const response = await l.host.answerUI(l.record.native_id, a, l.options);
      let current = worker.worker_epoch === a.worker_epoch && worker.session_id === a.session_id && worker.binding_revision === a.binding_revision && (worker.fence_generation ?? 0) === fenceGeneration && this.live.get(a.interaction_id) === l;
      try { writable(); } catch { current = false; } // Includes an in-progress rebind/fence.
      if (!current) {
        l.record.status = 'interrupted'; l.record.outcome = 'binding_changed'; this.save(l.record);
        this.live.delete(a.interaction_id); this.notify(l);
        // A negative exact-resolver ack proves no effect. Consumed (or RPC's
        // unproven forwarding) cannot become either no_effect or stale stage 3.
        throw new Refusal('answer_binding_changed', response.stage === 3 && response.consumed === false ? 'no_effect' : 'unknown');
      }
      if (response.stage === 3 && !response.consumed) {
        l.record.status = 'resolver_refused'; l.record.answer_stage = 2; l.record.outcome = response.outcome; this.save(l.record); this.notify(l);
        return { state: 'delivered', stage: 'forwarded', answer_stage: 2, effect: 'observed', result: { interaction_id: a.interaction_id, answer_id: a.answer_id, resolver_consumed: false, outcome: response.outcome } };
      }
      l.record.status = response.stage === 3 ? 'consumed' : 'forwarded'; l.record.answer_stage = response.stage;
      l.record.outcome = a.outcome === 'cancel' ? 'cancel' : a.value === false ? 'no' : 'answered';
      this.save(l.record); this.notify(l);
      if (l.record.kind !== 'tool_approval') this.live.delete(a.interaction_id);
      return { state: 'delivered', stage: response.stage === 3 ? 'resolver_consumed' : 'forwarded', answer_stage: response.stage, effect: 'observed', result: { interaction_id: a.interaction_id, answer_id: a.answer_id, outcome: l.record.outcome, resolver_consumed: response.stage === 3 ? true : 'unproven' } };
    }, () => {
      writable(); guard();
      if (worker.worker_epoch !== a.worker_epoch || worker.session_id !== a.session_id || worker.binding_revision !== a.binding_revision) throw new Refusal('stale_binding');
      const candidate = this.live.get(a.interaction_id); if (!candidate || candidate.record.worker_id !== worker.worker_id) throw new Refusal('interaction_not_pending'); l = candidate;
      const r = l.record;
      if (r.status !== 'pending') throw new Refusal('interaction_already_answered');
      if (r.worker_epoch !== a.worker_epoch || r.session_id !== a.session_id || r.binding_revision !== a.binding_revision || r.revision !== a.revision) throw new Refusal('stale_interaction');
      if (r.kind !== a.kind) throw new Refusal('wrong_interaction_kind');
      if (this.now() >= r.deadline) throw new Refusal('interaction_deadline_passed');
      if (a.outcome !== 'answer' && a.outcome !== 'cancel') throw new Refusal('invalid_outcome');
      if (a.outcome === 'cancel') { if (a.value !== undefined || a.option_id !== undefined) throw new Refusal('cancel_has_value'); return; }
      if (a.kind === 'select') {
        if (!/^\d+$/.test(a.option_id ?? '') || String(Number(a.option_id)) !== a.option_id || !l.options || !Number.isSafeInteger(Number(a.option_id)) || Number(a.option_id) >= l.options.length || a.value !== undefined) throw new Refusal('invalid_option');
      } else if (a.kind === 'confirm' || a.kind === 'tool_approval') {
        if (typeof a.value !== 'boolean' || a.option_id !== undefined) throw new Refusal('invalid_boolean');
      } else if (typeof a.value !== 'string' || Buffer.byteLength(a.value) > 65536 || a.option_id !== undefined) throw new Refusal('invalid_text');
    }); } finally { this.attempts.delete(a.command_id); }
    if (result.state === 'outcome_unknown') this.fence(worker.worker_id, a.command_id);
    return result;
  }
  async gate(worker: Worker, event: PiRecord, writable: () => void): Promise<void> {
    const l = [...this.live.values()].find(l => l.record.worker_id === worker.worker_id && l.record.approval?.gate_token === event.gate_token);
    if (!l) {
      // A queued gate_check may arrive after rebind cancelled its live owner.
      // The child has already denied the gate; do not turn this into a fault.
      const cancelled = [...this.records.values()].some(r => r.worker_id === worker.worker_id && r.kind === 'tool_approval' && r.approval?.gate_token === event.gate_token && r.status === 'interrupted');
      if (cancelled) return;
      throw new Error('unknown_gate');
    }
    if (l.record.kind !== 'tool_approval' || !l.guard) throw new Error('unknown_gate');
    const command_id = l.record.answer_id! + ':release';
    const r = await this.receipts.run(command_id, 'interactions.release', { command_id, worker_id: worker.worker_id, interaction_id: l.record.interaction_id }, async () => {
      let allowed = true;
      try {
        writable(); l.guard!();
        if (l.record.status !== 'consumed' || l.record.outcome !== 'answered' || l.record.binding_revision !== worker.binding_revision || l.record.worker_epoch !== worker.worker_epoch || l.record.session_id !== worker.session_id) throw new Refusal('approval_not_current');
        const b = l.record.approval!;
        if (['digest', 'policy_revision', 'expiry', 'operation', 'resource', 'environment', 'offered_scope'].some(k => b[k] !== event[k]) || this.now() >= Number(b.expiry)) throw new Refusal('approval_binding_invalid');
      } catch { allowed = false; }
      this.receipts.dispatch(command_id, { worker_id: worker.worker_id });
      const reply = await l.host.request({ type: 'gate_release', gate_token: event.gate_token, digest: event.digest, allowed, release_grant: l.guard?.grant_state_dir && l.guard?.grant_id && l.guard?.actor ? { state_dir: l.guard.grant_state_dir, grant_id: l.guard.grant_id, actor: l.guard.actor, worker_id: worker.worker_id, cwd: worker.cwd } : undefined });
      // The child revalidates policy/artifact/expiry too; a successful transport
      // response is never enough to claim release without released===true.
      const released = reply.success && reply.data?.released === true;
      l.record.status = released ? 'tool_released' : 'release_denied'; l.record.answer_stage = released ? 4 : l.record.answer_stage; l.record.release_command_id = command_id;
      this.save(l.record); this.live.delete(l.record.interaction_id); this.notify(l);
      return { state: 'delivered', stage: released ? 'tool_released' : 'refused', answer_stage: released ? 4 : 3, effect: 'observed', result: { released, interaction_id: l.record.interaction_id } };
    });
    if (r.state === 'outcome_unknown') this.fence(worker.worker_id, command_id);
  }
}
