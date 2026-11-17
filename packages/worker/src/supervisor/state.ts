/**
 * Supervisor state shared by the domain modules (lifecycle, input, fence, binding): the worker table, durable worker
 * records, the fence latch, binding and writer checks. Rewritten from A0 `src/supervisor.ts`, split by domain.
 *
 * pi owns the transcript; the supervisor owns control records. A worker record is journaled before anything that
 * depends on it is observable (a fence before the refusal or reply it causes).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { components } from '../generated/api.js';
import { Refusal } from '../b2/errors.js';
import type { SessionHost } from '../host/host.js';
import { budgetKey, fenceKey, recordBytes, type Journal } from '../journal/journal.js';
import { SESSION_DIRECTED } from './fence.js';
import type { DurableLabel } from '../journal/labels.js';
import { SessionIndex } from '../history/session-index.js';
import { Summaries, type Summary } from '../history/session-file.js';
import { EventHub } from '../events/hub.js';
import type { JournalAppended } from '../generated/events.js';
import type { Interactions } from '../interactions/interactions.js';
import type { GrantStore } from '../grants/store.js';
import type { Budget, Operation, ReceiptStore } from '../receipts/receipts.js';
import type { Guard } from '../grants/authority.js';

export type Worker = components['schemas']['Worker'];
export type Create = components['schemas']['Create'];
export type Binding = components['schemas']['Binding'];
export type Prompt = components['schemas']['Prompt'];
export type FollowUp = components['schemas']['FollowUp'];
export type Steer = components['schemas']['Steer'];
export type Control = components['schemas']['Control'];
export type ChildLaunch = components['schemas']['ChildLaunch'];

/** A queued input: its payload stays in memory only; a restart recovers its intent `no_effect`. */
export interface Queued {
  readonly operation: 'sessions.prompt' | 'sessions.follow_up' | 'children.launch';
  readonly request: Prompt | FollowUp | ChildLaunch;
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
  /** The session file's summary at the last refresh (preview, activity, title; memory only). */
  summary?: Summary;
  /** The file identity and watermark last published as `history.appended`. */
  appended?: string;
  /** Messages pi reported complete; history lags while the session file has fewer. */
  completedMessages: number;
  faulted?: boolean;
  exited?: boolean;
  /** A B2 binding change owns the move: native binding events are its own. */
  rebinding?: boolean;
  /** pi announced a native move that has not bound yet. */
  nativeRebinding?: boolean;
  /**
   * The command id of a session command or configure in flight (memory): it occupies the worker like an execution
   * until its reply, so a prompt, a binding move or another session write is refused busy before any record.
   */
  command?: string;
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

/** The name of the Git work tree holding `cwd` (nearest ancestor with `.git`), else the cwd's base name. */
export function repoLabel(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return basename(dir) || dir;
    if (dirname(dir) === dir) return basename(cwd) || cwd;
  }
}

/** Statuses that hold a session and an environment. */
export const HOLDING = new Set<Worker['status']>(['starting', 'ready', 'cleanup_pending']);

/*
 * The journal budget (PR #12 review F2). Worker rows written by stop, exit, fault, a failed launch, recovery, an
 * unknown outcome, a control request or a fence are control records (labels.ts): they may use the control reserve.
 * Every row consumes its worker's budget first, which each ordinary admission tops up before dispatch, and ordinary
 * records leave free the control room every worker that may still be stopped needs.
 */

/** After these rows the worker's process is gone: it writes no more ordinary records and its budget is released. */
const ENDING_ROW_LABELS = new Set<DurableLabel>(['worker.failed', 'worker.stopped', 'worker.exit', 'worker.fault']);
/** Ordinary rows a worker may write between two admissions (admit, reply, start, settle; create, spawned, identity, ready). */
const BUDGET_ROWS = 4;
/** Room for its settlement and interaction records between two admissions. */
const BUDGET_RECORD_BYTES = 4096;
/** Control rows a worker that may still be stopped needs (an exit or fault, then stop and stopped). */
const CONTROL_ROWS = 3;
/** What a new worker's row adds to its create request: the worker fields and pi's resource inventory. */
const ROW_BASE_BYTES = 8192;
/** What the row that fences a session adds to the worker's latest row: the fence and the execution's state. */
const FENCE_ROW_EXTRA_BYTES = 4096;

export class SupervisorState {
  readonly workers = new Map<string, Live>();
  /** session id → the file and the worker that last bound it (the resume catalog). */
  readonly sessionFiles = new Map<string, { file: string; worker_id: string }>();
  /** Sessions a binding change is moving to, before pi reports them. */
  readonly sessionReservations = new Map<string, string>();
  /** Incremental session-file summaries (session rows, worker previews). */
  readonly summaries = new Summaries();
  /** The status each worker row was last journaled with: a change stamps `status_since`. */
  private readonly journaledStatus = new Map<string, Worker['status']>();
  /** The supervisor-wide event stream; its transport epoch is this start's supervisor epoch. */
  readonly events: EventHub;
  /** Live interactions (set by the Supervisor once every module exists). */
  interactions?: Interactions;
  /** The grant registry, to recheck the grant that created a worker (children, reports). */
  grants?: GrantStore;
  /**
   * Parents with a child whose process ended and whose live missing-report check has not run yet (it waits for the
   * child's report channel to drain): a new child launch under such a parent is refused `child_end_unsettled`.
   */
  readonly childEnding = new Map<string, number>();
  /** A child's delivered report claims, for its row (children module). */
  childClaims?: (w: Worker) => NonNullable<Worker['child_reports']>;
  /** The size of each worker's latest row in the journal (the budget and control room scale with it). */
  private readonly rowSize = new Map<string, number>();

  constructor(
    readonly journal: Journal,
    readonly receipts: ReceiptStore,
    readonly supervisorEpoch: string,
    readonly stateDir: string,
    readonly factory: HostFactory,
  ) {
    this.events = new EventHub(supervisorEpoch);
    for (const record of journal.records) {
      if (record.kind === 'session_catalog') {
        // A catalog entry a compaction kept (journal/retention.ts): a session a dropped worker row bound.
        const { session_id, file, worker_id } = record.value;
        if (typeof session_id === 'string' && typeof file === 'string' && typeof worker_id === 'string') this.sessionFiles.set(session_id, { file, worker_id });
        continue;
      }
      if (record.kind !== 'worker') continue;
      // SAFETY: every `worker` record is written by persist() below from a Persisted value, and the journal
      // checksums each record, so a parsed `worker` record is that Persisted value.
      const persisted = structuredClone(record.value) as unknown as Persisted;
      this.catalog(persisted);
      this.journaledStatus.set(persisted.worker.worker_id, persisted.worker.status);
      this.workers.set(persisted.worker.worker_id, { ...persisted, index: new SessionIndex(persisted.sessionFile), completedMessages: 0 });
      this.rowSize.set(persisted.worker.worker_id, recordBytes(record.value));
    }
    receipts.budget = (operation, request) => this.budget(operation, request);
    journal.controlRoom = () => this.controlRoom();
  }

  /** A worker row's size: its latest, or the row it would write now. */
  private rowBytes(live: Live): number {
    return this.rowSize.get(live.worker.worker_id) ?? recordBytes(this.record(live));
  }

  /**
   * The room an ordinary command's worker records need, reserved before dispatch with its receipt: a create budgets
   * its new worker's rows (estimated from the request) and leaves its control room free; a worker-directed command
   * tops its worker's budget up. Other commands have none. A command whose unknown outcome fences a session (fence.ts)
   * also reserves the row that latches that fence: control traffic may spend every other byte meanwhile (PR #12
   * review F7).
   */
  budget(operation: Operation, request: Record<string, unknown>): Budget | null {
    if (operation === 'workers.create') {
      const row = 2 * recordBytes(request) + ROW_BASE_BYTES;
      const fence = request.resume_session_id ? row + FENCE_ROW_EXTRA_BYTES : 0;
      return { key: `create:${String(request.command_id)}`, bytes: BUDGET_ROWS * row + BUDGET_RECORD_BYTES, control: CONTROL_ROWS * row, fence };
    }
    const live = typeof request.worker_id === 'string' ? this.workers.get(request.worker_id) : undefined;
    if (!live) return null;
    const row = this.rowBytes(live);
    const fence = SESSION_DIRECTED.has(operation) ? row + FENCE_ROW_EXTRA_BYTES : 0;
    return { key: budgetKey(live.worker.worker_id), bytes: BUDGET_ROWS * row + BUDGET_RECORD_BYTES, control: 0, fence };
  }

  /** The room every worker that may still be stopped needs for its own control rows; ordinary records leave it free. */
  controlRoom(): number {
    let room = 0;
    for (const live of this.workers.values()) {
      const done = (live.worker.status === 'stopped' || live.worker.status === 'failed') && live.pid === null;
      if (!done) room += CONTROL_ROWS * this.rowBytes(live);
    }
    return room;
  }

  private record(live: Live): Persisted {
    // Only interaction metadata is durable; payloads (title, prefill, options) stay in memory.
    return {
      worker: { ...live.worker, pending_interactions: this.interactions?.summaries(live.worker.worker_id) ?? [] },
      sessionFile: live.sessionFile,
      pid: live.pid,
      token: live.token,
      ...(live.create ? { create: live.create } : {}),
      ...(live.resume ? { resume: live.resume } : {}),
    };
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
    const w = live.worker;
    if (!w.status_since || this.journaledStatus.get(w.worker_id) !== w.status) w.status_since = new Date().toISOString();
    this.journaledStatus.set(w.worker_id, w.status);
    const record = this.record(live);
    const id = live.worker.worker_id;
    // SAFETY: Persisted is a plain JSON object (no methods, no cycles); the journal stores it as a record value.
    const value = record as unknown as Record<string, unknown>;
    // A row that names uncertain commands in its fence is their fence row: it uses the room each reserved for it, and
    // once it is durable that room is released (ReceiptStore.run keeps it reserved for an unknown outcome until then).
    const fenced = (live.worker.fence?.uncertain_command_ids ?? (live.worker.fence ? [live.worker.fence.command_id] : [])).map(fenceKey);
    const { appended } = this.journal.append('worker', value, label, { budget: [...fenced, budgetKey(id)] });
    for (const key of fenced) this.journal.release(key);
    this.rowSize.set(id, recordBytes(value));
    if (ENDING_ROW_LABELS.has(label)) this.journal.release(budgetKey(id));
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
      status_since: new Date().toISOString(),
      settle_count: 0,
      repo_label: repoLabel(cwd),
      model: { provider: create.provider, id: create.model },
      thinking: create.thinking,
    };
    const live: Live = { worker, sessionFile: null, pid: null, token: null, create: { ...create, cwd }, index: new SessionIndex(null), completedMessages: 0 };
    this.workers.set(worker.worker_id, live);
    // The create's budget becomes the worker's.
    this.journal.move(`create:${create.command_id}`, budgetKey(worker.worker_id));
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
    // The history marker is the verified file watermark, never an SDK leaf pi has not written; such a leaf is lag.
    live.worker.history = {
      last_entry_id: live.index.watermark,
      lag: live.worker.foreground !== 'idle' || live.completedMessages > live.index.messageEntries || live.index.pending,
      evidence: 'pi_session_file',
    };
    // The file's identity and complete size, published once per change as `history.appended` (sessions.history's
    // Piw-Watermark for the same bytes).
    live.summary = this.summaries.get(live.sessionFile);
    const appended = `${live.summary.identity}:${live.summary.watermark}`;
    if (live.worker.session_id && live.appended !== appended) {
      live.appended = appended;
      this.events.publish('history.appended', {
        worker_id: live.worker.worker_id,
        execution_id: live.worker.execution?.execution_id ?? null,
        data: { session_id: live.worker.session_id, file_identity: live.summary.identity, watermark: live.summary.watermark, last_entry_id: live.index.watermark },
      });
    }
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
    const row: Worker = { ...structuredClone(live.worker), pending_interactions: this.interactions?.list(live.worker.worker_id) ?? [] };
    // The phone's chat row (contract 8.1, S-3, S-8): identity, lineage, label, title, preview and activity.
    row.chat_id = row.worker_id;
    row.runtime = 'worker';
    row.lineage = row.parent_worker_id ? 'child' : 'root';
    row.repo_label ??= repoLabel(row.cwd);
    row.settle_count ??= 0;
    row.title = row.title ?? live.summary?.title ?? null;
    row.preview = live.summary?.preview ?? null;
    row.last_activity_at = live.summary?.last_activity_at ?? null;
    row.model ??= live.create ? { provider: live.create.provider, id: live.create.model } : null;
    row.thinking ??= live.create?.thinking ?? null;
    if (row.parent_worker_id && this.childClaims) row.child_reports = this.childClaims(row);
    return row;
  }
}

export const newId = () => randomUUID();
