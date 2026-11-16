/**
 * Supervisor state shared by the domain modules (lifecycle, input, fence, binding): the worker table, durable worker
 * records, the fence latch, binding and writer checks. Rewritten from A0 `src/supervisor.ts`, split by domain.
 *
 * pi owns the transcript; the supervisor owns control records. A worker record is journaled before anything that
 * depends on it is observable (a fence before the refusal or reply it causes).
 */
import { randomUUID } from 'node:crypto';
import type { components } from '../generated/api.js';
import { Refusal } from '../b2/errors.js';
import type { SessionHost } from '../host/host.js';
import type { Journal } from '../journal/journal.js';
import type { DurableLabel } from '../journal/labels.js';
import { SessionIndex } from '../history/session-index.js';
import { EventHub } from '../events/hub.js';
import type { JournalAppended } from '../generated/events.js';
import type { Interactions } from '../interactions/interactions.js';
import type { ReceiptStore } from '../receipts/receipts.js';
import type { Guard } from '../grants/authority.js';

export type Worker = components['schemas']['Worker'];
export type Create = components['schemas']['Create'];
export type Binding = components['schemas']['Binding'];
export type Prompt = components['schemas']['Prompt'];
export type FollowUp = components['schemas']['FollowUp'];
export type Steer = components['schemas']['Steer'];
export type Control = components['schemas']['Control'];

/** A queued input: its payload stays in memory only; a restart recovers its intent `no_effect`. */
export interface Queued {
  readonly operation: 'sessions.prompt' | 'sessions.follow_up';
  readonly request: Prompt | FollowUp;
  /** The grant of the request that admitted it, rechecked when it dispatches (P1-9). */
  readonly guard?: Guard;
}

/** What a worker record carries besides the B2 row: never prompt or answer text. */
export interface Persisted {
  worker: Worker;
  sessionFile: string | null;
  pid: number | null;
  token: string | null;
  create?: Create;
  /**
   * A create-with-resume target, durable in the starting row before any host starts and kept until the binding to it
   * is recorded (or the open provably never happened). Recovery attributes it to the worker, so a restart never
   * releases a session pi may have opened (invariants 1 and 2).
   */
  resume?: { session_id: string; file: string };
}

export interface Live extends Persisted {
  host?: SessionHost;
  index: SessionIndex;
  /** Messages pi reported complete; history lags while the session file has fewer. */
  completedMessages: number;
  faulted?: boolean;
  exited?: boolean;
  /** A B2 binding change owns the move: native binding events are its own. */
  rebinding?: boolean;
  /** pi announced a native move that has not bound yet. */
  nativeRebinding?: boolean;
  observedIdle?: boolean;
  moveTimer?: NodeJS.Timeout;
  /** The supervisor-owned follow-up queue (cap 32), in arrival order. */
  pending?: Map<string, Queued>;
}

export interface HostLaunch {
  readonly workerId: string;
  readonly create: Create;
  /** The real path of the worker's cwd. */
  readonly cwd: string;
  readonly sessionDir: string;
}

export type HostFactory = (launch: HostLaunch) => SessionHost;

/** Statuses that hold a session and an environment. */
export const HOLDING = new Set<Worker['status']>(['starting', 'ready', 'cleanup_pending']);

export class SupervisorState {
  readonly workers = new Map<string, Live>();
  /** session id → the file and the worker that last bound it (the resume catalog). */
  readonly sessionFiles = new Map<string, { file: string; worker_id: string }>();
  /** Sessions a binding change is moving to, before pi reports them. */
  readonly sessionReservations = new Map<string, string>();
  /** The supervisor-wide event stream; its transport epoch is this start's supervisor epoch. */
  readonly events: EventHub;
  /** Live interactions (set by the Supervisor once every module exists). */
  interactions?: Interactions;

  constructor(
    readonly journal: Journal,
    readonly receipts: ReceiptStore,
    readonly supervisorEpoch: string,
    readonly stateDir: string,
    readonly factory: HostFactory,
  ) {
    this.events = new EventHub(supervisorEpoch);
    for (const record of journal.records) {
      if (record.kind !== 'worker') continue;
      // SAFETY: every `worker` record is written by persist() below from a Persisted value, and the journal
      // checksums each record, so a parsed `worker` record is that Persisted value.
      const persisted = structuredClone(record.value) as unknown as Persisted;
      this.catalog(persisted);
      this.workers.set(persisted.worker.worker_id, { ...persisted, index: new SessionIndex(persisted.sessionFile), completedMessages: 0 });
    }
  }

  private catalog(p: Persisted): void {
    if (p.worker.session_id && p.sessionFile) this.sessionFiles.set(p.worker.session_id, { file: p.sessionFile, worker_id: p.worker.worker_id });
  }

  /**
   * Journals the worker record under `label`, then publishes the row as `worker.updated` with the append's proof.
   * Returns that proof for a durable event that depends on this record (session.rebound, fence.resolved).
   */
  persist(live: Live, label: DurableLabel): JournalAppended {
    this.catalog(live);
    // Only interaction metadata is durable; payloads (title, prefill, options) stay in memory.
    const record: Persisted = {
      worker: { ...live.worker, pending_interactions: this.interactions?.summaries(live.worker.worker_id) ?? [] },
      sessionFile: live.sessionFile,
      pid: live.pid,
      token: live.token,
      ...(live.create ? { create: live.create } : {}),
      ...(live.resume ? { resume: live.resume } : {}),
    };
    // SAFETY: Persisted is a plain JSON object (no methods, no cycles); the journal stores it as a record value.
    const { appended } = this.journal.append('worker', record as unknown as Record<string, unknown>, label);
    this.published.set(live.worker.worker_id, JSON.stringify(this.view(live)));
    this.events.publish('worker.updated', { worker_id: live.worker.worker_id, execution_id: live.worker.execution?.execution_id ?? null, data: { worker: structuredClone(record.worker) }, appended });
    return appended;
  }

  /** The last row published per worker, so a read that changes a derived field publishes it once (in memory). */
  private readonly published = new Map<string, string>();

  /** Publishes the row as an in-memory `worker.updated` when it differs from the last published one. */
  publishChanged(live: Live): void {
    const row = JSON.stringify(this.view(live));
    if (this.published.get(live.worker.worker_id) === row) return;
    this.published.set(live.worker.worker_id, row);
    this.events.publish('worker.updated', { worker_id: live.worker.worker_id, execution_id: live.worker.execution?.execution_id ?? null, data: { worker: this.view(live) } });
  }

  require(id: string): Live {
    const live = this.workers.get(id);
    if (!live) throw new Refusal('unknown_worker');
    return live;
  }

  newWorker(cwd: string, create: Create): Live {
    const worker: Worker = {
      worker_id: randomUUID(),
      worker_epoch: randomUUID(),
      supervisor_epoch: this.supervisorEpoch,
      session_id: null,
      session_identity_evidence: 'pi_sdk_session_id',
      binding_revision: 1,
      leaf_id: null,
      cwd,
      status: 'starting',
      foreground: 'idle',
      execution: null,
      fence: null,
      history: { last_entry_id: null, lag: false, evidence: 'pi_session_file' },
      cleanup: 'not_started',
      pending_interactions: [],
      host: 'sdk',
    };
    const live: Live = { worker, sessionFile: null, pid: null, token: null, create: { ...create, cwd }, index: new SessionIndex(null), completedMessages: 0 };
    this.workers.set(worker.worker_id, live);
    return live;
  }

  /** Re-reads the session file: header identity, leaf and the history marker. Throws on a changed header. */
  refresh(live: Live): void {
    live.index.refresh();
    if (live.index.headerId !== null) {
      if (live.worker.session_id !== live.index.headerId) throw new Refusal('pi_header_identity_changed', 'unknown');
      live.worker.session_identity_evidence = 'pi_session_file';
    }
    live.worker.leaf_id = live.index.leafId;
    live.worker.history = {
      last_entry_id: live.index.leafId,
      lag: live.worker.foreground !== 'idle' || live.completedMessages > live.index.messageEntries,
      evidence: 'pi_session_file',
    };
  }

  /** A session-directed mutation names the binding it saw; any difference is `stale_binding`, `no_effect`. */
  binding(live: Live, b: Binding): void {
    const w = live.worker;
    if (w.worker_epoch !== b.worker_epoch || w.session_id !== b.session_id || w.binding_revision !== b.binding_revision) {
      throw new Refusal('stale_binding', 'no_effect', undefined, {
        expected_binding_revision: Math.max(1, w.binding_revision),
        received_binding_revision: b.binding_revision,
      });
    }
  }

  /** One live writer per session: refuses naming the holder. */
  noOtherWriter(sessionId: string, except: string): void {
    const reserved = this.sessionReservations.get(sessionId);
    if (reserved && reserved !== except) throw new Refusal('session_already_bound', 'no_effect', undefined, { holder_worker_id: reserved });
    const holder = [...this.workers.values()].find(l => l.worker.worker_id !== except && l.worker.session_id === sessionId && HOLDING.has(l.worker.status));
    if (holder) throw new Refusal('session_already_bound', 'no_effect', undefined, { holder_worker_id: holder.worker.worker_id });
  }

  /**
   * The gates every resume passes (create-with-resume and `sessions.rebind` resume), before anything is spawned or
   * opened: no other live writer, a known session, its last owner's cleanup proven (invariant 2) and its fence
   * resolved (invariant 3). Returns the session file.
   */
  resumable(sessionId: string, except: string): string {
    this.noOtherWriter(sessionId, except);
    const known = this.sessionFiles.get(sessionId);
    if (!known) throw new Refusal('unknown_session');
    const owner = this.require(known.worker_id).worker;
    if (known.worker_id !== except && (owner.status === 'cleanup_pending' || owner.cleanup.includes('escaped_descendants_unproven'))) {
      throw new Refusal('target_cleanup_unproven');
    }
    if (owner.fence) throw new Refusal('target_session_fenced', 'no_effect', owner.fence.command_id);
    return known.file;
  }

  /** One worker per environment: a cwd stays reserved while a worker holds it or its cleanup is unproven. */
  exclusiveCwd(cwd: string, except?: Live): void {
    const holder = [...this.workers.values()].find(
      l => l !== except && l.worker.cwd === cwd && (HOLDING.has(l.worker.status) || l.worker.cleanup.includes('descendants_unproven')),
    );
    if (holder) throw new Refusal('exclusive_environment_already_bound', 'no_effect', undefined, { holder_worker_id: holder.worker.worker_id });
  }

  /** A snapshot of the worker row for readers, with its live interaction cards (payload included, memory only). */
  view(live: Live): Worker {
    return { ...structuredClone(live.worker), pending_interactions: this.interactions?.list(live.worker.worker_id) ?? [] };
  }
}

export const newId = () => randomUUID();
