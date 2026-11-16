/**
 * The supervisor's fsynced control journal: one JSON record per line, each `{record, checksum}` with a strictly
 * increasing `seq` and a SHA-256 of the record. Rewritten from A0 `src/journal.ts`, same append, fsync and parse
 * semantics: only a torn final line (no newline) is discarded on open; any complete line that does not parse, checks
 * out or continues the sequence refuses startup. pi owns the transcript; the journal never stores prompt or answer
 * text.
 *
 * Compaction (P1-12) rewrites the journal to a planned set of records (journal/retention.ts decides which): the new
 * file is written beside the journal, fsynced (`journal.compact_file`), renamed over it, and the directory fsynced
 * (`journal.compact_directory`). A SIGKILL before the rename leaves the old journal whole and a stray `.compact` file,
 * which the next open removes; after the rename the compacted journal is the journal.
 *
 * Budget (PR #12 review F2): a record is ordinary unless its label is a control label (labels.ts: stop, exit, fault,
 * fence, recovery, ...) or its writer marks it `control` (a quota-exempt command's receipts). Every record consumes
 * the reservations it names first. An ordinary record may never leave less than `floor()` free beside every
 * reservation: the control reserve plus the room each worker's own control records need (supervisor/state.ts). A
 * record that fits inside its own reservations takes no free room and is never refused for the floor. One that would
 * is refused `JournalCapacity` before any byte is written, and the journal stays usable; its writer refuses
 * or faults only its own work. A control record may use the reserve.
 */
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { durable } from './fsync.js';
import { CONTROL_LABELS, type DurableLabel } from './labels.js';
import { DEFAULT_RETENTION } from './retention.js';
import type { JournalAppended } from '../generated/events.js';

/**
 * `receipt_expired`: the id of a receipt retention evicted, so a reuse is refused rather than run again (P1-12).
 * `forgotten_ids`: what the expired ids that rolled over leave behind, so none of them runs again (journal/retention.ts).
 * `session_catalog`: a resume catalog entry (session, file, the worker that last bound it) a compaction keeps when it
 * drops the worker rows that recorded it.
 */
export const JOURNAL_KINDS = ['supervisor', 'receipt', 'worker', 'settlement', 'interaction', 'interaction_effect', 'receipt_expired', 'forgotten_ids', 'session_catalog', 'attachment'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
export type JournalRecord = { seq: number; kind: JournalKind; value: Record<string, unknown> };

/** The journal's byte bound (advertised in `hello` as `journal_max_bytes`); compaction keeps it from filling. */
export const DEFAULT_JOURNAL_BYTES = DEFAULT_RETENTION.journalBytes;

const line = (record: JournalRecord) => Buffer.from(`${JSON.stringify({ record, checksum: digest(JSON.stringify(record)) })}\n`);

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const kinds: ReadonlySet<string> = new Set(JOURNAL_KINDS);

export class JournalCorruption extends Error {}

/** An ordinary record that did not fit beside the reservations and the floor: nothing was written. */
export class JournalCapacity extends Error {}

/** Bytes a record line adds around its value: seq, kind, checksum and framing (an upper bound). */
const RECORD_OVERHEAD = 160;

/** The bytes a record with this value takes in the journal, at most. */
export const recordBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) + RECORD_OVERHEAD;

/** The reservation a worker's ordinary records consume (its budget; supervisor/state.ts tops it up). */
export const budgetKey = (workerId: string) => `worker:${workerId}`;

/**
 * The reservation for the row that fences a session-directed command's session if its outcome becomes unknown: taken
 * at admission, consumed by the first row that names the command in its fence (PR #12 review F7).
 */
export const fenceKey = (commandId: string) => `fence:${commandId}`;

export interface AppendOptions {
  /** Reservations this record consumes, in order, before it needs free room. */
  readonly budget?: readonly string[];
  /**
   * A control or recovery record: it may use the control reserve and the workers' control room. By default, whether
   * its label is one of CONTROL_LABELS.
   */
  readonly control?: boolean;
}

export function parseJournal(bytes: Buffer): { records: JournalRecord[]; validBytes: number } {
  const records: JournalRecord[] = [];
  let start = 0;
  for (;;) {
    const end = bytes.indexOf(10, start);
    if (end === -1) break; // Only a torn FINAL record may be discarded.
    try {
      const { record, checksum } = JSON.parse(bytes.subarray(start, end).toString('utf8')) as { record: JournalRecord; checksum: string };
      if (
        record.seq !== records.length + 1 ||
        !kinds.has(record.kind) ||
        !record.value ||
        typeof record.value !== 'object' ||
        Array.isArray(record.value) ||
        digest(JSON.stringify(record)) !== checksum
      ) {
        throw new Error('invalid record');
      }
      records.push(record);
    } catch {
      throw new JournalCorruption(`journal corruption at byte ${start}; refusing startup`);
    }
    start = end + 1;
  }
  return { records, validBytes: start };
}

export class Journal {
  readonly records: JournalRecord[];
  /** Set by a failed append: every later append refuses, so the supervisor fences globally. */
  failed = false;
  private fd: number;
  private closed = false;
  private reservations = new Map<string, number>();
  private readonly compacted = new Set<() => void>();
  /** Room only control records may use (the receipt store sets it from its retention limits). */
  controlReserveBytes = 0;
  /** The room the workers' own control records still need (the supervisor sets it; supervisor/state.ts). */
  controlRoom: () => number = () => 0;

  constructor(
    readonly file: string,
    readonly maxBytes = DEFAULT_JOURNAL_BYTES,
  ) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // A compaction cut before its rename: the journal is whole; the half-made copy is not the journal.
    rmSync(`${file}.compact`, { force: true });
    this.fd = openSync(file, 'a+', 0o600);
    try {
      const loaded = parseJournal(readFileSync(file));
      this.records = loaded.records;
      ftruncateSync(this.fd, loaded.validBytes);
      durable(this.fd, 'journal.open_file');
      const dir = openSync(dirname(file), 'r');
      try {
        durable(dir, 'journal.open_directory');
      } finally {
        closeSync(dir);
      }
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }

  private reserved(): number {
    let total = 0;
    for (const bytes of this.reservations.values()) total += bytes;
    return total;
  }

  /** The journal file's current size in bytes. */
  size(): number {
    return fstatSync(this.fd).size;
  }

  /** Bytes reserved for the final records of commands in flight. */
  get reservedBytes(): number {
    return this.reserved();
  }

  /** What ordinary records and reservations must leave free: the control reserve and the workers' control room. */
  floor(): number {
    return this.controlReserveBytes + this.controlRoom();
  }

  /**
   * Reserves room for a command's later records; false when the journal could not hold them while leaving `headroom`
   * bytes free (the control reserve an ordinary command may not use).
   */
  reserve(key: string, bytes: number, headroom = 0): boolean {
    return this.reserveAll([{ key, bytes }], headroom);
  }

  /**
   * Tops each reservation up to its bytes, all or none; false when the journal could not hold the extra room while
   * leaving `headroom` bytes free.
   */
  reserveAll(wants: readonly { key: string; bytes: number }[], headroom = 0): boolean {
    let extra = 0;
    for (const w of wants) extra += Math.max(0, w.bytes - (this.reservations.get(w.key) ?? 0));
    if (this.closed || this.failed || fstatSync(this.fd).size + this.reserved() + extra + headroom > this.maxBytes) return false;
    for (const w of wants) this.reservations.set(w.key, Math.max(w.bytes, this.reservations.get(w.key) ?? 0));
    return true;
  }

  /** Moves what is left of a reservation to another key (a new worker takes its create's budget). */
  move(from: string, to: string): void {
    const bytes = this.reservations.get(from);
    if (bytes === undefined) return;
    this.reservations.delete(from);
    this.reservations.set(to, (this.reservations.get(to) ?? 0) + bytes);
  }

  /** Releases a reservation once its command's final record is durable (or its worker writes no more records). */
  release(key: string): void {
    this.reservations.delete(key);
  }

  /**
   * Appends one record and fsyncs it under `label`. The record consumes the reservations its options name (a string
   * names one), in order; the rest must fit beside every reservation and, for an ordinary record, the floor. An
   * ordinary record that does not fit is refused `JournalCapacity` and the journal stays usable; any other failure
   * marks the journal failed. A closed journal refuses, so a late callback of a discarded supervisor never writes.
   */
  append(kind: JournalKind, value: Record<string, unknown>, label: DurableLabel, options: string | AppendOptions = {}): JournalRecord & { appended: JournalAppended } {
    if (this.closed) throw new Error('journal closed; late callback has no write authority');
    if (this.failed) throw new Error('journal failed; supervisor fenced globally');
    const { budget = [], control = CONTROL_LABELS.has(label) } = typeof options === 'string' ? { budget: [options] } : options;
    const record = structuredClone({ seq: this.records.length + 1, kind, value }) as JournalRecord;
    const data = line(record);
    const takes: [string, number][] = [];
    let need = data.length;
    for (const key of new Set(budget)) {
      const take = Math.min(this.reservations.get(key) ?? 0, need);
      if (take > 0) takes.push([key, take]);
      need -= take;
    }
    const after = this.size() + need + this.reserved();
    // Bytes already reserved are the guarantee: a record that fits inside them takes no free room, so the floor (which
    // control records may have used since the reservation) never refuses it (PR #12 review F7).
    if (!control && need > 0 && after + this.floor() > this.maxBytes) throw new JournalCapacity('journal capacity: an ordinary record may not use the control room');
    try {
      if (after > this.maxBytes) throw new Error('journal capacity; no automatic eviction');
      let offset = 0;
      while (offset < data.length) offset += writeSync(this.fd, data, offset, data.length - offset);
      durable(this.fd, label);
      this.records.push(record);
      for (const [key, take] of takes) this.reservations.set(key, this.reservations.get(key)! - take);
      // The proof a durable event needs (generated/events.ts): only a fsynced append creates one.
      return { ...record, appended: { fsynced: true, label } };
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  /** Runs `listener` after every compaction (stores rebuild their tables from the compacted records). */
  onCompacted(listener: () => void): void {
    this.compacted.add(listener);
  }

  /**
   * Replaces the journal with `entries`, renumbered from 1. A failure before the rename leaves the journal as it was
   * (and usable); a failure after it marks the journal failed.
   */
  compact(entries: readonly { kind: JournalKind; value: Record<string, unknown> }[]): void {
    if (this.closed) throw new Error('journal closed; late callback has no write authority');
    if (this.failed) throw new Error('journal failed; supervisor fenced globally');
    const records = entries.map((e, i) => structuredClone({ seq: i + 1, kind: e.kind, value: e.value }) as JournalRecord);
    const temp = `${this.file}.compact`;
    try {
      const fd = openSync(temp, 'w', 0o600);
      try {
        for (const record of records) {
          const data = line(record);
          let offset = 0;
          while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
        }
        durable(fd, 'journal.compact_file');
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    try {
      renameSync(temp, this.file);
      closeSync(this.fd);
      this.fd = openSync(this.file, 'a+', 0o600);
      const dir = openSync(dirname(this.file), 'r');
      try {
        durable(dir, 'journal.compact_directory');
      } finally {
        closeSync(dir);
      }
    } catch (error) {
      this.failed = true;
      throw error;
    }
    this.records.length = 0;
    for (const record of records) this.records.push(record);
    for (const listener of this.compacted) listener();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch (error) {
      // A compaction that failed after its rename may have closed the descriptor already.
      if (!this.failed) throw error;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
