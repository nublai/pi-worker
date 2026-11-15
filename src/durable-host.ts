/** THROWAWAY comparison, NOT contract-conformant: automatic resume is intentional.
 * Durable owns transcript, submissions, queue and control document in one storage.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, configure, defineDoc, type Conversation, type ConversationView, type LiveState, type Tx, type ConversationId, type EntryId } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import { EventHub } from './events.js';
import { requestHash } from './receipts.js';
import { Refusal, type Binding, type Create, type Prompt, type Worker, type Receipt, type Hello, type HistoryCursor, type HistoryPage } from './types.js';
// Serialized control values keep this spike's wire schema separate from Chord's JSON types.
export const Control = defineDoc<{ workers: Record<string, string>; receipts: Record<string, string> }>({
  kind: 'a0.control', scope: 'session', version: 1,
  initial: () => ({ workers: {}, receipts: {} }), checkpointWhen: () => true,
});
type Live = { worker: Worker; conversation: Conversation; hub: EventHub; view: ConversationView;
  index: { page(cursor: HistoryCursor | null, limit: number): Promise<HistoryPage> } };
export class DurableHost {
  readonly epoch = randomUUID();
  readonly workers = new Map<string, Live>();
  readonly receipts = { all: new Map<string, Receipt>() };
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly harness: Harness, readonly models: Models) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next;
  }
  async recover(): Promise<void> {
    const control = await this.harness.snapshot(Control, ctx);
    try {
      for (const [id, value] of Object.entries(control?.receipts ?? {})) this.receipts.all.set(id, JSON.parse(value) as Receipt);
      for (const value of Object.values(control?.workers ?? {})) await this.mount(JSON.parse(value) as Worker);
    } catch (cause) { throw new Error('durable control recovery failed; refusing resume', { cause }); }
    // Deliberate experiment: no outcome_unknown fence. NOT a drop-in contract implementation.
    this.harness.resume();
  }
  private async mount(worker: Worker): Promise<void> {
    const conversation = (await this.harness.conversation(Number(worker.session_id) as ConversationId, ctx))!;
    const watch = await conversation.watch(ctx);
    const live: Live = { worker: { ...worker, supervisor_epoch: this.epoch }, conversation,
      hub: new EventHub(`${this.epoch}:${worker.worker_epoch}`), view: watch.value,
      index: { page: (cursor, limit) => this.history(worker.worker_id, cursor, limit) } };
    this.workers.set(worker.worker_id, live);
    this.project(live, watch.value);
    watch.start(async call => {
      if (call.kind !== 'value') return;
      const wasBusy = live.worker.foreground === 'running';
      this.project(live, call.value);
      live.hub.publish('durable_view', { view: call.value, ops: call.ops }, live.worker.execution?.execution_id ?? null);
      if (wasBusy && live.worker.foreground === 'idle') live.hub.publish('agent_settled', { source: 'durable.pi.live.run_removed', failure: call.value.docs['pi.live'] }, live.worker.execution?.execution_id ?? null);
    });
  }
  private project(live: Live, view: ConversationView): void {
    live.view = view;
    const state = view.docs['pi.live'] as LiveState | undefined;
    live.worker.foreground = state?.run ? 'running' : 'idle';
    if (live.worker.execution) live.worker.execution.state = state?.run ? 'started' : 'settled';
    live.worker.history = { last_entry_id: view.entries.length ? String(view.entries.at(-1)!.id) : null, lag: false, evidence: 'durable_storage' };
  }
  hello(): Hello {
    return { protocol: { major: 0, minor: 1 }, prototype: true, supervisor_id: 'a0-durable-throwaway', supervisor_epoch: this.epoch,
      pi_version: '@earendil-works/pi-durable 1.5.2', capabilities: ['workers.create', 'workers.list', 'workers.get', 'sessions.prompt', 'events.subscribe', 'history.page', 'workers.stop', 'receipts.get', 'host.durable'],
      resource_profile: 'Explicit CodingTools only; no coding-agent discovery. Gateway adapter or deterministic faux provider.',
      cleanup_profile: 'abort joins durable tasks, NOT proof escaped or crash-orphaned OS processes stopped',
      limits: { throwaway: true, contract_conformant: false, recovery: 'resume automatically retries model requests, interrupts unsafe tools, continues run/queue; no fence',
        evidence: 'durable_storage = JSONL fsync:true; live partials deferred up to 1s, event envelopes remain observed_memory',
        settlement: 'agent_settled is an adapter event from pi.live.run removal, NOT native coding-agent agent_settled',
        receipt_retention: 'all until scratch deletion; unbounded prototype control document',
        same_os_user_not_isolated: true, byo_machine_loss: true, linux_not_macos: true, peer_check: 'filesystem owner/mode only',
        history_format: 'pi-durable entries, NOT coding-agent JSONL; bounded pages but no byte-cap adaptation',
        approval: 'no B2 interaction endpoint', stop: 'abort then control commit; crash between these leaves command outcome unrecorded',
        queued_input: 'prompt while busy is a durable follow-up (deliberate semantic difference)', socket_mode: '0600' } };
  }
  require(id: string): Live { const live = this.workers.get(id); if (!live) throw new Refusal('unknown_worker'); return live; }
  get(id: string): Worker { return structuredClone(this.require(id).worker); }
  list(): Worker[] { return [...this.workers.keys()].map(id => this.get(id)); }
  private binding(w: Worker, b: Binding): void {
    if (w.worker_epoch !== b.worker_epoch || w.session_id !== b.session_id || w.binding_revision !== b.binding_revision) throw new Refusal('stale_binding');
  }
  private prior(id: string, hash: string): Receipt | undefined {
    const old = this.receipts.all.get(id);
    if (old && old.request_hash !== hash) throw new Refusal('command_id_conflict');
    return old;
  }
  private receipt(command_id: string, operation: Receipt['operation'], hash: string, worker_id: string): Receipt {
    return { command_id, operation, request_hash: hash, worker_id, state: 'delivered', stage: 'forwarded', effect: 'observed', evidence: 'durable_storage', created_at: new Date().toISOString() };
  }
  private async save(tx: Tx, w: Worker, receipt: Receipt): Promise<void> {
    const control = await tx.doc(Control);
    control.workers[w.worker_id] = JSON.stringify(w);
    control.receipts[receipt.command_id] = JSON.stringify(receipt);
  }
  create(c: Create): Promise<Receipt> {
    return this.serial(async () => {
      const hash = requestHash({ ...c, operation: 'workers.create' });
      const prior = this.prior(c.command_id, hash); if (prior) return prior;
      const cwd = realpathSync(c.cwd);
      if (!statSync(cwd).isDirectory()) throw new Refusal('cwd_not_directory');
      if ([...this.workers.values()].some(x => x.worker.cwd === cwd)) throw new Refusal('exclusive_environment_already_bound');
      const model = this.models.getModel(c.provider, c.model);
      if (!model) throw new Refusal('unknown_model');
      const worker: Worker = { worker_id: randomUUID(), worker_epoch: randomUUID(), supervisor_epoch: this.epoch, session_id: null,
        session_identity_evidence: 'durable_conversation_id', binding_revision: 1, leaf_id: null, cwd, status: 'ready', foreground: 'idle', execution: null, fence: null,
        history: { last_entry_id: null, lag: false, evidence: 'durable_storage' }, cleanup: 'durable_tasks_only', pending_interactions: [] };
      const receipt = this.receipt(c.command_id, 'workers.create', hash, worker.worker_id);
      await this.harness.commit(async tx => {
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        worker.session_id = String(conversation.id);
        await configure(tx, conversation.id, { model: { provider: c.provider, modelId: c.model }, cwd, thinkingLevel: c.thinking,
          instructions: 'THROWAWAY isolated test. Follow the user request concisely. Never access paths outside /tmp/a0d/.', maxTurns: 8 });
        receipt.result = { worker_id: worker.worker_id, worker_epoch: worker.worker_epoch, session_id: worker.session_id, binding_revision: 1 };
        await this.save(tx, worker, receipt);
      }, ctx);
      this.receipts.all.set(c.command_id, receipt); await this.mount(worker); return receipt;
    });
  }
  prompt(id: string, p: Prompt): Promise<Receipt> {
    return this.serial(async () => {
      const hash = requestHash({ ...p, worker_id: id, operation: 'sessions.prompt' });
      const prior = this.prior(p.command_id, hash); if (prior) return prior;
      const live = this.require(id), w = structuredClone(live.worker); this.binding(w, p);
      if (w.status !== 'ready') throw new Refusal('worker_not_ready');
      if (p.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_unsupported');
      const receipt = this.receipt(p.command_id, 'sessions.prompt', hash, id);
      await this.harness.commit(async tx => {
        const submissionId = await live.conversation.submit(tx, { type: 'input', content: p.message, requestId: p.command_id });
        w.execution = { execution_id: String(submissionId), command_id: p.command_id, state: 'admitted' };
        receipt.execution_id = String(submissionId); receipt.admission = 'accepted';
        receipt.disposition = live.worker.foreground === 'running' ? 'queued' : 'started';
        receipt.result = { submission_id: submissionId, request_id: p.command_id };
        await this.save(tx, w, receipt);
      }, ctx);
      live.worker.execution = w.execution;
      this.project(live, live.view);
      this.receipts.all.set(p.command_id, receipt);
      this.harness.resume(); return receipt;
    });
  }
  stop(id: string, b: Binding): Promise<Receipt> {
    return this.serial(async () => {
      const hash = requestHash({ ...b, worker_id: id, operation: 'workers.stop' });
      const prior = this.prior(b.command_id, hash); if (prior) return prior;
      const live = this.require(id); this.binding(live.worker, b);
      await live.conversation.abort(ctx, { background: true });
      const w = structuredClone(live.worker); w.status = 'stopped'; w.foreground = 'idle';
      const receipt = this.receipt(b.command_id, 'workers.stop', hash, id);
      // Do not claim termination_observed for processes a prior crash orphaned.
      receipt.result = { termination: 'durable_tasks_idle', os_descendants: 'unproven' };
      await this.harness.commit(tx => this.save(tx, w, receipt), ctx);
      live.worker = w; this.receipts.all.set(b.command_id, receipt); return receipt;
    });
  }
  async history(id: string, cursor: HistoryCursor | null, limit: number): Promise<HistoryPage> {
    const live = this.require(id);
    const newest = (await live.conversation.entries({}, 1, undefined, ctx)).items[0]?.id;
    const watermark = cursor?.watermark ?? (newest === undefined ? null : String(newest));
    if (!watermark) return { entries: [], watermark: null, next: null, leafId: null, truncated: false, evidence: 'durable_storage' };
    const page = await live.conversation.entries({ order: 'ascending', maxEntryId: Number(watermark) as EntryId, ...(cursor?.after ? { minEntryId: Number(cursor.after) as EntryId } : {}) }, limit + 2, undefined, ctx);
    const items = page.items.filter(x => String(x.id) !== cursor?.after);
    const entries = items.slice(0, limit).map(x => ({ ...x }));
    return { entries, watermark, next: items.length > limit ? { watermark, after: String(entries.at(-1)!.id) } : null, leafId: watermark, truncated: false, evidence: 'durable_storage' };
  }
  async shutdown(): Promise<void> { await this.harness.close(ctx); }
}
