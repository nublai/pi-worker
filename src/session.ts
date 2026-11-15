/**
 * THROWAWAY A0. Adapted from nublai/exmach b92773f packages/agent/src/session.ts.
 * Read-only adapter over a Pi session file. It never spawns
 * Pi and never writes. The index keeps only offsets, so a page reads just its own entries.
 * Pi appends entries and its leaf is the newest entry; the visible path is the parentId chain
 * from a pinned watermark back to the root, which later appends never change.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  type HistoryCursor,
  type HistoryEntry,
  type HistoryPage,
  jsonBytes,
  SIZE_LIMITS,
} from "./types.js";

interface Indexed {
  id: string;
  parentId: string | null;
  type: string;
  offset: number;
  length: number;
  oversize: boolean;
}

const MESSAGE_TYPES = new Set(["message", "custom_message"]);
const READ_CHUNK = 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TOKEN = /^[!#-[\]-~]{1,128}$/;

export class SessionIndex {
  private byId = new Map<string, Indexed>();
  private offset = 0;
  private ino = -1;
  private leaf: string | null = null;
  private messages = 0;
  private readonly rawLimit: number;
  file: string | null;
  headerId: string | null = null;

  constructor(file: string | null, rawLimit: number = SIZE_LIMITS.rawLineBytes) {
    this.file = file;
    this.rawLimit = rawLimit;
  }

  get leafId(): string | null {
    return this.leaf;
  }
  /** Message entries indexed so far (persisted `message_end`s). */
  get messageEntries(): number {
    return this.messages;
  }

  private reset(): void {
    this.byId.clear();
    this.offset = 0;
    this.leaf = null;
    this.messages = 0;
    this.headerId = null;
  }

  /** Index whatever Pi appended since the last call. A rewritten file is indexed afresh. */
  refresh(): void {
    if (this.file === null) return;
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch {
      this.reset();
      return;
    }
    try {
      const st = fstatSync(fd);
      if (st.ino !== this.ino || st.size < this.offset) {
        this.reset();
        this.ino = st.ino;
      }
      this.scan(fd, st.size);
    } finally {
      closeSync(fd);
    }
  }

  private scan(fd: number, size: number): void {
    let lineStart = this.offset;
    let pos = this.offset;
    let head: Buffer[] = [];
    let headBytes = 0;
    const buffer = Buffer.alloc(READ_CHUNK);
    while (pos < size) {
      const n = readSync(fd, buffer, 0, Math.min(READ_CHUNK, size - pos), pos);
      if (n <= 0) break;
      let start = 0;
      while (start < n) {
        const nl = buffer.indexOf(10, start);
        const end = nl === -1 || nl >= n ? n : nl;
        if (headBytes < HEAD_BYTES) {
          const piece = Buffer.from(buffer.subarray(start, Math.min(end, start + HEAD_BYTES - headBytes)));
          head.push(piece);
          headBytes += piece.length;
        }
        if (nl === -1 || nl >= n) break;
        const lineEnd = pos + nl;
        this.indexLine(fd, lineStart, lineEnd - lineStart, Buffer.concat(head).toString("utf8"));
        head = [];
        headBytes = 0;
        lineStart = lineEnd + 1;
        start = nl + 1;
      }
      pos += n;
    }
    // A partial last line is left for the next refresh.
    this.offset = lineStart;
  }

  private indexLine(fd: number, offset: number, length: number, head: string): void {
    if (length === 0) return;
    let fields: { id?: unknown; parentId?: unknown; type?: unknown };
    let oversize = false;
    if (length > this.rawLimit) {
      oversize = true;
      fields = {
        id: head.match(/"id"\s*:\s*"([^"\\]+)"/)?.[1],
        parentId: head.match(/"parentId"\s*:\s*(?:"([^"\\]+)"|null)/)?.[1] ?? null,
        type: head.match(/"type"\s*:\s*"([^"\\]+)"/)?.[1],
      };
    } else {
      try {
        fields = JSON.parse(readAt(fd, offset, length)) as typeof fields;
      } catch {
        return;
      }
    }
    const { id, parentId, type } = fields;
    if (typeof id !== "string" || !TOKEN.test(id) || typeof type !== "string") return;
    if (type === "session") { this.headerId = id; return; }
    this.byId.set(id, {
      id,
      parentId: typeof parentId === "string" ? parentId : null,
      type,
      offset,
      length,
      oversize,
    });
    this.leaf = id;
    if (MESSAGE_TYPES.has(type)) this.messages += 1;
  }

  hasEntry(id: string): boolean { this.refresh(); return this.byId.has(id); }

  /** Exact nubl attribution only; never infer an execution from user/model text. */
  hasExecution(executionId: string, commandId: string): boolean {
    this.refresh();
    if (!this.file) return false;
    const fd = openSync(this.file, 'r');
    try {
      for (const meta of this.byId.values()) {
        if (meta.oversize || meta.length > SIZE_LIMITS.historyPageBytes) continue;
        const entry = this.read(fd, meta);
        const data = entry.data as Record<string, unknown> | undefined;
        if (entry.type === 'custom' && entry.customType === 'a0_execution' && data?.execution_id === executionId && data.command_id === commandId) return true;
      }
      return false;
    } finally { closeSync(fd); }
  }

  /** The visible path from the root to `watermark`, oldest first. */
  private path(watermark: string): Indexed[] | null {
    if (!this.byId.has(watermark)) return null;
    const out: Indexed[] = [];
    const seen = new Set<string>();
    let entry = this.byId.get(watermark);
    // An unreadable ancestor or a cycle ends the path there.
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      out.push(entry);
      entry = entry.parentId === null ? undefined : this.byId.get(entry.parentId);
    }
    return out.reverse();
  }

  /**
   * One page of history. `cursor: null` pins the watermark at the current leaf. Errors are
   * returned as text for a `bad_request`.
   */
  page(cursor: HistoryCursor | null, limit: number): HistoryPage | { error: string } {
    this.refresh();
    const watermark = cursor === null ? this.leaf : cursor.watermark;
    const leafId = this.leaf;
    if (watermark === null) return { entries: [], watermark: null, next: null, leafId, truncated: false, evidence: 'pi_session_file' };
    const path = this.path(watermark);
    if (path === null) return { error: `unknown watermark ${watermark}` };
    let index = 0;
    const after = cursor?.after ?? null;
    if (after !== null) {
      index = path.findIndex((e) => e.id === after) + 1;
      if (index === 0) return { error: `entry ${after} is not on the path to ${watermark}` };
    }
    const entries: HistoryEntry[] = [];
    let bytes = 2;
    let truncated = false;
    if (this.file === null) return { error: "no session file" };
    const fd = openSync(this.file, "r");
    try {
      for (; index < path.length && entries.length < limit; index++) {
        const meta = path[index] as Indexed;
        const entry = this.read(fd, meta);
        const size = jsonBytes(entry) + (entries.length > 0 ? 1 : 0);
        if (bytes + size > SIZE_LIMITS.historyPageBytes) {
          truncated = true;
          break;
        }
        entries.push(entry);
        bytes += size;
      }
    } finally {
      closeSync(fd);
    }
    const last = entries.at(-1)?.id;
    const done = index >= path.length;
    return {
      entries,
      watermark,
      next: done || last === undefined ? null : { watermark, after: last },
      leafId,
      truncated,
      evidence: 'pi_session_file',
    };
  }

  private read(fd: number, meta: Indexed): HistoryEntry {
    const stub = { too_large: true as const, id: meta.id, type: meta.type, bytes: meta.length };
    if (meta.oversize || meta.length + 2 > SIZE_LIMITS.historyPageBytes) return stub;
    try {
      const value = JSON.parse(readAt(fd, meta.offset, meta.length)) as Record<string, unknown>;
      if (jsonBytes(value) + 2 > SIZE_LIMITS.historyPageBytes || "too_large" in value) return stub;
      return value as HistoryEntry;
    } catch {
      return stub;
    }
  }
}

function readAt(fd: number, offset: number, length: number): string {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, offset + done);
    if (n <= 0) break;
    done += n;
  }
  return buffer.subarray(0, done).toString("utf8");
}
