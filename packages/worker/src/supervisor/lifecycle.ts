/**
 * Worker lifecycle: create, stop, pi exit, worker faults, restart recovery and shutdown. Rewritten from A0
 * `src/supervisor.ts` (`create`, `stop`, `onExit`, `fault`, `recover`) without sandboxes, containment or children.
 *
 * Rules kept from A0: one live writer per session and one worker per cwd, refused naming the holder; the starting
 * row and the dispatch record are durable before pi is spawned, and the process identity right after, before any
 * request; a launch that fails after dispatch is `outcome_unknown` with the worker `failed` (or `cleanup_pending`
 * when the kill was not observed). A pi exit or a restart is leader evidence only: until P2's cgroup domains can
 * confirm cleanup, a restarted worker stays `cleanup_pending` and is not resumable (invariant 2), and a stopped
 * worker's cwd stays reserved because its descendants are unproven.
 */
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../b2/errors.js';
import { SessionIndex } from '../history/session-index.js';
import type { PiRecord, SessionHost } from '../host/host.js';
import { killGroup } from '../host/process.js';
import type { Receipt } from '../receipts/receipts.js';
import { HOLDING, type Binding, type Create, type Live, type SupervisorState } from './state.js';

const GROUP_GONE = 'process_group_observed_gone; escaped_descendants_unproven';
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message.slice(0, 256) : 'launch_failed');

export type Observer = (live: Live, event: PiRecord) => void;

/** Per-domain event observers; lifecycle's own runs first. Other modules register theirs (input, binding). */
export class Lifecycle {
  readonly observers: Observer[] = [];
  /** Per-domain recovery steps, run for every worker before its cleanup is recorded (input, fence). */
  readonly recoverers: ((live: Live) => void)[] = [];
  /** Called when a worker's execution can no longer settle (exit, fault, restart): the input module records it. */
  onUncertain: (live: Live, commandId: string, label: 'worker.exit' | 'worker.fault' | 'worker.recover') => void = () => {};

  constructor(readonly s: SupervisorState) {}

  sessionDir(live: Live): string {
    const dir = join(this.s.stateDir, 'sessions', live.worker.worker_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Runs an event or read action; any failure faults only this worker, never the supervisor. */
  guarded(live: Live, action: () => void, memoryOnly = false): void {
    if (live.faulted) return;
    try {
      action();
    } catch (error) {
      this.fault(live, error, memoryOnly);
    }
  }

  wireHost(live: Live, host: SessionHost): void {
    // A retired generation's callbacks must not fault or rebind the current one.
    host.on('event', event => {
      if (live.host === host) this.guarded(live, () => this.onEvent(live, event));
    });
    host.on('exit', () => {
      if (live.host === host) this.guarded(live, () => this.onExit(live));
    });
  }

  private onEvent(live: Live, event: PiRecord): void {
    const w = live.worker;
    if (event.type === 'host_identity' && typeof event.sessionId === 'string' && typeof event.sessionFile === 'string') {
      if (w.session_id && w.session_id !== event.sessionId && !live.rebinding) throw new Error('unexpected_host_identity');
      if (!w.session_id) {
        this.s.noOtherWriter(event.sessionId, w.worker_id);
        w.session_id = event.sessionId;
        live.sessionFile = event.sessionFile;
        live.index = new SessionIndex(live.sessionFile);
        live.index.setActiveLeaf(typeof event.leafId === 'string' ? event.leafId : null);
        this.s.persist(live, 'worker.identity');
      }
    }
    if (event.type === 'host_leaf' && (typeof event.leafId === 'string' || event.leafId === null)) {
      live.index.setActiveLeaf(event.leafId);
      this.s.refresh(live);
    }
    if (event.type === 'message_end') live.completedMessages++;
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'tool_approval'].includes(String(event.method))) {
      // Until interactions land (P1-10) every dialog is cancelled at once through its exact resolver; pi sees a
      // cancel, never an invented answer. A failed cancel faults the worker closed.
      const host = live.host;
      void host
        ?.request({ type: 'answer_ui', nativeId: String(event.id), answer: { outcome: 'cancel' } })
        .then(r => {
          if (!r.success) throw new Error('dialog_cancel_failed');
        })
        .catch(error => {
          if (live.host === host) this.fault(live, error);
        });
    }
    for (const observe of this.observers) observe(live, event);
  }

  private onExit(live: Live): void {
    if (live.exited) return;
    live.exited = true;
    const w = live.worker;
    // A stop that already observed the group gone keeps that stronger evidence.
    if (w.status === 'stopped' && live.pid === null) return;
    if (live.moveTimer) {
      clearTimeout(live.moveTimer);
      live.moveTimer = undefined;
    }
    if (w.execution && w.execution.state !== 'settled') this.onUncertain(live, w.execution.command_id, 'worker.exit');
    // A leader exit is not proof that its process group has terminated.
    w.status = 'cleanup_pending';
    w.cleanup = 'leader_exit_only';
    this.s.persist(live, 'worker.exit');
  }

  /** Closes one worker after an event or storage failure; other workers stay up. Never rethrows. */
  fault(live: Live, error: unknown, memoryOnly = false): void {
    if (live.faulted) return;
    live.faulted = true;
    const w = live.worker;
    w.status = 'cleanup_pending';
    w.cleanup = 'worker_fault; cleanup_unproven';
    w.foreground = 'unknown';
    w.failure = { command_id: w.execution?.command_id ?? live.create?.command_id ?? 'unknown', reason: this.s.journal.failed ? 'journal_failure' : reasonOf(error) };
    if (w.execution && w.execution.state !== 'settled' && !memoryOnly) {
      try {
        this.onUncertain(live, w.execution.command_id, 'worker.fault');
      } catch {
        /* storage may be unavailable; the in-memory state still refuses writes */
      }
    }
    const report = () => {
      if (memoryOnly) return;
      try {
        this.s.persist(live, 'worker.fault');
      } catch {
        /* the journal may have failed; the worker stays closed in memory */
      }
    };
    report();
    const host = live.host;
    void (host ? host.stop() : Promise.resolve(false))
      .then(gone => {
        if (live.host !== host) return;
        w.status = gone ? 'failed' : 'cleanup_pending';
        w.cleanup = gone ? GROUP_GONE : 'worker_fault; cleanup_unproven';
        if (gone) live.pid = null;
        report();
      })
      .catch(() => report());
  }

  async create(c: Create): Promise<Receipt> {
    let cwd = '';
    let resumeFile: string | undefined;
    return this.s.receipts.run(
      c.command_id,
      'workers.create',
      c,
      async () => {
        const live = this.s.newWorker(cwd, c);
        const w = live.worker;
        this.s.persist(live, 'worker.create');
        this.s.receipts.dispatch(c.command_id, { worker_id: w.worker_id });
        let host: SessionHost;
        try {
          host = this.s.factory({ workerId: w.worker_id, create: c, cwd, sessionDir: this.sessionDir(live) });
        } catch (error) {
          // No host was constructed: the row ends terminal with its reason; the receipt stays unknown.
          w.status = 'failed';
          w.cleanup = 'no_process_started';
          w.failure = { command_id: c.command_id, reason: reasonOf(error) };
          this.s.persist(live, 'worker.failed');
          throw error;
        }
        live.host = host;
        live.pid = host.pid ?? null;
        live.token = host.token;
        this.s.persist(live, 'worker.spawned');
        this.wireHost(live, host);
        try {
          let state = await host.request({ type: 'get_state' });
          if (live.faulted) throw new Error('worker fault during initialization');
          if (!state.success || typeof state.data?.sessionId !== 'string' || typeof state.data.sessionFile !== 'string') {
            throw new Error('pi initialization did not return a session identity');
          }
          if (resumeFile) {
            live.rebinding = true;
            try {
              const opened = await host.request({ type: 'switch_session', sessionPath: resumeFile });
              if (!opened.success || opened.data?.cancelled) throw new Error('resume_session_open_failed');
              state = await host.request({ type: 'get_state' });
              if (!state.success || state.data?.sessionId !== c.resume_session_id) throw new Error('resumed_session_identity_mismatch');
            } finally {
              live.rebinding = false;
            }
          }
          const sessionId = String(state.data!.sessionId);
          this.s.noOtherWriter(sessionId, w.worker_id);
          w.session_id = sessionId;
          live.sessionFile = String(state.data!.sessionFile);
          live.index = new SessionIndex(live.sessionFile);
          live.index.setActiveLeaf(typeof state.data!.leafId === 'string' ? state.data!.leafId : null);
          this.s.refresh(live);
          // Readiness: resources loaded with no loader errors.
          const inventory = await host.request({ type: 'inventory' });
          if (!inventory.success || ((inventory.data?.extension_errors as unknown[] | undefined)?.length ?? 1) > 0) throw new Error('resource_inventory_failed');
          if (live.faulted) throw new Error('worker fault during initialization');
          w.resources = inventory.data!;
          w.status = 'ready';
          w.cleanup = 'live_process_group';
          live.observedIdle = true;
          this.s.persist(live, 'worker.ready');
          return {
            state: 'delivered',
            stage: 'forwarded',
            effect: 'observed',
            worker_id: w.worker_id,
            result: { worker_id: w.worker_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision },
            history_lag: w.history.lag,
          };
        } catch (error) {
          const gone = await host.stop();
          w.status = gone ? 'failed' : 'cleanup_pending';
          w.cleanup = gone ? GROUP_GONE : 'unresolved';
          if (gone) live.pid = null;
          w.failure = { command_id: c.command_id, reason: reasonOf(error) };
          this.s.persist(live, 'worker.failed');
          throw error;
        }
      },
      () => {
        if (c.parent || c.launch_spec) throw new Refusal('typed_child_launch_unsupported');
        try {
          if (!statSync(c.cwd).isDirectory()) throw new Error('not a directory');
          cwd = realpathSync(c.cwd);
        } catch {
          throw new Refusal('cwd_not_directory');
        }
        this.s.exclusiveCwd(cwd);
        if (c.resume_session_id) {
          this.s.noOtherWriter(c.resume_session_id, '');
          const known = this.s.sessionFiles.get(c.resume_session_id);
          if (!known) throw new Refusal('unknown_session');
          resumeFile = known.file;
        }
      },
    );
  }

  async stop(id: string, b: Binding): Promise<Receipt> {
    let live!: Live;
    return this.s.receipts.run(
      b.command_id,
      'workers.stop',
      { ...b, worker_id: id },
      async () => {
        const w = live.worker;
        const epoch = w.worker_epoch;
        this.s.receipts.dispatch(b.command_id, { worker_id: id });
        const result = (termination: string) => ({ termination, stopped_worker_epoch: epoch, current_worker_epoch: w.worker_epoch });
        if ((w.status === 'stopped' || w.status === 'failed') && live.pid === null) {
          return { state: 'delivered', stage: 'termination_observed', effect: 'observed', result: result('observed_stopped') };
        }
        w.status = 'cleanup_pending';
        w.cleanup = 'stop_requested';
        this.s.persist(live, 'worker.stop');
        const gone = live.host ? await live.host.stop() : live.pid !== null ? await killGroup(live.pid, live.token) : false;
        w.status = gone ? 'stopped' : 'cleanup_pending';
        w.cleanup = gone ? GROUP_GONE : 'unresolved';
        if (gone) live.pid = null;
        this.s.persist(live, 'worker.stopped');
        return gone
          ? { state: 'delivered', stage: 'termination_observed', effect: 'observed', result: result('observed_stopped') }
          : { state: 'outcome_unknown', stage: 'unknown', effect: 'unknown', result: result('unknown') };
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, b);
      },
    );
  }

  /**
   * After a restart, before the socket listens: no host is adopted or relaunched. Every worker that held a session
   * is `cleanup_pending`; its recorded process group is killed when the identity token still matches. The kill is
   * leader evidence only, so the worker stays pending.
   */
  async recover(): Promise<void> {
    for (const live of this.s.workers.values()) {
      const w = live.worker;
      w.supervisor_epoch = this.s.supervisorEpoch;
      w.pending_interactions = []; // Old native resolvers no longer exist.
      live.index.setActiveLeaf(w.leaf_id);
      for (const recover of this.recoverers) recover(live);
      if (!HOLDING.has(w.status)) continue;
      w.status = 'cleanup_pending';
      if (live.pid !== null) {
        const gone = await killGroup(live.pid, live.token);
        w.cleanup = gone ? 'process_group_killed_at_restart; escaped_descendants_unproven' : 'unresolved';
      } else if (w.cleanup === 'not_started') {
        // No process identity after a crash may be the spawn-to-record cut: never release the environment.
        w.cleanup = 'spawn_identity_unrecorded';
      } else if (!w.cleanup.includes('descendants_unproven') && w.cleanup !== 'unresolved') w.cleanup = 'unresolved';
      this.s.persist(live, 'worker.recover');
    }
  }

  /** Stops every live host; used on SIGTERM. Records what was observed. */
  async shutdown(): Promise<void> {
    for (const live of this.s.workers.values()) {
      if (!live.host || live.exited) continue;
      const gone = await live.host.stop();
      if (gone) live.pid = null;
    }
  }
}
