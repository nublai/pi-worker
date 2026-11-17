/**
 * Worker lifecycle: create, stop, pi exit, worker faults, restart recovery and shutdown. Rewritten from A0
 * `src/supervisor.ts` (`create`, `stop`, `onExit`, `fault`, `cleanup`, `recover`). A sandboxed worker (P2-4) has its
 * session directory inside its root and its history read through opens pinned below it (state.ts `confinement`).
 *
 * Rules kept from A0: one live writer per session and one worker per cwd, refused naming the holder; the starting
 * row (with the worker's cleanup domain) and the dispatch record are durable before pi is spawned, and the process
 * identity right after, before any request; a launch that fails after dispatch is `outcome_unknown`.
 *
 * Cleanup (P2-1): every worker runs in its own cgroup v2 domain (containment/). Stop, a pi exit, a worker fault, a
 * failed launch and a restart record `cleanup_pending` durably, then kill the domain (`cgroup.kill`), wait for
 * `populated 0` and remove it. Only a removal that is observed and recorded confirms cleanup
 * (`cgroup_empty_removed`, status `stopped` or `failed`): until then the worker holds its session and cwd and is
 * not resumable (invariant 2). A pi exit is leader evidence only; its domain is cleaned at once, so a detached tool
 * dies with it.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import { processGone } from '../host/process.js';
import type { ChildReport, PiRecord, SessionHost } from '../host/host.js';
import type { Containment, Domain } from '../containment/containment.js';
import type { DurableLabel } from '../journal/labels.js';
import { budgetKey } from '../journal/journal.js';
import type { Receipt, ReceiptPatch } from '../receipts/receipts.js';
import { sandboxed, sandboxSessionDir } from '../sandbox/sandbox.js';
import { confinement, HOLDING, type Binding, type Create, type KeptBinding, type Live, type SupervisorState } from './state.js';
import { currentGuard } from '../grants/authority.js';

/** A domain observed gone (`populated 0`, removed) and recorded: the only confirmed cleanup. */
export const CLEANED = 'cgroup_empty_removed';
/** A domain observed gone whose record could not be made durable: no confirmation, the worker stays pending. */
const UNRECORDED = 'cgroup_empty_unrecorded';
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message.slice(0, 256) : 'launch_failed');

export type Observer = (live: Live, event: PiRecord) => void;

/** Per-domain event observers; lifecycle's own runs first. Other modules register theirs (input, binding). */
export class Lifecycle {
  readonly observers: Observer[] = [];
  /** Per-domain recovery steps, run for every worker before its cleanup is recorded (input, fence). */
  readonly recoverers: ((live: Live) => void)[] = [];
  /** Called when a worker's execution can no longer settle (exit, fault, restart): the input module records it. */
  onUncertain: (live: Live, commandId: string, label: 'worker.exit' | 'worker.fault' | 'worker.recover' | 'worker.stop') => void = () => {};
  /** Typed launch checks (children module), run in create's validation before any record. */
  typedLaunch: (c: Create) => void = c => {
    if (c.parent || c.launch_spec) throw new Refusal('typed_child_launch_unsupported');
  };
  /** A typed child's FD 3 report (children module). */
  onReport: (live: Live, report: ChildReport) => void = () => {};
  /** Fences a parent on an uncertain child launch (children module). */
  fenceParent: (parentId: string, commandId: string) => void = () => {};
  /** A worker's process ended (exit, fault): a child without a durable result report fences its parent (children). */
  childEnded: (live: Live) => void = () => {};
  /** Writes allowed (input module): not fenced, no move in flight. A tool release is refused otherwise. */
  writable: (live: Live) => void = () => {
    throw new Error('input_not_wired');
  };
  /**
   * A create's first prompt, once its worker is ready (input module): the create's receipt patch with the execution or
   * the prompt's typed refusal.
   */
  firstPrompt: (live: Live, c: Create, created: ReceiptPatch) => Promise<ReceiptPatch> = async (_live, _c, created) => created;
  /** Joins an uncertain command to the worker's fence in memory (the fence module); the caller persists. */
  latch: (live: Live, commandId: string) => boolean = () => {
    throw new Error('fence_not_wired');
  };

  constructor(
    readonly s: SupervisorState,
    readonly containment: Containment,
  ) {}

  /**
   * Kills the worker's domain and waits for it to be removed; one cleanup at a time per worker (a later call shares
   * the one in flight). Marked before the kill starts, so a pi exit it causes starts no other. Never throws.
   */
  private terminate(live: Live): Promise<boolean> {
    if (!live.cleaning) {
      const domain = live.domain;
      const leader = { pid: live.pid, token: live.token };
      const cleaning = Promise.resolve()
        .then(async () => (domain ? (await this.containment.clean(domain)) && this.leaderGone(leader) : false))
        .catch(() => false)
        .finally(() => {
          if (live.cleaning === cleaning) live.cleaning = undefined;
        });
      live.cleaning = cleaning;
    }
    return live.cleaning;
  }

  /**
   * The domain's removal proves only what was still in it. The generation's pi leader is proven gone too, or the
   * cleanup is not confirmed (Grok PR #27): only OS evidence about the exact process this generation spawned counts
   * (`processGone`: its pid is absent or recycled, another boot, or a zombie with no live thread). A host `exit` event
   * is not that evidence: `LineHost` emits it on a transport failure (stdin EPIPE) while the process still runs
   * (Grok and GPT PR #27 delta). A leader that left the domain and still runs keeps the worker pending, so no relaunch
   * or resume starts a second writer beside it. A generation that spawned no process has no leader.
   */
  private leaderGone(leader: { pid: number | null; token: string | null }): boolean {
    return leader.pid === null || processGone(leader.pid, leader.token);
  }

  /**
   * A relaunch still initializing when its process ends (a stop, an exit, a fault) has an unknown outcome: pi may
   * have opened the session. It joins the fence in the row that records the end, before any cleanup can confirm and
   * admit another relaunch (GPT PR #27 finding 3). A stop also retires the attempt (`retire`): a stop wins, so the
   * attempt's late continuation, success or failure, never changes the worker again (GPT PR #27 delta D1).
   */
  private endLaunch(live: Live, retire = false): void {
    if (!live.launching) return;
    this.uncertainLaunch(live, live.launching);
    if (retire) live.launching = undefined;
  }

  /** A relaunch's unknown outcome joins the fence, unless the owner already resolved it: a resolution is final. */
  private uncertainLaunch(live: Live, commandId: string): void {
    if (!(live.worker.resolutions ?? []).some(r => r.command_id === commandId)) this.latch(live, commandId);
  }

  /**
   * Records confirmed cleanup under `label`. A row that cannot be made durable is no confirmation: the worker stays
   * `cleanup_pending` and keeps its session and cwd (A0: no durable proof, no lease release). Never throws.
   */
  private confirm(live: Live, status: 'stopped' | 'failed', label: DurableLabel): boolean {
    const w = live.worker;
    const pid = live.pid;
    w.status = status;
    w.cleanup = CLEANED;
    live.pid = null;
    try {
      this.s.persist(live, label);
      return true;
    } catch {
      w.status = 'cleanup_pending';
      w.cleanup = UNRECORDED;
      live.pid = pid;
      return false;
    }
  }

  /** After a pi exit: the leader is gone, its domain may not be. Records the confirmation unless a stop or fault took over. */
  private async cleanAfterExit(live: Live): Promise<void> {
    const domain = live.domain;
    const gone = await this.terminate(live);
    const w = live.worker;
    // Evidence about a superseded generation's domain never retires the generation a relaunch brought up since.
    if (live.domain !== domain) return;
    if (live.faulted || w.status !== 'cleanup_pending' || w.cleanup !== 'leader_exit_only') return;
    if (gone && this.confirm(live, 'stopped', 'worker.cleaned')) return;
    w.cleanup = gone ? UNRECORDED : 'unresolved';
    // The durable row says what is known: the leader is gone and its domain is not proven gone (A0 review 5).
    try {
      this.s.persist(live, 'worker.exit');
    } catch {
      /* the journal may have failed; the row still says cleanup_pending */
    }
  }

  /**
   * Where pi writes the worker's session files: below the state directory, or for a sandboxed worker inside its root
   * (`ROOT/.piw-worker/sessions/<id>`, made through pinned opens), the only tree its pi can write.
   */
  sessionDir(live: Live): string {
    const root = confinement(live.worker);
    if (root) return sandboxSessionDir(root, live.worker.worker_id);
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
    host.on('report', report => {
      if (live.host === host) this.guarded(live, () => this.onReport(live, report));
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
        live.index = this.s.index(live, live.sessionFile);
        live.index.setActiveLeaf(typeof event.leafId === 'string' ? event.leafId : null);
        this.s.persist(live, 'worker.identity');
      }
    }
    if (event.type === 'host_leaf' && (typeof event.leafId === 'string' || event.leafId === null)) {
      live.index.setActiveLeaf(event.leafId);
      this.s.refresh(live);
    }
    if (event.type === 'message_end') live.completedMessages++;
    // Dialogs become typed interactions (P1-10): metadata durable, payload in memory, answered through the exact
    // resolver. Only the resolver's own close ends one; a gate check asks for a tool release.
    const interactions = this.s.interactions;
    if (event.type === 'extension_ui_request' && live.host && interactions) interactions.open(w, live.host, event);
    if (event.type === 'resolver_closed' && interactions) interactions.resolverClosed(w.worker_id, String(event.native_id), String(event.outcome));
    // Every gate ends with one terminal notification; it settles the approval the gate owned.
    if ((event.type === 'gate_closed' || event.type === 'gate_released') && interactions) interactions.gateEnded(w.worker_id, String(event.gate_token), event.type === 'gate_released');
    if (event.type === 'gate_check' && interactions) {
      const host = live.host;
      void interactions.gate(w, event, () => this.writable(live)).catch(error => {
        if (live.host === host) this.fault(live, error);
      });
    }
    for (const observe of this.observers) observe(live, event);
  }

  private onExit(live: Live): void {
    if (live.exited) return;
    live.exited = true;
    const w = live.worker;
    // The process and its resolvers are gone: every interaction of the worker is interrupted.
    this.s.interactions?.invalidate(w.worker_id, 'interrupted');
    // A child that died without a durable result report fences its parent now, not only after a restart (4a).
    this.childEnded(live);
    // A stop that already observed the group gone keeps that stronger evidence.
    if (w.status === 'stopped' && live.pid === null) return;
    if (live.moveTimer) {
      clearTimeout(live.moveTimer);
      live.moveTimer = undefined;
    }
    if (w.execution && w.execution.state !== 'settled') this.onUncertain(live, w.execution.command_id, 'worker.exit');
    this.endLaunch(live);
    // A leader exit is not proof that its process group has terminated.
    w.status = 'cleanup_pending';
    w.cleanup = 'leader_exit_only';
    this.s.persist(live, 'worker.exit');
    // Kill what the leader left behind (a detached tool) now, not at a stop or restart. A stop, fault or failed launch
    // that caused this exit already owns the domain's cleanup.
    if (!live.cleaning) void this.cleanAfterExit(live);
  }

  /** Closes one worker after an event or storage failure; other workers stay up. Never rethrows. */
  fault(live: Live, error: unknown, memoryOnly = false): void {
    if (live.faulted) return;
    live.faulted = true;
    const w = live.worker;
    try {
      this.s.interactions?.invalidate(w.worker_id, 'interrupted');
    } catch {
      /* storage may be unavailable; the faulted worker refuses answers in memory */
    }
    w.status = 'cleanup_pending';
    w.cleanup = 'worker_fault; cleanup_unproven';
    w.foreground = 'unknown';
    w.failure = { command_id: w.execution?.command_id ?? live.create?.command_id ?? 'unknown', reason: this.s.journal.failed ? 'journal_failure' : reasonOf(error) };
    this.endLaunch(live);
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
    // A faulted child is closed like an exit (its later exit event is ignored): the same live missing-report check.
    try {
      this.childEnded(live);
    } catch {
      /* storage may be unavailable; recovery fences the parent from the durable records */
    }
    // A storage failure never suppresses the kill; it only withholds the confirmation.
    const host = live.host;
    void this.terminate(live).then(gone => {
      if (live.host !== host) return;
      if (gone && !memoryOnly && this.confirm(live, 'failed', 'worker.fault')) return;
      w.status = 'cleanup_pending';
      w.cleanup = gone ? UNRECORDED : 'worker_fault; cleanup_unproven';
      report();
    });
  }

  /**
   * `lineage` names the parent and its launch command of an untyped child launched through `children.launch`; a typed
   * child carries `parent` in its create. Either way the lineage is in the starting row, durable before any spawn.
   */
  async create(c: Create, lineage?: { parent_worker_id: string; parent_launch_command_id: string }): Promise<Receipt> {
    let cwd = '';
    let resumeFile: string | undefined;
    const receipt = await this.s.receipts.run(
      c.command_id,
      'workers.create',
      c,
      async () => {
        const live = this.s.newWorker(cwd, c);
        const w = live.worker;
        if (c.launch_spec) w.launch_spec = structuredClone(c.launch_spec);
        if (c.parent) {
          w.parent = structuredClone(c.parent);
          w.parent_worker_id = c.parent.worker_id;
          w.parent_launch_command_id = c.command_id;
        } else if (lineage) {
          w.parent_worker_id = lineage.parent_worker_id;
          w.parent_launch_command_id = lineage.parent_launch_command_id;
        }
        // The grant that created it: a typed child's reports and its own children recheck it.
        const grantId = currentGuard()?.grant_id;
        if (grantId) w.grant_source_id = grantId;
        // One live writer: the resume target is reserved atomically with validation, before any await, and stays
        // reserved through opening, identity checks and failure cleanup (the same reservations as sessions.rebind).
        const target = c.resume_session_id;
        if (target) this.s.sessionReservations.set(target, w.worker_id);
        // The reservation also becomes durable: the starting row (`worker.create`, before dispatch and before any host
        // starts) carries the target, so a restart attributes it to this worker instead of releasing it.
        if (target && resumeFile) live.resume = { session_id: target, file: resumeFile };
        try {
          return await this.launch(live, c, cwd, resumeFile);
        } finally {
          if (target && this.s.sessionReservations.get(target) === w.worker_id) this.s.sessionReservations.delete(target);
        }
      },
      () => {
        this.typedLaunch(c);
        // A queued untyped launch that comes due while a sibling's missing-report check is pending waits for it (4a).
        if (lineage && this.s.childEnding.has(lineage.parent_worker_id)) throw new Refusal('child_end_unsettled');
        try {
          if (!statSync(c.cwd).isDirectory()) throw new Error('not a directory');
          cwd = realpathSync(c.cwd);
        } catch {
          throw new Refusal('cwd_not_directory');
        }
        this.s.exclusiveCwd(cwd);
        // The same session gates as every other resume: a new worker identity never erases session uncertainty.
        if (c.resume_session_id) resumeFile = this.s.resumable(c.resume_session_id, '', sandboxed(c.launch_spec) ? cwd : undefined);
      },
    );
    // A typed child whose launch may have run fences its parent: the parent cannot simply launch a replacement.
    if (c.parent && receipt.effect === 'unknown') this.fenceParent(c.parent.worker_id, c.command_id);
    return receipt;
  }

  /**
   * The dispatched part of create: the host's start, then the first prompt, if any. The prompt runs outside the start's
   * failure path: whatever becomes of it, the worker is created.
   */
  private async launch(live: Live, c: Create, cwd: string, resumeFile: string | undefined): Promise<ReceiptPatch> {
    const created = await this.start(live, c, cwd, resumeFile);
    return c.first_prompt ? this.firstPrompt(live, c, created) : created;
  }

  /** The host's start: spawn, identity, optional resume, readiness. */
  private async start(live: Live, c: Create, cwd: string, resumeFile: string | undefined): Promise<ReceiptPatch> {
    const w = live.worker;
    // The domain is reserved with the worker epoch and recorded in the starting row, before anything is spawned.
    live.domain = this.containment.reserve(w.worker_epoch);
    try {
      this.s.persist(live, 'worker.create');
    } catch (error) {
      // No starting row, no dispatch: nothing ran, and the worker never existed beyond memory.
      this.s.workers.delete(w.worker_id);
      this.s.journal.release(budgetKey(w.worker_id));
      throw error;
    }
    this.s.receipts.dispatch(c.command_id, { worker_id: w.worker_id });
    let host: SessionHost;
    try {
      const domain = live.domain;
      const prefix = this.containment.enter(domain);
      const root = confinement(w);
      host = this.s.factory({ workerId: w.worker_id, commandId: c.command_id, create: c, cwd, sessionDir: this.sessionDir(live), domain, prefix, ...(root ? { sandbox: root } : {}) });
    } catch (error) {
      // No host was constructed: the domain (if it was created) is cleaned and the row ends with its reason; the
      // receipt stays unknown, so a resume target is held and fenced like any other unknown create-with-resume.
      this.holdUnknownResume(live, c, resumeFile);
      await this.launchFailed(live, c.command_id, error);
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
      live.index = this.s.index(live, live.sessionFile);
      live.index.setActiveLeaf(typeof state.data!.leafId === 'string' ? state.data!.leafId : null);
      this.s.refresh(live);
      // Readiness: resources loaded with no loader errors.
      const inventory = await host.request({ type: 'inventory' });
      if (!inventory.success || ((inventory.data?.extension_errors as unknown[] | undefined)?.length ?? 1) > 0) throw new Error('resource_inventory_failed');
      if (live.faulted) throw new Error('worker fault during initialization');
      w.resources = inventory.data!;
      w.status = 'ready';
      w.cleanup = 'live_cgroup';
      live.observedIdle = true;
      // The binding to the target is recorded in this row: the session id now carries the reservation.
      delete live.resume;
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
      // pi may have run the target's switch hooks or opened it: the failed worker holds it (or blocks it as unproven
      // cleanup) after the reservation ends, never releasing it to another writer, and the unknown fences it.
      this.holdUnknownResume(live, c, resumeFile);
      await this.launchFailed(live, c.command_id, error);
      throw error;
    }
  }

  /** A launch that failed after its dispatch record: the domain is cleaned; `failed` only once that is recorded. */
  private async launchFailed(live: Live, commandId: string, error: unknown): Promise<void> {
    const w = live.worker;
    w.failure = { command_id: commandId, reason: reasonOf(error) };
    const gone = await this.terminate(live);
    if (gone && this.confirm(live, 'failed', 'worker.failed')) return;
    w.status = 'cleanup_pending';
    w.cleanup = gone ? UNRECORDED : 'unresolved';
    this.s.persist(live, 'worker.failed');
  }

  /**
   * A create-with-resume that fails after its dispatch record ends `outcome_unknown`: pi may have run the target's
   * `session_before_switch` hooks or opened it. The worker takes the target as its session and the unknown fences it
   * (invariant 3), in the same durable row as the failure and before the receipt is final. The target is then refused
   * `target_session_fenced` naming this command until `sessions.resolve_unknown`, even once cleanup is confirmed.
   */
  private holdUnknownResume(live: Live, c: Create, resumeFile: string | undefined): void {
    delete live.resume;
    if (!c.resume_session_id || !resumeFile) return;
    const w = live.worker;
    w.session_id = c.resume_session_id;
    w.leaf_id = null;
    live.sessionFile = resumeFile;
    live.index = this.s.index(live, resumeFile);
    this.latch(live, c.command_id);
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
        // The kill ends whatever runs: an unsettled execution's outcome is unknown and fences the session in this row,
        // durably before the kill. The domain can be observed empty before pi's exit event arrives (or the exit never
        // reports it), and a confirmed stop must never leave a relaunchable worker with an unfenced execution.
        const running = w.execution;
        if (running && running.state !== 'settled' && this.s.receipts.all.get(running.command_id)?.effect !== 'no_effect') this.onUncertain(live, running.command_id, 'worker.stop');
        // So is a relaunch still initializing: it fences in the same row, durably before the kill, and is retired.
        this.endLaunch(live, true);
        // cleanup_pending is durable before the kill: a crash between them leaves a pending row recovery cleans.
        w.status = 'cleanup_pending';
        w.cleanup = 'stop_requested';
        this.s.persist(live, 'worker.stop');
        const domain = live.domain;
        const cleaned = await this.terminate(live);
        // A relaunch brought up a new generation meanwhile: this stop's outcome is about the old domain only. It is
        // reported as that, and the live generation's row, process and domain stay untouched (A0 issue #1).
        if (live.domain !== domain) {
          return cleaned
            ? { state: 'delivered', stage: 'termination_observed', effect: 'observed', result: result('superseded_generation_stopped') }
            : { state: 'outcome_unknown', stage: 'unknown', effect: 'unknown', result: result('superseded_generation_unknown') };
        }
        const gone = cleaned && this.confirm(live, 'stopped', 'worker.stopped');
        if (!gone) {
          w.status = 'cleanup_pending';
          if (w.cleanup !== UNRECORDED) w.cleanup = 'unresolved';
          this.s.persist(live, 'worker.stopped');
        }
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
   * `workers.relaunch` (P2-3): a fresh pi process for a stopped or failed worker, in a new domain at a new epoch, on
   * the worker's own session file, without prompting. Refused `no_effect` before any record unless the previous
   * epoch's domain was observed removed and that is recorded, the session is not fenced, and no other worker holds the
   * session or the cwd. The new epoch's starting row (its domain, and the binding every recovered prompt intent was
   * admitted with) is durable before the dispatch record and before anything is spawned. A launch that fails after the
   * dispatch record cleans its domain like a failed create. Once a host exists it is `outcome_unknown` and fences the
   * session (invariant 3: pi may have run its switch hooks or opened the session), in the failure row before the reply;
   * only a spawn refused before any host existed, with its domain observed removed, is proven `no_effect`.
   */
  async relaunch(id: string, b: Binding): Promise<Receipt> {
    let live!: Live;
    return this.s.receipts.run(
      b.command_id,
      'workers.relaunch',
      { ...b, worker_id: id },
      async () => this.relaunched(live, b.command_id),
      () => {
        live = this.s.require(id);
        this.s.binding(live, b);
        const w = live.worker;
        if (w.parent_worker_id) throw new Refusal('child_relaunch_unsupported');
        // Only a recorded, observed removal of the last epoch's domain: a live, starting or pending worker is refused.
        if ((w.status !== 'stopped' && w.status !== 'failed') || w.cleanup !== CLEANED || !live.domain || live.pid !== null) {
          throw new Refusal('cleanup_pending_or_cleanup_unproven');
        }
        this.writable(live);
        if (!live.create || !w.session_id || !live.sessionFile || !existsSync(live.sessionFile)) throw new Refusal('relaunch_session_unavailable');
        // The session's gates, not only this worker's (GPT PR #27 finding 1): the resume gate refuses a session another
        // worker bound since and left fenced (`target_session_fenced`) or with its cleanup unproven, as for a resume.
        this.s.resumable(w.session_id, id, confinement(w));
        this.s.exclusiveCwd(w.cwd, live);
      },
    );
  }

  /** The dispatched part of a relaunch; its first part, up to the spawn, runs atomically with the validation. */
  private async relaunched(live: Live, commandId: string): Promise<ReceiptPatch> {
    const w = live.worker;
    const sessionId = w.session_id!;
    const file = live.sessionFile!;
    const before = { worker: structuredClone(w), domain: live.domain, kept: live.kept };
    // The previous generation is retired before the new epoch exists: its host's callbacks and any cleanup still
    // running for its domain (each checks live.host or live.domain) no longer touch this worker.
    live.host = undefined;
    live.cleaning = undefined;
    // Every prompt intent a restart recovered keeps the binding it was admitted with (this generation's, which a
    // stopped worker still has); the first successful relaunch on that session and revision becomes its one epoch.
    const kept: Record<string, KeptBinding> = {};
    for (const r of this.s.receipts.all.values()) {
      if (r.worker_id !== w.worker_id || r.operation !== 'sessions.prompt' || !['intent_recovered', 'intent_ready'].includes(r.state)) continue;
      kept[r.command_id] = live.kept?.[r.command_id] ?? { worker_epoch: w.worker_epoch, session_id: sessionId, binding_revision: w.binding_revision };
    }
    live.kept = kept;
    w.worker_epoch = randomUUID();
    w.supervisor_epoch = this.s.supervisorEpoch;
    w.status = 'starting';
    w.cleanup = 'not_started';
    w.execution = null;
    w.foreground = 'idle';
    delete w.failure;
    live.exited = false;
    live.faulted = false;
    live.nativeRebinding = false;
    live.pid = null;
    live.token = null;
    live.domain = this.containment.reserve(w.worker_epoch);
    try {
      this.s.persist(live, 'worker.relaunch');
    } catch (error) {
      // No starting row, no dispatch: nothing ran, and the worker is the stopped one it was.
      Object.assign(w, before.worker);
      if (!('failure' in before.worker)) delete w.failure;
      live.domain = before.domain;
      live.kept = before.kept;
      throw error;
    }
    this.s.receipts.dispatch(commandId, { worker_id: w.worker_id });
    live.launching = commandId;
    try {
      return await this.initialize(live, commandId, sessionId, file);
    } finally {
      if (live.launching === commandId) live.launching = undefined;
    }
  }

  /** A dispatched relaunch: spawn, reopen and verify the session, readiness. */
  private async initialize(live: Live, commandId: string, sessionId: string, file: string): Promise<ReceiptPatch> {
    const w = live.worker;
    // The model and thinking level the worker has now (session.configure may have changed them since the create).
    const create: Create = { ...live.create!, ...(w.model ? { provider: w.model.provider, model: w.model.id } : {}), ...(w.thinking ? { thinking: w.thinking } : {}) };
    let host: SessionHost;
    try {
      const domain = live.domain!;
      const root = confinement(w);
      host = this.s.factory({ workerId: w.worker_id, commandId, create, cwd: w.cwd, sessionDir: this.sessionDir(live), domain, prefix: this.containment.enter(domain), ...(root ? { sandbox: root } : {}) });
    } catch (error) {
      live.launching = undefined;
      await this.launchFailed(live, commandId, error);
      // No host was constructed, so no switch was ever sent, and the domain is observed removed and recorded: nothing
      // of this relaunch ran. Otherwise its outcome is unknown and fences the session like any other.
      if (w.status === 'failed' && w.cleanup === CLEANED) throw new ProvenNoEffect(`relaunch_spawn_refused: ${reasonOf(error)}`, 'no_host_constructed_no_session_opened_domain_removed');
      this.uncertainLaunch(live, commandId);
      this.s.persist(live, 'worker.failed');
      throw error;
    }
    live.host = host;
    live.pid = host.pid ?? null;
    live.token = host.token;
    this.s.persist(live, 'worker.spawned');
    this.wireHost(live, host);
    // pi starts on a new session of its own, then switches to the worker's: a B2-owned move, not a native one.
    live.rebinding = true;
    try {
      const init = await host.request({ type: 'get_state' });
      if (live.faulted) throw new Error('worker fault during initialization');
      if (!init.success) throw new Error('fresh_host_initialization_failed');
      const opened = await host.request({ type: 'switch_session', sessionPath: file });
      if (!opened.success || opened.data?.cancelled) throw new Error('fresh_host_session_open_failed');
      const state = await host.request({ type: 'get_state' });
      // The exact session and file, not only a successful switch.
      if (!state.success || state.data?.sessionId !== sessionId || state.data?.sessionFile !== file || live.faulted) throw new Error('fresh_host_session_identity_mismatch');
      live.rebinding = false;
      this.s.noOtherWriter(sessionId, w.worker_id);
      live.index = this.s.index(live, file);
      live.index.setActiveLeaf(typeof state.data.leafId === 'string' ? state.data.leafId : null);
      live.completedMessages = 0;
      this.s.refresh(live);
      const inventory = await host.request({ type: 'inventory' });
      // Only the attempt still in flight publishes readiness: not one a stop retired (with or without a newer epoch
      // since), nor one whose process ended meanwhile.
      if (live.host !== host || live.launching !== commandId || w.status !== 'starting') throw new Error('relaunch_superseded');
      if (!inventory.success || ((inventory.data?.extension_errors as unknown[] | undefined)?.length ?? 1) > 0) throw new Error('resource_inventory_failed');
      if (live.faulted) throw new Error('worker fault during initialization');
      w.resources = inventory.data!;
      w.status = 'ready';
      w.cleanup = 'live_cgroup';
      live.observedIdle = true;
      // A failed attempt binds no kept intent: only this verified launch does, and only one that has no epoch yet.
      for (const k of Object.values(live.kept ?? {})) {
        if (!k.relaunch_epoch && k.session_id === w.session_id && k.binding_revision === w.binding_revision) k.relaunch_epoch = w.worker_epoch;
      }
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
      // A retired attempt (its process ended and a newer relaunch brought up another generation since) reports its own
      // unknown outcome only: whatever ended it already fenced it, and the newer generation's state, process and domain
      // stay untouched (GPT PR #27 finding 3). So does one a stop retired: the stop's row stands (GPT PR #27 delta D1).
      if (live.host !== host || live.launching !== commandId) throw error;
      live.rebinding = false;
      live.launching = undefined;
      // pi may have run the session's switch hooks or opened it: the unknown fences the session in the failure row.
      this.uncertainLaunch(live, commandId);
      await this.launchFailed(live, commandId, error);
      throw error;
    }
  }

  /** The recorded domains recovery cleans and records itself: every holding worker's (the startup sweep skips them). */
  pendingDomains(): Domain[] {
    return [...this.s.workers.values()].flatMap(live => (live.domain && HOLDING.has(live.worker.status) ? [structuredClone(live.domain)] : []));
  }

  /**
   * After a restart, before the socket listens: no host is adopted or relaunched. Every worker that held a session
   * is recorded `cleanup_pending`, then its recorded domain is killed and removed; only an observed, recorded removal
   * makes it `stopped`. A domain that cannot be proven clean leaves the worker pending, holding its session and cwd.
   */
  async recover(): Promise<void> {
    for (const live of this.s.workers.values()) {
      const w = live.worker;
      w.supervisor_epoch = this.s.supervisorEpoch;
      w.pending_interactions = []; // Old native resolvers no longer exist.
      const attributed = this.attributeResume(live);
      live.index.setActiveLeaf(w.leaf_id);
      const before = JSON.stringify(w);
      for (const recover of this.recoverers) recover(live);
      if (!HOLDING.has(w.status)) {
        // A stopped or failed worker keeps its status; a fence recovery derived for it is still made durable.
        if (attributed || JSON.stringify(w) !== before) this.s.persist(live, 'worker.recover');
        continue;
      }
      w.status = 'cleanup_pending';
      w.cleanup = 'unresolved';
      this.s.persist(live, 'worker.recover');
      if (await this.terminate(live)) this.confirm(live, 'stopped', 'worker.cleaned');
    }
  }

  /**
   * A durable resume target whose binding was never recorded: pi may have opened it before the crash. The worker holds
   * it from now on, exactly as an in-process failed resume does, so the target is refused (naming this worker) and
   * blocked by its unproven cleanup until that cleanup is confirmed. Its record then carries the target as its session.
   */
  private attributeResume(live: Live): boolean {
    const target = live.resume;
    if (!target) return false;
    delete live.resume;
    if (live.worker.session_id === target.session_id) return true;
    live.worker.session_id = target.session_id;
    live.worker.leaf_id = null;
    live.sessionFile = target.file;
    live.index = this.s.index(live, live.sessionFile);
    return true;
  }

  /** Kills every live worker's domain; used on SIGTERM. Records nothing: the next start cleans and confirms. */
  async shutdown(): Promise<void> {
    for (const live of this.s.workers.values()) {
      if (!live.host || live.exited) continue;
      if (await this.terminate(live)) live.pid = null;
    }
  }
}
