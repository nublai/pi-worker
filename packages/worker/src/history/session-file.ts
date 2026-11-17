/**
 * A pi session file read as bytes (Shep's question S-1, shape (a)): the file identity, the watermark (the byte after
 * the last complete line), byte-range reads of complete lines with a reset rule, and an incremental summary for
 * session and worker rows. Read only; it never spawns pi and never writes. The path always comes from the
 * supervisor's own records (the resume catalog), never from a client.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import type { components } from '../generated/api.js';

export type SessionStats = components['schemas']['SessionStats'];

/** The worker's interrupt marker line (Shep's R9 text, owned by the worker since S-5). */
export const INTERRUPT_MARKER = '[The previous request was interrupted by the user before it finished.]';
/** Most bytes one sessions.history read may ask for, and the longest single line it returns. */
export const HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const HISTORY_LINE_MAX_BYTES = 64 * 1024 * 1024;
/** The identity of a session file pi has not written yet. */
export const ABSENT_IDENTITY = createHash('sha256').update('pi-worker:absent-session-file').digest('hex');
const HEAD_BYTES = 64 * 1024;
const CHUNK = 1024 * 1024;
/**
 * Lines longer than this are summarized without the values of their `"data"` strings (pi's base64 image payloads):
 * four photos make a user line of several MiB that must still count as a message with its text.
 */
const SUMMARY_LINE_BYTES = 4 * 1024 * 1024;
const DATA_KEY = Buffer.from('"data":"');
const PREVIEW_CHARS = 280;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, offset + done);
    if (n <= 0) break;
    done += n;
  }
  return buffer.subarray(0, done);
}

/**
 * Rewrite generations of session files by device and inode (memory). pi only appends, so a file that grew was appended
 * to; the same size with another mtime or ctime, or a smaller size, is a rewrite in place (Shep's S-1 reset rule, the
 * bridge's own local checks) and starts a new generation, which is part of the file identity. Every reader of a
 * session file (sessions.history, the summaries behind rows and `history.appended`) observes through one instance, so
 * the supervisor sees every state it serves. A restart forgets the generations: identities go back to generation 0,
 * which only resets a reader whose identity named a later one.
 */
export class FileGenerations {
  private readonly seen = new Map<string, { size: bigint; mtimeNs: bigint; ctimeNs: bigint; generation: number }>();

  /** Observes the open file's size and times; returns its rewrite generation. */
  observe(st: BigIntStats): number {
    const key = `${st.dev}:${st.ino}`;
    const prior = this.seen.get(key);
    let generation = prior?.generation ?? 0;
    if (prior && (st.size < prior.size || (st.size === prior.size && (st.mtimeNs !== prior.mtimeNs || st.ctimeNs !== prior.ctimeNs)))) generation++;
    this.seen.set(key, { size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, generation });
    return generation;
  }
}

/**
 * The file identity: device, inode, the first line's bytes and the rewrite generation. Stable across appends; a
 * replaced file (new inode), a rewritten header or a rewrite in place (a new generation) changes it. A rewrite that
 * also grew the file is caught by the `tail` check when it changed the line before the reader's offset.
 */
export function fileIdentity(fd: number, st: BigIntStats, generation: number): string {
  const head = readAt(fd, 0, Math.min(HEAD_BYTES, Number(st.size)));
  const nl = head.indexOf(0x0a);
  const first = nl >= 0 ? head.subarray(0, nl + 1) : Buffer.alloc(0);
  return sha256(`${st.dev}:${st.ino}:${sha256(first)}${generation > 0 ? `:${generation}` : ''}`);
}

/** The byte after the last complete line (0 when there is none): what a reader may see. */
export function watermarkOf(fd: number, size: number): number {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - CHUNK);
    const chunk = readAt(fd, start, end - start);
    const nl = chunk.lastIndexOf(0x0a);
    if (nl >= 0) return start + nl + 1;
    end = start;
  }
  return 0;
}

/** The start of the line that ends at `end` (end is a line start, so the byte before it is a line feed). */
function lineStartBefore(fd: number, end: number): number {
  let pos = end - 1; // the line feed that ends it
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK);
    const chunk = readAt(fd, start, pos - start);
    const nl = chunk.lastIndexOf(0x0a);
    if (nl >= 0) return start + nl + 1;
    pos = start;
  }
  return 0;
}

export interface HistoryRead {
  readonly identity: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly watermark: number;
  readonly reset: boolean;
  readonly tail: string | null;
  readonly body: Buffer;
}

export type HistoryReadError = 'history_offset_past_watermark' | 'history_offset_not_line_start' | 'history_line_too_large';

/**
 * Complete lines from `offset`, at most `maxBytes` unless one line alone is longer (then that line, up to
 * HISTORY_LINE_MAX_BYTES). Reset rule (sessions.history): a differing `identity`, or a `tail` that is not the SHA-256
 * of the line ending at `offset`, restarts from byte 0 with `reset`. Without a tail, an offset past the watermark or
 * not on a line start is an error, never an empty page. A missing file reads as empty with the absent identity.
 */
export function readHistory(
  file: string | null,
  q: { offset: number; maxBytes: number; identity?: string; tail?: string },
  generations: FileGenerations,
): HistoryRead | { error: HistoryReadError } {
  let fd: number;
  try {
    if (file === null) throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    fd = openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The same rule over an empty file: another identity, or a tail no line here can match, resets.
    const reset = (q.identity !== undefined && q.identity !== ABSENT_IDENTITY) || (q.offset > 0 && q.tail !== undefined);
    if (!reset && q.offset > 0) return { error: 'history_offset_past_watermark' };
    return { identity: ABSENT_IDENTITY, offset: 0, nextOffset: 0, watermark: 0, reset, tail: null, body: Buffer.alloc(0) };
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    const identity = fileIdentity(fd, st, generations.observe(st));
    const watermark = watermarkOf(fd, Number(st.size));
    let start = q.offset;
    let reset = q.identity !== undefined && q.identity !== identity;
    if (!reset && start > 0) {
      const onLine = start <= watermark && readAt(fd, start - 1, 1)[0] === 0x0a;
      if (q.tail !== undefined) {
        // The caller names the line it read last: a different one means the file changed under it.
        if (!onLine || sha256(readAt(fd, lineStartBefore(fd, start), start - lineStartBefore(fd, start))) !== q.tail) reset = true;
      } else if (start > watermark) return { error: 'history_offset_past_watermark' };
      else if (!onLine) return { error: 'history_offset_not_line_start' };
    }
    if (reset) start = 0;
    let end = Math.min(watermark, start + q.maxBytes);
    if (end > start) {
      const window = readAt(fd, start, end - start);
      const nl = window.lastIndexOf(0x0a);
      if (nl >= 0) end = start + nl + 1;
      else {
        // One line longer than max_bytes: return that line alone, so a reader always makes progress.
        let pos = end;
        end = -1;
        while (pos < watermark && pos - start <= HISTORY_LINE_MAX_BYTES) {
          const chunk = readAt(fd, pos, Math.min(CHUNK, watermark - pos));
          const at = chunk.indexOf(0x0a);
          if (at >= 0) {
            end = pos + at + 1;
            break;
          }
          pos += chunk.length;
        }
        if (end < 0 || end - start > HISTORY_LINE_MAX_BYTES) return { error: 'history_line_too_large' };
      }
    }
    const body = end > start ? readAt(fd, start, end - start) : Buffer.alloc(0);
    let tail: string | null = null;
    if (body.length > 0) {
      const lastStart = body.lastIndexOf(0x0a, body.length - 2) + 1;
      tail = sha256(body.subarray(lastStart));
    } else if (start > 0) {
      const ls = lineStartBefore(fd, start);
      tail = sha256(readAt(fd, ls, start - ls));
    }
    return { identity, offset: start, nextOffset: start + body.length, watermark, reset, tail, body };
  } finally {
    closeSync(fd);
  }
}

/** What a session or worker row shows about a session file. */
export interface Summary {
  identity: string;
  watermark: number;
  created_at: string | null;
  last_activity_at: string | null;
  title: string | null;
  preview: string | null;
  message_count: number;
  stats: SessionStats;
  model: { provider: string; id: string } | null;
  thinking: string | null;
}

const emptyStats = (): SessionStats => ({
  user_messages: 0,
  assistant_messages: 0,
  tool_calls: 0,
  tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
  cost_total: 0,
  models: [],
});

const emptySummary = (identity: string): Summary => ({
  identity,
  watermark: 0,
  created_at: null,
  last_activity_at: null,
  title: null,
  preview: null,
  message_count: 0,
  stats: emptyStats(),
  model: null,
  thinking: null,
});

/** A user's text without the worker's interrupt marker line. */
export function stripMarker(text: string): string {
  if (!text.startsWith(INTERRUPT_MARKER)) return text;
  const rest = text.slice(INTERRUPT_MARKER.length);
  return rest.startsWith('\r\n') ? rest.slice(2) : rest.startsWith('\n') ? rest.slice(1) : rest;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map(c => c.text)
    .join('\n');
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Folds one parsed session-file line into a summary. */
function fold(s: Summary, entry: Record<string, unknown>): void {
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null;
  if (entry.type === 'session') {
    s.created_at = ts;
    return;
  }
  if (ts) s.last_activity_at = ts;
  if (entry.type === 'session_info') s.title = typeof entry.name === 'string' && entry.name.trim() ? entry.name.slice(0, 512) : null;
  if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') s.model = { provider: entry.provider, id: entry.modelId };
  if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') s.thinking = entry.thinkingLevel;
  if (entry.type !== 'message' && entry.type !== 'custom_message') return;
  s.message_count++;
  const message = (entry.message ?? {}) as Record<string, unknown>;
  if (entry.type === 'message' && message.role === 'user') {
    s.stats.user_messages++;
    const text = stripMarker(textOf(message.content)).trim();
    if (text) s.preview = text.slice(0, PREVIEW_CHARS);
  }
  if (entry.type === 'message' && message.role === 'assistant') {
    s.stats.assistant_messages++;
    const content = Array.isArray(message.content) ? message.content : [];
    s.stats.tool_calls += content.filter(c => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'toolCall').length;
    const text = textOf(content).trim();
    if (text) s.preview = text.slice(0, PREVIEW_CHARS);
    const usage = (message.usage ?? {}) as Record<string, unknown>;
    const cost = num((usage.cost as Record<string, unknown> | undefined)?.total);
    const total = num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
    s.stats.tokens.input += num(usage.input);
    s.stats.tokens.output += num(usage.output);
    s.stats.tokens.cache_read += num(usage.cacheRead);
    s.stats.tokens.cache_write += num(usage.cacheWrite);
    s.stats.tokens.total += total;
    s.stats.cost_total += cost;
    const provider = String(message.provider ?? 'unknown').slice(0, 128);
    const model = String(message.model ?? 'unknown').slice(0, 256);
    let row = s.stats.models.find(m => m.provider === provider && m.model === model);
    if (!row && s.stats.models.length < 64) s.stats.models.push((row = { provider, model, assistant_messages: 0, tokens_total: 0, cost_total: 0 }));
    if (row) {
      row.assistant_messages++;
      row.tokens_total += total;
      row.cost_total += cost;
    }
  }
}

/**
 * The line `[start, end)` without the values of its `"data"` strings, read in chunks: what a summary needs (type,
 * role, text, timestamp, usage) without image bytes. Null when what is left is still over the summary limit.
 */
function withoutData(fd: number, start: number, end: number): Buffer | null {
  const out: Buffer[] = [];
  let kept = 0;
  let matched = 0;
  let inData = false;
  let escaped = false;
  for (let pos = start; pos < end; ) {
    const chunk = readAt(fd, pos, Math.min(CHUNK, end - pos));
    if (chunk.length === 0) break;
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      if (inData) {
        if (escaped) escaped = false;
        else if (b === 0x5c) escaped = true;
        else if (b === 0x22) {
          inData = false;
          from = i; // the closing quote is kept
        }
        continue;
      }
      matched = b === DATA_KEY[matched] ? matched + 1 : b === 0x22 ? 1 : 0;
      if (matched === DATA_KEY.length) {
        out.push(chunk.subarray(from, i + 1));
        kept += i + 1 - from;
        inData = true;
        matched = 0;
      }
    }
    if (!inData) {
      out.push(chunk.subarray(from));
      kept += chunk.length - from;
    }
    if (kept > SUMMARY_LINE_BYTES) return null;
    pos += chunk.length;
  }
  return Buffer.concat(out);
}

/**
 * Incremental summaries by file: each read folds only the complete lines appended since the last one, and starts over
 * when the identity changes (a replaced or rewritten file) or the file shrank. A line over 4 MiB is folded without its
 * `"data"` values (image payloads); one still over 4 MiB without them is not parsed.
 */
export class Summaries {
  private readonly cache = new Map<string, Summary>();
  /** The rewrite generations every session-file reader observes through (sessions.history included). */
  readonly generations = new FileGenerations();

  get(file: string | null): Summary {
    if (file === null) return emptySummary(ABSENT_IDENTITY);
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache.delete(file);
      return emptySummary(ABSENT_IDENTITY);
    }
    try {
      const st = fstatSync(fd, { bigint: true });
      const identity = fileIdentity(fd, st, this.generations.observe(st));
      const watermark = watermarkOf(fd, Number(st.size));
      let s = this.cache.get(file);
      if (!s || s.identity !== identity || watermark < s.watermark) s = emptySummary(identity);
      let pos = s.watermark;
      while (pos < watermark) {
        const chunk = readAt(fd, pos, Math.min(CHUNK, watermark - pos));
        const nl = chunk.indexOf(0x0a);
        if (nl < 0) {
          // A line longer than the chunk: find its end, skip it unparsed if it is over the summary limit.
          let end = pos + chunk.length;
          while (end < watermark) {
            const more = readAt(fd, end, Math.min(CHUNK, watermark - end));
            const at = more.indexOf(0x0a);
            if (at >= 0) {
              end += at + 1;
              break;
            }
            end += more.length;
          }
          const line = end - pos <= SUMMARY_LINE_BYTES ? readAt(fd, pos, end - pos) : withoutData(fd, pos, end);
          if (line) this.foldLine(s, line);
          pos = end;
          continue;
        }
        let start = 0;
        while (start < chunk.length) {
          const at = chunk.indexOf(0x0a, start);
          if (at < 0) break;
          this.foldLine(s, chunk.subarray(start, at));
          start = at + 1;
        }
        pos += start;
      }
      s.watermark = watermark;
      this.cache.set(file, s);
      return structuredClone(s);
    } finally {
      closeSync(fd);
    }
  }

  private foldLine(s: Summary, line: Buffer): void {
    if (line.length === 0) return;
    try {
      const entry = JSON.parse(line.toString('utf8')) as unknown;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) fold(s, entry as Record<string, unknown>);
    } catch {
      /* not one JSON value: pi's line, not ours to judge here; sessions.history refuses to serve it */
    }
  }
}
