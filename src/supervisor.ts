/** THROWAWAY A0 supervisor. pi owns transcript, this process owns control records. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from './journal.js';
import { GrantStore } from './grants.js';
import { ReceiptStore } from './receipts.js';
import { RpcHost, type SessionHost, type PiRecord } from './host.js';
import { SessionIndex } from './session.js';
import { EventHub, type EventScope } from './events.js';
import { killGroup } from './process.js';
import { Refusal, type Binding, type Create, type Prompt, type Worker, type Receipt, type Hello, type Resolve, type Rebind, type FollowUp, type Control, type ChildLaunch, type Report } from './types.js';
type Persisted = { worker: Worker; sessionFile: string | null; pid: number | null; token: string | null };
type Pending = { kind: 'follow_up' | 'child'; request: FollowUp | ChildLaunch; guard: () => void };
type Live = Persisted & { host?: SessionHost; index: SessionIndex; hub: EventScope; completedMessages: number; faulted?: boolean; startupDialog?: boolean; exited?: boolean; rebinding?: boolean; observedIdle?: boolean; pending?: Map<string, Pending>; interactionTimers?: Map<string, NodeJS.Timeout> };
export type HostFactory = (create: Create, sessionDir: string) => SessionHost;
export class Supervisor {
  readonly epoch = randomUUID();
  readonly events = new EventHub(this.epoch);
  readonly receipts: ReceiptStore;
  readonly grants: GrantStore;
  readonly workers = new Map<string, Live>();
  readonly id: string;
  private sessionFiles = new Map<string, { file: string; worker_id: string }>();
  private sessionReservations = new Map<string, string>();
  // Internal callers are trusted; the HTTP boundary supplies a per-request dispatch guard.
  readonly authority = new AsyncLocalStorage<() => void>();
  private dispatchGuard(): void { this.authority.getStore()?.(); }
  constructor(readonly stateDir: string, readonly journal: Journal, readonly piVersion: string, readonly factory: HostFactory) {
    this.grants = new GrantStore(stateDir); this.grants.registerOwner();
    this.id = (journal.records.find(r => r.kind === 'supervisor')?.value.supervisor_id as string | undefined) ?? randomUUID();
    journal.append('supervisor', { supervisor_id: this.id, supervisor_epoch: this.epoch });
    this.receipts = new ReceiptStore(journal);
    for (const record of journal.records) if (record.kind === 'worker') {
      const persisted = structuredClone(record.value) as Persisted;
      if (persisted.worker.session_id && persisted.sessionFile) this.sessionFiles.set(persisted.worker.session_id, { file: persisted.sessionFile, worker_id: persisted.worker.worker_id });
      this.workers.set(persisted.worker.worker_id, { ...persisted, index: new SessionIndex(persisted.sessionFile), hub: this.events.scoped(persisted.worker.worker_id), completedMessages: 0 });
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
      const resolved = new Map((w.resolutions ?? []).map(r => [r.command_id, r]));
      for (const [command, resolution] of resolved) {
        const receipt = this.receipts.all.get(command);
        if (receipt?.state === 'intent_recovered') this.receipts.resolveIntent(command, resolution.disposition);
      }
      for (const queued of w.queued ?? []) if (!['dropped', 'dispatched'].includes(queued.state)) queued.state = 'recovered';
      if (active && (!resolved.has(w.execution!.command_id) || ['ready', 'starting'].includes(w.status))) {
        const id = w.execution!.command_id;
        const receipt = this.receipts.all.get(id);
        if (receipt?.effect === 'no_effect' && (receipt.state === 'intent_recovered' || receipt.state === 'rejected')) {
          w.execution!.state = 'settled'; w.execution!.disposition = 'no_effect_before_dispatch'; w.foreground = 'idle';
        } else {
          if (receipt) this.receipts.unknown(id);
          this.fence(live, id);
        }
      }
      for (const receipt of this.receipts.all.values()) if (receipt.worker_id === w.worker_id && ['sessions.prompt', 'sessions.follow_up', 'sessions.rebind', 'children.launch'].includes(receipt.operation) && receipt.state === 'outcome_unknown' && !resolved.has(receipt.command_id)) this.fence(live, receipt.command_id);
      if (live.pid !== null) {
        w.status = 'cleanup_pending'; this.persist(live);
        const gone = await killGroup(live.pid, live.token);
        w.status = gone ? 'stopped' : 'cleanup_pending';
        w.cleanup = gone ? 'process_group_observed_gone; escaped_descendants_unproven' : 'unresolved';
        if (gone) live.pid = null;
      } else if (w.status === 'ready') {
        w.status = 'cleanup_pending'; w.cleanup = 'ready_without_process_identity';
      } else if (w.status === 'starting') {
        // No process identity after a crash may be the spawn-to-record cut. Do not
        // release the environment or claim cleanup without evidence.
        w.status = 'cleanup_pending'; w.cleanup = 'spawn_identity_unrecorded';
      }
      this.persist(live);
    }
    for (const child of this.workers.values()) {
      const launch = child.worker.parent_launch_command_id, parentId = child.worker.parent_worker_id;
      if (!launch || !parentId) continue;
      const parent = this.require(parentId);
      const resolved = parent.worker.resolutions?.some(r => r.command_id === launch);
      const reported = [...this.receipts.all.values()].some(r => r.operation === 'children.report' && r.worker_id === child.worker.worker_id && r.state === 'delivered' && r.result?.task_id === launch);
      if (!reported && !resolved) this.fence(parent, launch);
    }
  }
  hello(): Hello {
    return { protocol: { major: 0, minor: 1 }, prototype: true, supervisor_id: this.id, supervisor_epoch: this.epoch, pi_version: this.piVersion,
      capabilities: ['workers.create', 'workers.list', 'workers.get', 'sessions.prompt', 'events.subscribe', 'history.page', 'workers.stop', 'receipts.get', 'host.rpc', 'settlement.agent_settled', 'sessions.resolve_unknown', 'sessions.rebind', 'sessions.follow_up', 'children.launch', 'children.report', 'executions.cancel', 'executions.interrupt'],
      limits: { cleanup_replacement: 'Environment reuse blocked when escaped-descendant cleanup is unproven.', same_os_user_not_isolated: 'Private socket ownership does not isolate hostile same-user code, including project extensions.', byo_journal_machine_loss: 'BYO journal dies with the machine.', linux_not_macos: 'Linux results are not macOS results.', peer_check: 'filesystem owner/mode only; no SO_PEERCRED in stock Node API', grants: 'per-caller 0600 bearer file issued by local registration; method/worker/environment checks; revocation rechecked at mutation dispatch; same-user code can read grant files; no privileged-tool-release gate in slice 2', receipt_retention: 'until explicit prototype state removal; max 512 ordinary receipts; termination bypasses count quota, journal byte limit still applies; no eviction', journal_bytes: 33554432, request_bytes: 262144, sse_queue_events: 64, sse_queue_bytes: 262144, socket_mode: '0600', socket_directory_mode: '0700', replay: 'one supervisor-wide filtered stream; bounded per-subscriber queue; overflow closes and requires fresh snapshot; no historical event replay', fence_resolution: 'explicit keep/abandon/observed latch; observed proves exact input evidence, never external-effect completion', tree_navigation: 'Pi 1.5.2 RPC has get_tree but no navigate command; refused no_effect', pending_payloads: 'follow-up/child payloads memory-only; restart recovers intents no_effect, exact owner-authorized request required' },
      resource_profile: 'normal CLI discovery; exact loaded extension/tool inventory unverified', cleanup_profile: 'linux_process_group; no adoption or resume; escaped descendants unproven' };
  }
  private persist(live: Live): void {
    if (live.worker.session_id && live.sessionFile) this.sessionFiles.set(live.worker.session_id, { file: live.sessionFile, worker_id: live.worker.worker_id });
    this.journal.append('worker', { worker: live.worker, sessionFile: live.sessionFile, pid: live.pid, token: live.token });
    live.hub.publish('worker_changed', { worker: structuredClone(live.worker) }, live.worker.execution?.execution_id ?? null, 'supervisor', true);
  }
  private fence(live: Live, command_id: string, memoryOnly = false): void {
    const before = JSON.stringify([live.worker.fence, live.worker.execution, live.worker.foreground]);
    const prior = live.worker.fence;
    if (!prior) live.worker.fence = { command_id, fence_generation: (live.worker.fence_generation ?? 0) + 1, uncertain_command_ids: [command_id] };
    else if (!(prior.uncertain_command_ids ?? [prior.command_id]).includes(command_id)) {
      // Preserve every uncertainty. Recovery of the same item never changes generation.
      prior.uncertain_command_ids = [...(prior.uncertain_command_ids ?? [prior.command_id]), command_id];
      prior.fence_generation++;
    }
    live.worker.fence_generation = live.worker.fence!.fence_generation;
    for (const queued of live.worker.queued ?? []) if (queued.state === 'queued') queued.state = 'paused';
    if (live.worker.execution?.command_id === command_id && live.worker.execution.state !== 'settled') live.worker.execution.state = 'outcome_unknown';
    live.worker.foreground = 'unknown';
    if (JSON.stringify([live.worker.fence, live.worker.execution, live.worker.foreground]) !== before && !memoryOnly) this.persist(live); // Fence before any unknown reply.
  }
  require(id: string): Live { const live = this.workers.get(id); if (!live) throw new Refusal('unknown_worker'); return live; }
  get(id: string): Worker {
    const live = this.require(id); this.guarded(live, () => this.refresh(live), true); return structuredClone(live.worker);
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
    if (w.worker_epoch !== b.worker_epoch || w.session_id !== b.session_id || w.binding_revision !== b.binding_revision) throw new Refusal(`stale_binding: expected revision ${w.binding_revision}, received ${b.binding_revision}`, 'no_effect', undefined, { expected_binding_revision: w.binding_revision, received_binding_revision: b.binding_revision });
  }
  private guarded(live: Live, action: () => void, memoryOnly = false): void {
    if (live.faulted) return;
    try { action(); } catch (error) { this.fault(live, error, memoryOnly); }
  }
  private fault(live: Live, error: unknown, memoryOnly = false): void {
    if (live.faulted) return;
    live.faulted = true;
    const w = live.worker;
    this.clearInteractions(live);
    w.status = 'cleanup_pending'; w.cleanup = 'worker_fault; cleanup_unproven';
    w.foreground = 'unknown';
    const cause = this.journal.failed ? 'journal_failure' : error instanceof Refusal && error.message === 'pi_header_identity_changed' ? error.message : 'worker_event_failure';
    if (w.execution && w.execution.state !== 'settled') {
      try { if (!memoryOnly) this.receipts.unknown(w.execution.command_id); } catch { /* Storage may be unavailable. */ }
      try { this.fence(live, w.execution.command_id, memoryOnly); } catch { /* In-memory fence still blocks writes. */ }
    }
    const report = () => {
      try { if (memoryOnly) throw new Error('read_fault_memory_only'); this.persist(live); } catch {
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
      live.observedIdle = false;
      w.foreground = w.fence ? 'unknown' : 'running';
      if (w.execution && w.execution.state === 'admitted') { w.execution.state = 'started'; this.persist(live); }
    }
    if (event.type === 'agent_settled') {
      w.foreground = w.fence ? 'unknown' : 'idle';
      live.observedIdle = true;
      if (w.execution) w.execution.state = 'settled';
      this.refresh(live); this.persist(live);
      setImmediate(() => { void this.flushPending(live); });
    }
    live.hub.publish(event.type, event, w.execution?.execution_id ?? null, 'pi');
  }
  private onExit(live: Live): void {
    if (live.exited) return;
    live.exited = true;
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
      const live: Live = { worker: w, sessionFile: null, pid: null, token: null, index: new SessionIndex(null), hub: this.events.scoped(worker_id), completedMessages: 0 };
      this.workers.set(worker_id, live);
      this.persist(live);
      this.dispatchGuard();
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
        this.noOtherWriter(state.data.sessionId, worker_id);
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
      try { if (!statSync(c.cwd).isDirectory()) throw new Error('not directory'); cwd = realpathSync(c.cwd); }
      catch { throw new Refusal('cwd_not_directory'); }
      if ([...this.workers.values()].some(l => l.worker.cwd === cwd && (['starting', 'ready', 'cleanup_pending'].includes(l.worker.status) || l.worker.cleanup.includes('escaped_descendants_unproven')))) throw new Refusal('exclusive_environment_already_bound');
    });
  }
  async prompt(id: string, p: Prompt, operation: 'sessions.prompt' | 'sessions.follow_up' = 'sessions.prompt'): Promise<Receipt> {
    let live: Live;
    const receipt = await this.receipts.run(p.command_id, operation, { ...p, worker_id: id }, async () => {
      const w = live.worker;
      w.execution = { execution_id: randomUUID(), command_id: p.command_id, state: 'admitted' }; w.foreground = 'running';
      this.persist(live);
      this.dispatchGuard();
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
      live = this.require(id); const w = live.worker; this.writable(live); this.binding(live, p); this.refresh(live);
      if (w.status !== 'ready' || !live.host || live.faulted) throw new Refusal('worker_not_ready');
      if (w.foreground !== 'idle') throw new Refusal('busy_prompt_requires_explicit_steer_or_follow_up_not_supported');
      if (p.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_use_typed_rebind_or_unsupported');
    });
    if (receipt.state === 'outcome_unknown' && receipt.worker_id && !this.require(id).worker.resolutions?.some(r => r.command_id === p.command_id)) this.fence(this.require(id), p.command_id);
    return receipt;
  }
  private writable(live: Live): void {
    if (live.worker.fence) throw new Refusal('session_fenced', 'no_effect', live.worker.fence.command_id);
    if (live.rebinding) throw new Refusal('binding_change_in_progress');
  }
  private noOtherWriter(sessionId: string, except: string): void {
    const reserved = this.sessionReservations.get(sessionId);
    if (reserved && reserved !== except) throw new Refusal(`session_already_bound: holder ${reserved}`, 'no_effect', undefined, { holder_worker_id: reserved });
    const holder = [...this.workers.values()].find(l => l.worker.worker_id !== except && l.worker.session_id === sessionId && ['starting', 'ready', 'cleanup_pending'].includes(l.worker.status));
    if (holder) throw new Refusal(`session_already_bound: holder ${holder.worker.worker_id}`, 'no_effect', undefined, { holder_worker_id: holder.worker.worker_id });
  }
  async resolveUnknown(id: string, r: Resolve): Promise<Receipt> {
    let live: Live, uncertain: string;
    return this.receipts.run(r.command_id, 'sessions.resolve_unknown', { ...r, worker_id: id }, async () => {
      const w = live.worker;
      this.dispatchGuard(); this.receipts.dispatch(r.command_id, { worker_id: id });
      const resolved = { command_id: uncertain, disposition: r.disposition, fence_generation: r.fence_generation };
      (w.resolutions ??= []).push(resolved);
      const remaining = (w.fence?.uncertain_command_ids ?? (w.fence ? [w.fence.command_id] : [])).filter(x => x !== uncertain);
      w.fence = remaining.length ? { command_id: remaining[0]!, uncertain_command_ids: remaining, fence_generation: (w.fence_generation ?? 0) + 1 } : null;
      if (w.fence) w.fence_generation = w.fence.fence_generation;
      if (!w.fence) {
        w.foreground = live.host && live.observedIdle === false ? 'running' : 'idle';
        for (const queued of w.queued ?? []) if (queued.state === 'paused') queued.state = r.disposition === 'abandon' ? 'dropped' : 'queued';
        if (r.disposition === 'abandon') this.dropPending(live, 'resolve_abandon');
      }
      this.persist(live); // durable resolution tombstone before clearing/authorizing receipts
      const target = this.receipts.all.get(uncertain);
      if (target && ['intent_recovered', 'intent_ready'].includes(target.state)) this.receipts.resolveIntent(uncertain, r.disposition);
      live.hub.publish('fence_resolved', { ...resolved, external_effects_undone: false, fence: w.fence }, w.execution?.execution_id ?? null, 'supervisor', true);
      if (r.disposition !== 'abandon') setImmediate(() => { void this.flushPending(live); });
      return { state: 'delivered', stage: 'resolved', effect: 'observed', result: { ...resolved, external_effects_undone: false, fence: w.fence } };
    }, () => {
      live = this.require(id); this.binding(live, r);
      const w = live.worker;
      if (Boolean(r.uncertain_command_id) === Boolean(r.execution_id)) throw new Refusal('name_exactly_one_uncertain_command_or_execution');
      uncertain = r.uncertain_command_id ?? [...this.receipts.all.values()].find(x => x.worker_id === id && x.execution_id === r.execution_id)?.command_id ?? (w.execution && w.execution.execution_id === r.execution_id ? w.execution.command_id : '');
      const target = this.receipts.all.get(uncertain);
      const recovered = target?.worker_id === id && ['intent_recovered', 'intent_ready'].includes(target.state);
      if (r.fence_generation !== (w.fence?.fence_generation ?? w.fence_generation ?? 0)) throw new Refusal('wrong_fence_generation', 'no_effect', w.fence?.command_id);
      if (w.fence ? !(w.fence.uncertain_command_ids ?? [w.fence.command_id]).includes(uncertain) : !recovered) throw new Refusal('uncertainty_not_current');
      if (r.disposition === 'observed') {
        const execution = r.execution_id ?? target?.execution_id ?? (w.execution?.command_id === uncertain ? w.execution.execution_id : undefined);
        // A delivered fsynced receipt proves this exact input was accepted, not that its effects completed.
        const receiptEvidence = execution && target?.execution_id === execution && target.state === 'delivered' && target.effect === 'observed';
        if (!receiptEvidence && !(execution && live.index.hasExecution(execution, uncertain))) throw new Refusal('execution_not_in_session_file_or_fsynced_receipt');
      }
    });
  }
  async rebind(id: string, b: Rebind): Promise<Receipt> {
    const prior = this.receipts.all.get(b.command_id);
    const fresh = !prior || prior.state === 'intent_ready';
    let live: Live, target: string | undefined;
    const receipt = await this.receipts.run(b.command_id, 'sessions.rebind', { ...b, worker_id: id }, async () => {
      const w = live.worker, old = { session_id: w.session_id, binding_revision: w.binding_revision };
      this.writable(live);
      if (b.target_session_id) { this.noOtherWriter(b.target_session_id, id); this.sessionReservations.set(b.target_session_id, id); }
      live.rebinding = true;
      try {
        this.dispatchGuard(); this.receipts.dispatch(b.command_id, { worker_id: id });
        for (const interaction of w.pending_interactions) await live.host!.cancelUI(interaction.native_id);
        this.clearInteractions(live);
        this.dispatchGuard();
        const response = await live.host!.request(b.action === 'new' ? { type: 'new_session' } : b.action === 'resume' ? { type: 'switch_session', sessionPath: target! } : { type: 'fork', entryId: b.entry_id! });
        if (!response.success || response.data?.cancelled) throw new Refusal('pi_binding_change_cancelled');
        const state = await live.host!.request({ type: 'get_state' });
        if (!state.success || typeof state.data?.sessionId !== 'string' || typeof state.data.sessionFile !== 'string') throw new Error('binding_identity_unavailable');
        this.noOtherWriter(state.data.sessionId, id);
        this.dropPending(live, 'binding_changed');
        w.session_id = state.data.sessionId; w.binding_revision++; w.session_identity_evidence = 'pi_rpc_header_id';
        live.sessionFile = state.data.sessionFile; live.index = new SessionIndex(live.sessionFile); live.completedMessages = 0;
        w.leaf_id = null; w.execution = null; w.foreground = 'idle'; live.observedIdle = true;
        this.refresh(live); this.persist(live);
        live.hub.publish('session_rebound', { old, session_id: w.session_id, binding_revision: w.binding_revision, action: b.action }, null, 'supervisor', true);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: { session_id: w.session_id, binding_revision: w.binding_revision } };
      } finally { live.rebinding = false; if (b.target_session_id && this.sessionReservations.get(b.target_session_id) === id) this.sessionReservations.delete(b.target_session_id); }
    }, () => {
      live = this.require(id); const w = live.worker; this.writable(live); this.binding(live, b);
      if (w.status !== 'ready' || !live.host || live.faulted) throw new Refusal('cleanup_pending_or_worker_not_ready');
      if (w.foreground !== 'idle') throw new Refusal('binding_change_requires_idle');
      if (b.action === 'navigate') throw new Refusal('pi_1_5_2_rpc_tree_navigation_unavailable');
      this.refresh(live);
      if (b.action === 'fork') {
        if (b.source_leaf_id === undefined || b.source_leaf_id !== w.leaf_id) throw new Refusal('stale_source_leaf');
        if (!b.entry_id || !live.index.hasEntry(b.entry_id)) throw new Refusal('unknown_fork_entry');
      }
      if (b.action === 'resume') {
        if (!b.target_session_id) throw new Refusal('target_session_id_required');
        this.noOtherWriter(b.target_session_id, id);
        const known = this.sessionFiles.get(b.target_session_id);
        if (!known) throw new Refusal('unknown_session');
        const owner = this.require(known.worker_id);
        if (known.worker_id !== id && (owner.worker.status === 'cleanup_pending' || owner.worker.cleanup.includes('escaped_descendants_unproven'))) throw new Refusal('target_cleanup_unproven');
        if (owner.worker.fence) throw new Refusal('target_session_fenced', 'no_effect', owner.worker.fence.command_id);
        target = known.file;
      }
    });
    if (fresh && receipt.state === 'outcome_unknown') {
      const uncertain = this.require(id); this.fence(uncertain, b.command_id); this.fault(uncertain, new Error('binding_change_unknown'));
    }
    return receipt;
  }
  followUp(id: string, request: FollowUp): Promise<Receipt> { return this.enqueue(id, 'follow_up', request); }
  launchChild(id: string, request: ChildLaunch): Promise<Receipt> { return this.enqueue(id, 'child', request); }
  private enqueue(id: string, kind: Pending['kind'], request: FollowUp | ChildLaunch): Promise<Receipt> {
    let live: Live;
    return this.receipts.run(request.command_id, kind === 'follow_up' ? 'sessions.follow_up' : 'children.launch', { ...request, worker_id: id }, async () => {
      (live.pending ??= new Map()).set(request.command_id, { kind, request, guard: this.authority.getStore() ?? (() => {}) });
      (live.worker.queued ??= []).push({ command_id: request.command_id, kind, state: 'queued' });
      this.persist(live);
      setImmediate(() => { void this.flushPending(live); });
      return { state: 'queued', stage: 'reserved', effect: 'no_effect', admission: 'queued', worker_id: id };
    }, () => {
      live = this.require(id); this.writable(live); this.binding(live, request);
      if (live.worker.status !== 'ready' || !live.host) throw new Refusal('worker_not_ready');
      if (request.execution_id !== live.worker.execution?.execution_id) throw new Refusal('stale_execution');
      if ((live.pending?.size ?? 0) >= 32) throw new Refusal('pending_capacity');
    });
  }
  private dropPending(live: Live, reason: string): void {
    for (const [id] of live.pending ?? []) {
      const r = this.receipts.all.get(id);
      if (r && ['queued', 'intent_ready'].includes(r.state)) this.receipts.resolveIntent(id, 'abandon');
      live.hub.publish('queued_dropped', { command_id: id, reason }, null, 'supervisor');
    }
    live.pending?.clear();
    for (const q of live.worker.queued ?? []) if (['queued', 'paused'].includes(q.state)) q.state = 'dropped';
  }
  private async flushPending(live: Live): Promise<void> {
    // Every due item rechecks fence, binding and the original grant at dispatch.
    if (live.worker.fence || live.rebinding || live.faulted || live.worker.status !== 'ready' || live.worker.foreground !== 'idle') return;
    for (const [id, pending] of live.pending ?? []) {
      if (live.worker.fence || live.worker.foreground !== 'idle') return;
      const r = this.receipts.all.get(id);
      if (r?.state !== 'queued') continue;
      live.pending!.delete(id);
      try {
        await this.authority.run(pending.guard, async () => {
          pending.guard(); this.binding(live, pending.request); this.writable(live);
          this.receipts.resolveIntent(id, 'keep');
          if (pending.kind === 'follow_up') await this.prompt(live.worker.worker_id, pending.request as FollowUp, 'sessions.follow_up');
          else {
            // Child launch is intentionally minimal: no inheritance or sandbox claim in slice 2.
            this.receipts.dispatch(id, { worker_id: live.worker.worker_id });
            const child = await this.create((pending.request as ChildLaunch).launch);
            if (child.worker_id) {
              const childLive = this.require(child.worker_id);
              childLive.worker.parent_worker_id = live.worker.worker_id; childLive.worker.parent_launch_command_id = id; this.persist(childLive);
            }
            this.receipts.update(id, { state: child.effect === 'unknown' ? 'outcome_unknown' : 'delivered', stage: 'forwarded', effect: child.effect, result: { child_command_id: child.command_id, child_worker_id: child.worker_id } });
            if (child.effect === 'unknown') this.fence(live, id);
          }
        });
        const q = live.worker.queued?.find(q => q.command_id === id); if (q) q.state = 'dispatched';
      } catch (error) {
        const current = this.receipts.all.get(id);
        if (current && ['queued', 'intent_ready', 'intent'].includes(current.state)) this.receipts.update(id, { state: 'rejected', stage: 'refused', effect: 'no_effect', error: error instanceof Error ? error.message : 'pending_refused' });
        const q = live.worker.queued?.find(q => q.command_id === id); if (q) q.state = 'dropped';
      }
      try { this.persist(live); } catch (error) { this.fault(live, error); return; }
    }
  }
  async control(id: string, b: Control, interrupt: boolean): Promise<Receipt> {
    let live: Live;
    return this.receipts.run(b.command_id, interrupt ? 'executions.interrupt' : 'executions.cancel', { ...b, worker_id: id }, async () => {
      this.dispatchGuard(); this.receipts.dispatch(b.command_id, { worker_id: id });
      this.dropPending(live, interrupt ? 'interrupt' : 'cancel');
      for (const q of live.worker.pending_interactions) if (live.host) await live.host.cancelUI(q.native_id);
      this.clearInteractions(live);
      if (!live.host) return { state: 'delivered', stage: 'requested', effect: 'observed', result: { disposition: 'unknown', requested: true, profile: 'no_live_host' } };
      await live.host.request({ type: 'clear_queue' }); // abort alone may continue Pi-owned queued input
      const result = await live.host.request({ type: 'abort' });
      this.persist(live);
      return { state: result.success ? 'delivered' : 'outcome_unknown', stage: 'requested', effect: result.success ? 'observed' : 'unknown', result: { requested: true, disposition: live.worker.execution?.state === 'settled' ? 'settled' : 'unknown', external_effects_stopped: 'unproven' } };
    }, () => {
      live = this.require(id); this.binding(live, b);
      if (b.execution_id && live.worker.execution?.execution_id !== b.execution_id) throw new Refusal('stale_execution');
    });
  }
  report(id: string, r: Report): Promise<Receipt> {
    return this.receipts.run(r.command_id, 'children.report', { ...r, worker_id: id }, async () => {
      this.dispatchGuard(); this.receipts.dispatch(r.command_id, { worker_id: id });
      return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: { task_id: r.task_id, result_digest: r.result_digest, claim_not_verified: true } };
    }, () => { this.binding(this.require(id), r); });
  }
  async stop(id: string, b: Binding): Promise<Receipt> {
    let live: Live;
    return this.receipts.run(b.command_id, 'workers.stop', { ...b, worker_id: id }, async () => {
      this.dispatchGuard();
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
