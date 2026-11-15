/** THROWAWAY A0 supervisor. pi owns transcript, this process owns control records. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from './journal.js';
import { ReceiptStore } from './receipts.js';
import { RpcHost, type SessionHost, type PiRecord } from './host.js';
import { SessionIndex } from './session.js';
import { EventHub } from './events.js';
import { killGroup } from './process.js';
import { Refusal, type Binding, type Create, type Prompt, type Worker, type Receipt, type Hello } from './types.js';
type Persisted = { worker: Worker; sessionFile: string | null; pid: number | null; token: string | null };
type Live = Persisted & { host?: SessionHost; index: SessionIndex; hub: EventHub; completedMessages: number; faulted?: boolean; startupDialog?: boolean; interactionTimers?: Map<string, NodeJS.Timeout> };
export type HostFactory = (create: Create, sessionDir: string) => SessionHost;
export class Supervisor {
  readonly epoch = randomUUID();
  readonly receipts: ReceiptStore;
  readonly workers = new Map<string, Live>();
  readonly id: string;
  constructor(readonly stateDir: string, readonly journal: Journal, readonly piVersion: string, readonly factory: HostFactory) {
    this.id = (journal.records.find(r => r.kind === 'supervisor')?.value.supervisor_id as string | undefined) ?? randomUUID();
    journal.append('supervisor', { supervisor_id: this.id, supervisor_epoch: this.epoch });
    this.receipts = new ReceiptStore(journal);
    for (const record of journal.records) if (record.kind === 'worker') {
      const persisted = structuredClone(record.value) as Persisted;
      this.workers.set(persisted.worker.worker_id, { ...persisted, index: new SessionIndex(persisted.sessionFile), hub: new EventHub(`${this.epoch}:${persisted.worker.worker_epoch}`), completedMessages: 0 });
    }
  }
  static rpcFactory(executable: string): HostFactory {
    return (c, dir) => new RpcHost(executable, c.cwd, dir, c.provider, c.model, c.thinking);
  }
  async recover(): Promise<void> {
    this.receipts.recover();
    for (const live of this.workers.values()) {
      const w = live.worker;
      w.supervisor_epoch = this.epoch;
      w.pending_interactions = []; // Old native resolvers no longer exist.
      const active = w.execution && w.execution.state !== 'settled';
      if (active) {
        const id = w.execution!.command_id;
        const receipt = this.receipts.all.get(id);
        if (receipt?.effect === 'no_effect' && (receipt.state === 'intent_recovered' || receipt.state === 'rejected')) {
          w.execution!.state = 'settled'; w.execution!.disposition = 'no_effect_before_dispatch'; w.foreground = 'idle';
        } else {
          if (receipt) this.receipts.unknown(id);
          this.fence(live, id);
        }
      }
      for (const receipt of this.receipts.all.values()) if (receipt.worker_id === w.worker_id && receipt.operation === 'sessions.prompt' && receipt.state === 'outcome_unknown') this.fence(live, receipt.command_id);
      if (live.pid !== null) {
        w.status = 'cleanup_pending'; this.persist(live);
        const gone = await killGroup(live.pid, live.token);
        w.status = gone ? 'stopped' : 'cleanup_pending';
        w.cleanup = gone ? 'process_group_observed_gone; escaped_descendants_unproven' : 'unresolved';
        if (gone) live.pid = null;
      } else if (w.status === 'starting') {
        // No process identity after a crash may be the spawn-to-record cut. Do not
        // release the environment or claim cleanup without evidence.
        w.status = 'cleanup_pending'; w.cleanup = 'spawn_identity_unrecorded';
      }
      this.persist(live);
    }
  }
  hello(): Hello {
    return { protocol: { major: 0, minor: 1 }, prototype: true, supervisor_id: this.id, supervisor_epoch: this.epoch, pi_version: this.piVersion,
      capabilities: ['workers.create', 'workers.list', 'workers.get', 'sessions.prompt', 'events.subscribe', 'history.page', 'workers.stop', 'receipts.get', 'host.rpc', 'settlement.agent_settled'],
      limits: { cleanup_replacement: 'Environment reuse blocked when escaped-descendant cleanup is unproven.', same_os_user_not_isolated: 'Private socket ownership does not isolate hostile same-user code, including project extensions.', byo_journal_machine_loss: 'BYO journal dies with the machine.', linux_not_macos: 'Linux results are not macOS results.', peer_check: 'filesystem owner/mode only; no SO_PEERCRED in stock Node API', grants: 'not implemented', receipt_retention: 'until explicit prototype state removal; max 512 ordinary receipts; termination bypasses count quota, journal byte limit still applies; no eviction', journal_bytes: 33554432, request_bytes: 262144, sse_buffer_bytes: 1048576, socket_mode: '0600', socket_directory_mode: '0700', replay: 'fresh authoritative snapshot on every attach, no historical event replay', fence_resolution: 'not implemented; fenced session remains read/stop only' },
      resource_profile: 'normal CLI discovery; exact loaded extension/tool inventory unverified', cleanup_profile: 'linux_process_group; no adoption or resume; escaped descendants unproven' };
  }
  private persist(live: Live): void {
    this.journal.append('worker', { worker: live.worker, sessionFile: live.sessionFile, pid: live.pid, token: live.token });
    live.hub.publish('worker_changed', { worker: structuredClone(live.worker) }, live.worker.execution?.execution_id ?? null, 'supervisor', true);
  }
  private fence(live: Live, command_id: string): void {
    const before = JSON.stringify([live.worker.fence, live.worker.execution, live.worker.foreground]);
    const prior = live.worker.fence;
    if (!prior) live.worker.fence = { command_id, fence_generation: 1, uncertain_command_ids: [command_id] };
    else if (!(prior.uncertain_command_ids ?? [prior.command_id]).includes(command_id)) {
      // Preserve every uncertainty. Recovery of the same item never changes generation.
      prior.uncertain_command_ids = [...(prior.uncertain_command_ids ?? [prior.command_id]), command_id];
      prior.fence_generation++;
    }
    if (live.worker.execution?.command_id === command_id) live.worker.execution.state = 'outcome_unknown';
    live.worker.foreground = 'unknown';
    if (JSON.stringify([live.worker.fence, live.worker.execution, live.worker.foreground]) !== before) this.persist(live); // Fence before any unknown reply.
  }
  require(id: string): Live { const live = this.workers.get(id); if (!live) throw new Refusal('unknown_worker'); return live; }
  get(id: string): Worker {
    const live = this.require(id); this.guarded(live, () => this.refresh(live)); return structuredClone(live.worker);
  }
  list(): Worker[] { return [...this.workers.keys()].map(id => this.get(id)); }
  private refresh(live: Live): void {
    const before = JSON.stringify(live.worker);
    live.index.refresh();
    if (live.index.headerId !== null) {
      if (live.worker.session_id !== live.index.headerId) throw new Refusal('pi_header_identity_changed', 'unknown');
      live.worker.session_identity_evidence = 'pi_session_file';
    }
    live.worker.leaf_id = live.index.leafId;
    live.worker.history = { last_entry_id: live.index.leafId, lag: live.worker.foreground !== 'idle' || live.completedMessages > live.index.messageEntries, evidence: 'pi_session_file' };
    if (JSON.stringify(live.worker) !== before) live.hub.publish('worker_changed', { worker: structuredClone(live.worker) }, live.worker.execution?.execution_id ?? null, 'supervisor');
  }
  private binding(live: Live, b: Binding): void {
    const w = live.worker;
    if (w.worker_epoch !== b.worker_epoch || w.session_id !== b.session_id || w.binding_revision !== b.binding_revision) throw new Refusal('stale_binding');
  }
  private guarded(live: Live, action: () => void): void {
    if (live.faulted) return;
    try { action(); } catch (error) { this.fault(live, error); }
  }
  private fault(live: Live, error: unknown): void {
    if (live.faulted) return;
    live.faulted = true;
    const w = live.worker;
    this.clearInteractions(live);
    w.status = 'cleanup_pending'; w.cleanup = 'worker_fault; cleanup_unproven';
    w.foreground = 'unknown';
    const cause = this.journal.failed ? 'journal_failure' : error instanceof Refusal && error.message === 'pi_header_identity_changed' ? error.message : 'worker_event_failure';
    if (w.execution && w.execution.state !== 'settled') {
      try { this.receipts.unknown(w.execution.command_id); } catch { /* Storage may be unavailable. */ }
      try { this.fence(live, w.execution.command_id); } catch { /* In-memory fence still blocks writes. */ }
    }
    const report = () => {
      try { this.persist(live); } catch {
        live.hub.publish('worker_fault', { cause, worker: structuredClone(w) }, w.execution?.execution_id ?? null, 'supervisor');
      }
    };
    report();
    // Never rethrow from a child EventEmitter callback. Cleanup errors leave
    // this worker closed and its environment reserved; other workers stay up.
    void (live.host ? live.host.stop() : Promise.resolve(false)).then(gone => {
      w.status = gone ? 'failed' : 'cleanup_pending';
      w.cleanup = gone ? 'process_group_observed_gone; escaped_descendants_unproven' : 'worker_fault; cleanup_unproven';
      if (gone) live.pid = null;
      report();
    }).catch(() => { report(); });
  }
  private clearInteractions(live: Live): void {
    for (const timer of live.interactionTimers?.values() ?? []) clearTimeout(timer);
    live.interactionTimers?.clear(); live.worker.pending_interactions = [];
  }
  private closeInteraction(live: Live, id: string, reason: string): void {
    const timer = live.interactionTimers?.get(id); if (timer) clearTimeout(timer);
    live.interactionTimers?.delete(id);
    const pending = live.worker.pending_interactions;
    live.worker.pending_interactions = pending.filter(x => x.native_id !== id);
    if (pending.length === live.worker.pending_interactions.length) return;
    this.persist(live);
    live.hub.publish('interaction_closed', { native_id: id, reason, resolver_consumed: 'unproven' }, null, 'supervisor');
  }
  private onEvent(live: Live, event: PiRecord): void {
    const w = live.worker;
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(String(event.method))) {
      const id = String(event.id);
      if (w.pending_interactions.length >= 32 || w.pending_interactions.some(x => x.native_id === id)) throw new Error('unsupported interaction capacity or duplicate');
      if (w.status === 'starting') live.startupDialog = true;
      w.pending_interactions.push({ native_id: id, kind: String(event.method) });
      this.persist(live);
      const ttl = typeof event.timeout === 'number' && event.timeout > 0 ? Math.min(event.timeout, 30000) : 30000;
      const timer = setTimeout(() => this.guarded(live, () => this.closeInteraction(live, id, 'expired')), ttl); timer.unref();
      (live.interactionTimers ??= new Map()).set(id, timer);
      // Until slice 2 can answer, cancel every unsupported blocking dialog. Only
      // forwarding is observed; do not claim the native resolver consumed it.
      void live.host!.cancelUI(id).then(() => this.guarded(live, () => this.closeInteraction(live, id, 'cancel_forwarded'))).catch(error => this.fault(live, error));
    }
    if (event.type === 'tool_execution_end' || event.type === 'agent_settled') {
      if (w.pending_interactions.length) { this.clearInteractions(live); this.persist(live); }
    }
    if (event.type === 'message_end') live.completedMessages++;
    if (event.type === 'agent_start') {
      w.foreground = 'running';
      if (w.execution && w.execution.state === 'admitted') { w.execution.state = 'started'; this.persist(live); }
    }
    if (event.type === 'agent_settled') {
      w.foreground = w.fence ? 'unknown' : 'idle';
      if (w.execution && !w.fence) w.execution.state = 'settled';
      this.refresh(live); this.persist(live);
    }
    live.hub.publish(event.type, event, w.execution?.execution_id ?? null, 'pi');
  }
  private onExit(live: Live): void {
    if (live.worker.execution && live.worker.execution.state !== 'settled') {
      const id = live.worker.execution.command_id;
      this.receipts.unknown(id); this.fence(live, id);
    }
    // A leader exit is not proof its process group has terminated.
    this.clearInteractions(live);
    live.worker.status = 'cleanup_pending';
    live.worker.cleanup = 'leader_exit_only';
    this.persist(live);
    live.hub.publish('worker_exit', {}, live.worker.execution?.execution_id ?? null, 'supervisor', true);
  }
  create(c: Create): Promise<Receipt> {
    let cwd: string;
    return this.receipts.run(c.command_id, 'workers.create', c, async () => {
      const worker_id = randomUUID(), worker_epoch = randomUUID();
      const w: Worker = { worker_id, worker_epoch, supervisor_epoch: this.epoch, session_id: null, session_identity_evidence: 'pi_rpc_header_id', binding_revision: 1, leaf_id: null, cwd, status: 'starting', foreground: 'idle', execution: null, fence: null, history: { last_entry_id: null, lag: false, evidence: 'pi_session_file' }, cleanup: 'not_started', pending_interactions: [] };
      const live: Live = { worker: w, sessionFile: null, pid: null, token: null, index: new SessionIndex(null), hub: new EventHub(`${this.epoch}:${worker_epoch}`), completedMessages: 0 };
      this.workers.set(worker_id, live);
      this.persist(live);
      this.receipts.dispatch(c.command_id, { worker_id });
      const dir = join(this.stateDir, 'sessions', worker_id); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const host = this.factory({ ...c, cwd }, dir); live.host = host;
      live.pid = host.pid ?? null; live.token = host.token; this.persist(live);
      host.on('event', event => this.guarded(live, () => this.onEvent(live, event)));
      host.on('exit', () => this.guarded(live, () => this.onExit(live)));
      try {
        const state = await host.request({ type: 'get_state' });
        if (live.faulted) throw new Error('worker fault during initialization');
        if (!state.success || typeof state.data?.sessionId !== 'string' || typeof state.data.sessionFile !== 'string') throw new Error('pi initialization did not return a session identity');
        w.session_id = state.data.sessionId; live.sessionFile = state.data.sessionFile; live.index.file = live.sessionFile;
        this.refresh(live);
        if (live.startupDialog) throw new Error('startup blocked by unsupported interaction');
        w.status = 'ready'; w.cleanup = 'live_process_group'; this.persist(live);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed', worker_id, result: { worker_id, worker_epoch, session_id: w.session_id, binding_revision: 1 }, history_lag: w.history.lag };
      } catch (error) {
        const gone = await host.stop(); w.status = gone ? 'failed' : 'cleanup_pending';
        this.clearInteractions(live);
        w.cleanup = gone ? 'process_group_observed_gone; escaped_descendants_unproven' : 'unresolved';
        if (gone) live.pid = null;
        this.persist(live); throw error;
      }
    }, () => {
      if (!statSync(c.cwd).isDirectory()) throw new Refusal('cwd_not_directory');
      cwd = realpathSync(c.cwd);
      if ([...this.workers.values()].some(l => l.worker.cwd === cwd && (['starting', 'ready', 'cleanup_pending'].includes(l.worker.status) || l.worker.cleanup.includes('escaped_descendants_unproven')))) throw new Refusal('exclusive_environment_already_bound');
    });
  }
  async prompt(id: string, p: Prompt): Promise<Receipt> {
    let live: Live;
    const receipt = await this.receipts.run(p.command_id, 'sessions.prompt', { ...p, worker_id: id }, async () => {
      const w = live.worker;
      w.execution = { execution_id: randomUUID(), command_id: p.command_id, state: 'admitted' }; w.foreground = 'running';
      this.persist(live);
      this.receipts.dispatch(p.command_id, { worker_id: id, execution_id: w.execution.execution_id });
      const response = await live.host!.request({ type: 'prompt', message: p.message });
      if (live.faulted) throw new Error('worker fault during prompt');
      if (!response.success) {
        w.execution = null; w.foreground = 'idle'; this.persist(live);
        throw new Refusal('pi_rejected_prompt');
      }
      const disposition = String(response.data?.disposition);
      if (disposition !== 'started' && disposition !== 'handled') throw new Error('unexpected prompt disposition');
      w.execution!.disposition = disposition;
      if (disposition === 'handled' && w.execution!.state === 'admitted') {
        w.execution!.state = 'settled'; w.foreground = 'idle';
        live.hub.publish('execution_settled', { disposition: 'handled' }, w.execution!.execution_id, 'supervisor');
      }
      this.refresh(live); this.persist(live);
      return { state: 'delivered', stage: 'forwarded', effect: 'observed', admission: 'accepted', disposition, history_lag: w.history.lag };
    }, () => {
      live = this.require(id); const w = live.worker; this.binding(live, p);
      if (w.fence) throw new Refusal('session_fenced', 'no_effect', w.fence.command_id);
      if (w.status !== 'ready' || !live.host || live.faulted) throw new Refusal('worker_not_ready');
      if (w.foreground !== 'idle') throw new Refusal('busy_prompt_requires_explicit_steer_or_follow_up_not_supported');
      if (p.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_unsupported_in_slice1');
    });
    if (receipt.state === 'outcome_unknown' && receipt.worker_id) this.fence(this.require(id), p.command_id);
    return receipt;
  }
  async stop(id: string, b: Binding): Promise<Receipt> {
    let live: Live;
    return this.receipts.run(b.command_id, 'workers.stop', { ...b, worker_id: id }, async () => {
      this.receipts.dispatch(b.command_id, { worker_id: id });
      const gone = live.host ? await live.host.stop() : live.pid !== null ? await killGroup(live.pid, live.token) : live.worker.status !== 'cleanup_pending';
      live.worker.status = gone ? 'stopped' : 'cleanup_pending';
      live.worker.cleanup = gone ? 'process_group_observed_gone; escaped_descendants_unproven' : 'unresolved';
      if (gone) live.pid = null;
      this.persist(live);
      return { state: gone ? 'delivered' : 'outcome_unknown', stage: gone ? 'termination_observed' : 'unknown', effect: gone ? 'observed' : 'unknown', result: { termination: gone ? 'observed_stopped' : 'unknown', profile: 'process_group_only' } };
    }, () => { live = this.require(id); this.binding(live, b); });
  }
  async shutdown(): Promise<void> {
    for (const live of this.workers.values()) {
      if (live.host) { await live.host.stop(); }
    }
  }
}
