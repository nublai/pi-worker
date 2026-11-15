/** THROWAWAY. Fsynced control log, not a transcript. No prompt/answer values stored. */
import { openSync, closeSync, readFileSync, writeSync, fsyncSync, ftruncateSync, fstatSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
export type JournalRecord = { seq: number; kind: 'receipt' | 'worker' | 'supervisor'; value: Record<string, unknown> };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function parseJournal(bytes: Buffer): { records: JournalRecord[]; validBytes: number } {
  const records: JournalRecord[] = [];
  let start = 0;
  for (;;) {
    const end = bytes.indexOf(10, start);
    if (end === -1) break; // Only a torn FINAL record may be discarded.
    const text = bytes.subarray(start, end).toString('utf8');
    try {
      const { record, checksum } = JSON.parse(text) as { record: JournalRecord; checksum: string };
      if (record.seq !== records.length + 1 || !['receipt', 'worker', 'supervisor'].includes(record.kind)
        || !record.value || typeof record.value !== 'object' || digest(JSON.stringify(record)) !== checksum) throw new Error('invalid record');
      records.push(record);
    } catch { throw new Error(`journal corruption at byte ${start}; refusing startup`); }
    start = end + 1;
  }
  return { records, validBytes: start };
}
export class Journal {
  readonly records: JournalRecord[];
  private fd: number;
  private reservations = new Map<string, number>();
  failed = false;
  constructor(readonly file: string, readonly maxBytes = 32 * 1024 * 1024) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.fd = openSync(file, 'a+', 0o600);
    const loaded = parseJournal(readFileSync(file));
    this.records = loaded.records;
    ftruncateSync(this.fd, loaded.validBytes);
    fsyncSync(this.fd);
    const dir = openSync(dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  reserve(commandId: string, bytes: number): boolean {
    const reserved = [...this.reservations.values()].reduce((a, b) => a + b, 0);
    if (this.failed || fstatSync(this.fd).size + reserved + bytes > this.maxBytes) return false;
    this.reservations.set(commandId, bytes); return true;
  }
  append(kind: JournalRecord['kind'], value: Record<string, unknown>): void {
    if (this.failed) throw new Error('journal failed; supervisor fenced globally');
    const record = { seq: this.records.length + 1, kind, value } as JournalRecord;
    const data = Buffer.from(JSON.stringify({ record, checksum: digest(JSON.stringify(record)) }) + '\n');
    try {
      const reserved = [...this.reservations.values()].reduce((a, b) => a + b, 0);
      const terminal = kind === 'receipt' && ['delivered', 'rejected', 'outcome_unknown'].includes(String(value.state));
      const own = terminal ? this.reservations.get(String(value.command_id)) ?? 0 : 0;
      if (fstatSync(this.fd).size + data.length + reserved - own > this.maxBytes) throw new Error('journal capacity; no automatic eviction');
      let offset = 0;
      while (offset < data.length) offset += writeSync(this.fd, data, offset, data.length - offset);
      fsyncSync(this.fd);
      this.records.push(record);
      if (terminal) this.reservations.delete(String(value.command_id));
    } catch (error) { this.failed = true; throw error; }
  }
  close(): void { closeSync(this.fd); }
}
