/**
 * The supervisor's fsynced control journal: one JSON record per line, each `{record, checksum}` with a strictly
 * increasing `seq` and a SHA-256 of the record. Rewritten from A0 `src/journal.ts`, same append, fsync and parse
 * semantics: only a torn final line (no newline) is discarded on open; any complete line that does not parse, checks
 * out or continues the sequence refuses startup. pi owns the transcript; the journal never stores prompt or answer
 * text. Retention and compaction land in P1-12.
 */
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { durable } from './fsync.js';
import type { DurableLabel } from './labels.js';

export const JOURNAL_KINDS = ['supervisor', 'receipt', 'worker'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
export type JournalRecord = { seq: number; kind: JournalKind; value: Record<string, unknown> };

/** A0's bound; P1-12 replaces it with retention. */
export const DEFAULT_JOURNAL_BYTES = 32 * 1024 * 1024;

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

  constructor(
    readonly file: string,
    readonly maxBytes = DEFAULT_JOURNAL_BYTES,
  ) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
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

  /** Reserves room for a command's later records; false when the journal could not hold them. */
  reserve(key: string, bytes: number): boolean {
    if (this.closed || this.failed || fstatSync(this.fd).size + this.reserved() + bytes > this.maxBytes) return false;
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
  append(kind: JournalKind, value: Record<string, unknown>, label: DurableLabel, reservation?: string): JournalRecord {
    if (this.closed) throw new Error('journal closed; late callback has no write authority');
    if (this.failed) throw new Error('journal failed; supervisor fenced globally');
    const record = structuredClone({ seq: this.records.length + 1, kind, value }) as JournalRecord;
    const data = Buffer.from(`${JSON.stringify({ record, checksum: digest(JSON.stringify(record)) })}\n`);
    try {
      const own = reservation ? (this.reservations.get(reservation) ?? 0) : 0;
      if (fstatSync(this.fd).size + data.length + this.reserved() - own > this.maxBytes) throw new Error('journal capacity; no automatic eviction');
      let offset = 0;
      while (offset < data.length) offset += writeSync(this.fd, data, offset, data.length - offset);
      durable(this.fd, label);
      this.records.push(record);
      return record;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
