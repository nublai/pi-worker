/** Handler types derived from the generated operations, so a handler's input and output match the spec. */
import type { operations } from '../generated/api.js';
import type { SupportedOperationId } from '../generated/routes.js';

type OpOf<K extends keyof operations> = operations[K];

export type PathParams<K extends keyof operations> = OpOf<K> extends { parameters: { path: infer P } } ? (P extends undefined ? {} : P) : {};
export type QueryParams<K extends keyof operations> = OpOf<K> extends { parameters: { query?: infer Q } } ? (Q extends undefined ? {} : Q) : {};
export type RequestBody<K extends keyof operations> = OpOf<K> extends { requestBody: { content: { 'application/json': infer B } } } ? B : undefined;
export type OkBody<K extends keyof operations> = OpOf<K> extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;

export interface HandlerInput<K extends keyof operations> {
  readonly path: PathParams<K>;
  readonly query: QueryParams<K>;
  readonly body: RequestBody<K>;
}

/** A handler returns the 200 body or throws a Refusal. The router validates whatever it returns. */
export type Handler<K extends keyof operations> = (input: HandlerInput<K>) => OkBody<K> | Promise<OkBody<K>>;

/** One handler per operation the spec does not mark unsupported; a missing handler is a compile error. */
export type Handlers = { readonly [K in SupportedOperationId]: Handler<K> };
