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
import { join } from 'node:path';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { after } from 'node:test';
import { bundledSpec, ownerGrant, privateTmp, socketRaw, specOperationIds, urlFor, wireFixtures, type WireFixture } from './helpers.js';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { fixture } from './supervisor-fixture.js';

const table: Record<string, Route> = routes;
// Every B2 request needs a bearer (P1-9): these closure checks run as the owner.
const grantDir = privateTmp();
after(() => grantDir.cleanup());
const owner = ownerGrant(grantDir.dir);
const auth = owner.headers;
const app = (options: Parameters<typeof createApp>[0] = {}) => createApp({ grants: owner.grants, ...options });
const binding = { command_id: 'cmd-1', worker_epoch: 'epoch-1', session_id: 'session-1', binding_revision: 1 };

function send(handle: RequestHandler, operationId: string, request: WireFixture['request']) {
  const route = table[operationId]!;
  const init =
    request.bodyBase64 !== undefined
      ? { raw: Buffer.from(request.bodyBase64, 'base64'), headers: request.headers ?? {} }
      : { headers: request.headers ?? {}, ...(request.body === undefined ? {} : { json: request.body }) };
  return createMemoryTransport(handle, auth).request(route.method, urlFor(route.path, request), init);
}

/** A route table where sessions.prompt is served, to exercise mutation rules before any mutation is built. */
function withPromptServed(handler: (input: unknown) => unknown): RequestHandler {
  const served = { ...table, 'sessions.prompt': { ...table['sessions.prompt']!, supported: true } };
  // SAFETY: the test supplies a handler for an operation the generated Handlers type marks unsupported.
  const handlers = { hello: () => ({}), 'sessions.prompt': handler } as unknown as Handlers;
  return createRouter({ handlers, routes: served });
}

test('closure: every spec operation is routed (its handler when served, 501 no_effect when unsupported, never 404/405)', async () => {
  // Served operations need supervisor state; this embedded router has none, so a served operation answers hello's
  // 200 or `409 supervisor_state_unavailable`, both from its handler. Each served operation's own test replays its
  // wire fixtures against real state (receipts-get.test.ts, and the supervisor tests from P1-4).
  const { handle } = app();
  const fixtures = new Map(wireFixtures().map(f => [f.operationId, f.fixture]));
  for (const operationId of specOperationIds()) {
    const route = table[operationId];
    assert.ok(route, `${operationId} has no route`);
    const response = await send(handle, operationId, fixtures.get(operationId)!.request);
    if (operationId === 'hello') assert.equal(response.status, 200, operationId);
    else if (route.supported) assert.deepEqual(response, { status: 409, body: { error: 'supervisor_state_unavailable', effect: 'no_effect' } }, operationId);
    else assert.deepEqual(response, { status: 501, body: { error: 'operation_not_implemented', effect: 'no_effect' } }, operationId);
  }
});

test('closure: every route is in the spec and every served operation has a handler', () => {
  assert.deepEqual(Object.keys(table).sort(), specOperationIds().sort());
  const served = Object.values(table).filter(r => r.supported).map(r => r.operationId);
  assert.deepEqual(Object.keys(app().handlers).sort(), served.sort());
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
    const params = { path: {} as Record<string, unknown>, query: {} as Record<string, unknown>, header: {} as Record<string, unknown> };
    const headers = Object.fromEntries(Object.entries(fixture.request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const p of route.params) {
      if (p.in === 'header') {
        const raw = headers[p.name.toLowerCase()];
        if (raw !== undefined) params.header[p.name.toLowerCase()] = convertParam(raw, p.kind);
        continue;
      }
      const raw = p.in === 'path' ? fixture.request.path?.[p.name] : fixture.request.query?.[p.name];
      if (raw !== undefined) (p.in === 'path' ? params.path : params.query)[p.name] = convertParam(raw, p.kind);
    }
    for (const key of Object.keys(fixture.request.query ?? {})) if (!(key in params.query)) params.query[key] = fixture.request.query![key];
    assert.equal(route.validateParams(params), true, `${label} params: ${JSON.stringify(route.validateParams.errors)}`);
    if (route.body === 'json') assert.equal(route.validateBody!(fixture.request.body), true, `${label} body: ${JSON.stringify(route.validateBody!.errors)}`);
    else assert.equal(fixture.request.body, undefined, `${label} has a JSON body for a ${route.body} operation`);
    if (route.body === 'binary') {
      assert.ok(route.mediaTypes.includes(headers['content-type'] ?? ''), `${label} content type`);
      assert.ok(Buffer.from(fixture.request.bodyBase64 ?? '', 'base64').length > 0, `${label} needs bodyBase64`);
    } else assert.equal(fixture.request.bodyBase64, undefined, `${label} has a binary body for a ${route.body} operation`);
    const response = route.responses[String(fixture.response.status)];
    assert.ok(response, `${label}: status ${fixture.response.status} not in spec`);
    if (response.contentType === 'text/event-stream') {
      assert.ok(fixture.response.frames?.length, `${label} needs frames`);
      for (const frame of fixture.response.frames!) assert.equal(validateEventFrame(frame), true, `${label} frame: ${JSON.stringify(validateEventFrame.errors)}`);
    } else if (response.mode === 'ndjson' || response.mode === 'binary') {
      // Bytes with headers: the headers convert from their wire strings by kind and validate; the media type is
      // declared; an ndjson body is complete lines, each one JSON value.
      const wire = Object.fromEntries(Object.entries(fixture.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const typed = Object.fromEntries(Object.entries(wire).map(([k, v]) => [k, convertParam(v, response.headerKinds?.[k] ?? 'string')]));
      assert.equal(response.headers!(typed), true, `${label} headers: ${JSON.stringify(response.headers!.errors)}`);
      assert.ok(response.contentTypes.includes(fixture.response.contentType ?? ''), `${label} content type`);
      const bytes = fixture.response.bodyText !== undefined ? Buffer.from(fixture.response.bodyText) : Buffer.from(fixture.response.bodyBase64 ?? '', 'base64');
      assert.ok(bytes.length <= response.maxBytes!, `${label} within x-piw-max-bytes`);
      if (response.mode === 'ndjson') {
        assert.ok(bytes.length === 0 || bytes[bytes.length - 1] === 0x0a, `${label} ends on a line boundary`);
        for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) assert.doesNotThrow(() => JSON.parse(line), `${label} line is one JSON value`);
      }
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
    ...app().handlers,
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

const MiB = 1024 * 1024;
const attachment = '/b2/attachments/photo-1';
const attachmentHeaders = (extra: Record<string, string> = {}) => ({
  ...auth,
  'content-type': 'image/jpeg',
  'piw-command-id': 'cmd-a',
  'piw-worker-id': 'w1',
  'piw-worker-epoch': 'e1',
  'piw-session-id': 's1',
  'piw-binding-revision': '1',
  'piw-content-sha256': 'a'.repeat(64),
  ...extra,
});

test('closure: every operation declares its body and response modes, and the spec and route table agree', () => {
  const spec = bundledSpec() as unknown as {
    info: { 'x-piw-json-max-bytes': number };
    paths: Record<string, Record<string, { operationId: string; 'x-piw-body'?: string; 'x-piw-max-bytes'?: number; requestBody?: unknown }>>;
  };
  assert.equal(REQUEST_BODY_LIMIT, spec.info['x-piw-json-max-bytes']);
  for (const item of Object.values(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'delete', 'patch'].includes(method)) continue;
      const route = table[op.operationId]!;
      assert.ok(['json', 'binary', 'none'].includes(op['x-piw-body'] ?? ''), `${op.operationId} declares x-piw-body`);
      assert.equal(route.body, op['x-piw-body'], op.operationId);
      assert.ok(['json', 'sse', 'ndjson', 'binary'].includes(route.responseMode), `${op.operationId} response mode`);
      // A byte response declares its cap and its headers, and the router has their validator.
      if (route.raw) {
        const ok = route.responses['200']!;
        assert.ok(ok.maxBytes !== null && ok.maxBytes > 0 && ok.headers !== null && ok.headerKinds !== null, `${op.operationId} byte response declares x-piw-max-bytes and headers`);
      }
      if (route.body === 'none') assert.equal(route.maxBodyBytes, 0, op.operationId);
      if (route.body === 'json') assert.equal(route.maxBodyBytes, op['x-piw-max-bytes'] ?? REQUEST_BODY_LIMIT, op.operationId);
      if (route.body === 'binary') assert.ok(route.maxBodyBytes > REQUEST_BODY_LIMIT && route.maxBodyBytes === op['x-piw-max-bytes'], op.operationId);
      for (const [status, response] of Object.entries(route.responses)) {
        assert.equal(response.mode === 'sse', response.contentType === 'text/event-stream', `${op.operationId} ${status}`);
        assert.equal(response.mode === 'sse', response.maxFrameBytes !== null && response.maxFrameBytes > 0, `${op.operationId} ${status}`);
      }
    }
  }
  assert.equal(table['attachments.stage']!.body, 'binary');
  assert.equal(table['attachments.stage']!.supported, true, 'served from P1-16');
});

test('closure: hello advertises the spec limits (JSON cap, attachment limit, SSE frame cap) and the retention limits', async () => {
  const hello = await createMemoryTransport(app().handle, auth).request('GET', '/b2/hello');
  assert.equal(hello.status, 200);
  const limits = (hello.body as { limits: Record<string, number> }).limits;
  assert.deepEqual(limits, {
    request_body_bytes: REQUEST_BODY_LIMIT,
    attachment_max_bytes: table['attachments.stage']!.maxBodyBytes,
    attachments_per_message: 4,
    attachments_total_bytes: 8 * MiB,
    event_frame_bytes: table['events.subscribe']!.responses['200']!.maxFrameBytes,
    // Retention (P1-12): the journal bound, the control reserve, the receipt bound, the minimum age, expired ids.
    journal_max_bytes: 32 * MiB,
    journal_control_reserve_bytes: MiB,
    ordinary_receipts_max: 4096,
    receipt_retention_min_seconds: 3600,
    receipt_expired_ids_max: 16384,
    history_max_bytes: 16 * MiB,
    history_line_max_bytes: 64 * MiB,
    blob_max_bytes: table['blobs.read']!.responses['200']!.maxBytes,
    inventory_probes_max: 4,
    // artifacts.inspect (PR #42 fix round): its time budget and running caps.
    artifact_inspection_budget_ms: 60_000,
    artifact_inspections_max: 4,
    artifact_inspections_per_caller_max: 2,
  });
});

/** A JPEG-magic body of `n` bytes and its SHA-256: what the staging route checks after the last byte. */
function jpeg(n: number): { body: Buffer; sha: string } {
  const body = Buffer.alloc(n, 0x5a);
  body.set([0xff, 0xd8, 0xff, 0xe0]);
  return { body, sha: createHash('sha256').update(body).digest('hex') };
}

/** A supervisor with one ready worker, and stage headers naming it (P1-16: the binary route's real handler). */
async function stagingWorld() {
  const f = fixture();
  const owner = ownerGrant(f.dir);
  const w = await f.create();
  const handle = createApp({ supervisor: f.supervisor, grants: owner.grants }).handle;
  let n = 0;
  const headers = (sha: string, extra: Record<string, string> = {}) => ({
    ...owner.headers,
    'content-type': 'image/jpeg',
    'piw-command-id': `cmd-stage-${++n}`,
    'piw-worker-id': w.worker_id,
    'piw-worker-epoch': w.worker_epoch,
    'piw-session-id': w.session_id!,
    'piw-binding-revision': String(w.binding_revision),
    'piw-content-sha256': sha,
    ...extra,
  });
  const staged = () => (existsSync(join(f.dir, 'attachments')) ? readdirSync(join(f.dir, 'attachments')) : []);
  return { f, handle, headers, staged, memory: createMemoryTransport(handle) };
}

test('closure: a 1 MiB body reaches the binary route (staged by its handler), the same body to a JSON route is 413', async () => {
  const world = await stagingWorld();
  try {
    const { body, sha } = jpeg(MiB);
    const binary = await world.memory.request('PUT', '/b2/attachments/one-mib', { raw: body, headers: world.headers(sha) });
    assert.equal(binary.status, 200, JSON.stringify(binary.body));
    assert.deepEqual((binary.body as { result: unknown }).result, { attachment_id: 'one-mib', state: 'staged', bytes: MiB });
    const json = await createMemoryTransport(app().handle, auth).request('POST', '/b2/workers/w1/prompt', { raw: Buffer.alloc(MiB, 0xff), headers: { 'content-type': 'application/json' } });
    assert.deepEqual(json, { status: 413, body: { error: 'request_too_large', effect: 'no_effect' } });
  } finally {
    world.f.cleanup();
  }
});

test('closure: the real binary handler stages a body at the limit and refuses the byte past it 413 with no staged file', async () => {
  const world = await stagingWorld();
  try {
    const limit = table['attachments.stage']!.maxBodyBytes;
    const at = jpeg(limit);
    const ok = await world.memory.request('PUT', '/b2/attachments/at-limit', { raw: at.body, headers: world.headers(at.sha) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const over = jpeg(limit + 1);
    const refused = await world.memory.request('PUT', '/b2/attachments/over', { raw: over.body, headers: world.headers(over.sha, { 'content-length': '10' }) });
    assert.deepEqual(refused, { status: 413, body: { error: 'request_too_large', effect: 'no_effect' } });
    assert.equal(world.staged().length, 1, 'only the attachment at the limit is staged; no partial file is left');
  } finally {
    world.f.cleanup();
  }
});

test('closure: binary body modes refuse over-limit bodies, wrong media types and bad headers no_effect', async () => {
  const memory = createMemoryTransport(app().handle, auth);
  const limit = table['attachments.stage']!.maxBodyBytes;
  const cases: [string, Promise<{ status: number; body: unknown }>, number, string][] = [
    ['declared over the limit', memory.request('PUT', attachment, { raw: Buffer.alloc(1), headers: attachmentHeaders({ 'content-length': String(limit + 1) }) }), 413, 'request_too_large'],
    ['json to binary', memory.request('PUT', attachment, { json: { command_id: 'c' }, headers: attachmentHeaders({ 'content-type': 'application/json' }) }), 415, 'unsupported_media_type'],
    ['undeclared image type', memory.request('PUT', attachment, { raw: Buffer.alloc(8), headers: attachmentHeaders({ 'content-type': 'image/gif' }) }), 415, 'unsupported_media_type'],
    ['no content type', memory.request('PUT', attachment, { raw: Buffer.alloc(8), headers: Object.fromEntries(Object.entries(attachmentHeaders()).filter(([k]) => k !== 'content-type')) }), 415, 'unsupported_media_type'],
    ['missing command header', memory.request('PUT', attachment, { raw: Buffer.alloc(8), headers: Object.fromEntries(Object.entries(attachmentHeaders()).filter(([k]) => k !== 'piw-command-id')) }), 400, 'invalid_parameters'],
    ['bad sha header', memory.request('PUT', attachment, { raw: Buffer.alloc(8), headers: attachmentHeaders({ 'piw-content-sha256': 'XYZ' }) }), 400, 'invalid_parameters'],
    ['body on a none route', memory.request('GET', '/b2/hello', { raw: Buffer.from('{}'), headers: { 'content-type': 'application/json' } }), 400, 'body_not_allowed'],
  ];
  for (const [label, pending, status, error] of cases) {
    const response = await pending;
    assert.equal(response.status, status, label);
    assert.equal((response.body as { error: string }).error, error, label);
    assert.equal((response.body as { effect: string }).effect, 'no_effect', label);
    assert.equal(validateError(response.body), true, label);
  }
});

test('closure: a served binary route hands its handler the counted stream; the byte past the limit is 413', async () => {
  const served = { ...table, 'attachments.stage': { ...table['attachments.stage']!, supported: true } };
  const seen: number[] = [];
  // SAFETY: the test serves an operation the generated Handlers type marks unsupported.
  const handlers = {
    hello: () => ({}),
    'attachments.stage': async (input: { header: Record<string, unknown>; body: AsyncIterable<Uint8Array> }) => {
      let bytes = 0;
      for await (const chunk of input.body) bytes += chunk.byteLength;
      seen.push(bytes);
      return { command_id: input.header['piw-command-id'], operation: 'attachments.stage', request_hash: 'h', state: 'delivered', stage: 'dispatch_recorded', effect: 'observed', evidence: 'supervisor_journal_fsynced', created_at: 't' };
    },
  } as unknown as Handlers;
  const memory = createMemoryTransport(createRouter({ handlers, routes: served }));
  const limit = served['attachments.stage'].maxBodyBytes;
  const ok = await memory.request('PUT', attachment, { raw: Buffer.alloc(MiB), headers: attachmentHeaders() });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { command_id: string }).command_id, 'cmd-a');
  const over = await memory.request('PUT', attachment, { raw: Buffer.alloc(limit + 1), headers: attachmentHeaders({ 'content-length': '1' }) });
  // The refusal surfaces from the handler's read; it is a 413 naming the command, as for any mutation after its handler began.
  assert.equal(over.status, 413);
  assert.equal((over.body as { error: string }).error, 'request_too_large');
  assert.deepEqual(seen, [MiB]);
});

test('closure: over the Unix socket, 1 MiB is staged by the binary handler, a JSON MiB is 413, a chunked body past the binary limit is 413', async () => {
  const world = await stagingWorld();
  const tmp = privateTmp();
  const server = createB2Server(world.handle);
  try {
    const socket = join(tmp.dir, 'b2.sock');
    await listenPrivate(server, socket);
    const limit = table['attachments.stage']!.maxBodyBytes;
    const one = jpeg(MiB);
    const binary = await socketRaw(socket, 'PUT', '/b2/attachments/sock-1', world.headers(one.sha, { 'content-length': String(MiB) }), one.body);
    assert.equal(binary.status, 200, JSON.stringify(binary.body));
    const chunked = await socketRaw(socket, 'PUT', '/b2/attachments/sock-2', world.headers(one.sha), one.body);
    assert.equal(chunked.status, 200, JSON.stringify(chunked.body));
    const json = await socketRaw(socket, 'POST', '/b2/workers/w1/prompt', { ...world.headers(one.sha), 'content-type': 'application/json' }, Buffer.alloc(MiB, 0x20));
    assert.deepEqual(json, { status: 413, body: { error: 'request_too_large', effect: 'no_effect' } });
    const big = jpeg(limit + 64 * 1024);
    const over = await socketRaw(socket, 'PUT', '/b2/attachments/sock-3', world.headers(big.sha), big.body);
    assert.deepEqual(over, { status: 413, body: { error: 'request_too_large', effect: 'no_effect' } });
    const declared = await socketRaw(socket, 'PUT', '/b2/attachments/sock-4', world.headers(big.sha, { 'content-length': String(limit + 1) }), big.body.subarray(0, limit + 1));
    assert.deepEqual(declared, { status: 413, body: { error: 'request_too_large', effect: 'no_effect' } });
    assert.equal(world.staged().length, 2, 'the two accepted uploads, and no partial file from the refused ones');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    tmp.cleanup();
    world.f.cleanup();
  }
});
