/**
 * Hand-written B2 transport over the worker's Unix socket, typed by the generated API. Ported from A0 `src/client.ts`.
 *
 * Rules (contract section 1, B2 transport conditions):
 * - One attempt per call: `agent: false`, `Connection: close`, no retries, no keep-alive replay.
 * - Nothing is written until the socket connects. A failure before that is `no_effect`; after it, `unknown`, and the
 *   caller reads the receipt for its `command_id`. A disconnect is never a cancel.
 * - An HTTP refusal keeps the worker's `effect` only from a B2 Error body that passes its schema; anything else is
 *   `unknown`.
 * - Every reply is checked before the caller sees it, by validators generated from the spec (tools/codegen, no
 *   runtime package): its media type, UTF-8, JSON and schema, or for a byte read its typed headers and complete final
 *   line. A 200 that fails a check is `unknown` after the write and its body is never exposed. A failure names the
 *   check and the schema path only, never a value from the reply.
 * - The SSE reader delivers only frames that pass the event schema. An invalid frame ends the watch with
 *   ResyncRequired, so it never reaches the callback and never ends a resync. It never reconnects on its own: a
 *   reconnect is the caller's decision and starts with a snapshot.
 */
import { request, type IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { components, operations } from './generated/api.js';
import { routes, type ClientRoute, type OperationId } from './generated/routes.js';
import { error as validateError, event_frame as validateEventFrame, type Validator } from './generated/validators.js';

type Op<O extends OperationId> = operations[O];
export type PathParams<O extends OperationId> = Op<O> extends { parameters: { path: infer P } } ? (P extends undefined ? never : P) : never;
export type QueryParams<O extends OperationId> = Op<O> extends { parameters: { query?: infer Q } } ? Q : never;
export type RequestBody<O extends OperationId> = Op<O> extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
export type OkBody<O extends OperationId> = Op<O> extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
export type EventFrame = components['schemas']['EventFrame'];
export type Cursor = components['schemas']['Cursor'];
export type Hello = components['schemas']['Hello'];
export type Receipt = components['schemas']['Receipt'];

/** The session binding and command id `attachments.stage` sends as `Piw-*` headers. */
export interface StageParams {
  command_id: string;
  worker_id: string;
  worker_epoch: string;
  session_id: string;
  binding_revision: number;
}

export interface CallOptions<O extends OperationId> {
  path?: PathParams<O>;
  query?: QueryParams<O>;
  body?: RequestBody<O>;
}

/** The protocol major this client speaks. A worker with another major is refused. */
export const PROTOCOL_MAJOR = 0;
/**
 * The most bytes of one JSON response. It covers the largest reply the spec allows: files.read's 1 MiB of UTF-8
 * content at worst-case JSON escaping (6 bytes, `\u0001`, per content byte) plus its escaped path and envelope.
 */
const RESPONSE_LIMIT = 8 * 1024 * 1024;
/**
 * One SSE record: its field lines, each counted with one line-ending byte. The spec's x-piw-max-frame-bytes for
 * events.subscribe, through the generated route table.
 */
const FRAME_LIMIT = routes['events.subscribe'].maxFrameBytes;

const LF = 0x0a;
const CR = 0x0d;

/** Strict UTF-8: a malformed sequence throws instead of becoming U+FFFD. A BOM is kept as data. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The media type of a Content-Type header: lower case, without parameters. */
function mediaType(header: string | string[] | undefined): string {
  return (typeof header === 'string' ? header : '').split(';')[0]!.trim().toLowerCase();
}

/** Where a reply failed its schema: the schema path and keyword only, never a value or a key the reply chose. */
function schemaFailure(validate: Validator): Record<string, unknown> {
  const first = validate.errors?.[0];
  return first ? { schema_path: first.schemaPath, keyword: first.keyword } : {};
}

/** Header strings become their declared scalar kind, as the worker's router converts them; anything else stays. */
function convertHeader(raw: string, kind: 'string' | 'integer' | 'number' | 'boolean'): string | number | boolean {
  if (kind === 'integer' && /^-?\d{1,16}$/.test(raw)) return Number(raw);
  if (kind === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (kind === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  return raw;
}

/**
 * Incremental text/event-stream parser over bytes. Lines end in LF, CRLF or a lone CR (also across chunks); one
 * space after a field's colon is optional; lines starting with `:` are comments; a blank line ends a record. A line
 * or record over `limit` bytes throws ResyncRequired('frame_too_large'); nothing is ever truncated. A line that is not
 * UTF-8 throws ResyncRequired('invalid_frame').
 */
class EventStreamParser {
  private parts: Buffer[] = [];
  private lineBytes = 0;
  private recordBytes = 0;
  private pendingCR = false;
  private data: string[] = [];

  constructor(readonly limit: number = FRAME_LIMIT) {}

  /** Feeds bytes; returns the `data` payloads of the records this chunk completes, in order. */
  push(chunk: Uint8Array): string[] {
    const out: string[] = [];
    let start = 0;
    if (this.pendingCR && chunk.length > 0) {
      this.pendingCR = false;
      if (chunk[0] === LF) start = 1;
    }
    for (let i = start; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte !== LF && byte !== CR) continue;
      this.append(chunk.subarray(start, i));
      this.endLine(out);
      if (byte === CR) {
        if (i + 1 === chunk.length) this.pendingCR = true;
        else if (chunk[i + 1] === LF) i++;
      }
      start = i + 1;
    }
    this.append(chunk.subarray(start));
    return out;
  }

  private append(part: Uint8Array): void {
    if (part.length === 0) return;
    this.lineBytes += part.length;
    if (this.lineBytes > this.limit) throw new ResyncRequired('frame_too_large');
    this.parts.push(Buffer.from(part));
  }

  private endLine(out: string[]): void {
    const bytes = this.lineBytes;
    // Line endings are single bytes that never occur inside a UTF-8 sequence, so each line decodes on its own.
    let line: string;
    try {
      line = utf8.decode(Buffer.concat(this.parts, bytes));
    } catch {
      throw new ResyncRequired('invalid_frame');
    }
    this.parts = [];
    this.lineBytes = 0;
    if (bytes === 0) {
      const payload = this.data.join('\n');
      if (payload !== '') out.push(payload);
      this.data = [];
      this.recordBytes = 0;
      return;
    }
    this.recordBytes += bytes + 1;
    if (this.recordBytes > this.limit) throw new ResyncRequired('frame_too_large');
    const colon = line.indexOf(':');
    if (colon === 0) return; // a comment
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
  }
}

export class ClientFailure extends Error {
  constructor(
    message: string,
    readonly effect: 'no_effect' | 'unknown',
    readonly phase: 'before_write' | 'after_write' | 'http',
    readonly status?: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class ResyncRequired extends Error {
  constructor(readonly reason: string) {
    super(`SSE ${reason}; fresh snapshot required before controls`);
  }
}

export class ProtocolMismatch extends Error {
  constructor(readonly major: number) {
    super(`worker speaks B2 protocol major ${major}; this client speaks ${PROTOCOL_MAJOR}`);
  }
}

export interface ClientOptions {
  socketPath: string;
  /** A 0600 JSON file `{ "token": "..." }` written by `pi-worker grant register`. Default: `PIW_GRANT_FILE`. */
  grantFile?: string;
  /** Per-call timeout; on expiry the call fails (unknown once written), never retries. Default 60 s. */
  timeoutMs?: number;
}

function fillPath(template: string, params: Record<string, unknown> | undefined): string {
  return template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new ClientFailure(`missing path parameter ${name}`, 'no_effect', 'before_write');
    return encodeURIComponent(String(value));
  });
}

function queryString(query: Record<string, unknown> | undefined): string {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined);
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
}

export class Client {
  /** True until a snapshot arrives on the current stream; controls stay disabled meanwhile. */
  resyncRequired = true;
  readonly socketPath: string;
  readonly grantFile: string | undefined;
  readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.socketPath = options.socketPath;
    this.grantFile = options.grantFile ?? process.env.PIW_GRANT_FILE;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private headers(): Record<string, string> {
    if (!this.grantFile) return {};
    let token: unknown;
    try {
      token = (JSON.parse(readFileSync(this.grantFile, 'utf8')) as { token?: unknown }).token;
    } catch {
      throw new ClientFailure('grant_file_unreadable', 'no_effect', 'before_write');
    }
    if (typeof token !== 'string' || !token) throw new ClientFailure('grant_file_invalid', 'no_effect', 'before_write');
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * `hello`, refusing a worker whose protocol major this client does not speak. The major is read before the schema
   * check, so another major is a ProtocolMismatch even when the rest of its reply differs.
   */
  async hello(): Promise<Hello> {
    const reply = await this.exchange('hello', {});
    const value = reply.status === 200 && mediaType(reply.headers['content-type']) === 'application/json' ? parseJson(reply.body) : NOT_JSON;
    const protocol = value !== null && typeof value === 'object' ? (value as { protocol?: unknown }).protocol : undefined;
    const major = protocol !== null && typeof protocol === 'object' ? (protocol as { major?: unknown }).major : undefined;
    if (Number.isInteger(major) && major !== PROTOCOL_MAJOR) throw new ProtocolMismatch(major as number);
    return jsonReply<Hello>(routes.hello, reply);
  }

  /**
   * Sends one request once. Resolves with the 200 body once it passes the operation's response schema; rejects with
   * ClientFailure.
   */
  async call<O extends OperationId>(op: O, options: CallOptions<O> = {}): Promise<OkBody<O>> {
    return jsonReply<OkBody<O>>(routes[op], await this.exchange(op, options));
  }

  /**
   * `attachments.stage`: uploads one image once (PUT, `Content-Length`, the binding and the bytes' SHA-256 as
   * `Piw-*` headers). A media type the operation does not declare, an empty body or one over its byte cap
   * (`hello.limits.attachment_max_bytes`) is refused before anything is sent (`no_effect`). A failure after the write
   * is `unknown`: read `attachments.status` for the id (or the receipt of the command id), never upload blindly again.
   */
  async stage(attachmentId: string, params: StageParams, contentType: string, bytes: Uint8Array): Promise<Receipt> {
    const route = routes['attachments.stage'];
    const media: readonly string[] = route.mediaTypes;
    if (!media.includes(contentType)) throw new ClientFailure('unsupported_media_type', 'no_effect', 'before_write');
    if (bytes.length === 0 || bytes.length > route.maxBodyBytes) throw new ClientFailure('attachment_size_out_of_range', 'no_effect', 'before_write');
    if (!Number.isInteger(params.binding_revision) || params.binding_revision < 1) throw new ClientFailure('invalid_binding_revision', 'no_effect', 'before_write');
    const headers = {
      'Piw-Command-Id': params.command_id,
      'Piw-Worker-Id': params.worker_id,
      'Piw-Worker-Epoch': params.worker_epoch,
      'Piw-Session-Id': params.session_id,
      'Piw-Binding-Revision': String(params.binding_revision),
      'Piw-Content-Sha256': createHash('sha256').update(bytes).digest('hex'),
    };
    const reply = await this.exchange('attachments.stage', { path: { attachment_id: attachmentId } }, { headers, contentType, bytes });
    return jsonReply<Receipt>(route, reply);
  }

  /**
   * Reads an `ndjson` or `binary` operation (sessions.history, blobs.read): one GET, once. Resolves with the 200's
   * headers (lower-case names), media type and bytes once its media type is declared, its declared headers pass their
   * schema as typed values and, for ndjson, its last line is complete. A body over the route's x-piw-max-bytes, or a
   * reply that fails a check, is `unknown`; a refusal rejects with ClientFailure as for `call`.
   */
  async read<O extends OperationId>(op: O, options: { path?: PathParams<O>; query?: QueryParams<O> } = {}): Promise<{ headers: Record<string, string>; contentType: string; body: Buffer }> {
    const route: ClientRoute = routes[op];
    const mode = route.responseMode;
    if (mode !== 'ndjson' && mode !== 'binary') throw new ClientFailure('operation_is_not_a_byte_read', 'no_effect', 'before_write');
    const reply = await this.exchange(op, options);
    if (reply.status !== 200) throw refusal(route, reply);
    const contentType = mediaType(reply.headers['content-type']);
    if (!route.contentTypes.includes(contentType)) throw unreadable('response_content_type_mismatch', reply.status);
    const typed: Record<string, string | number | boolean> = {};
    for (const [name, kind] of Object.entries(route.headerKinds ?? {})) {
      const raw = reply.headers[name];
      if (typeof raw === 'string') typed[name] = convertHeader(raw, kind);
    }
    if (!route.headers) throw unreadable('response_headers_mismatch', reply.status);
    if (!route.headers(typed)) throw unreadable('response_headers_mismatch', reply.status, schemaFailure(route.headers));
    // ndjson is complete lines: a body that does not end in LF was cut, and its last line is not a line.
    if (mode === 'ndjson' && reply.body.length > 0 && reply.body[reply.body.length - 1] !== LF) throw unreadable('ndjson_incomplete_final_line', reply.status);
    const headers = Object.fromEntries(Object.entries(reply.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    return { headers, contentType, body: reply.body };
  }

  /**
   * One request, once: nothing is written until the socket connects; afterwards every ambiguous failure is unknown.
   * Resolves with the status, headers and body bytes, refusing a 200 body over the route's x-piw-max-bytes (byte
   * reads) and any body over RESPONSE_LIMIT. Interpreting the reply is the caller's: all of it is after the write.
   */
  private exchange<O extends OperationId>(
    op: O,
    options: { path?: PathParams<O>; query?: QueryParams<O>; body?: RequestBody<O> },
    binary?: { headers: Record<string, string>; contentType: string; bytes: Uint8Array },
  ): Promise<RawReply> {
    const route: ClientRoute = routes[op];
    let path: string;
    let auth: Record<string, string>;
    let json: string | undefined;
    try {
      path = fillPath(route.path, options.path as Record<string, unknown> | undefined) + queryString(options.query as Record<string, unknown> | undefined);
      auth = this.headers();
    } catch (error) {
      return Promise.reject(error);
    }
    // A body that cannot be serialized (a cycle, a BigInt) fails here, before anything is sent.
    try {
      json = options.body === undefined ? undefined : JSON.stringify(options.body);
    } catch {
      return Promise.reject(new ClientFailure('request_not_serializable', 'no_effect', 'before_write'));
    }
    const body = binary ? { contentType: binary.contentType, bytes: binary.bytes } : json === undefined ? undefined : { contentType: 'application/json', bytes: json };
    const okLimit = route.responseMode === 'ndjson' || route.responseMode === 'binary' ? (route.maxResponseBytes ?? 0) : RESPONSE_LIMIT;
    return new Promise((resolve, reject) => {
      let wrote = false;
      let settled = false;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        reject(
          e instanceof ClientFailure
            ? e
            : new ClientFailure(e instanceof Error ? e.message : 'transport_failure', wrote ? 'unknown' : 'no_effect', wrote ? 'after_write' : 'before_write'),
        );
      };
      const req = request(
        {
          socketPath: this.socketPath,
          method: route.method,
          path,
          agent: false,
          headers: {
            ...auth,
            ...binary?.headers,
            Connection: 'close',
            ...(body === undefined ? {} : { 'Content-Type': body.contentType, 'Content-Length': typeof body.bytes === 'string' ? Buffer.byteLength(body.bytes) : body.bytes.length }),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          const cap = res.statusCode === 200 ? okLimit : RESPONSE_LIMIT;
          res.on('data', (b: Buffer) => {
            bytes += b.length;
            if (bytes > cap) {
              res.destroy(new Error('response too large'));
              return;
            }
            chunks.push(b);
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new Error('response_aborted_reconcile_command_id')));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('HTTP timeout; reconcile command_id, never blind replay')));
      req.on('error', fail);
      // Nothing is written until connect. Once end() is attempted, every ambiguous failure is unknown.
      req.once('socket', socket => {
        socket.once('connect', () => {
          wrote = true;
          req.end(body?.bytes);
        });
      });
    });
  }

  /**
   * Reads the supervisor-wide SSE stream. Only a frame that passes the event schema reaches `onFrame`; returning
   * false ends the watch (resolves). An `overflow` frame is delivered, then the watch rejects with
   * ResyncRequired('overflow'); a disconnect rejects with ResyncRequired('disconnected'); a reply that is not
   * text/event-stream, or a frame that is not UTF-8, JSON or a valid event, rejects with ResyncRequired and is never
   * delivered. The caller decides whether to reconnect; a reconnect always starts with a snapshot.
   */
  watch(
    onFrame: (frame: EventFrame) => boolean | void,
    options: { workerIds?: string[]; types?: string[]; since?: Cursor; overflowResync?: boolean } = {},
  ): Promise<void> {
    this.resyncRequired = true;
    const query = new URLSearchParams();
    if (options.workerIds) query.set('worker_id', options.workerIds.join(','));
    if (options.types) query.set('types', options.types.join(','));
    if (options.overflowResync) query.set('resync', 'overflow');
    let auth: Record<string, string>;
    try {
      auth = this.headers();
    } catch (error) {
      return Promise.reject(error);
    }
    const suffix = query.size ? `?${query}` : '';
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        this.resyncRequired = true;
        req.destroy();
        reject(error);
      };
      const req = request(
        {
          socketPath: this.socketPath,
          path: `${routes['events.subscribe'].path}${suffix}`,
          agent: false,
          headers: { ...auth, Connection: 'close', ...(options.since ? { 'Last-Event-ID': JSON.stringify(options.since) } : {}) },
        },
        res => {
          if (res.statusCode !== 200) {
            res.resume();
            fail(new ResyncRequired(`HTTP ${res.statusCode}`));
            return;
          }
          if (!(routes['events.subscribe'].contentTypes as readonly string[]).includes(mediaType(res.headers['content-type']))) {
            res.resume();
            fail(new ResyncRequired('invalid_content_type'));
            return;
          }
          const parser = new EventStreamParser();
          res.on('data', (chunk: Buffer) => {
            if (done) return;
            let records: string[];
            try {
              records = parser.push(chunk);
            } catch (error) {
              fail(error as Error);
              return;
            }
            for (const data of records) {
              if (done) break;
              let value: unknown;
              try {
                value = JSON.parse(data);
              } catch {
                fail(new ResyncRequired('invalid_frame'));
                break;
              }
              // Only a valid frame is delivered, and only a valid snapshot ends the resync.
              if (!validateEventFrame(value)) {
                fail(new ResyncRequired('invalid_frame'));
                break;
              }
              const frame = value as EventFrame;
              if (frame.type === 'snapshot') this.resyncRequired = false;
              if (frame.type === 'overflow') {
                onFrame(frame);
                fail(new ResyncRequired('overflow'));
                break;
              }
              if (onFrame(frame) === false) {
                done = true;
                req.destroy();
                resolve();
              }
            }
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new ResyncRequired('disconnected')));
          res.on('end', () => fail(new ResyncRequired('disconnected')));
        },
      );
      req.on('error', fail);
      req.end();
    });
  }
}

interface RawReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const NOT_JSON = Symbol('not_json');

/** Strict UTF-8, then JSON; NOT_JSON when either fails. */
function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(utf8.decode(body));
  } catch {
    return NOT_JSON;
  }
}

/** A reply the client cannot trust: unknown after the write. `details` never holds a value from the reply. */
function unreadable(reason: string, status: number, details: Record<string, unknown> = {}): ClientFailure {
  return new ClientFailure(reason, 'unknown', 'after_write', status, details);
}

/** A JSON 200 that passes the route's response schema, or a refusal. Nothing else reaches the caller. */
function jsonReply<T>(route: ClientRoute, reply: RawReply): T {
  if (reply.status !== 200) throw refusal(route, reply);
  if (mediaType(reply.headers['content-type']) !== 'application/json') throw unreadable('response_content_type_mismatch', reply.status);
  const value = parseJson(reply.body);
  if (value === NOT_JSON) throw unreadable('response_not_json', reply.status);
  if (!route.validate) throw unreadable('response_schema_mismatch', reply.status);
  if (!route.validate(value)) throw unreadable('response_schema_mismatch', reply.status, schemaFailure(route.validate));
  return value as T;
}

/**
 * A non-200 reply. It keeps the worker's effect only from a B2 Error body that passes the schema of its status (or
 * Error for a status the operation does not declare, as the router's own refusals). JSON that is not one is an
 * unreadable refusal: unknown, with nothing from it kept. A body that is not JSON at all is unknown after the write.
 */
function refusal(route: ClientRoute, reply: RawReply): ClientFailure {
  const value = mediaType(reply.headers['content-type']) === 'application/json' ? parseJson(reply.body) : NOT_JSON;
  if (value === NOT_JSON) return unreadable('refusal_not_json', reply.status);
  const validate = route.errors[String(reply.status)] ?? validateError;
  if (!validate(value)) return new ClientFailure('refusal_not_b2_error', 'unknown', 'http', reply.status);
  const body = value as components['schemas']['Error'];
  return new ClientFailure(body.error, body.effect === 'no_effect' ? 'no_effect' : 'unknown', 'http', reply.status, body as unknown as Record<string, unknown>);
}
