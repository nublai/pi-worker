/** Handler types derived from the generated operations, so a handler's input and output match the spec. */
import type { operations } from '../generated/api.js';
import type { SupportedOperationId } from '../generated/routes.js';
import type { B2Stream } from './router.js';
import type { Caller } from '../grants/store.js';

type OpOf<K extends keyof operations> = operations[K];

export type PathParams<K extends keyof operations> = OpOf<K> extends { parameters: { path: infer P } } ? (P extends undefined ? {} : P) : {};
export type QueryParams<K extends keyof operations> = OpOf<K> extends { parameters: { query?: infer Q } } ? (Q extends undefined ? {} : Q) : {};
/** Header parameters by lower-case name, as the router reads them. */
export type HeaderParams<K extends keyof operations> = OpOf<K> extends { parameters: { header?: infer H } }
  ? H extends undefined
    ? {}
    : { readonly [P in keyof H as Lowercase<P & string>]: H[P] }
  : {};
/** A JSON body is parsed and validated; a binary body is the counted byte stream (413 past its limit). */
export type RequestBody<K extends keyof operations> = OpOf<K> extends { requestBody: { content: { 'application/json': infer B } } }
  ? B
  : OpOf<K> extends { requestBody: { content: object } }
    ? AsyncIterable<Uint8Array>
    : undefined;
export type OkBody<K extends keyof operations> = OpOf<K> extends { responses: { 200: { content: { 'application/json': infer R } } } }
  ? R
  : OpOf<K> extends { responses: { 200: { content: { 'text/event-stream': unknown } } } }
    ? B2Stream
    : never;

export interface HandlerInput<K extends keyof operations> {
  readonly path: PathParams<K>;
  readonly query: QueryParams<K>;
  /** Declared header parameters, by lower-case name. */
  readonly header: HeaderParams<K>;
  readonly body: RequestBody<K>;
  /** The authenticated caller (P1-9); absent only for a router built without `authorize` (router tests). */
  readonly caller?: Caller;
}

/**
 * A handler returns the 200 body or throws a Refusal. The router validates whatever it returns; an `sse` operation
 * returns a B2Stream whose frames the event hub validates one by one.
 */
export type Handler<K extends keyof operations> = (input: HandlerInput<K>) => OkBody<K> | Promise<OkBody<K>>;

/** One handler per operation the spec does not mark unsupported; a missing handler is a compile error. */
export type Handlers = { readonly [K in SupportedOperationId]: Handler<K> };
