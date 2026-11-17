/**
 * Journal retention (P1-12): what a compaction keeps. A pure function of the journal's own records (plus the commands
 * the caller still has in flight), so recovery from a compacted journal reaches the same decisions as recovery from the
 * journal it replaced: every worker's latest row, the resume catalog (every session a worker bound, with its file and
 * the worker that last bound it), every interaction still owned by a live pi process, the retained receipts with the
 * settlement evidence that names them, every staged attachment (and a released one while a command that staged or
 * released it is retained), and the ids of evicted receipts.
 *
 * A receipt is evictable only when it is final (`delivered`, `rejected`, `outcome_unknown`), was created at least
 * `minAgeMs` ago, is not an `outcome_unknown` its owner has not resolved, and nothing still names it: a worker's create
 * command (kept as long as the worker's row), unsettled execution, fence, queue or child lineage, a live interaction's
 * answer or release, a child's latest discharging report, or a command still in flight. The oldest (by their latest
 * record) go first. An evicted receipt leaves its id, so a reuse is refused `receipt_expired` instead of running again;
 * the newest `expiredIds` ids are kept.
 *
 * An expired id that rolls over is not forgotten as evidence (contract rule "no replay past retention",
 * docs/plan/b2-for-shep.md): the `forgotten_ids` horizon keeps the newest issue time of a forgotten UUIDv7 command id
 * and whether any other id was forgotten, so a command id the worker may have admitted is refused, never run again.
 */
import type { JournalKind, JournalRecord } from './journal.js';

export interface RetentionLimits {
  /** The journal never grows past this many bytes. */
  readonly journalBytes: number;
  /** Room only quota-exempt commands may use. */
  readonly controlReserveBytes: number;
  /**
   * The most receipts of ordinary commands retained (`ordinary_receipts_max`); ordinary commands are refused at the
   * bound when nothing is evictable. Quota-exempt receipts neither count toward it nor are refused at it.
   */
  readonly receipts: number;
  /** A final receipt is retained at least this long after its command was created. */
  readonly minAgeMs: number;
  /** How many evicted command ids are remembered (and refused `receipt_expired`). */
  readonly expiredIds: number;
}

export const DEFAULT_RETENTION: RetentionLimits = {
  journalBytes: 32 * 1024 * 1024,
  controlReserveBytes: 1024 * 1024,
  receipts: 4096,
  minAgeMs: 60 * 60 * 1000,
  expiredIds: 16384,
};

/** An evicted receipt's id, with what a reuse must match to be a duplicate rather than a conflict. */
export interface ExpiredId {
  command_id: string;
  operation: string;
  request_hash: string;
  /** The receipt's worker, so only a caller that could read the receipt learns it expired. */
  worker_id?: string;
}

/**
 * What the forgotten expired ids leave behind: the newest issue time of a forgotten UUIDv7 id and whether an id that is
 * not a UUIDv7 was forgotten. A command id the worker does not remember is refused when it could be one of them.
 */
export interface ForgottenIds {
  /** The newest UUIDv7 timestamp (Unix ms) among forgotten ids; null when none was a UUIDv7. */
  uuidv7_through_ms: number | null;
  /** Some forgotten id was not a UUIDv7: no id that is not one can be told apart from it any more. */
  untimed: boolean;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The issue time (Unix ms) a UUIDv7 (RFC 9562) command id carries; null for any other id. */
export function uuidv7Time(id: string): number | null {
  return UUIDV7.test(id) ? parseInt(id.slice(0, 8) + id.slice(9, 13), 16) : null;
}

/** The horizon after `ids` are forgotten too. */
export function forget(horizon: ForgottenIds | null, ids: readonly string[]): ForgottenIds | null {
  let next = horizon;
  for (const id of ids) {
    const t = uuidv7Time(id);
    const prev = next ?? { uuidv7_through_ms: null, untimed: false };
    next = t === null ? { ...prev, untimed: true } : { ...prev, uuidv7_through_ms: Math.max(prev.uuidv7_through_ms ?? t, t) };
  }
  return next;
}

/**
 * Whether `id`, which the worker remembers neither as a receipt nor as an expired id, could be one it forgot: a
 * UUIDv7 issued no later than the newest forgotten one, or any other id once such an id was forgotten. Errs toward
 * refusal: a fresh id it refuses did nothing and the caller mints a new one.
 */
export function mayBeForgotten(horizon: ForgottenIds | null, id: string): boolean {
  if (!horizon) return false;
  const t = uuidv7Time(id);
  if (t === null) return horizon.untimed;
  return horizon.uuidv7_through_ms !== null && t <= horizon.uuidv7_through_ms;
}

/** A `forgotten_ids` record's value (written only by planCompaction, checksummed by the journal). */
export function readForgotten(v: Record<string, unknown>): ForgottenIds {
  const t = v.uuidv7_through_ms;
  return { uuidv7_through_ms: typeof t === 'number' ? t : null, untimed: v.untimed === true };
}

export interface CompactionGoal {
  /** Evict until at most this many receipts are retained. */
  readonly receipts: number;
  /** Evict until the retained records take at most about this many bytes. */
  readonly bytes: number;
}

/** What a compaction aims for: three quarters of the receipt bound and a quarter of the journal's bytes. */
export const goalFor = (limits: RetentionLimits): CompactionGoal => ({ receipts: Math.floor((limits.receipts * 3) / 4), bytes: Math.floor(limits.journalBytes / 4) });

export interface CompactionPlan {
  readonly entries: { kind: JournalKind; value: Record<string, unknown> }[];
  readonly evicted: string[];
  /** Approximate bytes of the planned journal. */
  readonly bytes: number;
}

const FINAL = new Set(['delivered', 'rejected', 'outcome_unknown']);
const LIVE_INTERACTION = new Set(['pending', 'accepted', 'forwarded', 'consumed']);
const HOLDING = new Set(['starting', 'ready']);
/** Bytes a record line adds around its value: seq, kind, checksum and framing. */
const LINE_OVERHEAD = 140;

type Row = { worker?: Record<string, unknown> } & Record<string, unknown>;
type Value = Record<string, unknown>;

const size = (v: Value) => Buffer.byteLength(JSON.stringify(v)) + LINE_OVERHEAD;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): Value[] => (Array.isArray(v) ? (v as Value[]) : []);

function expiredId(v: Value): ExpiredId {
  const worker = str(v.worker_id);
  return { command_id: str(v.command_id)!, operation: str(v.operation)!, request_hash: str(v.request_hash)!, ...(worker ? { worker_id: worker } : {}) };
}

/**
 * Whether receipt `r` is a report that discharges the launch of `child` (a worker row) (invariant 4a): a delivered,
 * non-`help` report by the child for its launch task (a typed child's task, else the launch command), and for a typed
 * child only one its own FD 3 delivered. Recovery's missing-report check (supervisor/children.ts) and retention's pins
 * use this one rule.
 */
export function dischargesLaunch(child: Readonly<Record<string, unknown>>, r: Readonly<Record<string, unknown>>): boolean {
  const parent = child.parent as Value | undefined;
  const result = r.result as Value | undefined;
  const typed = !!(parent || child.launch_spec);
  const task = str(parent?.task_id) ?? str(child.parent_launch_command_id);
  return (
    r.operation === 'children.report' &&
    r.worker_id === child.worker_id &&
    r.state === 'delivered' &&
    task !== undefined &&
    result?.task_id === task &&
    result?.kind !== 'help' &&
    (!typed || result?.channel === 'fd3')
  );
}

/** Command ids a worker row still depends on. */
function rowPins(w: Value, pins: Set<string>): void {
  const add = (v: unknown) => {
    if (typeof v === 'string') pins.add(v);
  };
  const execution = w.execution as Value | null | undefined;
  // An unsettled execution's command decides its recovery (unknown or no effect); a settled one decides nothing.
  if (execution && execution.state !== 'settled') add(execution.command_id);
  const fence = w.fence as Value | null | undefined;
  add(fence?.command_id);
  for (const id of Array.isArray(fence?.uncertain_command_ids) ? (fence.uncertain_command_ids as unknown[]) : []) add(id);
  // Queued input not yet dispatched or dropped (a dispatched or dropped one's receipt has its own pins or none).
  for (const q of list(w.queued)) if (q.state !== 'dispatched' && q.state !== 'dropped') add(q.command_id);
  add(w.parent_launch_command_id);
}

export function planCompaction(records: readonly JournalRecord[], options: { limits: RetentionLimits; goal: CompactionGoal; now: number; inFlight: ReadonlySet<string> }): CompactionPlan {
  const { limits, goal, now, inFlight } = options;
  const supervisors: Value[] = [];
  const workers = new Map<string, Row>();
  const receipts = new Map<string, Value>();
  const lastSeq = new Map<string, number>();
  const interactions = new Map<string, Value>();
  const settlements: Value[] = [];
  const effects: Value[] = [];
  const expired = new Map<string, ExpiredId>();
  let horizon: ForgottenIds | null = null;
  // The resume catalog as supervisor/state.ts builds it: in record order, each binding of a session to a file.
  const catalog = new Map<string, Value>();
  const attachments = new Map<string, Value>();
  const probes = new Map<string, Value>();
  for (const r of records) {
    const v = r.value;
    if (r.kind === 'supervisor') supervisors.push(v);
    else if (r.kind === 'worker') {
      const row = v as Row;
      const id = str(row.worker?.worker_id);
      if (id) workers.set(id, row);
      const session = str(row.worker?.session_id);
      if (id && session && str(row.sessionFile)) catalog.set(session, { session_id: session, file: row.sessionFile, worker_id: id });
    } else if (r.kind === 'session_catalog') catalog.set(str(v.session_id)!, v);
    else if (r.kind === 'receipt') {
      const id = str(v.command_id)!;
      receipts.set(id, v);
      lastSeq.set(id, r.seq);
    } else if (r.kind === 'receipt_expired') expired.set(str(v.command_id)!, expiredId(v));
    else if (r.kind === 'interaction') interactions.set(str(v.interaction_id)!, v);
    else if (r.kind === 'settlement') settlements.push(v);
    else if (r.kind === 'interaction_effect') effects.push(v);
    else if (r.kind === 'forgotten_ids') horizon = readForgotten(v);
    else if (r.kind === 'attachment') attachments.set(str(v.attachment_id)!, v);
    else if (r.kind === 'inventory') probes.set(str(v.inventory_id)!, v);
  }
  // Workers keep their first-appearance order (the worker table and every recovery iterate in it).
  const order: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const id = r.kind === 'worker' ? str((r.value as Row).worker?.worker_id) : undefined;
    if (id && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  const rows = order.map(id => workers.get(id)!);

  const pins = new Set<string>(inFlight);
  const resolved = new Set<string>();
  for (const row of rows) {
    const w = row.worker ?? {};
    rowPins(w, pins);
    const create = row.create as Value | undefined;
    if (typeof create?.command_id === 'string') pins.add(create.command_id);
    for (const res of list(w.resolutions)) if (typeof res.command_id === 'string') resolved.add(res.command_id);
  }
  // Each child's latest report that discharges its launch (its task, its channel), kept with the launch it discharges:
  // recovery's missing-report check reads it (supervisor/children.ts).
  for (const child of rows.map(row => row.worker ?? {}).filter(w => typeof w.parent_launch_command_id === 'string')) {
    let latest: string | undefined;
    for (const [id, r] of receipts) if (dischargesLaunch(child, r)) latest = id;
    if (latest) pins.add(latest);
  }
  // Interactions a live pi process may still touch (its gate, its resolver) are kept, with the receipts they name.
  const current = new Map(rows.map(row => [str(row.worker?.worker_id), row.worker ?? {}]));
  const keptInteractions = new Map<string, Value>();
  for (const [id, i] of interactions) {
    const w = current.get(str(i.worker_id));
    const live = LIVE_INTERACTION.has(str(i.status) ?? '');
    const owned = !!w && w.worker_epoch === i.worker_epoch && HOLDING.has(str(w.status) ?? '');
    if (live || owned) keptInteractions.set(id, i);
    if (live) {
      if (typeof i.answer_command_id === 'string') pins.add(i.answer_command_id);
      if (typeof i.release_command_id === 'string') pins.add(i.release_command_id);
    }
  }

  const evictable = (id: string, r: Value): boolean => {
    if (pins.has(id) || !FINAL.has(str(r.state) ?? '')) return false;
    if (r.state === 'outcome_unknown' && !resolved.has(id)) return false;
    const created = Date.parse(str(r.created_at) ?? '');
    return Number.isFinite(created) && now - created >= limits.minAgeMs;
  };

  const fixed = [...supervisors.slice(0, 1), ...(supervisors.length > 1 ? [supervisors.at(-1)!] : [])];
  let bytes = 0;
  for (const v of fixed) bytes += size(v);
  for (const row of rows) bytes += size(row);
  for (const entry of catalog.values()) bytes += size(entry);
  const receiptBytes = new Map<string, number>();
  for (const [id, r] of receipts) {
    const b = size(r);
    receiptBytes.set(id, b);
    bytes += b;
  }
  for (const i of keptInteractions.values()) bytes += size(i);

  const candidates = [...receipts].filter(([id, r]) => evictable(id, r)).sort((a, b) => lastSeq.get(a[0])! - lastSeq.get(b[0])!);
  const evicted: string[] = [];
  let count = receipts.size;
  for (const [id] of candidates) {
    if (count <= goal.receipts && bytes <= goal.bytes) break;
    evicted.push(id);
    count--;
    bytes -= receiptBytes.get(id)!;
  }
  const gone = new Set(evicted);
  for (const id of evicted) {
    const r = receipts.get(id)!;
    expired.delete(id);
    expired.set(id, expiredId(r));
  }
  const rollover = Math.max(0, expired.size - limits.expiredIds);
  const expiredKept = [...expired.values()].slice(rollover);
  // An expired id that rolls over moves the horizon: it is refused from now on, never run again.
  horizon = forget(horizon, [...expired.keys()].slice(0, rollover));
  const keptIds = new Set([...receipts.keys()].filter(id => !gone.has(id)));
  // Settlement evidence for a retained command only, once each.
  const settled = new Set<string>();
  const keptSettlements = settlements.filter(s => {
    const key = JSON.stringify(s);
    if (!keptIds.has(str(s.command_id) ?? '') || settled.has(key)) return false;
    settled.add(key);
    return true;
  });
  for (const s of keptSettlements) bytes += size(s);
  const keptEffects = effects.filter(e => keptInteractions.has(str(e.interaction_id) ?? ''));
  for (const e of keptEffects) bytes += size(e);
  for (const e of expiredKept) bytes += size({ ...e });
  if (horizon) bytes += size({ ...horizon });
  // Each attachment's latest record (P1-16): a staged one always (its bytes are usable and the startup sweep keeps only
  // what a staged record names); a released one while the command that staged or released it is retained.
  const keptAttachments = [...attachments.values()].filter(a => a.state === 'staged' || keptIds.has(str(a.command_id) ?? '') || keptIds.has(str(a.released_by) ?? ''));
  for (const a of keptAttachments) bytes += size(a);
  // An inventory probe whose domain is not confirmed removed (P2-1): recovery cleans it from this record alone.
  const keptProbes = [...probes.values()].filter(p => p.state !== 'cleaned');
  for (const p of keptProbes) bytes += size(p);

  const entries: CompactionPlan['entries'] = [
    ...fixed.slice(0, 1).map(value => ({ kind: 'supervisor' as const, value })),
    ...rows.map(value => ({ kind: 'worker' as const, value })),
    // After the rows, so the catalog a restart builds is the one the dropped rows built.
    ...[...catalog.values()].map(value => ({ kind: 'session_catalog' as const, value })),
    // Receipts keep their first-appearance order (the receipt table and recovery iterate in it).
    ...[...receipts].filter(([id]) => !gone.has(id)).map(([, value]) => ({ kind: 'receipt' as const, value })),
    ...expiredKept.map(value => ({ kind: 'receipt_expired' as const, value: { ...value } })),
    ...(horizon ? [{ kind: 'forgotten_ids' as const, value: { ...horizon } }] : []),
    ...keptSettlements.map(value => ({ kind: 'settlement' as const, value })),
    ...[...keptInteractions.values()].map(value => ({ kind: 'interaction' as const, value })),
    ...keptEffects.map(value => ({ kind: 'interaction_effect' as const, value })),
    ...keptAttachments.map(value => ({ kind: 'attachment' as const, value })),
    ...keptProbes.map(value => ({ kind: 'inventory' as const, value })),
    ...fixed.slice(1).map(value => ({ kind: 'supervisor' as const, value })),
  ];
  return { entries, evicted, bytes };
}
