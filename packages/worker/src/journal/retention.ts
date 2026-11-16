/**
 * Journal retention (P1-12): what a compaction keeps. A pure function of the journal's own records (plus the commands
 * the caller still has in flight), so recovery from a compacted journal reaches the same decisions as recovery from the
 * journal it replaced: every worker's latest row, every interaction still owned by a live pi process, the retained
 * receipts with the settlement evidence that names them, and the ids of evicted receipts.
 *
 * A receipt is evictable only when it is final (`delivered`, `rejected`, `outcome_unknown`), was created at least
 * `minAgeMs` ago, is not an `outcome_unknown` its owner has not resolved, and nothing still names it: a worker's create
 * command (kept as long as the worker's row), unsettled execution, fence, queue or child lineage, a live interaction's
 * answer or release, a child's latest discharging report, or a command still in flight. The oldest (by their latest
 * record) go first. An evicted receipt leaves its id, so a reuse is refused `receipt_expired` instead of running again;
 * the newest `expiredIds` ids are kept.
 */
import type { JournalKind, JournalRecord } from './journal.js';

export interface RetentionLimits {
  /** The journal never grows past this many bytes. */
  readonly journalBytes: number;
  /** Room only quota-exempt commands may use. */
  readonly controlReserveBytes: number;
  /** The most receipts retained; ordinary commands are refused at the bound when nothing is evictable. */
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
  for (const r of records) {
    const v = r.value;
    if (r.kind === 'supervisor') supervisors.push(v);
    else if (r.kind === 'worker') {
      const id = str((v as Row).worker?.worker_id);
      if (id) workers.set(id, v as Row);
    } else if (r.kind === 'receipt') {
      const id = str(v.command_id)!;
      receipts.set(id, v);
      lastSeq.set(id, r.seq);
    } else if (r.kind === 'receipt_expired') expired.set(str(v.command_id)!, expiredId(v));
    else if (r.kind === 'interaction') interactions.set(str(v.interaction_id)!, v);
    else if (r.kind === 'settlement') settlements.push(v);
    else if (r.kind === 'interaction_effect') effects.push(v);
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
  // A child's latest delivered non-help report per channel: recovery's missing-report check reads it.
  const discharging = new Map<string, string>();
  for (const [id, r] of receipts) {
    const result = r.result as Value | undefined;
    if (r.operation === 'children.report' && r.state === 'delivered' && result?.kind !== 'help') discharging.set(`${str(r.worker_id)}:${str(result?.channel)}`, id);
  }
  for (const id of discharging.values()) pins.add(id);
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
  const expiredKept = [...expired.values()].slice(Math.max(0, expired.size - limits.expiredIds));
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

  const entries: CompactionPlan['entries'] = [
    ...fixed.slice(0, 1).map(value => ({ kind: 'supervisor' as const, value })),
    ...rows.map(value => ({ kind: 'worker' as const, value })),
    // Receipts keep their first-appearance order (the receipt table and recovery iterate in it).
    ...[...receipts].filter(([id]) => !gone.has(id)).map(([, value]) => ({ kind: 'receipt' as const, value })),
    ...expiredKept.map(value => ({ kind: 'receipt_expired' as const, value: { ...value } })),
    ...keptSettlements.map(value => ({ kind: 'settlement' as const, value })),
    ...[...keptInteractions.values()].map(value => ({ kind: 'interaction' as const, value })),
    ...keptEffects.map(value => ({ kind: 'interaction_effect' as const, value })),
    ...fixed.slice(1).map(value => ({ kind: 'supervisor' as const, value })),
  ];
  return { entries, evicted, bytes };
}
