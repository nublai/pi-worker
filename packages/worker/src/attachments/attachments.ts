/**
 * Staged attachments (P1-16, Shep's S-4): images the bridge forwards before the prompt that uses them.
 *
 * - The body streams into a private temporary file in `$STATE/attachments/` (0700) through the router's byte counter;
 *   the SHA-256 and the magic bytes are checked after the last byte. Every refusal up to there removes the file and
 *   is `no_effect`: nothing was recorded.
 * - Then the receipt flow: intent, the dispatch record, the file fsynced and renamed to its final name, the directory
 *   fsynced, and one `attachment` journal record makes it `staged`. A crash after the dispatch record is
 *   `outcome_unknown`; `attachments.status` reads the record to reconcile, never a re-upload.
 * - Idempotent by `attachment_id` plus SHA-256: the same id and hash again stores nothing twice; another hash, or an id
 *   another worker staged, is refused `attachment_id_conflict`.
 * - The per-worker bound (16 attachments, 32 MiB) counts uploads still streaming: one reserves its slot before its first
 *   byte and each chunk's bytes before writing them, each check in the same synchronous turn as its reservation, so a
 *   wave of concurrent uploads holds the bound on disk too and the record never takes more than was reserved. A refused
 *   or failed upload releases its reservation and removes its file.
 * - Release: the `released` record is durable before the bytes are removed. A delivered prompt releases its own.
 * - At startup, temporary files and files without a `staged` record are removed: no record, no attachment.
 *
 * The journal never stores image bytes; only ids, sizes, hashes and states.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../b2/errors.js';
import type { components } from '../generated/api.js';
import { durable } from '../journal/fsync.js';
import type { Journal } from '../journal/journal.js';
import type { Receipt, ReceiptStore } from '../receipts/receipts.js';

export type AttachmentStatus = components['schemas']['AttachmentStatus'];
export type ContentType = AttachmentStatus['content_type'];

/** Per worker: staged attachments at once, and their bytes (four photos of two messages, with room to spare). */
export const STAGED_PER_WORKER = 16;
export const STAGED_BYTES_PER_WORKER = 32 * 1024 * 1024;

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/** The media type the bytes' magic numbers say, among the staged image types. */
export function sniff(head: Buffer): ContentType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** What a stage request names, from its headers and path. */
export interface StageRequest {
  readonly attachment_id: string;
  readonly command_id: string;
  readonly worker_id: string;
  readonly worker_epoch: string;
  readonly session_id: string;
  readonly binding_revision: number;
  readonly sha256: string;
  readonly content_type: ContentType;
}

interface Receiving {
  readonly request: StageRequest;
  bytes: number;
}

export class Attachments {
  readonly dir: string;
  /** attachment id → its latest durable record. */
  readonly records = new Map<string, AttachmentStatus>();
  /** Uploads still streaming (memory only). */
  private readonly receiving = new Map<string, Receiving>();

  constructor(
    readonly journal: Journal,
    readonly receipts: ReceiptStore,
    stateDir: string,
  ) {
    this.dir = join(stateDir, 'attachments');
    for (const record of journal.records) {
      if (record.kind !== 'attachment') continue;
      // SAFETY: every `attachment` record is written by `record()` below from an AttachmentStatus value.
      const value = record.value as unknown as AttachmentStatus;
      this.records.set(value.attachment_id, value);
    }
  }

  private file(id: string): string {
    return join(this.dir, `${sha256(id)}.img`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('attachments directory must be an owned 0700 directory');
  }

  /** At startup: temporary files and files without a staged record are removed. Only this store's own names. */
  sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const keep = new Set([...this.records.values()].filter(r => r.state === 'staged').map(r => `${sha256(r.attachment_id)}.img`));
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.(img|[0-9a-f-]{36}\.part)$/.test(name) || keep.has(name)) continue;
      try {
        unlinkSync(join(this.dir, name));
      } catch {
        /* already gone */
      }
    }
  }

  status(id: string): AttachmentStatus {
    const record = this.records.get(id);
    if (record) return structuredClone(record);
    const receiving = this.receiving.get(id);
    if (receiving) {
      const r = receiving.request;
      return {
        attachment_id: id,
        worker_id: r.worker_id,
        state: 'receiving',
        content_type: r.content_type,
        bytes: receiving.bytes,
        sha256: r.sha256,
        command_id: r.command_id,
        staged_at: null,
        released_at: null,
        released_by: null,
        evidence: 'observed_memory',
      };
    }
    // Unknown is never proof that nothing was staged (a reply may still be in flight, or the record expired).
    throw new Refusal('unknown_attachment_is_not_proof_of_no_effect', 'unknown', undefined, {}, 409);
  }

  /** The worker an attachment belongs to, if the worker knows the attachment. */
  owner(id: string): string | undefined {
    return this.records.get(id)?.worker_id ?? this.receiving.get(id)?.request.worker_id;
  }

  /**
   * A worker's staged attachments plus its uploads still streaming (each with the bytes it has so far), against the
   * per-worker bound. Without `self` it asks for one more upload, not yet streaming.
   */
  private quota(workerId: string, self?: Receiving): void {
    let count = self ? 0 : 1;
    let bytes = 0;
    for (const r of this.records.values()) {
      if (r.worker_id !== workerId || r.state !== 'staged') continue;
      count++;
      bytes += r.bytes;
    }
    for (const r of this.receiving.values()) {
      // An upload whose record is written counts once, as staged.
      if (r.request.worker_id !== workerId || this.records.has(r.request.attachment_id)) continue;
      count++;
      bytes += r.bytes;
    }
    if (count > STAGED_PER_WORKER || bytes > STAGED_BYTES_PER_WORKER) throw new Refusal('attachment_capacity');
  }

  private record(value: AttachmentStatus, label: 'attachment.stage' | 'attachment.release'): void {
    // SAFETY: AttachmentStatus is a plain JSON object; the journal stores it as a record value.
    this.journal.append('attachment', value as unknown as Record<string, unknown>, label);
    this.records.set(value.attachment_id, value);
  }

  /**
   * Stages one upload. `checks` are the caller's synchronous checks (worker, scope, binding); they run before any
   * byte is read and again inside the receipt flow. The body is drained even when the request is answered without
   * storing it (a duplicate), so a well-behaved client never sees its upload cut off.
   */
  async stage(request: StageRequest, body: AsyncIterable<Uint8Array>, checks: () => void): Promise<Receipt> {
    const id = request.attachment_id;
    const drain = async () => {
      for await (const _ of body);
    };
    const prior = this.records.get(id);
    const receipt = this.receipts.all.get(request.command_id);
    // A retry of a command already recorded: its stored receipt (receipts.run compares the request).
    if (receipt) {
      await drain();
      return this.receipts.run(request.command_id, 'attachments.stage', { ...request }, async () => ({}));
    }
    checks();
    // An id another worker staged is never this worker's duplicate: its command id stays with that worker.
    if (prior && (prior.worker_id !== request.worker_id || prior.sha256 !== request.sha256)) throw new Refusal('attachment_id_conflict');
    if (prior && prior.state === 'released') throw new Refusal('attachment_released');
    if (prior) {
      // The same image again: nothing is stored twice; a receipt for this command names the staged attachment.
      await drain();
      return this.receipts.run(
        request.command_id,
        'attachments.stage',
        { ...request },
        async () => ({ state: 'delivered', stage: 'forwarded', effect: 'observed', worker_id: request.worker_id, result: { attachment_id: id, state: prior.state, bytes: prior.bytes, duplicate_of: prior.command_id } }),
        checks,
      );
    }
    if (this.receiving.has(id)) throw new Refusal('attachment_upload_in_progress');
    // Reserves this upload's slot: synchronous with the set below, so concurrent arrivals each see the others.
    this.quota(request.worker_id);
    this.ensureDir();
    const temp = join(this.dir, `${sha256(id)}.${randomUUID()}.part`);
    const receiving: Receiving = { request, bytes: 0 };
    this.receiving.set(id, receiving);
    let kept = false;
    try {
      const hash = createHash('sha256');
      let head = Buffer.alloc(0);
      const fd = openSync(temp, 'wx', 0o600);
      try {
        // The router's counter refuses the byte past the limit (413); the file is removed below.
        for await (const chunk of body) {
          const b = Buffer.from(chunk);
          hash.update(b);
          if (head.length < 16) head = Buffer.concat([head, b.subarray(0, 16 - head.length)]);
          // The chunk's bytes are reserved before they are written: the worker's staged and streaming bytes together
          // never pass the bound on disk.
          receiving.bytes += b.length;
          this.quota(request.worker_id, receiving);
          let off = 0;
          while (off < b.length) off += writeSync(fd, b, off, b.length - off);
        }
        if (receiving.bytes === 0) throw new Refusal('attachment_empty', 'no_effect', undefined, {}, 400);
        if (hash.digest('hex') !== request.sha256) throw new Refusal('attachment_sha256_mismatch', 'no_effect', undefined, {}, 400);
        if (sniff(head) !== request.content_type) throw new Refusal('attachment_type_mismatch', 'no_effect', undefined, {}, 400);
        // The staged bytes are durable before the record that makes them usable.
        durable(fd, 'attachment.file');
      } finally {
        closeSync(fd);
      }
      const bytes = receiving.bytes;
      const result = await this.receipts.run(
        request.command_id,
        'attachments.stage',
        { ...request },
        async () => {
          this.receipts.dispatch(request.command_id, { worker_id: request.worker_id });
          renameSync(temp, this.file(id));
          kept = true;
          const dir = openSync(this.dir, 'r');
          try {
            durable(dir, 'attachment.directory');
          } finally {
            closeSync(dir);
          }
          const now = new Date().toISOString();
          this.record(
            { attachment_id: id, worker_id: request.worker_id, state: 'staged', content_type: request.content_type, bytes, sha256: request.sha256, command_id: request.command_id, staged_at: now, released_at: null, released_by: null, evidence: 'supervisor_journal_fsynced' },
            'attachment.stage',
          );
          return { state: 'delivered', stage: 'forwarded', effect: 'observed', worker_id: request.worker_id, result: { attachment_id: id, state: 'staged', bytes } };
        },
        () => {
          checks();
          if (this.records.has(id)) throw new Refusal('attachment_id_conflict');
        },
      );
      return result;
    } finally {
      this.receiving.delete(id);
      if (!kept) {
        try {
          unlinkSync(temp);
        } catch {
          /* never created, or already renamed */
        }
      }
    }
  }

  /** The staged attachments a prompt names, checked against the worker and the per-message limits. */
  forPrompt(workerId: string, ids: readonly string[], limits: { count: number; bytes: number }): { id: string; path: string; sha256: string; mime_type: ContentType; bytes: number }[] {
    if (ids.length > limits.count) throw new Refusal('too_many_attachments');
    if (new Set(ids).size !== ids.length) throw new Refusal('duplicate_attachment');
    const out = ids.map(id => {
      const r = this.records.get(id);
      if (!r || r.worker_id !== workerId) throw new Refusal('unknown_attachment');
      if (r.state !== 'staged') throw new Refusal('attachment_not_staged');
      return { id, path: this.file(id), sha256: r.sha256, mime_type: r.content_type, bytes: r.bytes };
    });
    if (out.reduce((n, a) => n + a.bytes, 0) > limits.bytes) throw new Refusal('attachments_too_large');
    return out;
  }

  /** Marks staged attachments released (durable first), then removes their bytes. */
  releaseNow(ids: readonly string[], by: string): void {
    for (const id of ids) {
      const r = this.records.get(id);
      if (!r || r.state !== 'staged') continue;
      this.record({ ...r, state: 'released', released_at: new Date().toISOString(), released_by: by }, 'attachment.release');
      try {
        unlinkSync(this.file(id));
      } catch {
        /* the startup sweep removes what is left */
      }
    }
  }

  /** `attachments.release`: refused for an unknown or already released attachment, before any record. */
  release(id: string, commandId: string, checks: () => void): Promise<Receipt> {
    let workerId = '';
    return this.receipts.run(
      commandId,
      'attachments.release',
      { attachment_id: id },
      async () => {
        this.receipts.dispatch(commandId, { worker_id: workerId });
        this.releaseNow([id], commandId);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed', worker_id: workerId, result: { attachment_id: id, state: 'released' } };
      },
      () => {
        checks();
        const r = this.records.get(id);
        if (!r) throw new Refusal('unknown_attachment');
        if (r.state !== 'staged') throw new Refusal('attachment_not_staged');
        workerId = r.worker_id;
      },
    );
  }
}
