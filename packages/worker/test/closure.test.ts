/** Contract closure (plan section 4.2): spec, routes, handlers, wire fixtures and validation agree. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { createRouter, convertParam, REQUEST_BODY_LIMIT, type RequestHandler } from '../src/b2/router.js';
import { Refusal } from '../src/b2/errors.js';
import type { Handlers } from '../src/b2/types.js';
import { routes, type Route } from '../src/generated/routes.js';
import { validateEventFrame } from '../src/generated/events.js';
import { error as validateError } from '../src/generated/validators.js';
import { specOperationIds, urlFor, wireFixtures, type WireFixture } from './helpers.js';

const table: Record<string, Route> = routes;
const binding = { command_id: 'cmd-1', worker_epoch: 'epoch-1', session_id: 'session-1', binding_revision: 1 };

function send(handle: RequestHandler, operationId: string, request: WireFixture['request']) {
  const route = table[operationId]!;
  return createMemoryTransport(handle).request(route.method, urlFor(route.path, request), request.body === undefined ? {} : { json: request.body });
}

/** A route table where sessions.prompt is served, to exercise mutation rules before any mutation is built. */
function withPromptServed(handler: (input: unknown) => unknown): RequestHandler {
  const served = { ...table, 'sessions.prompt': { ...table['sessions.prompt']!, supported: true } };
  // SAFETY: the test supplies a handler for an operation the generated Handlers type marks unsupported.
  const handlers = { hello: () => ({}), 'sessions.prompt': handler } as unknown as Handlers;
  return createRouter({ handlers, routes: served });
}

test('closure: every spec operation is routed (200 when served, 501 no_effect when unsupported, never 404/405)', async () => {
  const { handle } = createApp();
  const fixtures = new Map(wireFixtures().map(f => [f.operationId, f.fixture]));
  for (const operationId of specOperationIds()) {
    const route = table[operationId];
    assert.ok(route, `${operationId} has no route`);
    const response = await send(handle, operationId, fixtures.get(operationId)!.request);
    if (route.supported) assert.equal(response.status, 200, operationId);
    else assert.deepEqual(response, { status: 501, body: { error: 'operation_not_implemented', effect: 'no_effect' } }, operationId);
  }
});

test('closure: every route is in the spec and every served operation has a handler', () => {
  assert.deepEqual(Object.keys(table).sort(), specOperationIds().sort());
  const served = Object.values(table).filter(r => r.supported).map(r => r.operationId);
  assert.deepEqual(Object.keys(createApp().handlers).sort(), served.sort());
});

test('closure: every operation has at least one wire fixture, and every fixture names an operation', () => {
  const covered = new Set(wireFixtures().map(f => f.operationId));
  for (const operationId of specOperationIds()) assert.ok(covered.has(operationId), `${operationId} has no wire fixture`);
  for (const operationId of covered) assert.ok(table[operationId], `fixture directory ${operationId} names no operation`);
});

test('closure: every wire fixture validates (parameters, body, response or SSE frames)', () => {
  for (const { operationId, name, fixture } of wireFixtures()) {
    const route = table[operationId]!;
    const label = `${operationId}/${name}`;
    const params = { path: {} as Record<string, unknown>, query: {} as Record<string, unknown>, header: {} };
    for (const p of route.params) {
      const raw = p.in === 'path' ? fixture.request.path?.[p.name] : p.in === 'query' ? fixture.request.query?.[p.name] : undefined;
      if (raw !== undefined) (p.in === 'path' ? params.path : params.query)[p.name] = convertParam(raw, p.kind);
    }
    for (const key of Object.keys(fixture.request.query ?? {})) if (!(key in params.query)) params.query[key] = fixture.request.query![key];
    assert.equal(route.validateParams(params), true, `${label} params: ${JSON.stringify(route.validateParams.errors)}`);
    if (route.validateBody) assert.equal(route.validateBody(fixture.request.body), true, `${label} body: ${JSON.stringify(route.validateBody.errors)}`);
    else assert.equal(fixture.request.body, undefined, `${label} has a body for a bodiless operation`);
    const response = route.responses[String(fixture.response.status)];
    assert.ok(response, `${label}: status ${fixture.response.status} not in spec`);
    if (response.contentType === 'text/event-stream') {
      assert.ok(fixture.response.frames?.length, `${label} needs frames`);
      for (const frame of fixture.response.frames!) assert.equal(validateEventFrame(frame), true, `${label} frame: ${JSON.stringify(validateEventFrame.errors)}`);
    } else {
      assert.equal(response.validate!(fixture.response.body), true, `${label} response: ${JSON.stringify(response.validate!.errors)}`);
    }
  }
});

test('closure: a response that fails its schema is never sent (read: 500 no_effect)', async () => {
  // SAFETY: deliberately returns a body that violates Hello, to prove the router validates responses.
  const handlers = { hello: () => ({ protocol: { major: 0 } }) } as unknown as Handlers;
  const response = await createMemoryTransport(createRouter({ handlers })).request('GET', '/b2/hello');
  assert.equal(response.status, 500);
  assert.equal((response.body as { error: string }).error, 'response_schema_mismatch');
  assert.equal((response.body as { effect: string }).effect, 'no_effect');
  assert.equal(JSON.stringify(response.body).includes('protocol":{"major":0}'), false);
});

test('closure: a mutation whose response fails its schema is 500 unknown naming the command (never retryable)', async () => {
  const handle = withPromptServed(() => ({ command_id: 'cmd-1' }));
  const response = await createMemoryTransport(handle).request('POST', '/b2/workers/w1/prompt', { json: { ...binding, message: 'hi' } });
  assert.deepEqual(response.status, 500);
  assert.equal((response.body as { effect: string }).effect, 'unknown');
  assert.equal((response.body as { uncertain_command_id: string }).uncertain_command_id, 'cmd-1');
  assert.equal(validateError(response.body), true);
});

test('closure: a refusal status the operation does not declare is a response_schema_mismatch', async () => {
  const handlers: Handlers = {
    hello: () => {
      throw new Refusal('teapot', 'no_effect', undefined, {}, 418);
    },
  };
  const response = await createMemoryTransport(createRouter({ handlers })).request('GET', '/b2/hello');
  assert.deepEqual(response, { status: 500, body: { error: 'response_schema_mismatch', effect: 'no_effect', detail: 'status 418 not in spec' } });
});

test('closure: an unexpected handler failure after a mutation began is 500 unknown with the command id', async () => {
  const handle = withPromptServed(() => {
    throw new Error('host pipe broke');
  });
  const response = await createMemoryTransport(handle).request('POST', '/b2/workers/w1/prompt', { json: { ...binding, message: 'hi' } });
  assert.deepEqual(response, {
    status: 500,
    body: { error: 'internal_error_reconcile_before_retry', effect: 'unknown', uncertain_command_id: 'cmd-1' },
  });
});

test('closure: malformed requests are refused no_effect before any handler runs', async () => {
  let calls = 0;
  const memory = createMemoryTransport(withPromptServed(() => (calls++, {})));
  const prompt = '/b2/workers/w1/prompt';
  const cases: [string, Promise<{ status: number; body: unknown }>, number, string][] = [
    ['bad JSON', memory.request('POST', prompt, { raw: Buffer.from('{'), headers: { 'content-type': 'application/json' } }), 400, 'invalid_json'],
    ['schema', memory.request('POST', prompt, { json: { ...binding } }), 400, 'request_schema_mismatch'],
    ['extra field', memory.request('POST', prompt, { json: { ...binding, message: 'x', sneak: true } }), 400, 'request_schema_mismatch'],
    ['content type', memory.request('POST', prompt, { raw: Buffer.from('{}'), headers: { 'content-type': 'text/plain' } }), 415, 'content_type_must_be_json'],
    ['declared too large', memory.request('POST', prompt, { raw: Buffer.from('{}'), headers: { 'content-type': 'application/json', 'content-length': String(REQUEST_BODY_LIMIT + 1) } }), 413, 'request_too_large'],
    ['actually too large', memory.request('POST', prompt, { json: { ...binding, message: 'x'.repeat(REQUEST_BODY_LIMIT) }, headers: { 'content-length': '10' } }), 413, 'request_too_large'],
    ['path parameter', memory.request('POST', `/b2/workers/${'w'.repeat(129)}/prompt`, { json: { ...binding, message: 'x' } }), 400, 'invalid_parameters'],
    ['unknown query', memory.request('POST', `${prompt}?retry=1`, { json: { ...binding, message: 'x' } }), 400, 'invalid_parameters'],
    ['repeated query', memory.request('GET', '/b2/workers/w1/history?limit=1&limit=2'), 400, 'repeated_query_parameter'],
    ['query range', memory.request('GET', '/b2/workers/w1/history?limit=1000'), 400, 'invalid_parameters'],
    ['missing query', memory.request('GET', '/b2/workers/w1/interactions/status'), 400, 'invalid_parameters'],
    ['path encoding', memory.request('GET', '/b2/workers/%E0%A4%A/history'), 400, 'invalid_path_encoding'],
    ['unknown route', memory.request('GET', '/v0/hello'), 404, 'unknown_route'],
    ['wrong method', memory.request('DELETE', '/b2/hello'), 405, 'method_not_allowed'],
  ];
  for (const [label, pending, status, error] of cases) {
    const response = await pending;
    assert.equal(response.status, status, label);
    assert.equal((response.body as { error: string }).error, error, label);
    assert.equal((response.body as { effect: string }).effect, 'no_effect', label);
    assert.equal(validateError(response.body), true, label);
  }
  assert.equal(calls, 0);
  // The valid request reaches the handler, proving the cases above were refused by validation, not by routing.
  await memory.request('POST', prompt, { json: { ...binding, message: 'x' } });
  assert.equal(calls, 1);
});
