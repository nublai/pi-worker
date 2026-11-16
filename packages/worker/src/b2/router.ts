/**
 * The B2 request handler, built from the generated route table. Transport-independent: the Unix-socket server and the
 * in-memory transport both call `handle`. Order for every request (plan section 4.2):
 *   route match → path, query and header parameters → body by the route's mode → 501 when the spec marks the
 *   operation unsupported → handler → response schema → reply.
 * Body modes (x-piw-body): `json` checks the content type (415), the declared and the actual length against the
 * route's cap (413), then parses and validates (400). `binary` checks the content type against the declared media
 * types (415) and the declared length (413), then hands the handler a stream that refuses the byte past the limit
 * (413); an unsupported binary route reads the whole body through that counter before its 501. `none` refuses any
 * body (400). Nothing before the handler writes state, so every refusal up to there is `no_effect`.
 */
import { jsonBodyLimit, routes as generatedRoutes, type Route } from '../generated/routes.js';
import { error as validateError, type ValidationError } from '../generated/validators.js';
import { Refusal, type ErrorBody } from './errors.js';
import type { Handlers } from './types.js';
import { authority, type Guard } from '../grants/authority.js';
import type { Caller } from '../grants/store.js';

/** The JSON request body cap (the spec's info.x-piw-json-max-bytes); an operation may declare less. */
export const REQUEST_BODY_LIMIT = jsonBodyLimit;

export interface B2Request {
  readonly method: string;
  /** Path and query, for example `/b2/workers/w1/history?limit=10`. */
  readonly url: string;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: AsyncIterable<Uint8Array> | Uint8Array;
}

/** The transport side of an SSE response: one complete record per write. */
export interface StreamSink {
  /** Writes one SSE record; false when the transport buffer is full (wait for `onDrain`). */
  write(record: string): boolean;
  /** Ends the response after what was written. */
  end(): void;
  /** Drops the connection. */
  destroy(): void;
  onDrain(listener: () => void): void;
  onClose(listener: () => void): void;
}

/** What an `sse` operation's handler returns: started once the 200 headers are written. */
export interface B2Stream {
  readonly sse: (sink: StreamSink) => void;
}

export interface B2Response {
  readonly status: number;
  readonly body: unknown;
  /** Present for a 200 of an `sse` operation; every frame is validated by the event hub before it is written. */
  readonly stream?: B2Stream;
}

const isStream = (value: unknown): value is B2Stream => typeof (value as B2Stream | null)?.sse === 'function';

export interface RouterOptions {
  readonly handlers: Handlers;
  /** Defaults to the generated table. Tests pass a modified table to exercise rules on unsupported operations. */
  readonly routes?: Readonly<Record<string, Route>>;
  /**
   * Authenticates the request for its route right after the route matches, before parameters or body are read, so an
   * unauthenticated or unauthorized request is refused `no_effect` before anything else. The handler then runs under
   * the returned guard (grants/authority.ts), which the supervisor rechecks at dispatch.
   */
  readonly authorize?: (request: B2Request, route: Route) => Authorized;
}

export interface Authorized {
  readonly caller: Caller;
  readonly guard: Guard;
}

export type RequestHandler = (request: B2Request) => Promise<B2Response>;

function describe(errors: readonly ValidationError[] | null | undefined): string {
  const first = errors?.[0];
  return first ? `${first.instancePath || '/'} ${first.message ?? first.keyword}`.slice(0, 1024) : 'invalid';
}

export type ParamValue = string | number | boolean;

/** Raw query and path strings become the parameter's scalar kind; anything else is left for the validator to refuse. */
export function convertParam(raw: string, kind: Route['params'][number]['kind']): ParamValue {
  if (kind === 'integer' && /^-?\d{1,16}$/.test(raw)) return Number(raw);
  if (kind === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (kind === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  return raw;
}

function match(route: Route, segments: readonly string[]): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const want = route.segments[i]!;
    if (want.startsWith('{') && want.endsWith('}')) params[want.slice(1, -1)] = segments[i]!;
    else if (want !== segments[i]) return null;
  }
  return params;
}

const tooLarge = () => new Refusal('request_too_large', 'no_effect', undefined, {}, 413);

/** The body's chunks, refusing (413) the byte past `limit` before it is handed on. */
async function* counted(body: B2Request['body'], limit: number): AsyncGenerator<Uint8Array> {
  if (!body) return;
  if (body instanceof Uint8Array) {
    if (body.byteLength > limit) throw tooLarge();
    if (body.byteLength > 0) yield body;
    return;
  }
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw tooLarge();
    yield chunk;
  }
}

async function readBody(body: B2Request['body'], limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of counted(body, limit)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function mediaType(request: B2Request): string | undefined {
  return request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
}

/** True when the request declares a body: a positive Content-Length or any Transfer-Encoding. */
function hasBody(request: B2Request): boolean {
  const length = request.headers['content-length'];
  return (length !== undefined && length.trim() !== '0') || request.headers['transfer-encoding'] !== undefined;
}

/** Reads the request body by the route's mode (x-piw-body). JSON is parsed and validated; binary stays a stream. */
async function readByMode(route: Route, request: B2Request): Promise<unknown> {
  const declared = Number(request.headers['content-length']);
  if (route.body === 'none') {
    if (hasBody(request)) throw new Refusal('body_not_allowed', 'no_effect', undefined, {}, 400);
    return undefined;
  }
  if (route.body === 'binary') {
    const type = mediaType(request);
    if (!type || !route.mediaTypes.includes(type)) throw new Refusal('unsupported_media_type', 'no_effect', undefined, {}, 415);
    if (Number.isFinite(declared) && declared > route.maxBodyBytes) throw tooLarge();
    return counted(request.body, route.maxBodyBytes);
  }
  if (mediaType(request) !== 'application/json') throw new Refusal('content_type_must_be_json', 'no_effect', undefined, {}, 415);
  if (Number.isFinite(declared) && declared > route.maxBodyBytes) throw tooLarge();
  const bytes = await readBody(request.body, route.maxBodyBytes);
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Refusal('invalid_json', 'no_effect', undefined, {}, 400);
  }
  if (!route.validateBody?.(body)) {
    throw new Refusal('request_schema_mismatch', 'no_effect', undefined, { detail: describe(route.validateBody?.errors) }, 400);
  }
  return body;
}

export function createRouter(options: RouterOptions): RequestHandler {
  const table = Object.values(options.routes ?? generatedRoutes);
  // SAFETY: handlers is keyed by operationId and each handler is only called for its own route, after that route's
  // parameter and body validators accepted the input, so the input matches the handler's generated input type.
  const handlers = options.handlers as unknown as Record<string, (input: unknown) => unknown>;

  /** Validates a reply against the operation's response schema for its status. */
  function reply(route: Route, status: number, body: unknown, commandId: string | undefined): B2Response {
    const spec = route.responses[String(status)];
    if (spec?.validate?.(body)) return { status, body };
    // Never let an unvalidated body out, and never make a validation failure look retryable: after a mutation's
    // handler ran, the outcome is unknown and the caller must read the receipt for command_id.
    const failure: ErrorBody =
      route.mutation && commandId
        ? { error: 'response_schema_mismatch', effect: 'unknown', uncertain_command_id: commandId, detail: describe(spec?.validate?.errors) }
        : { error: 'response_schema_mismatch', effect: 'no_effect', detail: spec ? describe(spec.validate?.errors) : `status ${status} not in spec` };
    return { status: 500, body: failure };
  }

  return async function handle(request: B2Request): Promise<B2Response> {
    let url: URL;
    let segments: string[];
    try {
      url = new URL(request.url, 'http://pi-worker');
      segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return { status: 400, body: { error: 'invalid_path_encoding', effect: 'no_effect' } };
    }
    const candidates = table.map(route => ({ route, path: match(route, segments) })).filter(c => c.path !== null);
    if (candidates.length === 0) return checked({ status: 404, body: { error: 'unknown_route', effect: 'no_effect' } });
    const found = candidates.find(c => c.route.method === request.method);
    if (!found) return checked({ status: 405, body: { error: 'method_not_allowed', effect: 'no_effect' } });
    const { route } = found;

    let commandId: string | undefined;
    try {
      // The bearer first: an unauthenticated request learns nothing about parameters, bodies or state.
      const auth = options.authorize?.(request, route);
      // Parameters: path from the match, query from the URL, declared headers by lower-case name.
      const query: Record<string, ParamValue> = {};
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        if (values.length !== 1) throw new Refusal('repeated_query_parameter', 'no_effect', undefined, { detail: key.slice(0, 128) }, 400);
        const declared = route.params.find(p => p.in === 'query' && p.name === key);
        const raw = values[0]!;
        query[key] = declared ? convertParam(raw, declared.kind) : raw;
      }
      const path: Record<string, ParamValue> = {};
      for (const [name, raw] of Object.entries(found.path!)) {
        const declared = route.params.find(p => p.in === 'path' && p.name === name);
        path[name] = declared ? convertParam(raw, declared.kind) : raw;
      }
      const header: Record<string, ParamValue> = {};
      for (const p of route.params.filter(p => p.in === 'header')) {
        const value = request.headers[p.name.toLowerCase()];
        if (value !== undefined) header[p.name.toLowerCase()] = convertParam(value, p.kind);
      }
      const params = { path, query, header };
      if (!route.validateParams(params)) {
        throw new Refusal('invalid_parameters', 'no_effect', undefined, { detail: describe(route.validateParams.errors) }, 400);
      }

      const body = await readByMode(route, request);
      if (route.mutation) {
        commandId = route.body === 'binary' ? String(header['piw-command-id']) : (body as { command_id: string }).command_id;
      }

      const handler = route.supported ? handlers[route.operationId] : undefined;
      if (!handler) {
        // A binary body is read through its counter first, so its byte limit holds here as it will for a handler.
        if (route.body === 'binary') for await (const _ of body as AsyncIterable<Uint8Array>);
        throw new Refusal('operation_not_implemented', 'no_effect', undefined, {}, 501);
      }
      const input = { path, query, header, body, ...(auth ? { caller: auth.caller } : {}) };
      const result = await (auth ? authority.run(auth.guard, () => handler(input)) : handler(input));
      if (route.stream) {
        if (!isStream(result)) throw new Error('stream operation returned no stream');
        return { status: 200, body: null, stream: result };
      }
      return reply(route, 200, result, commandId);
    } catch (error) {
      if (error instanceof Refusal) return reply(route, error.status, error.toBody(), commandId);
      // An unexpected failure may have happened after an effect: unknown, reconcile before any retry.
      const unknown = new Refusal('internal_error_reconcile_before_retry', 'unknown', route.mutation ? commandId : undefined);
      return reply(route, 500, unknown.toBody(), commandId);
    }
  };
}

function checked(response: B2Response): B2Response {
  if (validateError(response.body)) return response;
  return { status: 500, body: { error: 'response_schema_mismatch', effect: 'no_effect' } };
}
