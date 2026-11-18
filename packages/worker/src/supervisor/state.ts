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
import type { Domain } from '../containment/containment.js';
import { sandboxed } from '../sandbox/sandbox.js';
import type { GitPin } from '../sandbox/git-sandbox.js';
import type { DependencyBind } from '../sandbox/staging.js';
import type { Channel, ChannelFactory } from './channel.js';

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
   * A resume target (create-with-resume, or a `sessions.rebind` resume), durable before pi is asked to open it and
   * kept until the binding to it is recorded (or the open provably never happened). Recovery attributes it to the
   * worker, so a restart never releases a session pi may have opened (invariants 1 and 2).
   */
  resume?: { session_id: string; file: string };
  /** The worker's cleanup domain, durable in its starting row before anything is spawned (P2-1). */
  domain?: Domain;
  /**
   * `sessions.prompt` intents a restart recovered, by command id: the binding each was admitted with, recorded by the
   * relaunch that followed (P2-3), and the epoch of the first relaunch that brought pi up on that binding's session and
   * revision. Only an owner-kept intent's exact retry may use it, once, on that epoch.
   */
  kept?: Record<string, KeptBinding>;
}

/** The binding a recovered prompt intent was admitted with, and the one epoch it may dispatch on after a relaunch. */
export interface KeptBinding {
  readonly worker_epoch: string;
  readonly session_id: string;
  readonly binding_revision: number;
  relaunch_epoch?: string;
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
  /** The command of a relaunch still initializing (memory): its process ending makes its outcome unknown. */
  launching?: string;
  /** The domain cleanup in flight (lifecycle): one at a time per worker; a pi exit during it starts no other. */
  cleaning?: Promise<boolean>;
  /** The supervisor-owned follow-up queue (cap 32), in arrival order. */
  pending?: Map<string, Queued>;
  /**
   * A sandboxed worker's Git metadata as its create's (or, for a sandboxed root worker, its relaunch's) validation
   * accepted it (memory, P2-5; sandbox/git-sandbox.ts): its launch mounts only that metadata, and a sandboxed parent's
   * channel children must share its common dir (P2-8). Not journaled: a relaunch validates the metadata again.
   */
  gitPin?: GitPin | null;
  /** A sandboxed root worker's parent channel for its current generation (memory, P2-8; channel.ts). */
  channel?: Channel;
  /**
   * The parent profile a sandboxed child stages into its root (memory, P2-7; sandbox/staging.ts), as its create's
   * validation found it: `PARENT/.piw-agent`. Absent when the parent has none (nothing is staged).
   */
  profile?: string;
}

export interface HostLaunch {
  readonly workerId: string;
  /** The command that launches this host: the worker's create, or a relaunch (P2-3). */
  readonly commandId: string;
  readonly create: Create;
  /** The real path of the worker's cwd. */
  readonly cwd: string;
  readonly sessionDir: string;
  /** The worker's cleanup domain, created before the factory runs. */
  readonly domain: Domain;
  /** The argv prefix that runs the host's program inside the domain (`Containment.enter`). */
  readonly prefix: readonly string[];
  /**
   * A sandboxed worker's root (its real cwd, P2-4): the host runs pi in the bwrap profile of this root, inside the
   * domain (the prefix stays the outermost wrapper). Never unsandboxed when set: no fallback.
   */
  readonly sandbox?: string;
  /** With `sandbox`: the Git pin its validation read (P2-5); the launch refuses metadata that differs. */
  readonly gitPin?: GitPin | null;
  /**
   * With `sandbox`: its staged profile's dependency trees (P2-7), open descriptors the sandbox binds read-only. The
   * supervisor closes them once the factory returns.
   */
  readonly dependencies?: readonly DependencyBind[];
  /** With `sandbox`, a sandboxed root worker's channel directory (P2-8), bound read-only at `/run/piw-parent`. */
  readonly channel?: string;
}

export type HostFactory = (launch: HostLaunch) => SessionHost;

/** The name of the Git work tree holding `cwd` (nearest ancestor with `.git`), else the cwd's base name. */
export function repoLabel(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return basename(dir) || dir;
    if (dirname(dir) === dir) return basename(cwd) || cwd;
  }
}

/**
 * A sandboxed worker's root (P2-4): its cwd, which a bwrap launch spec's root must equal. Every read of a file the
 * sandbox can write is pinned below it (history, session rows, files.read). Undefined for an unsandboxed worker.
 */
export const confinement = (w: Worker): string | undefined => (sandboxed(w.launch_spec) ? w.cwd : undefined);

/** Statuses that hold a session and an environment. */
export const HOLDING = new Set<Worker['status']>(['starting', 'ready', 'cleanup_pending']);

/*
 * The journal budget (PR #12 review F2). Worker rows written by stop, exit, fault, a failed launch, recovery, an
 * unknown outcome, a control request or a fence are control records (labels.ts): they may use the control reserve.
 * Every row consumes its worker's budget first, which each ordinary admission tops up before dispatch, and ordinary
 * records leave free the control room every worker that may still be stopped needs.
 */

/** After these rows the worker's process is gone: it writes no more ordinary records and its budget is released. */
const ENDING_ROW_LABELS = new Set<DurableLabel>(['worker.failed', 'worker.stopped', 'worker.exit', 'worker.fault', 'worker.cleaned']);
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
  readonly sessionFiles = new Map<string, { file: string; worker_id: string; root?: string }>();
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
  /** Control paths besides the state directory that no sandbox root may overlap (the B2 socket's directory). */
  sandboxControls: readonly string[] = [];
  /** Builds each parent channel's B2 handler (P2-8); without it a sandboxed root worker is refused. */
  channels?: ChannelFactory;
  /**
   * Parents with a child whose process ended and whose live missing-report check has not run yet (it waits for the
   * child's report channel to drain): a new child launch under such a parent is refused `child_end_unsettled`.
   */
  readonly childEnding = new Map<string, number>();
  /** A child's delivered report claims, for its row (children module). */
  childClaims?: (w: Worker) => NonNullable<Worker['child_reports']>;
  /** The size of each worker's latest row in the journal (the budget and control room scale with it). */
  private readonly rowSize = new Map<string, number>();
  /** The uncertain commands of each worker's last journaled fence: a row adding one publishes `fence.set`. */
  private readonly journaledFence = new Map<string, string[]>();

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
        // A sandboxed session's root (P2-4) stays with it: its file is read pinned below that root even without the row.
        const { session_id, file, worker_id, root } = record.value;
        if (typeof session_id === 'string' && typeof file === 'string' && typeof worker_id === 'string') this.sessionFiles.set(session_id, { file, worker_id, ...(typeof root === 'string' ? { root } : {}) });
        continue;
      }
      if (record.kind !== 'worker') continue;
      // SAFETY: every `worker` record is written by persist() below from a Persisted value, and the journal
      // checksums each record, so a parsed `worker` record is that Persisted value.
      const persisted = structuredClone(record.value) as unknown as Persisted;
      this.catalog(persisted);
      this.journaledStatus.set(persisted.worker.worker_id, persisted.worker.status);
      this.workers.set(persisted.worker.worker_id, { ...persisted, index: new SessionIndex(persisted.sessionFile, undefined, confinement(persisted.worker)), completedMessages: 0 });
      this.rowSize.set(persisted.worker.worker_id, recordBytes(record.value));
      this.journaledFence.set(persisted.worker.worker_id, uncertainOf(persisted.worker.fence));
    }
    receipts.budget = (operation, request) => this.budget(operation, request);
    // Every journaled receipt record of a worker's command is a durable `receipt.updated` (P1-19).
    receipts.onRecord = (receipt, appended) => {
      if (receipt.worker_id) this.events.publish('receipt.updated', { worker_id: receipt.worker_id, execution_id: receipt.execution_id ?? null, data: { receipt: structuredClone(receipt) }, appended });
    };
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
      // A first prompt is an admission too (its rows and records), and its unknown outcome fences the new session.
      const rows = request.first_prompt ? 2 * BUDGET_ROWS : BUDGET_ROWS;
      const fence = request.resume_session_id || request.first_prompt ? row + FENCE_ROW_EXTRA_BYTES : 0;
      return { key: `create:${String(request.command_id)}`, bytes: rows * row + BUDGET_RECORD_BYTES, control: CONTROL_ROWS * row, fence };
    }
    const live = typeof request.worker_id === 'string' ? this.workers.get(request.worker_id) : undefined;
    if (!live) return null;
    const row = this.rowBytes(live);
    const fence = SESSION_DIRECTED.has(operation) ? row + FENCE_ROW_EXTRA_BYTES : 0;
    // A relaunch brings a stopped worker back: like a create, it leaves free the control room its live worker needs.
    const control = operation === 'workers.relaunch' ? CONTROL_ROWS * row : 0;
    return { key: budgetKey(live.worker.worker_id), bytes: BUDGET_ROWS * row + BUDGET_RECORD_BYTES, control, fence };
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
      ...(live.domain ? { domain: live.domain } : {}),
      ...(live.kept && Object.keys(live.kept).length ? { kept: live.kept } : {}),
    };
  }

  private catalog(p: Persisted): void {
    const root = confinement(p.worker);
    if (p.worker.session_id && p.sessionFile) this.sessionFiles.set(p.worker.session_id, { file: p.sessionFile, worker_id: p.worker.worker_id, ...(root ? { root } : {}) });
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
    // The frame carries the reader's row (view: display fields from the session file, live interaction cards), the
    // same row workers.get returns; the journal record above keeps only the durable row (no prompt-derived text).
    const row = this.view(live);
    this.published.set(live.worker.worker_id, JSON.stringify(row));
    this.events.publish('worker.updated', { worker_id: live.worker.worker_id, execution_id: live.worker.execution?.execution_id ?? null, data: { worker: row }, appended });
    // An uncertain command that joined the fence in this row: `fence.set`, durable with the row (P1-19).
    const before = this.journaledFence.get(id) ?? [];
    const now = uncertainOf(w.fence);
    this.journaledFence.set(id, now);
    const joined = now.find(c => !before.includes(c));
    if (w.fence && joined) {
      this.events.publish('fence.set', {
        worker_id: id,
        execution_id: w.execution?.command_id === joined ? w.execution.execution_id : null,
        data: { command_id: joined, fence_generation: w.fence.fence_generation, fence: structuredClone(w.fence) },
        appended,
      });
    }
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

  /** The history index of `file` for this worker: pinned below its root when it is sandboxed. */
  index(live: Live, file: string | null): SessionIndex {
    return new SessionIndex(file, undefined, confinement(live.worker));
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
      recent_settlements: [],
      repo_label: repoLabel(cwd),
      model: { provider: create.provider, id: create.model },
      thinking: create.thinking,
    };
    // The worker record keeps the create without its first prompt: prompt text is never journaled.
    const { first_prompt: _firstPrompt, ...kept } = create;
    const live: Live = { worker, sessionFile: null, pid: null, token: null, create: { ...kept, cwd }, index: new SessionIndex(null), completedMessages: 0 };
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
    live.summary = this.summaries.get(live.sessionFile, confinement(live.worker));
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
   * opened: no other live writer, a known session, its last owner's cleanup proven (its domain removed and recorded;
   * invariant 2) and its fence resolved (invariant 3). Returns the session file.
   *
   * A session moves only between workers of the same confinement (P2-4): `root` is the requester's sandbox root (none
   * when unsandboxed). An unsandboxed pi never opens a file a sandbox can write (its path could lead anywhere), and a
   * sandbox never gets a session outside its root.
   */
  resumable(sessionId: string, except: string, root?: string): string {
    this.noOtherWriter(sessionId, except);
    const known = this.sessionFiles.get(sessionId);
    if (!known) throw new Refusal('unknown_session');
    const owner = this.require(known.worker_id).worker;
    if (known.root !== root) throw new Refusal('session_confinement_mismatch');
    if (known.worker_id !== except && owner.status === 'cleanup_pending') {
      throw new Refusal('target_cleanup_unproven');
    }
    if (owner.fence) throw new Refusal('target_session_fenced', 'no_effect', owner.fence.command_id);
    return known.file;
  }

  /** One worker per environment: a cwd stays reserved while a worker holds it or its cleanup is unproven. */
  exclusiveCwd(cwd: string, except?: Live): void {
    const holder = [...this.workers.values()].find(l => l !== except && l.worker.cwd === cwd && HOLDING.has(l.worker.status));
    if (holder) throw new Refusal('exclusive_environment_already_bound', 'no_effect', undefined, { holder_worker_id: holder.worker.worker_id });
  }

  /** A snapshot of the worker row for readers, with its live interaction cards (payload included, memory only). */
  view(live: Live): Worker {
    const row: Worker = { ...structuredClone(live.worker), pending_interactions: this.interactions?.list(live.worker.worker_id) ?? [] };
    // The phone's chat row (contract 8.1, S-8): lineage, label, title, preview and activity.
    row.lineage = row.parent_worker_id ? 'child' : 'root';
    row.repo_label ??= repoLabel(row.cwd);
    row.settle_count ??= 0;
    row.recent_settlements ??= [];
    row.title = row.title ?? live.summary?.title ?? null;
    row.preview = live.summary?.preview ?? null;
    row.first_user_line = live.summary?.first_user_line ?? null;
    row.last_activity_at = live.summary?.last_activity_at ?? null;
    row.model ??= live.create ? { provider: live.create.provider, id: live.create.model } : null;
    row.thinking ??= live.create?.thinking ?? null;
    if (row.parent_worker_id && this.childClaims) row.child_reports = this.childClaims(row);
    return row;
  }
}

export const newId = () => randomUUID();

/** A fence's uncertain commands (none without a fence). */
function uncertainOf(fence: Worker['fence'] | undefined): string[] {
  return fence ? (fence.uncertain_command_ids ?? [fence.command_id]) : [];
}
