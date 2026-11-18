/**
 * C1 (P3 plan section 4): the public client checks every reply against validators generated from api/b2.openapi.yaml
 * before the caller sees it. A fake worker on a Unix socket serves each wire fixture and mutants of it; the client is
 * driven only through its public surface. Assertion messages name operations, fixtures and mutants, never values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { chmodSync, globSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, ClientFailure, ResyncRequired, routes, streamRefused, type EventFrame, type OperationId } from '../src/index.js';
import type { ClientRoute } from '../src/generated/routes.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const wire = join(root, 'api', 'fixtures', 'wire');
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
interface Fixture {
  request: { path?: Record<string, string>; query?: Record<string, string>; body?: Json; headers?: Record<string, string>; bodyBase64?: string };
  response: { status: number; body?: Json; frames?: Obj[]; headers?: Record<string, string>; contentType?: string; bodyText?: string; bodyBase64?: string };
}
const fixtures = (op: string): [string, Fixture][] =>
  readdirSync(join(wire, op))
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => [f.slice(0, -5), JSON.parse(readFileSync(join(wire, op, f), 'utf8')) as Fixture]);

/** Never sent by a worker: a mutant carries it, so a failure that exposes the reply shows it. */
const SENTINEL = 'zz-sentinel-9f1c';
const TOKEN = 'piw1.zz-token-secret';

interface Reply {
  status: number;
  headers?: OutgoingHttpHeaders;
  body: string | Buffer;
  /** Pieces to write, a tick apart, instead of `body` in one write (chunked transfer encoding). */
  pieces?: Buffer[];
}

/** A fake worker that answers every request with `reply`, counting requests. */
async function fake() {
  const dir = mkdtempSync(join(tmpdir(), 'piw-client-v-'));
  chmodSync(dir, 0o700);
  const socket = join(dir, 'worker.sock');
  const state: { reply: Reply; requests: number; seen: IncomingHttpHeaders[] } = { reply: { status: 500, body: '' }, requests: 0, seen: [] };
  const server = createServer((req, res) => {
    state.requests++;
    state.seen.push(req.headers);
    req.resume();
    req.on('end', async () => {
      const { status, headers, body, pieces } = state.reply;
      res.writeHead(status, { Connection: 'close', ...headers });
      if (!pieces) return void res.end(body);
      for (const piece of pieces) {
        res.write(piece);
        await new Promise(r => setImmediate(r));
      }
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(socket, () => r()));
  const grant = join(dir, 'grant.json');
  writeFileSync(grant, JSON.stringify({ token: TOKEN }), { mode: 0o600 });
  return {
    state,
    client: new Client({ socketPath: socket, grantFile: grant, timeoutMs: 5_000 }),
    json(status: number, body: unknown, contentType = 'application/json') {
      state.reply = { status, headers: contentType ? { 'Content-Type': contentType } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          r();
        });
      }),
  };
}
type Fake = Awaited<ReturnType<typeof fake>>;

/** Sends `fixture`'s request through the public client. */
function send(client: Client, op: OperationId, fixture: Fixture): Promise<unknown> {
  const { request } = fixture;
  if (op === 'attachments.stage') {
    const h = request.headers!;
    const params = { command_id: h['Piw-Command-Id']!, worker_id: h['Piw-Worker-Id']!, worker_epoch: h['Piw-Worker-Epoch']!, session_id: h['Piw-Session-Id']!, binding_revision: Number(h['Piw-Binding-Revision']) };
    return client.stage(request.path!.attachment_id!, params, h['Content-Type']!, Buffer.from(request.bodyBase64!, 'base64'));
  }
  const options = { path: request.path, query: request.query, body: request.body } as never;
  if (routes[op].responseMode === 'ndjson' || routes[op].responseMode === 'binary') return client.read(op, options);
  return client.call(op, options);
}

/** The settled outcome of a promise, so a missing rejection fails by assertion. */
const settle = (p: Promise<unknown>) => p.then(value => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined, error }));

/** A failure exposes nothing of the reply: only its typed name, status and (for an invalid reply) schema location. */
function assertNothingExposed(error: unknown, label: string) {
  assert.ok(error instanceof ClientFailure, `${label}: a ClientFailure`);
  const text = [error.message, error.stack ?? '', JSON.stringify(error.details), String(error)].join('\n');
  assert.ok(!text.includes(SENTINEL), `${label}: the failure carries nothing from the reply`);
  assert.ok(!text.includes(TOKEN), `${label}: the failure carries no bearer`);
}

/** Expects an untrusted reply: unknown after the write, the named check, no body exposed. */
function assertUnknown(outcome: { value: unknown; error: unknown }, reason: string, label: string) {
  assert.equal(outcome.value, undefined, `${label}: no result is exposed`);
  assert.ok(outcome.error instanceof ClientFailure, `${label}: rejects with ClientFailure`);
  assert.deepEqual([outcome.error.effect, outcome.error.phase, outcome.error.message], ['unknown', 'after_write', reason], label);
  for (const key of Object.keys(outcome.error.details)) assert.ok(['schema_path', 'keyword'].includes(key), `${label}: detail ${key} is not a reply value`);
  assertNothingExposed(outcome.error, label);
}

// The bundled spec, read only to derive mutants (which fields are required, enums, closed objects).
const spec = JSON.parse(readFileSync(join(root, 'api', 'generated', 'b2.json'), 'utf8')) as Obj;
interface Shape {
  required: string[];
  properties: Record<string, Obj>;
  closed: boolean;
}
/** Follows local `#/...` references through the bundled spec. */
function deref(node: Obj): Obj {
  let s = node;
  while (typeof s.$ref === 'string') s = s.$ref.slice(2).split('/').reduce<Json>((at, key) => (at as Obj)[key]!, spec) as Obj;
  return s;
}
/** An object schema's shape: through $ref, allOf (merged) and an anyOf with one object branch (plus null). */
function shape(schema: Obj): Shape | null {
  const s = deref(schema);
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map(p => shape(p as Obj)).filter((p): p is Shape => p !== null);
    if (!parts.length) return null;
    return { required: parts.flatMap(p => p.required), properties: Object.assign({}, ...parts.map(p => p.properties)) as Record<string, Obj>, closed: parts.some(p => p.closed) };
  }
  if (Array.isArray(s.anyOf)) {
    const branches = s.anyOf.map(b => deref(b as Obj)).filter(b => b.type !== 'null');
    return branches.length === 1 ? shape(branches[0]!) : null;
  }
  if (s.type !== 'object' && (!s.properties || typeof s.properties !== 'object')) return null;
  return { required: (s.required as string[] | undefined) ?? [], properties: (s.properties ?? {}) as Record<string, Obj>, closed: s.additionalProperties === false };
}
const enumOf = (schema: Obj) => {
  const s = deref(schema);
  return Array.isArray(s.enum) || s.const !== undefined;
};

interface Mutant {
  name: string;
  body: Json;
  /** False for an extra field in an explicitly open object: the client must keep it. */
  invalid: boolean;
}
/**
 * Mutants of `value` (valid against `schema`): each required field missing, each field of the wrong type, each enum
 * field off its enum and an extra field, at every object depth (an array's first item stands for its items).
 */
function mutants(schema: Obj, value: Json, at = '', depth = 0): Mutant[] {
  const out: Mutant[] = [];
  const s = deref(schema);
  if (Array.isArray(value)) {
    if (!value.length || depth > 4) return out;
    const items = (s.type === 'array' ? s.items : undefined) as Obj | undefined;
    if (!items) return out;
    for (const m of mutants(items, value[0]!, `${at}/0`, depth + 1)) out.push({ ...m, body: [m.body, ...value.slice(1)] });
    return out;
  }
  const sh = shape(schema);
  if (!sh || value === null || typeof value !== 'object' || depth > 4) return out;
  const obj = value;
  for (const key of sh.required) {
    if (!(key in obj)) continue;
    const { [key]: _, ...rest } = obj;
    out.push({ name: `${at}/${key} missing`, body: rest, invalid: true });
  }
  for (const [key, field] of Object.entries(obj)) {
    const fieldSchema = sh.properties[key];
    if (!fieldSchema) continue;
    const wrong: Json = field === null || typeof field !== 'object' ? { [SENTINEL]: SENTINEL } : SENTINEL;
    out.push({ name: `${at}/${key} wrong type`, body: { ...obj, [key]: wrong }, invalid: true });
    if (enumOf(fieldSchema)) out.push({ name: `${at}/${key} off its enum`, body: { ...obj, [key]: SENTINEL }, invalid: true });
    for (const m of mutants(fieldSchema, field, `${at}/${key}`, depth + 1)) out.push({ ...m, body: { ...obj, [key]: m.body } });
  }
  out.push({ name: `${at} extra field`, body: { ...obj, [SENTINEL]: 1 }, invalid: sh.closed });
  return out;
}

/** The 200 response schema of a JSON operation, from the bundled spec's paths. */
function okSchema(op: OperationId): Obj {
  const paths = spec.paths as unknown as Record<string, Record<string, { operationId: string; responses: Record<string, Obj> }>>;
  for (const item of Object.values(paths)) {
    for (const operation of Object.values(item)) {
      if (operation?.operationId !== op) continue;
      const ok = deref(operation.responses['200']!);
      return ((ok.content as Record<string, { schema: Obj }>)['application/json']!).schema;
    }
  }
  throw new Error(`no operation ${op}`);
}

const jsonOps = (Object.keys(routes) as OperationId[]).filter(op => routes[op].responseMode === 'json');

test('C1: every JSON operation accepts its wire fixtures; missing, mistyped, off-enum and extra fields are unknown with nothing exposed; open objects stay open', { timeout: 120_000 }, async () => {
  const f = await fake();
  let rejected = 0;
  const open: string[] = [];
  try {
    assert.ok(jsonOps.length >= 30, 'every JSON operation is covered');
    for (const op of jsonOps) {
      const all = fixtures(op);
      assert.ok(all.length > 0, `${op}: has a wire fixture`);
      for (const [name, fixture] of all) {
        const label = `${op}/${name}`;
        const { status, body } = fixture.response;
        f.json(status, body);
        const got = await settle(send(f.client, op, fixture));
        if (status === 200) {
          assert.equal(got.error, undefined, `${label}: the fixture is accepted`);
          assert.deepEqual(got.value, body, `${label}: the body arrives whole`);
          for (const m of mutants(okSchema(op), body!)) {
            f.json(200, m.body);
            const before = f.state.requests;
            const outcome = await settle(send(f.client, op, fixture));
            assert.equal(f.state.requests, before + 1, `${label} ${m.name}: one request`);
            if (m.invalid) {
              assertUnknown(outcome, 'response_schema_mismatch', `${label} ${m.name}`);
              rejected++;
            } else {
              assert.equal(outcome.error, undefined, `${label} ${m.name}: an open object keeps extra fields`);
              assert.deepEqual(outcome.value, m.body, `${label} ${m.name}`);
              open.push(`${op} ${m.name}`);
            }
          }
        } else {
          const error = got.error as ClientFailure;
          assert.ok(error instanceof ClientFailure, `${label}: a refusal rejects`);
          const refusal = body as Obj;
          assert.deepEqual([error.phase, error.status, error.message, error.effect], ['http', status, refusal.error, refusal.effect], label);
          assert.deepEqual(error.details, refusal, `${label}: a valid B2 Error is kept`);
        }
      }
    }
    assert.ok(rejected > 500, 'non-vacuous: hundreds of invalid replies refused');
    for (const want of ['workers.create /result extra field', 'workers.stop /result extra field', 'attachments.stage /result extra field']) {
      assert.ok(open.includes(want), `explicitly open objects stay open: ${want}`);
    }
  } finally {
    await f.close();
  }
});

test('C1: StopReceipt and nested worker rows are validated: an off-enum termination or a malformed worker row is unknown', { timeout: 30_000 }, async () => {
  const f = await fake();
  try {
    const [, stop] = fixtures('workers.stop').find(([n]) => n === 'ok')!;
    const receipt = stop.response.body as Obj;
    const cases: [string, Json][] = [
      ['termination off its enum', { ...receipt, result: { ...(receipt.result as Obj), termination: SENTINEL } }],
      ['stopped_worker_epoch empty', { ...receipt, result: { ...(receipt.result as Obj), stopped_worker_epoch: '' } }],
      ['result not an object', { ...receipt, result: [SENTINEL] }],
    ];
    for (const [name, body] of cases) {
      f.json(200, body);
      assertUnknown(await settle(send(f.client, 'workers.stop', stop)), 'response_schema_mismatch', `workers.stop ${name}`);
    }
    const [, list] = fixtures('workers.list')[0]!;
    const row = (list.response.body as Obj[])[0]!;
    const rows: [string, Json][] = [
      ['second row lacks status', [row, { ...row, worker_id: 'w2', status: undefined } as unknown as Json]],
      ['second row has an extra field', [row, { ...row, worker_id: 'w2', [SENTINEL]: true }]],
      ['execution of the wrong shape', [{ ...row, execution: { [SENTINEL]: 1 } }]],
    ];
    for (const [name, body] of rows) {
      f.json(200, body);
      assertUnknown(await settle(send(f.client, 'workers.list', list)), 'response_schema_mismatch', `workers.list ${name}`);
    }
    // A worker row's `resources` is an explicitly open object: any fields arrive.
    const open = [{ ...row, resources: { profile: 'cgroup_v2', any: { nested: [1, 'two'] } } }];
    f.json(200, open);
    assert.deepEqual(await send(f.client, 'workers.list', list), open, 'an open resources object stays open');
  } finally {
    await f.close();
  }
});

test('C1: an invalid HTTP-200 create or prompt receipt is unknown after exactly one request; no result is exposed', { timeout: 30_000 }, async () => {
  const f = await fake();
  try {
    for (const op of ['workers.create', 'sessions.prompt'] as const) {
      const [, fixture] = fixtures(op).find(([n]) => n === 'ok')!;
      const receipt = fixture.response.body as Obj;
      const { request_hash: _hash, ...noHash } = receipt;
      const invalid: [string, Json][] = [
        ['no request_hash', { ...noHash, [SENTINEL]: SENTINEL }],
        ['state off its enum', { ...receipt, state: SENTINEL }],
        ['extra field', { ...receipt, [SENTINEL]: SENTINEL }],
        ['effect off its enum', { ...receipt, effect: 'no_effect_' }],
      ];
      for (const [name, body] of invalid) {
        f.state.requests = 0;
        f.json(200, body);
        const outcome = await settle(send(f.client, op, fixture));
        await new Promise(r => setTimeout(r, 30));
        assert.equal(f.state.requests, 1, `${op} ${name}: exactly one request, never resent`);
        assertUnknown(outcome, 'response_schema_mismatch', `${op} ${name}`);
      }
    }
  } finally {
    await f.close();
  }
});

test('C1: a refusal keeps no_effect only from a valid B2 Error; an invalid refusal is unknown and keeps nothing', { timeout: 30_000 }, async () => {
  const f = await fake();
  try {
    const [, fixture] = fixtures('sessions.prompt').find(([n]) => n === 'ok')!;
    const invalid: [string, Json][] = [
      ['no error field', { effect: 'no_effect' }],
      ['empty error', { error: '', effect: 'no_effect' }],
      ['error not a string', { error: 7, effect: 'no_effect' }],
      ['effect off its enum', { error: 'busy', effect: 'nothing' }],
      ['extra field', { error: 'busy', effect: 'no_effect', [SENTINEL]: SENTINEL }],
      ['negative expected revision', { error: 'stale_binding', effect: 'no_effect', expected_binding_revision: 0 }],
    ];
    for (const status of [409, 500, 503]) {
      for (const [name, body] of invalid) {
        f.state.requests = 0;
        f.json(status, body);
        const { value, error } = await settle(send(f.client, 'sessions.prompt', fixture));
        const label = `${status} ${name}`;
        assert.equal(value, undefined, label);
        assert.ok(error instanceof ClientFailure, label);
        assert.deepEqual([error.effect, error.phase, error.status, error.message, error.details], ['unknown', 'http', status, 'refusal_not_b2_error', {}], `${label}: never permission to retry`);
        assert.equal(f.state.requests, 1, `${label}: one request`);
        assertNothingExposed(error, label);
      }
    }
    // The same no_effect refusal in a reply that is not JSON is unreadable: unknown after the write.
    for (const [name, contentType] of [['text/plain', 'text/plain'], ['no content type', '']] as const) {
      f.json(409, { error: 'busy', effect: 'no_effect' }, contentType);
      const { error } = await settle(send(f.client, 'sessions.prompt', fixture));
      assert.ok(error instanceof ClientFailure, name);
      assert.deepEqual([error.effect, error.phase, error.message], ['unknown', 'after_write', 'refusal_not_json'], name);
    }
    // A valid one keeps the worker's effect and its typed fields; a status the operation does not declare still
    // carries an Error (the router's own refusals).
    for (const status of [409, 404]) {
      f.json(status, { error: 'stale_binding', effect: 'no_effect', expected_binding_revision: 1, received_binding_revision: 3 });
      const { error } = await settle(send(f.client, 'sessions.prompt', fixture));
      assert.ok(error instanceof ClientFailure);
      assert.deepEqual([error.effect, error.phase, error.status, error.details.received_binding_revision], ['no_effect', 'http', status, 3]);
    }
  } finally {
    await f.close();
  }
});

test('C1: JSON replies of the wrong content type, truncated, cut short, oversized or not UTF-8 are unknown', { timeout: 60_000 }, async () => {
  const f = await fake();
  try {
    const [, fixture] = fixtures('receipts.get').find(([n]) => n === 'ok')!;
    const text = JSON.stringify(fixture.response.body);
    f.json(200, text);
    assert.deepEqual(await send(f.client, 'receipts.get', fixture), fixture.response.body, 'control: the fixture is accepted');
    for (const [name, contentType] of [['text/plain', 'text/plain'], ['ndjson', 'application/x-ndjson'], ['none', '']] as const) {
      f.json(200, text, contentType);
      assertUnknown(await settle(send(f.client, 'receipts.get', fixture)), 'response_content_type_mismatch', `content type ${name}`);
    }
    f.json(200, text, 'application/json; charset=utf-8');
    assert.deepEqual(await send(f.client, 'receipts.get', fixture), fixture.response.body, 'a media type parameter is allowed');
    f.json(200, text.slice(0, -2));
    assertUnknown(await settle(send(f.client, 'receipts.get', fixture)), 'response_not_json', 'truncated JSON');
    // Malformed UTF-8 inside a string: lossy decoding would turn it into U+FFFD and pass the schema.
    const bad = Buffer.from(text.replace('"supervisor_journal_fsynced"', '"supervisor_journal_fsynced"').replace(/"request_hash":"[^"]*"/, '"request_hash":"ab\u00ffcd"'));
    const at = bad.indexOf(Buffer.from('\u00ff'));
    assert.ok(at > 0, 'the marker is in the reply');
    f.state.reply = { status: 200, headers: { 'Content-Type': 'application/json' }, body: Buffer.concat([bad.subarray(0, at), Buffer.from([0xff]), bad.subarray(at + 2)]) };
    assertUnknown(await settle(send(f.client, 'receipts.get', fixture)), 'response_not_json', 'malformed UTF-8');
    // A body cut short of its Content-Length is a transport failure after the write.
    f.state.reply = { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(text.length + 10) }, body: text };
    const short = await settle(send(f.client, 'receipts.get', fixture));
    assert.ok(short.error instanceof ClientFailure && short.error.effect === 'unknown' && short.error.phase === 'after_write', 'cut short');
    assert.equal(short.value, undefined);
    // Over the response limit (8 MiB), well-formed or not, refusal or success.
    for (const status of [200, 409]) {
      f.json(status, `{"error":"${'x'.repeat(8 * 1024 * 1024)}","effect":"no_effect"}`);
      const big = await settle(send(f.client, 'receipts.get', fixture));
      assert.ok(big.error instanceof ClientFailure && big.error.effect === 'unknown' && big.error.phase === 'after_write', `oversized ${status}`);
    }
  } finally {
    await f.close();
  }
});

/** Watches through the public client; returns the delivered frames, the outcome and whether controls are enabled. */
async function watch(f: Fake, frames: Buffer | Buffer[], options: { contentType?: string; chunked?: boolean } = {}) {
  const pieces = Array.isArray(frames) ? frames : [frames];
  f.state.reply = { status: 200, headers: { 'Content-Type': options.contentType ?? 'text/event-stream', ...(options.chunked === false ? {} : { 'Transfer-Encoding': 'chunked' }) }, body: '', pieces };
  const delivered: EventFrame[] = [];
  const controls: boolean[] = [];
  const error = await f.client
    .watch(frame => {
      delivered.push(frame);
      controls.push(!f.client.resyncRequired);
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  return { delivered, controls, error, resyncRequired: f.client.resyncRequired };
}
const record = (frame: unknown) => Buffer.from(`id: 1\nevent: frame\ndata: ${JSON.stringify(frame)}\n\n`);

test('C1: every event fixture streams through; an invalid snapshot, nested worker or event never reaches the callback or enables controls', { timeout: 60_000 }, async () => {
  const f = await fake();
  try {
    for (const [name, fixture] of fixtures('events.subscribe')) {
      const frames = fixture.response.frames!;
      const got = await watch(f, frames.map(record));
      assert.deepEqual(got.delivered, frames, `${name}: every frame arrives whole`);
      const last = frames.at(-1)!;
      const data = last.data as { resync_required?: boolean; reason?: string } | undefined;
      if (last.type === 'overflow' && data?.resync_required === false) {
        // An authority end is terminal: the watch ends with the refusal, never a resync.
        assert.equal(streamRefused(got.error), data.reason, `${name}: ends with its refusal`);
        assert.ok(got.error instanceof ClientFailure && got.error.effect === 'no_effect', `${name}: no_effect`);
      } else assert.ok(got.error instanceof ResyncRequired && got.error.reason === (last.type === 'overflow' ? 'overflow' : 'disconnected'), name);
    }
    const [, every] = fixtures('events.subscribe').find(([n]) => n === 'every-type')!;
    const snapshot = every.response.frames!.find(fr => fr.type === 'snapshot')!;
    const row = (snapshot.workers as Obj[])[0]!;
    const badSnapshots: [string, Obj][] = [
      ['worker lacks status', { ...snapshot, workers: [{ ...row, status: undefined } as unknown as Obj] }],
      ['worker status off its enum', { ...snapshot, workers: [{ ...row, status: SENTINEL }] }],
      ['worker has an extra field', { ...snapshot, workers: [row, { ...row, worker_id: 'w2', [SENTINEL]: 1 }] }],
      ['worker history malformed', { ...snapshot, workers: [{ ...row, history: { [SENTINEL]: 1 } }] }],
      ['nine recent settlements', { ...snapshot, workers: [{ ...row, recent_settlements: Array.from({ length: 9 }, (_, i) => ({ execution_id: `x${i}`, outcome: 'completed', settled_at: '2026-11-16T04:30:00Z' })) }] }],
      ['cursor without seq', { ...snapshot, cursor: { transport_epoch: 't' } }],
      ['resync reason off its enum', { ...snapshot, resync_reason: SENTINEL }],
      ['workers not an array', { ...snapshot, workers: { [SENTINEL]: row } }],
    ];
    for (const [name, bad] of badSnapshots) {
      const got = await watch(f, record(bad));
      assert.equal(got.delivered.length, 0, `${name}: never delivered`);
      assert.ok(got.error instanceof ResyncRequired && got.error.reason === 'invalid_frame', `${name}: resync required`);
      assert.equal(got.resyncRequired, true, `${name}: controls stay disabled`);
      assert.ok(!String(got.error.message).includes(SENTINEL), `${name}: nothing of the frame in the error`);
    }
    // After a valid snapshot, an invalid event stops the stream before the callback and disables controls again.
    const events = every.response.frames!.filter(fr => fr.type !== 'snapshot' && fr.type !== 'overflow');
    assert.ok(events.length >= 15, 'non-vacuous: every event type');
    for (const event of events) {
      for (const [name, bad] of [
        ['extra field', { ...event, [SENTINEL]: 1 }],
        ['no cursor', { ...event, cursor: undefined }],
        ['data of the wrong shape', { ...event, data: [SENTINEL] }],
        ['unknown type', { ...event, type: `${String(event.type)}.${SENTINEL}` }],
      ] as const) {
        const got = await watch(f, [record(snapshot), record(bad)]);
        const label = `${String(event.type)} ${name}`;
        assert.deepEqual(got.delivered, [snapshot], `${label}: only the snapshot is delivered`);
        assert.deepEqual(got.controls, [true], `${label}: the valid snapshot enabled controls`);
        assert.ok(got.error instanceof ResyncRequired && got.error.reason === 'invalid_frame', label);
        assert.equal(got.resyncRequired, true, `${label}: controls disabled again`);
      }
    }
  } finally {
    await f.close();
  }
});

test('C1: SSE over chunked transfer with CR, LF and split UTF-8 arrives whole; a wrong content type or malformed UTF-8 is refused before the callback', { timeout: 30_000 }, async () => {
  const f = await fake();
  try {
    const [, ok] = fixtures('events.subscribe').find(([n]) => n === 'ok')!;
    const snapshot = { ...ok.response.frames![0]!, workers: [{ ...(ok.response.frames![0]!.workers as Obj[])[0]!, title: 'café ☕ 𝄞' }] };
    const body = Buffer.from(`: hello\r\nid: 1\r\ndata: ${JSON.stringify(snapshot)}\r\r`);
    // Cut every multi-byte character in two, and the CRLF pair too.
    const cuts = [body.indexOf(Buffer.from('é')) + 1, body.indexOf(Buffer.from('☕')) + 2, body.indexOf(Buffer.from('𝄞')) + 3, body.indexOf('\r\n') + 1];
    const pieces = [0, ...cuts.sort((a, b) => a - b), body.length].slice(1).map((end, i, all) => body.subarray(i === 0 ? 0 : all[i - 1], end));
    assert.equal(Buffer.concat(pieces).length, body.length);
    const whole = await watch(f, pieces);
    assert.deepEqual(whole.delivered, [snapshot], 'split characters and line endings across chunks arrive whole');
    assert.deepEqual(whole.controls, [true]);
    for (const contentType of ['application/json', 'text/plain', '']) {
      const got = await watch(f, record(snapshot), { contentType });
      assert.equal(got.delivered.length, 0, `content type ${contentType || 'none'}: nothing delivered`);
      assert.ok(got.error instanceof ResyncRequired && got.error.reason === 'invalid_content_type', `content type ${contentType || 'none'}`);
      assert.equal(got.resyncRequired, true);
    }
    // A byte that is not UTF-8 inside the snapshot's title: lossy decoding would deliver U+FFFD and enable controls.
    const marked = record({ ...snapshot, workers: [{ ...(snapshot.workers as Obj[])[0]!, title: 'a\u00ffb' }] });
    const at = marked.indexOf(Buffer.from('\u00ff'));
    const invalid = Buffer.concat([marked.subarray(0, at), Buffer.from([0xff]), marked.subarray(at + 2)]);
    const got = await watch(f, invalid);
    assert.equal(got.delivered.length, 0, 'malformed UTF-8: nothing delivered');
    assert.ok(got.error instanceof ResyncRequired && got.error.reason === 'invalid_frame', 'malformed UTF-8: invalid_frame');
    assert.equal(got.resyncRequired, true);
  } finally {
    await f.close();
  }
});

test('C1: byte reads check their media type, typed required headers and, for NDJSON, a complete final line', { timeout: 30_000 }, async () => {
  const f = await fake();
  try {
    let checked = 0;
    for (const op of ['sessions.history', 'blobs.read'] as const) {
      for (const [name, fixture] of fixtures(op)) {
        const r = fixture.response;
        const label = `${op}/${name}`;
        if (r.status !== 200) {
          f.json(r.status, r.body);
          const { error } = await settle(send(f.client, op, fixture));
          assert.ok(error instanceof ClientFailure && error.phase === 'http' && error.status === r.status, label);
          continue;
        }
        const body = r.bodyText !== undefined ? Buffer.from(r.bodyText) : Buffer.from(r.bodyBase64!, 'base64');
        const serve = (headers: Record<string, string>, bytes = body, contentType = r.contentType!) => {
          f.state.reply = { status: 200, headers: { ...headers, 'Content-Type': contentType }, body: bytes };
        };
        serve(r.headers!);
        const ok = (await send(f.client, op, fixture)) as { body: Buffer; contentType: string; headers: Record<string, string> };
        assert.deepEqual([ok.body, ok.contentType], [body, r.contentType], `${label}: accepted whole`);
        // Each declared header the spec requires, missing; each typed one with a value of the wrong kind.
        const kinds = (routes[op] as ClientRoute).headerKinds!;
        const required = Object.entries(kinds);
        for (const [header] of required) {
          const wire = Object.keys(r.headers!).find(h => h.toLowerCase() === header)!;
          if (!wire) continue;
          const { [wire]: _, ...without } = r.headers!;
          serve(without);
          const missing = await settle(send(f.client, op, fixture));
          // Piw-Tail-Sha256 is the one optional header of the set.
          if (header === 'piw-tail-sha256') assert.equal(missing.error, undefined, `${label}: ${header} is optional`);
          else assertUnknown(missing, 'response_headers_mismatch', `${label}: ${header} missing`);
          // A typed header (integer, boolean) whose wire value is not of its kind.
          serve({ ...r.headers!, [wire]: `${SENTINEL}-x` });
          const wrong = await settle(send(f.client, op, fixture));
          if (kinds[header] !== 'string') assertUnknown(wrong, 'response_headers_mismatch', `${label}: ${header} of the wrong kind`);
          checked++;
        }
        serve(r.headers!, body, 'text/plain');
        assertUnknown(await settle(send(f.client, op, fixture)), 'response_content_type_mismatch', `${label}: undeclared media type`);
        if (op === 'sessions.history') {
          serve(r.headers!, body.subarray(0, body.length - 1));
          assertUnknown(await settle(send(f.client, op, fixture)), 'ndjson_incomplete_final_line', `${label}: incomplete final line`);
          serve(r.headers!, Buffer.from(`${body.toString()}{"type":"message","id":"cut`));
          assertUnknown(await settle(send(f.client, op, fixture)), 'ndjson_incomplete_final_line', `${label}: a cut last line`);
          serve({ ...r.headers!, 'Piw-Offset': '-1' });
          assertUnknown(await settle(send(f.client, op, fixture)), 'response_headers_mismatch', `${label}: a negative offset`);
          serve({ ...r.headers!, 'Piw-Next-Offset': '12', 'Piw-Watermark': '12' }, Buffer.alloc(0));
          assert.equal((await settle(send(f.client, op, fixture))).error, undefined, `${label}: an empty body has no line to cut`);
        }
      }
    }
    assert.ok(checked >= 12, 'non-vacuous: every declared header was checked');
  } finally {
    await f.close();
  }
});

test('C1: replies, refusals and frames are never logged and failures carry no payload or bearer', { timeout: 30_000 }, async () => {
  const f = await fake();
  const written: string[] = [];
  const restore: (() => void)[] = [];
  const capture = (stream: NodeJS.WriteStream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => void (stream.write = original));
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => void written.push(args.map(String).join(' '));
    restore.push(() => void (console[method] = original));
  }
  capture(process.stdout);
  capture(process.stderr);
  const failures: unknown[] = [];
  try {
    const [, fixture] = fixtures('sessions.prompt').find(([n]) => n === 'ok')!;
    const receipt = fixture.response.body as Obj;
    f.json(200, { ...receipt, [SENTINEL]: SENTINEL });
    failures.push((await settle(send(f.client, 'sessions.prompt', fixture))).error);
    f.json(200, { ...receipt, state: SENTINEL });
    failures.push((await settle(send(f.client, 'sessions.prompt', fixture))).error);
    f.json(409, { error: 'busy', effect: 'no_effect', [SENTINEL]: SENTINEL });
    failures.push((await settle(send(f.client, 'sessions.prompt', fixture))).error);
    f.json(502, `<html>${SENTINEL}</html>`, 'text/html');
    failures.push((await settle(send(f.client, 'sessions.prompt', fixture))).error);
    f.json(200, `{"${SENTINEL}": `);
    failures.push((await settle(send(f.client, 'sessions.prompt', fixture))).error);
    const frame = await watch(f, Buffer.from(`data: {"type":"snapshot","${SENTINEL}":1}\n\n`));
    failures.push(frame.error);
    const notJson = await watch(f, Buffer.from(`data: {${SENTINEL}\n\n`));
    failures.push(notJson.error);
  } finally {
    for (const undo of restore.reverse()) undo();
    await f.close();
  }
  assert.equal(failures.length, 7);
  for (const [i, failure] of failures.entries()) {
    assert.ok(failure instanceof Error, `failure ${i}`);
    const text = [failure.message, failure.stack ?? '', JSON.stringify(failure)].join('\n');
    assert.ok(!text.includes(SENTINEL) && !text.includes(TOKEN), `failure ${i} carries nothing from the reply and no bearer`);
  }
  assert.ok(f.state.seen.every(h => h.authorization === `Bearer ${TOKEN}`), 'the bearer was sent');
  const logged = written.join('\n');
  assert.ok(!logged.includes(SENTINEL), 'no reply was logged');
  assert.ok(!logged.includes(TOKEN), 'no bearer was logged');
});

test('C1: the client imports only Node built-ins and its own files: no worker runtime, no runtime package', () => {
  const dist = fileURLToPath(new URL('../src/', import.meta.url));
  const files = globSync('**/*.js', { cwd: dist });
  assert.ok(files.includes('generated/validators.js'), 'the generated validators ship with the client');
  for (const file of files) {
    const source = readFileSync(join(dist, file), 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]!);
    for (const s of specifiers) assert.ok(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../'), `${file} imports ${s}`);
    assert.ok(!/\brequire\s*\(/.test(source), `${file}: no require`);
  }
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.deepEqual([pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies], [undefined, undefined, undefined], 'no runtime dependencies');
});
