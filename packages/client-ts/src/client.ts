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
const FRAME_LIMIT = 1024 * 1024;

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
            let value: Record<string, unknown>;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            } catch (error) {
              fail(error);
              return;
            }
            settled = true;
            if (res.statusCode === 200) resolve(value as OkBody<O>);
            else {
              const effect = value.effect === 'no_effect' ? 'no_effect' : 'unknown';
              reject(new ClientFailure(String(value.error ?? 'HTTP refusal'), effect, 'http', res.statusCode, value));
            }
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
          let pending = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            pending += chunk;
            for (;;) {
              const end = pending.indexOf('\n\n');
              if (end < 0 || done) break;
              const record = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = record
                .split('\n')
                .filter(l => l.startsWith('data: '))
                .map(l => l.slice(6))
                .join('\n');
              if (!data) continue;
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
            if (pending.length > FRAME_LIMIT) fail(new ResyncRequired('frame_too_large'));
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
