/** THROWAWAY A0 supervisor. pi owns transcript, this process owns control records. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from './journal.js';
import { GrantStore, type Grant } from './grants.js';
import { ReceiptStore } from './receipts.js';
import { RpcHost, type SessionHost, type PiRecord, type HostContext, type ChildReport } from './host.js';
import { SdkHost, AcpHost } from './library-host.js';
import { Interactions, type Answer, type AnswerGuard } from './interactions.js';
import { SessionIndex } from './session.js';
import { EventHub, type EventScope } from './events.js';
import { killGroup } from './process.js';
import { ProcessGroupContainment, type Containment, type CleanupUnit } from './containment.js';
import { sandboxRoot, readConfined, sandboxSessionDir } from './sandbox.js';
import { Refusal, type Binding, type Create, type Prompt, type Worker, type Receipt, type Hello, type Resolve, type Rebind, type FollowUp, type Control, type ChildLaunch, type Report } from './types.js';
type Persisted = { worker: Worker; sessionFile: string | null; pid: number | null; token: string | null; unit?: CleanupUnit; create?: Create; intentBindings?: Record<string, Binding & { relaunch_epoch?: string }> };
type Pending = { kind: 'follow_up' | 'child'; request: FollowUp | ChildLaunch; guard: () => void };
type Live = Persisted & { host?: SessionHost; index: SessionIndex; hub: EventScope; completedMessages: number; faulted?: boolean; startupDialog?: boolean; exited?: boolean; rebinding?: boolean; nativeRebinding?: boolean; observedIdle?: boolean; pending?: Map<string, Pending>; interactionTimers?: Map<string, NodeJS.Timeout>; inventoryReady?: () => void };
export type HostFactory = (create: Create, sessionDir: string, context?: HostContext) => SessionHost;
export class Supervisor {
  readonly epoch = randomUUID();
  readonly events = new EventHub(this.epoch);
  readonly receipts: ReceiptStore;
  readonly grants: GrantStore;
  readonly interactions: Interactions;
  readonly workers = new Map<string, Live>();
  readonly id: string;
  private sessionFiles = new Map<string, { file: string; worker_id: string }>();
  private sessionReservations = new Map<string, string>();
  private reportNotifications = new Set<string>();
  // Internal callers are trusted; the HTTP boundary supplies a per-request dispatch guard.
  readonly authority = new AsyncLocalStorage<AnswerGuard>();
  readonly callerGrant = new AsyncLocalStorage<Grant>();
  private dispatchGuard(): void { this.authority.getStore()?.(); }
  constructor(readonly stateDir: string, readonly journal: Journal, readonly piVersion: string, readonly factory: HostFactory, readonly containment: Containment = new ProcessGroupContainment()) {
    this.grants = new GrantStore(stateDir); this.grants.registerOwner();
    this.id = (journal.records.find(r => r.kind === 'supervisor')?.value.supervisor_id as string | undefined) ?? randomUUID();
    journal.append('supervisor', { supervisor_id: this.id, supervisor_epoch: this.epoch });
    this.receipts = new ReceiptStore(journal);
    this.interactions = new Interactions(journal, this.receipts, id => { const live = this.require(id); live.worker.pending_interactions = this.interactions.summaries(id); this.persist(live); live.hub.publish('interactions_changed', { interactions: this.interactions.list(id) }, live.worker.execution?.execution_id ?? null, 'supervisor'); }, (id, command) => this.fence(this.require(id), command));
    for (const record of journal.records) if (record.kind === 'worker') {
      const persisted = structuredClone(record.value) as Persisted;
      if (persisted.worker.session_id && persisted.sessionFile) this.sessionFiles.set(persisted.worker.session_id, { file: persisted.sessionFile, worker_id: persisted.worker.worker_id });
      this.workers.set(persisted.worker.worker_id, { ...persisted, index: new SessionIndex(persisted.sessionFile, undefined, persisted.worker.launch_spec?.environment.filesystem === 'bwrap' ? persisted.worker.cwd : undefined), hub: this.events.scoped(persisted.worker.worker_id), completedMessages: 0 });
    }
  }
  static rpcFactory(executable: string): HostFactory {
    return (c, dir, context) => c.host === 'sdk' ? new SdkHost(c, dir, 'sdk', context) : c.host === 'acp' ? new AcpHost(c, dir, context) : new RpcHost(executable, c.cwd, dir, c.provider, c.model, c.thinking, 30000, context, undefined, c.project_trusted === true);
  }
  async recover(): Promise<void> {
    await this.containment.sweepUnknown?.([...this.workers.values()].flatMap(live => live.unit ? [live.unit] : []));
    this.receipts.recover();
    this.interactions.recover();
    for (const live of this.workers.values()) {
      const w = live.worker;
      w.supervisor_epoch = this.epoch;
      if (w.host === 'sdk' || w.host === 'acp') live.index.setActiveLeaf(w.leaf_id);
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
      for (const receipt of this.receipts.all.values()) if (receipt.worker_id === w.worker_id && ['sessions.prompt', 'sessions.follow_up', 'sessions.rebind', 'children.launch', 'interactions.answer_if_current', 'interactions.release'].includes(receipt.operation) && receipt.state === 'outcome_unknown' && !resolved.has(receipt.command_id)) this.fence(live, receipt.command_id);
      if (live.unit) {
        await this.cleanup(live);
      } else if (live.pid !== null) {
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
      if (!launch || !parentId || this.receipts.all.get(launch)?.effect === 'no_effect') continue;
      const parent = this.require(parentId);
      const resolved = parent.worker.resolutions?.some(r => r.command_id === launch);
      const reported = [...this.receipts.all.values()].some(r => r.operation === 'children.report' && r.worker_id === child.worker.worker_id && r.state === 'delivered' && r.result?.task_id === (child.worker.parent?.task_id ?? launch) && r.result?.kind !== 'help');
      if (!reported && !resolved) this.fence(parent, launch);
    }
  }
  hello(): Hello {
    return { protocol: { major: 0, minor: 1 }, prototype: true, supervisor_id: this.id, supervisor_epoch: this.epoch, pi_version: this.piVersion,
      capabilities: ['workers.create', 'workers.list', 'workers.get', 'sessions.prompt', 'events.subscribe', 'history.page', 'workers.stop', 'receipts.get', 'host.rpc', 'host.sdk', 'host.acp', 'interactions.list', 'interactions.answer_if_current', 'interactions.status', 'interaction.select', 'interaction.confirm', 'interaction.input', 'interaction.editor', 'interaction.tool_approval.sdk_acp', 'answer_stage.rpc.2', 'answer_stage.sdk_acp.3', 'gate_stage.sdk_acp.4', 'custom_ui.refused', 'settlement.agent_settled', 'sessions.resolve_unknown', 'sessions.rebind', 'sessions.follow_up', 'children.launch', 'children.report', 'executions.cancel', 'executions.interrupt', 'workers.create.typed_child', 'children.report.fd', 'workers.relaunch', 'environment.bwrap', 'files.read'],
      limits: { sandbox: 'Linux SDK/ACP children only; bwrap filesystem root is cwd, system/runtime mounts read-only, private proc/tmp; network shared. Child profile must be staged inside root; no inherited parent credentials, socket or grants. files.read uses explicit subroots, pinned no-symlink opens, hidden-file refusal, UTF-8 and 1 MiB cap. Sandbox history opens are also root-pinned.', relaunch: 'Explicit workers.relaunch only after cgroup_empty_removed; opens known history without prompting, fresh process epoch. Exact owner-kept recovered prompts retain only their original command binding; ordinary stale writes refuse. Other recovered operation rebinding is not implemented.', cleanup_replacement: 'Cgroup cleanup requires populated=0 AND removal; weaker process-group cleanup never authorizes reuse/relaunch.', same_os_user_not_isolated: 'Private socket ownership does not isolate hostile same-user code, including project extensions.', byo_journal_machine_loss: 'BYO journal dies with the machine.', linux_not_macos: 'Linux results are not macOS results.', peer_check: 'filesystem owner/mode only; no SO_PEERCRED in stock Node API', grants: 'per-caller 0600 bearer file issued by local registration; method/worker/environment checks; revocation rechecked at mutation dispatch; same-user code can read grant files; SDK/ACP test bash gate rechecks grant at release dispatch and child rechecks input digest/policy/expiry; not a production sandbox', receipt_retention: 'until explicit prototype state removal; max 512 ordinary receipts; termination, cancel/interrupt, resolution and child reports bypass count quota; journal byte limit still applies; no eviction', journal_bytes: 33554432, request_bytes: 262144, sse_queue_events: 64, sse_queue_bytes: 262144, socket_mode: '0600', socket_directory_mode: '0700', replay: 'one supervisor-wide filtered stream; bounded per-subscriber queue; overflow closes and requires fresh snapshot; no historical event replay', fence_resolution: 'explicit keep/abandon/observed latch; observed requires exact agent_settled evidence in the session file or fsynced settlement record, never external-effect completion', tree_navigation: 'SDK/ACP navigateTree supported; RPC refused no_effect. SDK leaf overrides append-order history.', pending_payloads: 'follow-up/child payloads memory-only; restart recovers intents no_effect, exact owner-authorized request required' },
      resource_profile: 'per-worker resources inventories actually registered tools/commands; SDK/ACP also exact loaded extension paths and skills. Project resources require create.project_trusted=true. SDK builtins added explicitly for untyped launches; launch_spec uses explicit resources/tools with no discovered resources/MCP/project context; no MCP connection parity claim', cleanup_profile: this.containment.profile };
  }
  private async cleanup(live: Live): Promise<boolean> {
    const unit = live.unit;
    live.worker.status = 'cleanup_pending'; live.worker.cleanup = 'unresolved';
    const execution = live.worker.execution;
    if (execution && execution.state !== 'settled' && this.receipts.all.get(execution.command_id)?.effect !== 'no_effect') {
      // Domain removal may beat Node's exit event. Do not lose the uncertain
      // execution or allow relaunch merely because the OS cleanup is confirmed.
      try { this.fence(live, execution.command_id); } catch { /* keep the in-memory fence and still kill */ }
    }
    let durable = true;
    try { this.persist(live); } catch { durable = false; } // storage failure must not suppress a safety kill
    let gone = false;
    try { gone = unit ? await this.containment.clean(unit) : false; } catch { /* remain pending */ }
    // Another cleanup may already have released this generation for relaunch.
    // Its late completion is evidence about the old domain, never the new one.
    if (live.unit !== unit) return gone && durable;
    if (gone && durable) {
      live.pid = null; live.worker.status = 'stopped'; live.worker.cleanup = 'cgroup_empty_removed';
      try { this.persist(live); return true; } catch { /* unrecorded cleanup is not confirmation */ }
    }
    live.worker.status = 'cleanup_pending'; live.worker.cleanup = gone ? 'unit_empty_cleanup_unrecorded' : 'unresolved';
    try { this.persist(live); } catch { /* original durable unit identity still reserves the lease on recovery */ }
    return false;
  }
  private persist(live: Live): void {
    if (live.worker.session_id && live.sessionFile) this.sessionFiles.set(live.worker.session_id, { file: live.sessionFile, worker_id: live.worker.worker_id });
    this.journal.append('worker', { worker: live.worker, sessionFile: live.sessionFile, pid: live.pid, token: live.token, ...(live.unit ? { unit: live.unit } : {}), ...(live.create ? { create: live.create } : {}), ...(live.intentBindings ? { intentBindings: live.intentBindings } : {}) });
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
    const live = this.require(id); this.guarded(live, () => this.refresh(live), true);
    const w = structuredClone(live.worker);
    if (w.parent) w.child_reports = [...this.receipts.all.values()].filter(r => r.worker_id === id && r.operation === 'children.report' && r.state === 'delivered' && r.result?.kind).map(r => ({ command_id: r.command_id, kind: r.result!.kind as 'result' | 'help', message: String(r.result!.message), claim_not_verified: true }));
    if (live.host?.answerUI) w.pending_interactions = this.interactions.list(id);
    return w;
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
    const unit = live.unit;
    void (unit ? this.cleanup(live) : live.host ? live.host.stop() : Promise.resolve(false)).then(gone => {
      if (live.unit !== unit) return;
      w.status = gone ? 'failed' : 'cleanup_pending';
      w.cleanup = gone ? live.unit ? 'cgroup_empty_removed' : 'process_group_observed_gone; escaped_descendants_unproven' : 'worker_fault; cleanup_unproven';
      if (gone) live.pid = null;
      report();
    }).catch(() => { report(); });
  }
  private clearInteractions(live: Live): void {
    this.interactions.invalidate(live.worker.worker_id, 'interrupted');
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
  private nativeBinding(live: Live, event: PiRecord): void {
    if (live.rebinding) return; // B2 owns this move and will commit exactly one revision.
    if (typeof event.sessionId !== 'string' || typeof event.sessionFile !== 'string') throw new Error('native_binding_identity_missing');
    const w = live.worker, old = { session_id: w.session_id, binding_revision: w.binding_revision };
    this.noOtherWriter(event.sessionId, w.worker_id);
    const initialized = w.session_id !== null;
    this.clearInteractions(live);
    if (initialized) { this.dropPending(live, 'binding_changed'); w.binding_revision++; }
    w.session_id = event.sessionId; live.sessionFile = event.sessionFile;
    live.index = new SessionIndex(live.sessionFile, undefined, w.launch_spec?.environment.filesystem === 'bwrap' ? w.cwd : undefined);
    live.index.setActiveLeaf(typeof event.leafId === 'string' ? event.leafId : null);
    live.completedMessages = 0; live.nativeRebinding = false;
    if (initialized) { w.execution = null; w.foreground = w.fence ? 'unknown' : 'idle'; }
    this.refresh(live); this.persist(live);
    if (initialized) live.hub.publish('session_rebound', { old, session_id: w.session_id, binding_revision: w.binding_revision, action: event.action, source: 'native' }, null, 'supervisor', true);
  }
  private onEvent(live: Live, event: PiRecord): void {
    const w = live.worker;
    if (event.type === 'host_binding_changing' && !live.rebinding) { live.nativeRebinding = true; this.clearInteractions(live); }
    if (event.type === 'host_binding') this.nativeBinding(live, event);
    if (event.type === 'host_leaf' && (typeof event.leafId === 'string' || event.leafId === null)) { live.index.setActiveLeaf(event.leafId); this.refresh(live); }
    if (event.type === 'host_identity' && typeof event.sessionId === 'string' && typeof event.sessionFile === 'string') {
      if (w.session_id && w.session_id !== event.sessionId && !live.rebinding) throw new Error('unexpected_host_identity');
      if (!w.session_id) { this.noOtherWriter(event.sessionId, w.worker_id); w.session_id = event.sessionId; live.sessionFile = event.sessionFile; live.index.file = live.sessionFile; this.persist(live); }
    }
    if (event.type === 'extension_ui_request' && event.method === 'notify' && typeof event.message === 'string') {
      try {
        if (event.message.startsWith('A0_RESOURCE_INVENTORY:')) { w.resources = JSON.parse(event.message.slice('A0_RESOURCE_INVENTORY:'.length)); this.persist(live); live.inventoryReady?.(); return; }
        if (event.message.startsWith('A0_HOST_BINDING:')) { this.onEvent(live, { type: 'host_binding', ...JSON.parse(event.message.slice('A0_HOST_BINDING:'.length)) }); return; }
        if (event.message.startsWith('A0_HOST_IDENTITY:')) { this.onEvent(live, { type: 'host_identity', ...JSON.parse(event.message.slice('A0_HOST_IDENTITY:'.length)) }); return; }
      } catch { throw new Error('invalid_host_audit_record'); }
      if (event.message === 'A0_UNSUPPORTED_CUSTOM_UI') { live.hub.publish('unsupported_ui', { kind: 'custom', reason: 'headless_form_required' }, null, 'supervisor'); return; }
    }
    if (event.type === 'resolver_closed') this.interactions.resolverClosed(w.worker_id, String(event.native_id), String(event.outcome));
    if (event.type === 'gate_check') { void this.interactions.gate(w, event, () => this.writable(live)).catch(error => this.fault(live, error)); return; }
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'tool_approval'].includes(String(event.method)) && live.host?.answerUI) {
      this.interactions.open(w, live.host, event);
    } else if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(String(event.method))) {
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
    // Exact resolver/deadline events own supported dialogs. A sibling tool/run
    // settling is not a binding move and must not erase an accepted answer.
    if (!live.host?.answerUI && (event.type === 'tool_execution_end' || event.type === 'agent_settled')) {
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
      if (w.execution) {
        w.execution.state = 'settled'; // Observed in memory even if persistence fails.
        this.journal.append('settlement', { worker_id: w.worker_id, session_id: w.session_id, execution_id: w.execution.execution_id, command_id: w.execution.command_id, source: 'pi.agent_settled' });
      }
      this.refresh(live); this.persist(live);
      setImmediate(() => { void this.flushPending(live); });
    }
    live.hub.publish(event.type, event, w.execution?.execution_id ?? null, 'pi');
  }
  private wireHost(live: Live, host: SessionHost): void {
    // Retired process callbacks must not fault or rebind the fresh generation.
    host.on('event', event => { if (live.host === host) this.guarded(live, () => this.onEvent(live, event)); });
    host.on('exit', () => { if (live.host === host) this.guarded(live, () => this.onExit(live)); });
    host.on('report', report => { if (live.host === host) this.onReport(live, report); });
  }
  private onExit(live: Live): void {
    if (live.exited) return;
    // killGroup may observe termination before Node delivers the exit callback.
    // Never downgrade that independent confirmed-stop evidence to leader-only.
    if (live.worker.status === 'stopped' && live.pid === null) { live.exited = true; return; }
    live.exited = true;
    const cleaning = live.worker.status === 'cleanup_pending';
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
    // An exit is only leader evidence. Kill detached tools now, not at restart.
    // Explicit stop/fault cleanup already owns a pending domain operation.
    if (live.unit && !cleaning) void this.cleanup(live).catch(error => this.fault(live, error));
  }
  private validateLaunch(c: Create): void {
    const spec = c.launch_spec;
    if (c.parent && !spec) throw new Refusal('child_launch_spec_required');
    const caller = this.callerGrant.getStore();
    if (spec) {
      const subset = (child: string[], parent: string[]) => child.every(x => parent.includes('*') || parent.includes(x));
      if (!subset(spec.grant_methods, spec.environment.allowed_methods) || (caller && !subset(spec.grant_methods, this.grants.active(caller.grant_id).methods))) throw new Refusal('child_grant_not_subset');
      if (spec.tools.some(t => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(t)) || spec.tools.some(t => spec.denied_tools.includes(t))) throw new Refusal('invalid_tool_allowlist');
      if (spec.resources.extensions.concat(spec.resources.skills).some(p => !p.startsWith('/'))) throw new Refusal('resource_path_must_be_absolute');
      if (c.parent) {
        const parent = this.require(c.parent.worker_id); this.writable(parent);
        this.binding(parent, { ...c.parent, command_id: c.command_id });
        if (parent.worker.status !== 'ready' || parent.worker.execution?.execution_id !== c.parent.execution_id) throw new Refusal('stale_parent_execution');
        const p = parent.worker.launch_spec;
        if (p?.environment.filesystem === 'bwrap' && spec.environment.filesystem !== 'bwrap') throw new Refusal('child_filesystem_cannot_widen');
        if (!p || !subset(spec.grant_methods, p.grant_methods) || !subset(spec.environment.allowed_methods, p.environment.allowed_methods) || !subset(spec.tools, p.tools) || !subset(p.denied_tools, spec.denied_tools) || !subset(spec.resources.extensions, p.resources.extensions) || !subset(spec.resources.skills, p.resources.skills)) throw new Refusal('child_authority_not_subset');
        if (parent.worker.grant_source_id) this.grants.active(parent.worker.grant_source_id);
      }
    }
  }
  readFile(id: string, request: { path: string; roots: string[] }) {
    const w = this.require(id).worker;
    if (w.launch_spec?.environment.filesystem !== 'bwrap') throw new Refusal('files_read_requires_sandbox_environment');
    return readConfined(w.cwd, request.path, request.roots);
  }
  private onReport(live: Live, report: ChildReport): void {
    const w = live.worker, parent = w.parent;
    if (!parent || !w.session_id) { this.fault(live, new Error('report_before_binding')); return; }
    const guard = () => {
      if (!w.launch_spec?.grant_methods.includes('children.report')) throw new Refusal('report_not_granted');
      for (const owner of [w, this.require(parent.worker_id).worker]) if (owner.grant_source_id) this.grants.active(owner.grant_source_id);
    };
    void this.authority.run(guard, () => this.report(w.worker_id, { command_id: `fd-${w.worker_id}-${report.report_id}`, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision, task_id: parent.task_id, result_digest: 'unverified-claim', kind: report.kind, message: report.message })).catch(error => this.fault(live, error));
  }
  async create(c: Create): Promise<Receipt> {
    let cwd: string;
    const receipt = await this.receipts.run(c.command_id, 'workers.create', c, async () => {
      this.dispatchGuard(); // Refusal must precede even local worker/cwd reservation.
      this.validateLaunch(c);
      const worker_id = randomUUID(), worker_epoch = randomUUID();
      const w: Worker = { worker_id, worker_epoch, host: c.host ?? 'rpc', supervisor_epoch: this.epoch, session_id: null, session_identity_evidence: 'pi_rpc_header_id', binding_revision: 1, leaf_id: null, cwd, status: 'starting', foreground: 'idle', execution: null, fence: null, history: { last_entry_id: null, lag: false, evidence: 'pi_session_file' }, cleanup: 'not_started', pending_interactions: [] };
      if (c.launch_spec) w.launch_spec = structuredClone(c.launch_spec);
      if (this.callerGrant.getStore()) w.grant_source_id = this.callerGrant.getStore()!.grant_id;
      if (c.parent) { w.parent = structuredClone(c.parent); w.parent_worker_id = c.parent.worker_id; w.parent_launch_command_id = c.command_id; }
      const live: Live = { worker: w, sessionFile: null, pid: null, token: null, unit: this.containment.reserve(worker_epoch), create: { ...c, cwd }, index: new SessionIndex(null, undefined, c.launch_spec?.environment.filesystem === 'bwrap' ? cwd : undefined), hub: this.events.scoped(worker_id), completedMessages: 0 };
      this.workers.set(worker_id, live);
      this.persist(live);
      this.receipts.dispatch(c.command_id, { worker_id });
      const dir = this.sessionDir(live);
      const host = this.factory({ ...c, cwd }, dir, { worker_id, launch_command_id: c.command_id, parent: c.parent, launch_spec: c.launch_spec, containment: this.containment, unit: live.unit }); live.host = host;
      live.pid = host.pid ?? null; live.token = host.token; this.persist(live);
      this.wireHost(live, host);
      try {
        const state = await host.request({ type: 'get_state' });
        if (live.faulted) throw new Error('worker fault during initialization');
        if (!state.success || typeof state.data?.sessionId !== 'string' || typeof state.data.sessionFile !== 'string') throw new Error('pi initialization did not return a session identity');
        this.noOtherWriter(state.data.sessionId, worker_id);
        w.session_id = state.data.sessionId; live.sessionFile = state.data.sessionFile; live.index.file = live.sessionFile;
        this.refresh(live);
        if (live.startupDialog && !host.answerUI) throw new Error('startup blocked by unsupported interaction');
        if (host.kind === 'sdk' || host.kind === 'acp') { const inventory = await host.request({ type: 'inventory' }); if (!inventory.success || (inventory.data?.extension_errors as unknown[])?.length) throw new Error('resource_inventory_failed'); w.resources = inventory.data; }
        if (host.kind === 'rpc' && !w.resources) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { live.inventoryReady = undefined; reject(new Error('rpc_audit_inventory_required')); }, 30000); timer.unref();
          live.inventoryReady = () => { clearTimeout(timer); live.inventoryReady = undefined; resolve(); };
        });
        w.status = 'ready'; w.cleanup = live.unit ? 'live_cgroup' : 'live_process_group'; this.persist(live);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed', worker_id, result: { worker_id, worker_epoch, session_id: w.session_id, binding_revision: 1 }, history_lag: w.history.lag };
      } catch (error) {
        const gone = live.unit ? await this.cleanup(live) : await host.stop(); w.status = gone ? 'failed' : 'cleanup_pending';
        this.clearInteractions(live);
        w.cleanup = gone ? live.unit ? 'cgroup_empty_removed' : 'process_group_observed_gone; escaped_descendants_unproven' : 'unresolved';
        if (gone) live.pid = null;
        this.persist(live); throw error;
      }
    }, () => {
      this.validateLaunch(c);
      sandboxRoot(c, this.stateDir);
      try { if (!statSync(c.cwd).isDirectory()) throw new Error('not directory'); cwd = realpathSync(c.cwd); }
      catch { throw new Refusal('cwd_not_directory'); }
      if ([...this.workers.values()].some(l => l.worker.cwd === cwd && (['starting', 'ready', 'cleanup_pending'].includes(l.worker.status) || l.worker.cleanup.includes('escaped_descendants_unproven')))) throw new Refusal('exclusive_environment_already_bound');
    });
    if (c.parent && receipt.effect === 'unknown') this.fence(this.require(c.parent.worker_id), c.command_id);
    return receipt;
  }
  async prompt(id: string, p: Prompt, operation: 'sessions.prompt' | 'sessions.follow_up' = 'sessions.prompt'): Promise<Receipt> {
    let live: Live;
    const receipt = await this.receipts.run(p.command_id, operation, { ...p, worker_id: id }, async () => {
      this.dispatchGuard(); // A revoked input must not leave an admitted execution.
      const w = live.worker;
      w.execution = { execution_id: randomUUID(), command_id: p.command_id, state: 'admitted' }; w.foreground = 'running';
      if (live.intentBindings) delete live.intentBindings[p.command_id];
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
      live = this.require(id); const w = live.worker; this.writable(live); this.intentBinding(live, p); this.refresh(live);
      if (w.status !== 'ready' || !live.host || live.faulted) throw new Refusal('worker_not_ready');
      if (w.foreground !== 'idle') throw new Refusal('busy_prompt_requires_explicit_steer_or_follow_up_not_supported');
      if (p.message.trimStart().startsWith('/')) throw new Refusal('slash_commands_use_typed_rebind_or_unsupported');
    });
    if (receipt.state === 'outcome_unknown' && receipt.worker_id && !this.require(id).worker.resolutions?.some(r => r.command_id === p.command_id)) this.fence(this.require(id), p.command_id);
    return receipt;
  }
  /** Only a durable owner-kept pre-dispatch intent can retain its old binding
   * across an explicit fresh-process launch. All ordinary stale writes refuse. */
  private intentBinding(live: Live, b: Binding): void {
    const old = live.intentBindings?.[b.command_id];
    if (this.receipts.all.get(b.command_id)?.state === 'intent_ready' && old && old.worker_epoch === b.worker_epoch && old.session_id === b.session_id && old.binding_revision === b.binding_revision && live.worker.worker_epoch === old.relaunch_epoch && live.worker.session_id === old.session_id && live.worker.binding_revision === old.binding_revision) return;
    this.binding(live, b);
  }
  async relaunch(id: string, b: Binding): Promise<Receipt> {
    let live: Live;
    return this.receipts.run(b.command_id, 'workers.relaunch', { ...b, worker_id: id }, async () => {
      this.dispatchGuard();
      live.host = undefined; // retire listeners before publishing the new epoch
      const w = live.worker, old = { worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision };
      w.worker_epoch = randomUUID();
      (live.intentBindings ??= {});
      for (const r of this.receipts.all.values()) if (r.worker_id === id && ['intent_recovered', 'intent_ready'].includes(r.state) && r.operation === 'sessions.prompt') live.intentBindings[r.command_id] ??= { ...old, command_id: r.command_id };
      w.status = 'starting'; w.cleanup = 'not_started';
      w.execution = null; w.foreground = 'idle'; live.exited = false; live.faulted = false;
      live.unit = this.containment.reserve(w.worker_epoch); live.pid = null; live.token = null;
      this.persist(live); // new domain and old exact-intent binding before any spawn
      this.receipts.dispatch(b.command_id, { worker_id: id });
      const c = live.create!, originalFile = live.sessionFile!, originalId = w.session_id;
      const dir = this.sessionDir(live);
      live.rebinding = true;
      try {
        const host = this.factory(c, dir, { worker_id: id, launch_command_id: b.command_id, parent: c.parent, launch_spec: c.launch_spec, containment: this.containment, unit: live.unit });
        live.host = host; live.pid = host.pid ?? null; live.token = host.token; this.persist(live);
        this.wireHost(live, host);
        const init = await host.request({ type: 'get_state' });
        if (!init.success) throw new Error('fresh_host_initialization_failed');
        const opened = await host.request({ type: 'switch_session', sessionPath: originalFile });
        if (!opened.success || opened.data?.cancelled) throw new Error('fresh_host_session_open_failed');
        const state = await host.request({ type: 'get_state' });
        if (!state.success || state.data?.sessionId !== originalId || state.data?.sessionFile !== originalFile || live.faulted) throw new Error('fresh_host_session_identity_mismatch');
        live.index = new SessionIndex(originalFile, undefined, w.launch_spec?.environment.filesystem === 'bwrap' ? w.cwd : undefined); live.completedMessages = 0;
        if (host.kind === 'sdk' || host.kind === 'acp') {
          live.index.setActiveLeaf(typeof state.data.leafId === 'string' ? state.data.leafId : null);
          const inventory = await host.request({ type: 'inventory' });
          if (!inventory.success || (inventory.data?.extension_errors as unknown[])?.length) throw new Error('resource_inventory_failed');
          w.resources = inventory.data;
        }
        w.status = 'ready'; w.cleanup = 'live_cgroup'; live.observedIdle = true;
        this.refresh(live);
        // Failed attempts retain the original exact binding, but do not consume
        // its one target epoch. Only a verified successful launch binds it.
        for (const kept of Object.values(live.intentBindings)) if (!kept.relaunch_epoch && kept.session_id === w.session_id && kept.binding_revision === w.binding_revision) kept.relaunch_epoch = w.worker_epoch;
        this.persist(live);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: { worker_id: id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision, prompted: false } };
      } catch (error) { await this.cleanup(live); throw error; }
      finally { live.rebinding = false; }
    }, () => {
      live = this.require(id); this.binding(live, b);
      if (live.worker.status === 'cleanup_pending' || live.worker.cleanup !== 'cgroup_empty_removed' || !live.unit) throw new Refusal('cleanup_pending_or_cleanup_unproven');
      this.writable(live); this.noOtherWriter(live.worker.session_id!, id);
      if ([...this.workers.values()].some(other => other !== live && other.worker.cwd === live.worker.cwd && (['starting', 'ready', 'cleanup_pending'].includes(other.worker.status) || other.worker.cleanup.includes('escaped_descendants_unproven')))) throw new Refusal('exclusive_environment_already_bound');
      if (!live.create || !live.sessionFile || !existsSync(live.sessionFile)) throw new Refusal('relaunch_session_or_launch_record_unavailable');
    });
  }
  private sessionDir(live: Live): string {
    if (live.worker.launch_spec?.environment.filesystem === 'bwrap') return sandboxSessionDir(live.worker.cwd, live.worker.worker_id);
    const dir = join(this.stateDir, 'sessions', live.worker.worker_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir;
  }
  private writable(live: Live): void {
    if (live.worker.fence) throw new Refusal('session_fenced', 'no_effect', live.worker.fence.command_id);
    if (live.rebinding || live.nativeRebinding) throw new Refusal('binding_change_in_progress');
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
        for (const queued of w.queued ?? []) if (queued.state === 'paused' && r.disposition !== 'abandon') queued.state = 'queued';
      }
      if (r.disposition === 'abandon') this.dropPending(live, 'resolve_abandon');
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
        // Admission is not settlement. Require exact worker/session/run attribution.
        const settlementEvidence = execution && this.journal.records.some(record => record.kind === 'settlement' && record.value.worker_id === id && record.value.session_id === w.session_id && record.value.execution_id === execution && record.value.command_id === uncertain && record.value.source === 'pi.agent_settled');
        if (!settlementEvidence && !(execution && live.index.hasSettlement(execution, uncertain))) throw new Refusal('execution_settlement_not_in_session_file_or_fsynced_record');
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
        await this.interactions.cancelAll(id, live.host!, w.pending_interactions);
        this.clearInteractions(live);
        this.dispatchGuard();
        const response = await live.host!.request(b.action === 'new' ? { type: 'new_session' } : b.action === 'resume' ? { type: 'switch_session', sessionPath: target! } : b.action === 'navigate' ? { type: 'navigate', entryId: b.entry_id! } : { type: 'fork', entryId: b.entry_id! });
        if (!response.success || response.data?.cancelled) throw new Refusal('pi_binding_change_cancelled', 'unknown');
        const state = await live.host!.request({ type: 'get_state' });
        if (!state.success || typeof state.data?.sessionId !== 'string' || typeof state.data.sessionFile !== 'string') throw new Error('binding_identity_unavailable');
        if (b.action === 'resume' && state.data.sessionId !== b.target_session_id) throw new Error('resumed_session_identity_mismatch');
        try { this.noOtherWriter(state.data.sessionId, id); }
        catch (error) { throw new Refusal(error instanceof Error ? error.message : 'post_write_binding_refusal', 'unknown'); }
        this.dropPending(live, 'binding_changed');
        w.session_id = state.data.sessionId; w.binding_revision++; w.session_identity_evidence = 'pi_rpc_header_id';
        live.sessionFile = state.data.sessionFile; live.index = new SessionIndex(live.sessionFile, undefined, w.launch_spec?.environment.filesystem === 'bwrap' ? w.cwd : undefined); live.completedMessages = 0;
        if (live.host?.kind === 'sdk' || live.host?.kind === 'acp') live.index.setActiveLeaf(typeof state.data.leafId === 'string' ? state.data.leafId : null);
        w.leaf_id = null; w.execution = null; w.foreground = 'idle'; live.observedIdle = true;
        this.refresh(live); this.persist(live);
        live.hub.publish('session_rebound', { old, session_id: w.session_id, binding_revision: w.binding_revision, action: b.action }, null, 'supervisor', true);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: { session_id: w.session_id, binding_revision: w.binding_revision } };
      } finally { live.rebinding = false; if (b.target_session_id && this.sessionReservations.get(b.target_session_id) === id) this.sessionReservations.delete(b.target_session_id); }
    }, () => {
      live = this.require(id); const w = live.worker; this.writable(live); this.binding(live, b);
      if (w.status !== 'ready' || !live.host || live.faulted) throw new Refusal('cleanup_pending_or_worker_not_ready');
      if (w.foreground !== 'idle') throw new Refusal('binding_change_requires_idle');
      if (b.action === 'navigate' && (!live.host?.kind || live.host.kind === 'rpc')) throw new Refusal('pi_1_5_2_rpc_tree_navigation_unavailable');
      this.refresh(live);
      if (b.action === 'fork' || b.action === 'navigate') {
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
  answer(id: string, a: Answer): Promise<Receipt> { const live = this.require(id); return this.interactions.answer(live.worker, a, this.authority.getStore() ?? (() => {}), () => { this.writable(live); if (live.faulted || !live.host || !['starting', 'ready'].includes(live.worker.status)) throw new Refusal('worker_not_ready'); }); }
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
      if (kind === 'child' && live.worker.launch_spec) throw new Refusal('typed_children_use_workers_create');
      if (live.worker.status !== 'ready' || !live.host) throw new Refusal('worker_not_ready');
      if (request.execution_id !== live.worker.execution?.execution_id) throw new Refusal('stale_execution');
      if ((live.pending?.size ?? 0) >= 32) throw new Refusal('pending_capacity');
    });
  }
  private dropPending(live: Live, reason: string): void {
    const active = (live.worker.queued ?? []).filter(q => ['queued', 'paused', 'recovered'].includes(q.state));
    const ids = new Set([...(live.pending?.keys() ?? []), ...active.map(q => q.command_id)]);
    for (const id of ids) {
      const r = this.receipts.all.get(id);
      if (r && ['queued', 'queue_ready', 'intent_ready', 'intent_recovered'].includes(r.state)) this.receipts.resolveIntent(id, 'abandon');
      live.hub.publish('queued_dropped', { command_id: id, reason }, null, 'supervisor');
    }
    live.pending?.clear();
    for (const q of active) q.state = 'dropped';
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
          this.receipts.readyQueued(id);
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
        if (current && ['queued', 'queue_ready', 'intent_ready', 'intent'].includes(current.state)) this.receipts.update(id, { state: 'rejected', stage: 'refused', effect: 'no_effect', error: error instanceof Error ? error.message : 'pending_refused' });
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
      if (live.host) await this.interactions.cancelAll(id, live.host, live.worker.pending_interactions);
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
  async report(id: string, r: Report): Promise<Receipt> {
    const receipt = await this.receipts.run(r.command_id, 'children.report', { ...r, worker_id: id }, async () => {
      this.dispatchGuard(); this.receipts.dispatch(r.command_id, { worker_id: id });
      return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: { task_id: r.task_id, result_digest: r.result_digest, ...(r.kind ? { kind: r.kind, message: r.message } : {}), claim_not_verified: true } };
    }, () => {
      const w = this.require(id).worker; this.binding(this.require(id), r);
      if (w.parent && r.task_id !== w.parent.task_id) throw new Refusal('wrong_child_task');
      if (r.kind && (typeof r.message !== 'string' || Buffer.byteLength(r.message) > 8192)) throw new Refusal('report_message_invalid');
    });
    if (receipt.state === 'delivered' && !this.reportNotifications.has(r.command_id)) {
      this.reportNotifications.add(r.command_id);
      this.require(id).hub.publish('child_report', { receipt }, null, 'supervisor', true);
    }
    return receipt;
  }
  async stop(id: string, b: Binding): Promise<Receipt> {
    let live: Live;
    return this.receipts.run(b.command_id, 'workers.stop', { ...b, worker_id: id }, async () => {
      this.dispatchGuard();
      this.receipts.dispatch(b.command_id, { worker_id: id });
      const unit = live.unit;
      const stoppedEpoch = live.worker.worker_epoch;
      if (!unit) { live.worker.status = 'cleanup_pending'; this.persist(live); }
      const gone = unit ? await this.cleanup(live) : live.host ? await live.host.stop() : live.pid !== null ? await killGroup(live.pid, live.token) : live.worker.cleanup === 'not_started';
      const superseded = live.unit !== unit;
      if (!superseded) {
        live.worker.status = gone ? 'stopped' : 'cleanup_pending';
        live.worker.cleanup = gone ? unit ? 'cgroup_empty_removed' : 'process_group_observed_gone; escaped_descendants_unproven' : 'unresolved';
        if (gone) live.pid = null;
        this.persist(live);
      }
      if (superseded) {
        const currentEpoch = live.worker.worker_epoch;
        return gone
          ? { state: 'delivered', stage: 'termination_observed', effect: 'observed', result: { termination: 'superseded_generation_stopped', stopped_worker_epoch: stoppedEpoch, current_worker_epoch: currentEpoch, profile: unit ? 'cgroup_v2' : 'process_group_only' } }
          : { state: 'outcome_unknown', stage: 'unknown', effect: 'unknown', result: { termination: 'superseded_generation_unknown', stopped_worker_epoch: stoppedEpoch, current_worker_epoch: currentEpoch, profile: unit ? 'cgroup_v2' : 'process_group_only' } };
      }
      return { state: gone ? 'delivered' : 'outcome_unknown', stage: gone ? 'termination_observed' : 'unknown', effect: gone ? 'observed' : 'unknown', result: { termination: gone ? 'observed_stopped' : 'unknown', stopped_worker_epoch: stoppedEpoch, current_worker_epoch: stoppedEpoch, profile: unit ? 'cgroup_v2' : 'process_group_only' } };
    }, () => { live = this.require(id); this.binding(live, b); });
  }
  async shutdown(): Promise<void> {
    for (const live of this.workers.values()) {
      this.clearInteractions(live);
      if (live.unit) await this.cleanup(live);
      else if (live.host) { await live.host.stop(); }
    }
  }
}
