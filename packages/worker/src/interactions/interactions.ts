/**
 * Interactions: live questions and approvals, their durable metadata and outcomes. Ported from A0
 * `src/interactions.ts` onto the SDK host's correlated `answer_ui` / `gate_release` requests.
 *
 * - Four dialog kinds plus `tool_approval`, offered option ids (`"0"`, `"1"`, … for select), an absolute deadline.
 * - Answer stages are never collapsed: 1 accepted by the worker (durable before dispatch), 2 forwarded, 3 consumed by
 *   the exact resolver (the child's compare-and-delete acknowledged it), 4 tool released by its gate. Nothing here
 *   proves 5 (the tool's effect).
 * - First valid answer wins; a second is refused `interaction_already_answered`. A duplicate `answer_id` returns the
 *   recorded outcome without redispatch, and after a restart without revalidating the value.
 * - Privacy: payloads (title, message, prefill, options) and answer values live in memory only. Journal records,
 *   receipts and events carry ids, kind, stage and outcome, never the answer text or a hash of it; the receipt's
 *   request hash covers the answer's metadata only.
 * - Only the native resolver lifecycle (`resolver_closed`) closes an accepted interaction; an unrelated settlement or
 *   tool end never does. A binding move, an interrupt, a pi exit or a restart closes them all (`interrupted`); after
 *   an in-flight answer, a binding that moved makes the receipt `rejected/no_effect` only on the exact resolver's
 *   negative acknowledgement, otherwise `outcome_unknown` and the session fences.
 * - A tool release rechecks the answering grant, the binding and the approval's artifact, policy and expiry before it
 *   dispatches `gate_release`; a fenced or moving session never dispatches a release.
 * - A consumed approval stays live (it owns the child's gate) until that gate ends, and every gate ending removes it
 *   exactly once: the release command (`tool_released` / `release_denied`), the child's terminal notification for a
 *   gate that never released (`gate_closed`: a No, a cancel, an expiry or a move after consumption, a release that
 *   never came), an interrupt, a move or a pi exit (`interrupted`). Capacity counts only these open interactions.
 */
import { randomUUID } from 'node:crypto';
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import type { components } from '../generated/api.js';
import { currentGuard, type Guard } from '../grants/authority.js';
import type { PiRecord, SessionHost } from '../host/host.js';
import { budgetKey, type Journal } from '../journal/journal.js';
import type { DurableLabel } from '../journal/labels.js';
import type { Receipt, ReceiptStore } from '../receipts/receipts.js';

export type Interaction = components['schemas']['Interaction'];
export type Answer = components['schemas']['Answer'];
export type InteractionKind = components['schemas']['InteractionKind'];

const KINDS: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor', 'tool_approval']);
const CAPACITY = 32;
const MAX_TIMEOUT_MS = 30_000;
const APPROVAL_BINDING = ['digest', 'policy_revision', 'expiry', 'operation', 'resource', 'environment', 'offered_scope'] as const;
export type ApprovalBinding = components['schemas']['ApprovalBinding'];

/**
 * A tool gate's approval as the spec's ApprovalBinding: exactly its eight fields, each within its bounds (the SDK
 * child's isApproval plus the gate token), any other field dropped; null when one is missing or out of bounds.
 */
export function approvalBinding(value: unknown): ApprovalBinding | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = (k: string, max: number) => typeof v[k] === 'string' && v[k].length >= 1 && v[k].length <= max;
  if (!['digest', 'policy_revision', 'operation', 'resource', 'environment', 'offered_scope'].every(k => text(k, 4096)) || !text('gate_token', 128)) return null;
  if (!Number.isSafeInteger(v.expiry) || (v.expiry as number) < 0) return null;
  const s = (k: string) => v[k] as string;
  return {
    digest: s('digest'),
    policy_revision: s('policy_revision'),
    expiry: v.expiry as number,
    operation: s('operation'),
    resource: s('resource'),
    environment: s('environment'),
    offered_scope: s('offered_scope'),
    gate_token: s('gate_token'),
  };
}

/** The worker as the interactions need it; the supervisor passes its live row. */
export interface WorkerRef {
  readonly worker_id: string;
  readonly worker_epoch: string;
  readonly session_id: string | null;
  readonly binding_revision: number;
  readonly fence_generation?: number;
}

interface Live {
  record: Interaction;
  /** Title, message, placeholder, prefill and offered options: memory only. */
  payload: Record<string, unknown>;
  options?: string[];
  timer?: NodeJS.Timeout;
  host: SessionHost;
  /** The answering request's grant, rechecked at release. */
  guard?: Guard;
  /** A release command for this approval is running; it owns the settlement until it returns. */
  releasing?: boolean;
  /** The child's gate ended (released or not) while the answer or the release was still in flight. */
  gateEnd?: boolean;
}

export interface InteractionHooks {
  /** The worker's live interactions changed (cards for readers, `interactions.changed`). */
  changed(workerId: string): void;
  /** Joins an uncertain command to the worker's fence and makes it durable before the receipt is returned. */
  fence(workerId: string, commandId: string): void;
}

export class Interactions {
  readonly records = new Map<string, Interaction>();
  private readonly live = new Map<string, Live>();
  // Duplicate-answer comparison happens in live memory only; nothing derived from an answer value is stored.
  private readonly answers = new Map<string, { command: string; signature: string }>();
  private readonly attempts = new Map<string, string>();
  /** The clock; tests move it to the deadline boundary. */
  now: () => number = Date.now;

  constructor(
    readonly journal: Journal,
    readonly receipts: ReceiptStore,
    readonly hooks: InteractionHooks,
  ) {
    this.load();
    // Retention drops interactions no live pi process can touch any more (journal/retention.ts).
    journal.onCompacted(() => this.load());
  }

  /** The durable interaction records, from the journal (each one's latest record). */
  private load(): void {
    this.records.clear();
    for (const r of this.journal.records) {
      if (r.kind !== 'interaction') continue;
      // SAFETY: every `interaction` record is written by save() below from an Interaction, checksummed by the journal.
      const record = structuredClone(r.value) as unknown as Interaction;
      this.records.set(record.interaction_id, record);
    }
  }

  private save(r: Interaction, label: DurableLabel): void {
    // SAFETY: an Interaction is a plain JSON object (no methods, no cycles); the journal stores it as a record value.
    this.journal.append('interaction', r as unknown as Record<string, unknown>, label, { budget: [budgetKey(r.worker_id)] });
    this.records.set(r.interaction_id, structuredClone(r));
  }

  /** After a restart: no resolver survived, so every open interaction is `interrupted`, never re-opened. */
  recover(): void {
    for (const r of this.records.values()) {
      if (['pending', 'accepted'].includes(r.status) || (r.kind === 'tool_approval' && ['forwarded', 'consumed'].includes(r.status))) {
        this.save({ ...r, status: 'interrupted' }, 'interaction.recover');
      }
    }
  }

  /** Live cards with their payload (interactions.list, the snapshot); never durable. */
  list(workerId: string): Interaction[] {
    return [...this.live.values()]
      .filter(l => l.record.worker_id === workerId && l.record.status === 'pending')
      .map(l => ({ ...structuredClone(l.record), ...structuredClone(l.payload), payload_evidence: 'observed_memory' as const }));
  }

  /** The durable metadata of the pending ones, as the worker row persists them. */
  summaries(workerId: string): Interaction[] {
    return [...this.live.values()].filter(l => l.record.worker_id === workerId && l.record.status === 'pending').map(l => structuredClone(l.record));
  }

  status(workerId: string, id: string): Interaction {
    const r = this.records.get(id);
    if (!r || r.worker_id !== workerId) throw new Refusal('unknown_interaction');
    return structuredClone(r);
  }

  /** A dialog pi opened through an exact resolver. Durable metadata first, then the card is live. */
  open(worker: WorkerRef, host: SessionHost, event: PiRecord): void {
    const kind = String(event.method);
    if (!KINDS.has(kind)) return;
    // A tool gate's card carries exactly the typed binding. Without a valid one it is never shown: its native dialog
    // is cancelled, so the child's gate denies the tool.
    const approval = kind === 'tool_approval' ? approvalBinding(event.approval) : null;
    if (kind === 'tool_approval' && !approval) {
      void this.cancelNative(host, String(event.id)).catch(() => {});
      return;
    }
    const mine = [...this.live.values()].filter(l => l.record.worker_id === worker.worker_id);
    if (mine.length >= CAPACITY) throw new Error('interaction_capacity');
    if (mine.some(l => l.record.native_id === String(event.id))) throw new Error('duplicate_native_interaction');
    const deadline =
      typeof event.deadline === 'number'
        ? event.deadline
        : this.now() + (typeof event.timeout === 'number' && event.timeout > 0 ? Math.min(event.timeout, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS);
    const record: Interaction = {
      interaction_id: randomUUID(),
      native_id: String(event.id),
      worker_id: worker.worker_id,
      worker_epoch: worker.worker_epoch,
      session_id: worker.session_id,
      binding_revision: Math.max(1, worker.binding_revision),
      revision: 1,
      // SAFETY: KINDS above is the InteractionKind enum.
      kind: kind as InteractionKind,
      source: kind === 'tool_approval' ? 'pi.tool_gate' : 'pi.extension_ui',
      evidence: 'supervisor_journal_fsynced',
      deadline,
      status: 'pending',
      ...(approval ? { approval } : {}),
    };
    const options = kind === 'select' && Array.isArray(event.options) ? event.options.map(String) : undefined;
    const payload: Record<string, unknown> = {};
    for (const key of ['title', 'message', 'placeholder', 'prefill'] as const) if (typeof event[key] === 'string') payload[key] = event[key];
    if (options) payload.options = options.map((label, i) => ({ option_id: String(i), label }));
    const l: Live = { record, payload, ...(options ? { options } : {}), host };
    this.save(record, 'interaction.open');
    this.live.set(record.interaction_id, l);
    this.hooks.changed(worker.worker_id);
    l.timer = setTimeout(() => this.expire(l), Math.max(1, deadline - this.now()));
    l.timer.unref();
  }

  /** The deadline passed while pending: closed `timeout`, and the native resolver is cancelled behind a durable marker. */
  private expire(l: Live): void {
    try {
      this.close(l, 'timeout', true);
    } catch {
      try {
        this.hooks.fence(l.record.worker_id, `interaction-timeout-${l.record.interaction_id}`);
      } catch {
        /* storage failure cannot throw from a timer */
      }
    }
  }

  private close(l: Live, reason: string, cancel = false): void {
    if (l.record.status !== 'pending') return;
    clearTimeout(l.timer);
    l.record = { ...l.record, status: reason, outcome: reason };
    this.save(l.record, 'interaction.close');
    this.live.delete(l.record.interaction_id);
    this.hooks.changed(l.record.worker_id);
    if (!cancel) return;
    // Write-ahead cancellation marker; a cancel claims nothing about consumption.
    this.journal.append('interaction_effect', { interaction_id: l.record.interaction_id, worker_id: l.record.worker_id, operation: 'cancel', reason }, 'interaction.cancel', { budget: [budgetKey(l.record.worker_id)] });
    void this.cancelNative(l.host, l.record.native_id).catch(() => {
      try {
        this.hooks.fence(l.record.worker_id, `interaction-cancel-${l.record.interaction_id}`);
      } catch {
        /* storage may already be closed */
      }
    });
  }

  private async cancelNative(host: SessionHost, nativeId: string): Promise<void> {
    // The supervisor's own cancel (deadline, move, interrupt), distinct from a person's cancel answer (`answer_ui`).
    const r = await host.request({ type: 'cancel_ui', nativeId });
    if (!r.success) throw new Error('dialog_cancel_failed');
  }

  /** Closes every interaction of the worker (`interrupted`), pending or accepted, without native cancellation. */
  invalidate(workerId: string, reason: string): void {
    for (const l of [...this.live.values()]) {
      if (l.record.worker_id !== workerId) continue;
      if (l.record.status === 'pending') this.close(l, reason);
      else {
        clearTimeout(l.timer);
        l.record = { ...l.record, status: reason };
        this.save(l.record, 'interaction.close');
        this.live.delete(l.record.interaction_id);
        this.hooks.changed(workerId);
      }
    }
  }

  /**
   * Before a binding move or an interrupt: every live native resolver of the worker, including accepted answers and
   * consumed approvals that still own a resolver or gate, is invalidated and cancelled natively before the move.
   */
  async cancelAll(workerId: string, host: SessionHost): Promise<number> {
    const ids = [...this.live.values()].filter(l => l.record.worker_id === workerId).map(l => l.record.native_id);
    this.invalidate(workerId, 'interrupted');
    for (const id of ids) await this.cancelNative(host, id);
    // How many resolvers were cancelled: each ran its continuation, an effect of the command that cancelled it.
    return ids.length;
  }

  /** The child's resolver closed (answered, cancelled, timed out, aborted): the only thing that closes an accepted one. */
  resolverClosed(workerId: string, nativeId: string, outcome: string): void {
    const l = [...this.live.values()].find(x => x.record.worker_id === workerId && x.record.native_id === nativeId);
    if (!l) return;
    if (l.record.status === 'pending') this.close(l, outcome);
    else l.record = { ...l.record, resolver_outcome: outcome };
  }

  /**
   * Answers an interaction if its binding, revision, kind and deadline are current. `writable` refuses under a fence or
   * a move in flight; `binding` is the worker's current row (rechecked after the reply).
   */
  async answer(worker: WorkerRef, a: Answer, writable: () => void, actor: { caller?: string; grant_id?: string } = {}): Promise<Receipt> {
    const signature = JSON.stringify({ outcome: a.outcome, value: a.value, option_id: a.option_id });
    const known = this.answers.get(a.answer_id);
    if (known && known.signature !== signature) throw new Refusal('answer_id_conflict');
    const attempting = this.attempts.get(a.command_id);
    if (attempting !== undefined && attempting !== signature) throw new Refusal('answer_id_conflict');
    const recorded = [...this.records.values()].find(r => r.answer_id === a.answer_id);
    if (recorded) {
      if (
        recorded.interaction_id !== a.interaction_id ||
        recorded.worker_id !== worker.worker_id ||
        recorded.worker_epoch !== a.worker_epoch ||
        recorded.session_id !== a.session_id ||
        recorded.binding_revision !== a.binding_revision ||
        recorded.revision !== a.revision ||
        recorded.kind !== a.kind
      ) {
        throw new Refusal('answer_id_conflict');
      }
      const prior = recorded.answer_command_id ? this.receipts.all.get(recorded.answer_command_id) : undefined;
      // The recorded outcome, without revalidating the value (it is not stored) and without redispatch.
      if (prior && !this.attempts.has(recorded.answer_command_id!)) return structuredClone(prior);
    }
    // Everything involving the answer's content stays live; the receipt's request hash covers metadata only.
    const { value: _value, option_id: _option, outcome: _outcome, ...metadata } = a;
    let l!: Live;
    const guard = currentGuard();
    this.attempts.set(a.command_id, signature);
    let result: Receipt;
    try {
      result = await this.receipts.run(
        a.command_id,
        'interactions.answer_if_current',
        { ...metadata, worker_id: worker.worker_id },
        async () => {
          writable();
          const pending = l.record;
          l.record = {
            ...l.record,
            status: 'accepted',
            answer_id: a.answer_id,
            answer_command_id: a.command_id,
            answer_stage: 1,
            ...(actor.caller ?? a.actor ? { actor: a.actor ?? actor.caller } : {}),
            ...(actor.grant_id ? { grant_id: actor.grant_id } : {}),
          };
          this.answers.set(a.answer_id, { command: a.command_id, signature });
          if (guard) l.guard = guard;
          clearTimeout(l.timer);
          this.save(l.record, 'interaction.accept');
          this.hooks.changed(worker.worker_id);
          try {
            writable();
            if (this.now() >= l.record.deadline) throw new Refusal('interaction_deadline_passed');
          } catch (error) {
            this.refusedAfterAccept(l, pending, a.answer_id);
            throw error;
          }
          this.receipts.dispatch(a.command_id, { worker_id: worker.worker_id, answer_stage: 1 });
          const fenceGeneration = worker.fence_generation ?? 0;
          const answer = a.outcome === 'cancel' ? { outcome: 'cancel' } : { outcome: 'answer', ...(a.value !== undefined ? { value: a.value } : {}), ...(a.option_id !== undefined ? { option_id: a.option_id } : {}) };
          const response = await l.host.request({ type: 'answer_ui', nativeId: l.record.native_id, answer });
          if (!response.success) throw new Error('answer_reply_failed_after_dispatch');
          const consumed = response.data?.consumed === true;
          const negative = response.data?.consumed === false;
          let current =
            worker.worker_epoch === a.worker_epoch &&
            worker.session_id === a.session_id &&
            worker.binding_revision === a.binding_revision &&
            (worker.fence_generation ?? 0) === fenceGeneration &&
            this.live.get(a.interaction_id) === l;
          try {
            writable();
          } catch {
            current = false; // A fence or a move in flight while the answer was out.
          }
          if (!current) {
            l.record = { ...l.record, status: 'interrupted', outcome: 'binding_changed' };
            this.save(l.record, 'interaction.close');
            this.live.delete(a.interaction_id);
            this.hooks.changed(worker.worker_id);
            // Only the exact resolver's negative acknowledgement proves nothing was consumed.
            throw negative ? new ProvenNoEffect('answer_binding_changed', 'resolver_negative_ack') : new Refusal('answer_binding_changed', 'unknown');
          }
          if (!consumed) {
            if (!negative) throw new Error('answer_consumption_unproven');
            l.record = { ...l.record, status: 'resolver_refused', answer_stage: 2, outcome: String(response.data?.outcome ?? 'not_consumed').slice(0, 64) };
            this.save(l.record, 'interaction.answer');
            this.live.delete(a.interaction_id);
            this.hooks.changed(worker.worker_id);
            return { state: 'delivered', stage: 'forwarded', answer_stage: 2, effect: 'observed', result: { interaction_id: a.interaction_id, answer_id: a.answer_id, resolver_consumed: false, outcome: l.record.outcome } };
          }
          const outcome = a.outcome === 'cancel' ? 'cancel' : a.value === false ? 'no' : 'answered';
          l.record = { ...l.record, status: 'consumed', answer_stage: 3, outcome };
          this.save(l.record, 'interaction.answer');
          if (l.record.kind !== 'tool_approval') this.live.delete(a.interaction_id);
          this.hooks.changed(worker.worker_id);
          // The child's gate already ended (a No or a cancel ends it as soon as the resolver is consumed). A release
          // already in flight (its gate check arrived with this reply) owns the ending and settles it when it returns.
          if (l.gateEnd !== undefined && !l.releasing) this.settleGate(l, l.gateEnd);
          return { state: 'delivered', stage: 'resolver_consumed', answer_stage: 3, effect: 'observed', result: { interaction_id: a.interaction_id, answer_id: a.answer_id, outcome, resolver_consumed: true } };
        },
        () => {
          writable();
          if (worker.worker_epoch !== a.worker_epoch || worker.session_id !== a.session_id || worker.binding_revision !== a.binding_revision) {
            throw new Refusal('stale_binding', 'no_effect', undefined, { expected_binding_revision: Math.max(1, worker.binding_revision), received_binding_revision: a.binding_revision });
          }
          const candidate = this.live.get(a.interaction_id);
          if (!candidate || candidate.record.worker_id !== worker.worker_id) throw new Refusal('interaction_not_pending');
          l = candidate;
          const r = l.record;
          if (r.status !== 'pending') throw new Refusal('interaction_already_answered');
          if (r.worker_epoch !== a.worker_epoch || r.session_id !== a.session_id || r.binding_revision !== a.binding_revision || r.revision !== a.revision) throw new Refusal('stale_interaction');
          if (r.kind !== a.kind) throw new Refusal('wrong_interaction_kind');
          if (this.now() >= r.deadline) throw new Refusal('interaction_deadline_passed');
          if (a.outcome === 'cancel') {
            if (a.value !== undefined || a.option_id !== undefined) throw new Refusal('cancel_has_value');
            return;
          }
          if (a.kind === 'select') {
            const i = Number(a.option_id);
            if (!/^\d+$/.test(a.option_id ?? '') || String(i) !== a.option_id || !Number.isSafeInteger(i) || !l.options || i >= l.options.length || a.value !== undefined) throw new Refusal('invalid_option');
          } else if (a.kind === 'confirm' || a.kind === 'tool_approval') {
            if (typeof a.value !== 'boolean' || a.option_id !== undefined) throw new Refusal('invalid_boolean');
          } else if (typeof a.value !== 'string' || Buffer.byteLength(a.value) > 65_536 || a.option_id !== undefined) throw new Refusal('invalid_text');
        },
      );
    } finally {
      this.attempts.delete(a.command_id);
    }
    if (result.state === 'outcome_unknown') this.hooks.fence(worker.worker_id, a.command_id);
    return result;
  }

  /**
   * An accepted answer refused before its dispatch (its deadline passed during the acceptance fsync, or the session
   * stopped being writable): nothing reached the resolver, so the interaction is not left `accepted`. Past its
   * deadline it closes `timeout` with the native resolver cancelled behind a durable marker (what the deadline timer,
   * cleared at acceptance, would have done); otherwise it is pending again under its timer.
   */
  private refusedAfterAccept(l: Live, pending: Interaction, answerId: string): void {
    this.answers.delete(answerId);
    delete l.guard;
    l.record = pending;
    if (this.now() >= pending.deadline) {
      this.close(l, 'timeout', true);
      return;
    }
    this.save(l.record, 'interaction.accept');
    this.hooks.changed(l.record.worker_id);
    l.timer = setTimeout(() => this.expire(l), Math.max(1, pending.deadline - this.now()));
    l.timer.unref();
  }

  /**
   * A gate asks to release the tool its approval covers (`gate_check`). The release is its own command: a fenced or
   * moving session refuses it before any dispatch; otherwise the answering grant, the binding, and the approval's
   * artifact, policy and expiry are rechecked, and `gate_release` carries the decision. Stage 4 is the gate's release.
   */
  async gate(worker: WorkerRef, event: PiRecord, writable: () => void): Promise<void> {
    const l = [...this.live.values()].find(x => x.record.worker_id === worker.worker_id && x.record.approval?.gate_token === event.gate_token);
    if (!l) {
      // A gate check queued before a move cancelled its owner: the child has already denied it. Not a fault.
      const cancelled = [...this.records.values()].some(r => r.worker_id === worker.worker_id && r.kind === 'tool_approval' && r.approval?.gate_token === event.gate_token && r.status === 'interrupted');
      if (cancelled) return;
      throw new Error('unknown_gate');
    }
    if (l.record.kind !== 'tool_approval' || !l.record.answer_id) throw new Error('unknown_gate');
    const command_id = `${l.record.answer_id}:release`;
    l.releasing = true;
    let r: Receipt;
    try {
      r = await this.release(worker, event, writable, l, command_id);
    } finally {
      l.releasing = false;
    }
    if (r.state === 'outcome_unknown') this.hooks.fence(worker.worker_id, command_id);
    // The release left the approval open (refused before dispatch, or unknown) and the child's gate has since ended.
    if (l.gateEnd !== undefined) this.settleGate(l, l.gateEnd);
  }

  /**
   * The child's terminal notification for one gate (`gate_closed`, or `gate_released`): the approval it owned is
   * settled and leaves the live set. An answer or a release still in flight settles it when it returns; an approval
   * already settled (released, denied, interrupted) is left alone.
   */
  gateEnded(workerId: string, gateToken: string, released: boolean): void {
    const l = [...this.live.values()].find(x => x.record.worker_id === workerId && x.record.kind === 'tool_approval' && x.record.approval?.gate_token === gateToken);
    // A pending card's resolver closes through resolver_closed or its deadline, never through a gate notification.
    if (!l || l.record.status === 'pending') return;
    l.gateEnd = released;
    if (l.record.status === 'consumed' && !l.releasing) this.settleGate(l, released);
  }

  /**
   * Settles a consumed approval whose gate ended outside a release receipt. Never stage 4: only the release command
   * proves that. A release the child reports without a delivered release receipt is `release_reported`, stage 3.
   */
  private settleGate(l: Live, released: boolean): void {
    if (this.live.get(l.record.interaction_id) !== l || l.record.status !== 'consumed') return;
    l.record = { ...l.record, status: released ? 'release_reported' : 'gate_closed' };
    this.save(l.record, 'interaction.gate_close');
    this.live.delete(l.record.interaction_id);
    this.hooks.changed(l.record.worker_id);
  }

  private release(worker: WorkerRef, event: PiRecord, writable: () => void, l: Live, command_id: string): Promise<Receipt> {
    return this.receipts.run(command_id, 'interactions.release', { command_id, worker_id: worker.worker_id, interaction_id: l.record.interaction_id }, async () => {
      // A fenced or moving session never dispatches a release, not even a denial; the child's own timeout denies.
      writable();
      let allowed = true;
      try {
        l.guard?.();
        if (l.record.status !== 'consumed' || l.record.outcome !== 'answered' || l.record.binding_revision !== worker.binding_revision || l.record.worker_epoch !== worker.worker_epoch || l.record.session_id !== worker.session_id) {
          throw new Refusal('approval_not_current');
        }
        const b = l.record.approval!;
        if (APPROVAL_BINDING.some(k => b[k] !== event[k]) || this.now() >= Number(b.expiry)) throw new Refusal('approval_binding_invalid');
      } catch {
        allowed = false;
      }
      this.receipts.dispatch(command_id, { worker_id: worker.worker_id });
      const reply = await l.host.request({ type: 'gate_release', gate_token: event.gate_token, digest: event.digest, allowed });
      const claimed = reply.success && reply.data?.released === true;
      if (claimed && !allowed) {
        // The child says it released a tool the supervisor denied: never stage 4, and what it ran is unknown.
        l.record = { ...l.record, status: 'release_contradicted', outcome: 'released_against_denial', release_command_id: command_id };
        this.save(l.record, 'interaction.release');
        this.live.delete(l.record.interaction_id);
        this.hooks.changed(worker.worker_id);
        throw new Error('release_claimed_against_denial');
      }
      // Stage 4 needs both: the supervisor allowed the release and the child, rechecking artifact, policy and expiry
      // itself, released it.
      const released = allowed && claimed;
      l.record = { ...l.record, status: released ? 'tool_released' : 'release_denied', answer_stage: released ? 4 : (l.record.answer_stage ?? 3), release_command_id: command_id };
      this.save(l.record, 'interaction.release');
      this.live.delete(l.record.interaction_id);
      this.hooks.changed(worker.worker_id);
      return { state: 'delivered', stage: released ? 'tool_released' : 'refused', answer_stage: released ? 4 : 3, effect: 'observed', result: { released, interaction_id: l.record.interaction_id } };
    });
  }
}
