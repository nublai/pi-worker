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
 */
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { durable } from './fsync.js';
import type { DurableLabel } from './labels.js';
import { DEFAULT_RETENTION } from './retention.js';
import type { JournalAppended } from '../generated/events.js';

/**
 * `receipt_expired`: the id of a receipt retention evicted, so a reuse is refused rather than run again (P1-12).
 * `forgotten_ids`: what the expired ids that rolled over leave behind, so none of them runs again (journal/retention.ts).
 */
export const JOURNAL_KINDS = ['supervisor', 'receipt', 'worker', 'settlement', 'interaction', 'interaction_effect', 'receipt_expired', 'forgotten_ids'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
export type JournalRecord = { seq: number; kind: JournalKind; value: Record<string, unknown> };

/** The journal's byte bound (advertised in `hello` as `journal_max_bytes`); compaction keeps it from filling. */
export const DEFAULT_JOURNAL_BYTES = DEFAULT_RETENTION.journalBytes;

const line = (record: JournalRecord) => Buffer.from(`${JSON.stringify({ record, checksum: digest(JSON.stringify(record)) })}\n`);

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const kinds: ReadonlySet<string> = new Set(JOURNAL_KINDS);

export class JournalCorruption extends Error {}

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

  /**
   * Reserves room for a command's later records; false when the journal could not hold them while leaving `headroom`
   * bytes free (the control reserve an ordinary command may not use).
   */
  reserve(key: string, bytes: number, headroom = 0): boolean {
    if (this.closed || this.failed || fstatSync(this.fd).size + this.reserved() + bytes + headroom > this.maxBytes) return false;
    this.reservations.set(key, bytes);
    return true;
  }

  /** Releases a reservation once its command's final record is durable. */
  release(key: string): void {
    this.reservations.delete(key);
  }

  /**
   * Appends one record and fsyncs it under `label`. `reservation` names the reservation this append may consume (the
   * command's own final record); other appends must fit beside every reservation. Any failure marks the journal
   * failed. A closed journal refuses, so a late callback of a discarded supervisor never writes.
   */
  append(kind: JournalKind, value: Record<string, unknown>, label: DurableLabel, reservation?: string): JournalRecord & { appended: JournalAppended } {
    if (this.closed) throw new Error('journal closed; late callback has no write authority');
    if (this.failed) throw new Error('journal failed; supervisor fenced globally');
    const record = structuredClone({ seq: this.records.length + 1, kind, value }) as JournalRecord;
    const data = line(record);
    try {
      const own = reservation ? (this.reservations.get(reservation) ?? 0) : 0;
      if (fstatSync(this.fd).size + data.length + this.reserved() - own > this.maxBytes) throw new Error('journal capacity; no automatic eviction');
      let offset = 0;
      while (offset < data.length) offset += writeSync(this.fd, data, offset, data.length - offset);
      durable(this.fd, label);
      this.records.push(record);
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
