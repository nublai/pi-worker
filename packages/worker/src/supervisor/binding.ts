/**
 * Binding changes: `sessions.rebind` (new, fork, resume, navigate), `sessions.new`, and native moves pi makes on its
 * own (an extension's `/new`, fork, resume or tree move). Rewritten from A0 `src/supervisor.ts` (`rebind`,
 * `nativeBinding`, `reconcileNativeMove`).
 *
 * Every move bumps the binding revision, so a mutation naming the old binding is refused `stale_binding`. A B2 move
 * owns its revision (native events during it are its own). A native move is announced before pi invalidates the old
 * session (`host_binding_changing`): writes refuse `binding_change_in_progress` until pi binds, and if it never does
 * the supervisor reconciles from pi's state after `nativeMoveTimeoutMs` (15 s) instead of refusing forever. A move
 * that fails after its dispatch record is `outcome_unknown`: it fences the session and faults the worker.
 */
import { Refusal } from '../b2/errors.js';
import { SessionIndex } from '../history/session-index.js';
import type { PiRecord, SessionHost } from '../host/host.js';
import type { Receipt } from '../receipts/receipts.js';
import type { Fence } from './fence.js';
import type { Input } from './input.js';
import type { Lifecycle } from './lifecycle.js';
import type { Binding, Live, SupervisorState } from './state.js';

export type Rebind = import('../generated/api.js').components['schemas']['Rebind'];

export class Bindings {
  /** A native move that announces itself but never binds is reconciled from pi's state after this delay. */
  nativeMoveTimeoutMs = 15_000;

  constructor(
    readonly s: SupervisorState,
    readonly lifecycle: Lifecycle,
    readonly input: Input,
    readonly fence: Fence,
  ) {
    lifecycle.observers.push((live, event) => this.observe(live, event));
  }

  private observe(live: Live, event: PiRecord): void {
    if (event.type === 'host_binding_changing' && !live.rebinding) {
      live.nativeRebinding = true;
      if (live.moveTimer) clearTimeout(live.moveTimer);
      const host = live.host;
      live.moveTimer = setTimeout(() => {
        live.moveTimer = undefined;
        void this.reconcile(live, host);
      }, this.nativeMoveTimeoutMs);
      live.moveTimer.unref();
    }
    if (event.type === 'host_binding') this.native(live, event);
  }

  /** A native move: whatever session pi now reports becomes the binding, always at a new revision. */
  private native(live: Live, event: PiRecord): void {
    if (live.rebinding) return; // A B2 move owns this event and commits exactly one revision.
    if (typeof event.sessionId !== 'string' || typeof event.sessionFile !== 'string') throw new Error('native_binding_identity_missing');
    const w = live.worker;
    this.s.noOtherWriter(event.sessionId, w.worker_id);
    const initialized = w.session_id !== null;
    if (initialized) {
      this.input.dropQueued(live, 'binding_changed');
      w.binding_revision++;
    }
    w.session_id = event.sessionId;
    live.sessionFile = event.sessionFile;
    live.index = new SessionIndex(live.sessionFile);
    live.index.setActiveLeaf(typeof event.leafId === 'string' ? event.leafId : null);
    live.completedMessages = 0;
    live.nativeRebinding = false;
    if (live.moveTimer) {
      clearTimeout(live.moveTimer);
      live.moveTimer = undefined;
    }
    if (initialized) {
      w.execution = null;
      w.foreground = w.fence ? 'unknown' : 'idle';
    }
    this.s.refresh(live);
    this.s.persist(live, 'binding.native');
  }

  /** After a native move that never bound: bind what pi reports now, or fault (stop stays available). */
  private async reconcile(live: Live, host: SessionHost | undefined): Promise<void> {
    if (!live.nativeRebinding || live.host !== host || !host || live.exited) return;
    try {
      const state = await host.request({ type: 'get_state' });
      if (!live.nativeRebinding || live.host !== host) return;
      if (!state.success || typeof state.data?.sessionId !== 'string' || typeof state.data.sessionFile !== 'string') throw new Error('native_move_unreconciled');
      const data = state.data;
      this.lifecycle.guarded(live, () => this.native(live, { type: 'host_binding', action: 'reconciled', sessionId: data.sessionId, sessionFile: data.sessionFile, leafId: data.leafId ?? null }));
    } catch (error) {
      this.lifecycle.fault(live, error);
    }
  }

  newSession(id: string, b: Binding): Promise<Receipt> {
    return this.move(id, { ...b, action: 'new' }, 'sessions.new', b);
  }

  rebind(id: string, b: Rebind): Promise<Receipt> {
    return this.move(id, b, 'sessions.rebind', b);
  }

  private async move(id: string, b: Rebind, operation: 'sessions.rebind' | 'sessions.new', request: Binding | Rebind): Promise<Receipt> {
    const prior = this.s.receipts.all.get(b.command_id);
    const fresh = !prior || prior.state === 'intent_ready';
    let live!: Live;
    let target: string | undefined;
    const receipt = await this.s.receipts.run(
      b.command_id,
      operation,
      { ...request, worker_id: id },
      async () => {
        const w = live.worker;
        this.input.writable(live);
        if (b.target_session_id) {
          this.s.noOtherWriter(b.target_session_id, id);
          this.s.sessionReservations.set(b.target_session_id, id);
        }
        live.rebinding = true;
        try {
          this.s.receipts.dispatch(b.command_id, { worker_id: id });
          const command: PiRecord =
            b.action === 'new'
              ? { type: 'new_session' }
              : b.action === 'resume'
                ? { type: 'switch_session', sessionPath: target! }
                : b.action === 'navigate'
                  ? { type: 'navigate', entryId: b.entry_id! }
                  : { type: 'fork', entryId: b.entry_id! };
          const response = await live.host!.request(command);
          if (!response.success || response.data?.cancelled) throw new Refusal('pi_binding_change_cancelled', 'unknown');
          const state = await live.host!.request({ type: 'get_state' });
          if (!state.success || typeof state.data?.sessionId !== 'string' || typeof state.data.sessionFile !== 'string') throw new Error('binding_identity_unavailable');
          if (b.action === 'resume' && state.data.sessionId !== b.target_session_id) throw new Error('resumed_session_identity_mismatch');
          try {
            this.s.noOtherWriter(state.data.sessionId, id);
          } catch (error) {
            throw new Refusal(error instanceof Error ? error.message : 'post_write_binding_refusal', 'unknown');
          }
          this.input.dropQueued(live, 'binding_changed');
          w.session_id = state.data.sessionId;
          w.binding_revision++;
          w.session_identity_evidence = 'pi_sdk_session_id';
          live.sessionFile = state.data.sessionFile;
          live.index = new SessionIndex(live.sessionFile);
          live.index.setActiveLeaf(typeof state.data.leafId === 'string' ? state.data.leafId : null);
          live.completedMessages = 0;
          w.leaf_id = null;
          w.execution = null;
          w.foreground = 'idle';
          live.observedIdle = true;
          this.s.refresh(live);
          this.s.persist(live, 'binding.rebind');
          return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: { session_id: w.session_id, binding_revision: w.binding_revision } };
        } finally {
          live.rebinding = false;
          if (b.target_session_id && this.s.sessionReservations.get(b.target_session_id) === id) this.s.sessionReservations.delete(b.target_session_id);
        }
      },
      () => {
        live = this.s.require(id);
        const w = live.worker;
        this.input.writable(live);
        this.s.binding(live, b);
        if (w.status !== 'ready' || !live.host || live.faulted) throw new Refusal('cleanup_pending_or_worker_not_ready');
        if (w.foreground !== 'idle') throw new Refusal('binding_change_requires_idle');
        this.s.refresh(live);
        if (b.action === 'fork' || b.action === 'navigate') {
          if (b.source_leaf_id === undefined || b.source_leaf_id !== w.leaf_id) throw new Refusal('stale_source_leaf');
          if (!b.entry_id || !live.index.hasEntry(b.entry_id)) throw new Refusal('unknown_fork_entry');
        }
        if (b.action === 'resume') {
          if (!b.target_session_id) throw new Refusal('target_session_id_required');
          this.s.noOtherWriter(b.target_session_id, id);
          const known = this.s.sessionFiles.get(b.target_session_id);
          if (!known) throw new Refusal('unknown_session');
          const owner = this.s.require(known.worker_id);
          if (known.worker_id !== id && (owner.worker.status === 'cleanup_pending' || owner.worker.cleanup.includes('escaped_descendants_unproven'))) {
            throw new Refusal('target_cleanup_unproven');
          }
          if (owner.worker.fence) throw new Refusal('target_session_fenced', 'no_effect', owner.worker.fence.command_id);
          target = known.file;
        }
      },
    );
    if (fresh && receipt.state === 'outcome_unknown') {
      // The move may have happened: fence durably, then close the worker (stop stays available).
      const uncertain = this.s.require(id);
      if (this.fence.latch(uncertain, b.command_id)) this.s.persist(uncertain, 'fence.latch');
      this.lifecycle.fault(uncertain, new Error('binding_change_unknown'));
    }
    return receipt;
  }
}
