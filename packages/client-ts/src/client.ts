/**
 * Hand-written B2 transport over the worker's Unix socket, typed by the generated API. Ported from A0 `src/client.ts`.
 *
 * Rules (contract section 1, B2 transport conditions):
 * - One attempt per call: `agent: false`, `Connection: close`, no retries, no keep-alive replay.
 * - Nothing is written until the socket connects. A failure before that is `no_effect`; after it, `unknown`, and the
 *   caller reads the receipt for its `command_id`. A disconnect is never a cancel.
 * - An HTTP refusal keeps the worker's `effect`; anything but an explicit `no_effect` is `unknown`.
 * - The SSE reader never reconnects on its own. A reconnect is the caller's decision and starts with a snapshot.
 */
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import type { components, operations } from './generated/api.js';
import { routes, type OperationId } from './generated/routes.js';

type Op<O extends OperationId> = operations[O];
export type PathParams<O extends OperationId> = Op<O> extends { parameters: { path: infer P } } ? (P extends undefined ? never : P) : never;
export type QueryParams<O extends OperationId> = Op<O> extends { parameters: { query?: infer Q } } ? Q : never;
export type RequestBody<O extends OperationId> = Op<O> extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
export type OkBody<O extends OperationId> = Op<O> extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
export type EventFrame = components['schemas']['EventFrame'];
export type Cursor = components['schemas']['Cursor'];
export type Hello = components['schemas']['Hello'];

export interface CallOptions<O extends OperationId> {
  path?: PathParams<O>;
  query?: QueryParams<O>;
  body?: RequestBody<O>;
}

/** The protocol major this client speaks. A worker with another major is refused. */
export const PROTOCOL_MAJOR = 0;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
/**
 * One SSE record: its field lines, each counted with one line-ending byte. The spec's x-piw-max-frame-bytes for
 * events.subscribe, through the generated route table.
 */
const FRAME_LIMIT = routes['events.subscribe'].maxFrameBytes;

const LF = 0x0a;
const CR = 0x0d;

/**
 * Incremental text/event-stream parser over bytes. Lines end in LF, CRLF or a lone CR (also across chunks); one
 * space after a field's colon is optional; lines starting with `:` are comments; a blank line ends a record. A line
 * or record over `limit` bytes throws ResyncRequired('frame_too_large'); nothing is ever truncated.
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
    const line = Buffer.concat(this.parts, bytes).toString('utf8');
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

  /** `hello`, refusing a worker whose protocol major this client does not speak. */
  async hello(): Promise<Hello> {
    const hello = await this.call('hello');
    if (hello.protocol.major !== PROTOCOL_MAJOR) throw new ProtocolMismatch(hello.protocol.major);
    return hello;
  }

  /** Sends one request once. Resolves with the 200 body; rejects with ClientFailure. */
  call<O extends OperationId>(op: O, options: CallOptions<O> = {}): Promise<OkBody<O>> {
    const route = routes[op];
    let path: string;
    let auth: Record<string, string>;
    try {
      path = fillPath(route.path, options.path as Record<string, unknown> | undefined) + queryString(options.query as Record<string, unknown> | undefined);
      auth = this.headers();
    } catch (error) {
      return Promise.reject(error);
    }
    const data = options.body === undefined ? undefined : JSON.stringify(options.body);
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
            Connection: 'close',
            ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (b: Buffer) => {
            bytes += b.length;
            if (bytes > RESPONSE_LIMIT) {
              res.destroy(new Error('response too large'));
              return;
            }
            chunks.push(b);
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new Error('response_aborted_reconcile_command_id')));
          res.on('end', () => {
            if (settled) return;
            let value: unknown;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (error) {
              fail(error);
              return;
            }
            settled = true;
            if (res.statusCode === 200) {
              resolve(value as OkBody<O>);
              return;
            }
            // A refusal keeps the worker's effect only from a B2 Error object; anything else (null, a scalar, an
            // array) is an unreadable refusal: unknown.
            const refusal = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
            const effect = refusal?.effect === 'no_effect' ? 'no_effect' : 'unknown';
            const message = typeof refusal?.error === 'string' ? refusal.error : 'HTTP refusal without a B2 Error body';
            reject(new ClientFailure(message, effect, 'http', res.statusCode, refusal ?? {}));
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('HTTP timeout; reconcile command_id, never blind replay')));
      req.on('error', fail);
      // Nothing is written until connect. Once end() is attempted, every ambiguous failure is unknown.
      req.once('socket', socket => {
        socket.once('connect', () => {
          wrote = true;
          req.end(data);
        });
      });
    });
  }

  /**
   * Reads an `ndjson` or `binary` operation (sessions.history, blobs.read): one GET, once. Resolves with the 200's
   * headers (lower-case names), media type and bytes, refusing a body over the route's x-piw-max-bytes; a refusal
   * rejects with ClientFailure as for `call`. These are reads: any failure is `no_effect` or `unknown` as usual.
   */
  read<O extends OperationId>(op: O, options: { path?: PathParams<O>; query?: QueryParams<O> } = {}): Promise<{ headers: Record<string, string>; contentType: string; body: Buffer }> {
    const route = routes[op];
    // Widened: the table's literal modes grow as byte-read operations are added (blobs.read is P1-16).
    const mode: string = route.responseMode;
    if (mode !== 'ndjson' && mode !== 'binary') return Promise.reject(new ClientFailure('operation_is_not_a_byte_read', 'no_effect', 'before_write'));
    const limit = route.maxResponseBytes ?? 0;
    let path: string;
    let auth: Record<string, string>;
    try {
      path = fillPath(route.path, options.path as Record<string, unknown> | undefined) + queryString(options.query as Record<string, unknown> | undefined);
      auth = this.headers();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let wrote = false;
      let settled = false;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        reject(e instanceof ClientFailure ? e : new ClientFailure(e instanceof Error ? e.message : 'transport_failure', wrote ? 'unknown' : 'no_effect', wrote ? 'after_write' : 'before_write'));
      };
      const req = request({ socketPath: this.socketPath, method: route.method, path, agent: false, headers: { ...auth, Connection: 'close' } }, res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const cap = res.statusCode === 200 ? limit : RESPONSE_LIMIT;
        res.on('data', (b: Buffer) => {
          bytes += b.length;
          if (bytes > cap) {
            res.destroy(new Error('response too large'));
            return;
          }
          chunks.push(b);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('response_aborted')));
        res.on('end', () => {
          if (settled) return;
          const body = Buffer.concat(chunks);
          if (res.statusCode === 200) {
            settled = true;
            const headers = Object.fromEntries(Object.entries(res.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
            resolve({ headers, contentType: String(res.headers['content-type'] ?? ''), body });
            return;
          }
          let value: unknown;
          try {
            value = JSON.parse(body.toString('utf8'));
          } catch (error) {
            fail(error);
            return;
          }
          settled = true;
          const refusal = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
          reject(new ClientFailure(typeof refusal?.error === 'string' ? refusal.error : 'HTTP refusal without a B2 Error body', refusal?.effect === 'no_effect' ? 'no_effect' : 'unknown', 'http', res.statusCode, refusal ?? {}));
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('HTTP timeout')));
      req.on('error', fail);
      req.once('socket', socket => {
        socket.once('connect', () => {
          wrote = true;
          req.end();
        });
      });
    });
  }

  /**
   * Reads the supervisor-wide SSE stream. `onFrame` returning false ends the watch (resolves). An `overflow` frame is
   * delivered, then the watch rejects with ResyncRequired('overflow'); a disconnect rejects with
   * ResyncRequired('disconnected'). The caller decides whether to reconnect; a reconnect always starts with a snapshot.
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
              let frame: EventFrame;
              try {
                frame = JSON.parse(data) as EventFrame;
              } catch {
                fail(new ResyncRequired('invalid_frame'));
                break;
              }
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
