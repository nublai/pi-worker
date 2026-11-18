/**
 * C2 (P3 plan section 4): write/effect classification and receipt reconciliation, through the public client over a
 * real Unix socket. A fake worker counts every connection and request; the client never sends a mutation twice and
 * reconciliation reads receipts only. Assertion messages name cases, never request or reply values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as netServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquisition,
  classifyReceipt,
  Client,
  ClientFailure,
  reconcile,
  requestHash,
  type Expected,
  type Receipt,
  type Reconciliation,
  type RequestBody,
} from '../src/index.js';

const fixtureBody = (op: string, name: string) =>
  (JSON.parse(readFileSync(new URL(`../../../../api/fixtures/wire/${op}/${name}.json`, import.meta.url), 'utf8')) as { response: { body: Record<string, unknown> } }).response.body;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'piw-c2-'));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const listen = (server: Server, path: string) => new Promise<void>(r => server.listen(path, () => r()));
const close = (server: Server) =>
  new Promise<void>(r => {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => r());
  });
const settle = () => new Promise(r => setTimeout(r, 50));

const promptBody = (command_id: string, message = 'm'): RequestBody<'sessions.prompt'> => ({ command_id, worker_epoch: 'epoch-1', session_id: 'session-1', binding_revision: 1, message });
const promptExpected = (body: RequestBody<'sessions.prompt'>, worker_id = 'worker-1'): Expected => ({
  command_id: body.command_id,
  operation: 'sessions.prompt',
  worker_id,
  request_hash: requestHash('sessions.prompt', { path: { worker_id }, body }),
});
/** The worker's receipt of a delivered prompt, with the identity of `expected`. */
const delivered = (expected: Expected): Receipt => ({
  ...(fixtureBody('receipts.get', 'ok') as unknown as Receipt),
  command_id: expected.command_id,
  operation: expected.operation,
  request_hash: expected.request_hash,
  ...(expected.worker_id === undefined ? {} : { worker_id: expected.worker_id }),
});
const failure = (e: unknown) => (e instanceof ClientFailure ? e : assert.fail('not a ClientFailure'));
const isFailure = (phase: ClientFailure['phase'], effect: ClientFailure['effect']) => (e: unknown) => e instanceof ClientFailure && e.phase === phase && e.effect === effect;

/**
 * A fake worker over HTTP. `onRequest` answers each request (or leaves it unanswered); every connection and request
 * is counted, mutations (non-GET) apart, so a resend shows.
 */
async function fakeWorker(socket: string, onRequest: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void) {
  const counts = { connections: 0, requests: 0, mutations: 0, reads: 0 };
  const server = httpServer((req, res) => {
    counts.requests++;
    if (req.method === 'GET') counts.reads++;
    else counts.mutations++;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => onRequest(req, res, Buffer.concat(chunks)));
  });
  server.on('connection', () => counts.connections++);
  await listen(server, socket);
  return { server, counts };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end(JSON.stringify(body));
};

test('C2: a missing or refused socket, an unreadable grant or an unserializable body is before_write/no_effect with zero server requests', { timeout: 30_000 }, async () => {
  const t = tmp();
  try {
    const body = promptBody('c-before');
    const prompt = (client: Client, b: RequestBody<'sessions.prompt'> = body) => client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body: b });

    // Missing: nothing at the path.
    const missing = failure(await prompt(new Client({ socketPath: join(t.dir, 'missing.sock') })).catch((e: unknown) => e));
    assert.ok(missing.phase === 'before_write' && missing.effect === 'no_effect', 'missing socket');
    assert.match(missing.message, /ENOENT/, 'missing socket: the connect failed with ENOENT');

    // Refused: a socket inode nobody listens on (a hard link that outlives its listener).
    const live = join(t.dir, 'live.sock');
    const stale = join(t.dir, 'stale.sock');
    const listener = netServer(c => c.destroy());
    await listen(listener, live);
    linkSync(live, stale);
    await close(listener);
    assert.ok(existsSync(stale), 'the stale socket inode is still there');
    const refused = failure(await prompt(new Client({ socketPath: stale })).catch((e: unknown) => e));
    assert.ok(refused.phase === 'before_write' && refused.effect === 'no_effect', 'refused socket');
    assert.match(refused.message, /ECONNREFUSED/, 'refused socket: the connect was refused');

    // Unreadable or invalid grants, and a body that cannot be serialized, against a live worker that sees nothing.
    const socket = join(t.dir, 'worker.sock');
    const { server, counts } = await fakeWorker(socket, (_req, res) => json(res, 500, { error: 'should_not_be_reached', effect: 'unknown' }));
    try {
      const noRead = join(t.dir, 'no-read.json');
      writeFileSync(noRead, JSON.stringify({ token: 'test-token' }), { mode: 0o000 });
      const notJson = join(t.dir, 'not-json.json');
      writeFileSync(notJson, 'not json', { mode: 0o600 });
      const noToken = join(t.dir, 'no-token.json');
      writeFileSync(noToken, JSON.stringify({ token: '' }), { mode: 0o600 });
      const grants: Record<string, string> = { absent: join(t.dir, 'absent.json'), 'mode 000': noRead, 'not JSON': notJson, 'empty token': noToken, directory: t.dir };
      for (const [name, grantFile] of Object.entries(grants)) {
        await assert.rejects(prompt(new Client({ socketPath: socket, grantFile })), isFailure('before_write', 'no_effect'), `grant ${name}`);
      }
      const cyclic = { ...body } as Record<string, unknown>;
      cyclic.self = cyclic;
      await assert.rejects(prompt(new Client({ socketPath: socket }), cyclic as never), isFailure('before_write', 'no_effect'), 'cyclic body');
      await settle();
      assert.deepEqual(counts, { connections: 0, requests: 0, mutations: 0, reads: 0 }, 'the worker saw nothing');
    } finally {
      await close(server);
    }
  } finally {
    t.cleanup();
  }
});

test('C2: a disconnect right after the request is written, a partial request, a timeout or a malformed response is after_write/unknown with exactly one attempt', { timeout: 30_000 }, async () => {
  const t = tmp();
  try {
    // Each case: what the fake worker does with the connection. Every one sees the request start.
    const cases: Record<string, (c: Socket, state: { bytes: number }) => void> = {
      'reset on connect': c => c.destroy(),
      'reset after the whole request': (c, s) =>
        c.on('data', (b: Buffer) => {
          s.bytes += b.length;
          if (b.includes('"message"')) c.destroy();
        }),
      'partial request': (c, s) =>
        c.once('data', (b: Buffer) => {
          s.bytes += b.length;
          c.destroy();
        }),
      timeout: (c, s) => c.on('data', (b: Buffer) => void (s.bytes += b.length)),
      'not HTTP': (c, s) =>
        c.once('data', (b: Buffer) => {
          s.bytes += b.length;
          c.end('NOT HTTP AT ALL\r\n\r\n');
        }),
      'truncated JSON 200': (c, s) =>
        c.once('data', (b: Buffer) => {
          s.bytes += b.length;
          c.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{"command_id":"c');
        }),
      'malformed JSON 200': (c, s) =>
        c.once('data', (b: Buffer) => {
          s.bytes += b.length;
          c.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 3\r\nConnection: close\r\n\r\n{{{');
        }),
    };
    // A message large enough that the request spans many socket reads, so a partial request is partial.
    const body = promptBody('c-after', 'x'.repeat(200 * 1024));
    const whole = Buffer.byteLength(JSON.stringify(body));
    for (const [name, behave] of Object.entries(cases)) {
      const socket = join(t.dir, `${name.replace(/\W/g, '-')}.sock`);
      const state = { bytes: 0 };
      let connections = 0;
      const server = netServer(c => {
        connections++;
        behave(c, state);
      });
      await listen(server, socket);
      try {
        const client = new Client({ socketPath: socket, timeoutMs: 300 });
        const got = failure(await client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body }).catch((e: unknown) => e));
        assert.ok(got.phase === 'after_write' && got.effect === 'unknown', `${name}: after_write/unknown`);
        await settle();
        assert.equal(connections, 1, `${name}: exactly one attempt`);
        if (name === 'partial request') assert.ok(state.bytes > 0 && state.bytes < whole, 'partial request: the worker read only part of it');
      } finally {
        await close(server);
      }
    }
  } finally {
    t.cleanup();
  }
});

test('C2: a valid explicit HTTP no_effect stays no_effect with phase http; an HTTP unknown stays unknown', { timeout: 30_000 }, async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const replies: [number, Record<string, unknown>][] = [
    [409, { error: 'session_busy', effect: 'no_effect' }],
    [409, { error: 'stale_binding', effect: 'no_effect', expected_binding_revision: 1, received_binding_revision: 3 }],
    [500, { error: 'internal_error_reconcile_before_retry', effect: 'unknown', uncertain_command_id: 'c-http-2' }],
  ];
  let next = 0;
  const { server, counts } = await fakeWorker(socket, (_req, res) => json(res, ...replies[next++]!));
  try {
    const client = new Client({ socketPath: socket });
    for (const [i, [status, reply]] of replies.entries()) {
      const effect = reply.effect as ClientFailure['effect'];
      const got = failure(await client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body: promptBody(`c-http-${i}`) }).catch((e: unknown) => e));
      assert.ok(got.phase === 'http' && got.status === status && got.effect === effect && got.message === reply.error, `reply ${i}: phase http, the worker's effect`);
    }
    assert.equal(counts.mutations, replies.length, 'one request each');
  } finally {
    await close(server);
    t.cleanup();
  }
});

/** A fake worker whose mutations lose their reply and whose receipts.get answers `receipt(id)`. */
async function lossyWorker(socket: string, receipt: (commandId: string) => [number, unknown]) {
  return fakeWorker(socket, (req, res) => {
    if (req.method !== 'GET') return void res.socket?.destroy();
    const id = decodeURIComponent(/^\/b2\/receipts\/([^/?]+)$/.exec(req.url ?? '')?.[1] ?? '');
    json(res, ...receipt(id));
  });
}

test('C2: an observed receipt with matching command id, operation, worker and request hash resolves a lost reply; nothing is resent', { timeout: 30_000 }, async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const body = promptBody('c-lost');
  const expected = promptExpected(body);
  const { server, counts } = await lossyWorker(socket, id => (id === expected.command_id ? [200, delivered(expected)] : [409, { error: 'unknown_command_id_is_not_proof_of_no_effect', effect: 'unknown' }]));
  try {
    const client = new Client({ socketPath: socket });
    await assert.rejects(client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body }), isFailure('after_write', 'unknown'), 'the reply is lost');
    const result = await reconcile(client, expected);
    assert.equal(result.outcome, 'observed');
    assert.equal((result as Extract<Reconciliation, { outcome: 'observed' }>).receipt.execution_id, 'exec-1');
    // The same receipt classifies the same way as a direct 200 reply.
    assert.equal(classifyReceipt(delivered(expected), expected).outcome, 'observed');
    assert.deepEqual({ mutations: counts.mutations, reads: counts.reads }, { mutations: 1, reads: 1 }, 'one prompt, one receipt read');
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('C2: a wrong identity or hash, an accepted/dispatch_recorded, outcome_unknown, queued or recovered receipt is never success or permission to resend', { timeout: 30_000 }, async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const body = promptBody('c-mutant');
  const expected = promptExpected(body);
  const good = delivered(expected);
  const { worker_id: _w, ...noWorker } = good;
  const mutants: Record<string, [unknown, Reconciliation['outcome'], string]> = {
    'other command id': [{ ...good, command_id: 'c-other' }, 'unknown', 'receipt_mismatch'],
    'other operation': [{ ...good, operation: 'sessions.steer' }, 'unknown', 'receipt_mismatch'],
    'other worker': [{ ...good, worker_id: 'worker-2' }, 'unknown', 'receipt_mismatch'],
    'no worker': [noWorker, 'unknown', 'receipt_mismatch'],
    'other request hash': [{ ...good, request_hash: requestHash('sessions.prompt', { path: { worker_id: 'worker-1' }, body: { ...body, message: 'another' } }) }, 'unknown', 'receipt_mismatch'],
    'accepted, dispatch_recorded': [{ ...good, state: 'accepted', stage: 'dispatch_recorded', effect: 'unknown' }, 'unknown', 'receipt_not_settled'],
    'intent, reserved': [{ ...good, state: 'intent', stage: 'reserved', effect: 'unknown' }, 'unknown', 'receipt_not_settled'],
    'outcome_unknown': [{ ...good, state: 'outcome_unknown', stage: 'unknown', effect: 'unknown' }, 'unknown', 'outcome_unknown'],
    'intent_recovered, no_effect': [{ ...good, state: 'intent_recovered', stage: 'recovery_pending', effect: 'no_effect' }, 'unknown', 'receipt_not_settled'],
    'queued, no_effect': [{ ...good, state: 'queued', stage: 'reserved', effect: 'no_effect', admission: 'queued' }, 'unknown', 'receipt_not_settled'],
    'queue_ready, no_effect': [{ ...good, state: 'queue_ready', stage: 'reserved', effect: 'no_effect' }, 'unknown', 'receipt_not_settled'],
    'intent_ready, no_effect': [{ ...good, state: 'intent_ready', stage: 'recovery_pending', effect: 'no_effect' }, 'unknown', 'receipt_not_settled'],
    'delivered, effect unknown': [{ ...good, effect: 'unknown' }, 'unknown', 'receipt_not_settled'],
    'rejected, effect unknown': [{ ...good, state: 'rejected', stage: 'refused', effect: 'unknown' }, 'unknown', 'receipt_not_settled'],
    'off-schema receipt': [{ ...good, state: 'done' }, 'unknown', 'receipt_unreadable'],
    // The one other conclusive receipt: the worker journaled a refusal of this very command.
    'rejected, no_effect': [{ ...good, state: 'rejected', stage: 'refused', effect: 'no_effect', error: 'queued_input_refused' }, 'no_effect', ''],
    matching: [good, 'observed', ''],
  };
  let current: unknown = good;
  const { server, counts } = await lossyWorker(socket, () => [200, current]);
  try {
    const client = new Client({ socketPath: socket });
    for (const [name, [receipt, outcome, reason]] of Object.entries(mutants)) {
      current = receipt;
      const result = await reconcile(client, expected);
      assert.equal(result.outcome, outcome, name);
      if (outcome === 'unknown') assert.equal((result as Extract<Reconciliation, { outcome: 'unknown' }>).reason, reason, name);
      // A receipt is handed back only when it is this command's.
      if (reason === 'receipt_mismatch' || reason === 'receipt_unreadable') assert.equal('receipt' in result, false, `${name}: no foreign receipt exposed`);
      if (name !== 'off-schema receipt') assert.equal(classifyReceipt(receipt as Receipt, expected).outcome, outcome, `${name}: classifyReceipt agrees`);
    }
    assert.equal(counts.mutations, 0, 'reconciliation reads receipts only');
    assert.equal(counts.reads, Object.keys(mutants).length, 'one read per reconciliation');
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('C2: a missing, expired or scope-denied receipt stays unknown; the read refusal\'s own no_effect is never the command\'s', { timeout: 30_000 }, async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const expected = promptExpected(promptBody('c-unread'));
  const reads: Record<string, [[number, unknown], string]> = {
    missing: [[409, { error: 'unknown_command_id_is_not_proof_of_no_effect', effect: 'unknown' }], 'receipt_missing'],
    expired: [[409, { error: 'receipt_expired', effect: 'unknown', uncertain_command_id: 'c-unread' }], 'receipt_expired'],
    'scope denied (no_effect read)': [[409, { error: 'grant_scope_denied', effect: 'no_effect' }], 'receipt_scope_denied'],
    'method denied (no_effect read)': [[409, { error: 'grant_method_denied', effect: 'no_effect' }], 'receipt_unreadable'],
    'bad request (no_effect read)': [[400, { error: 'request_schema_mismatch', effect: 'no_effect' }], 'receipt_unreadable'],
    'not implemented (no_effect read)': [[501, { error: 'operation_not_implemented', effect: 'no_effect' }], 'receipt_unreadable'],
    'internal error': [[500, { error: 'internal_error', effect: 'unknown' }], 'receipt_unreadable'],
    'refusal not a B2 error': [[409, { effect: 'no_effect' }], 'receipt_unreadable'],
  };
  let current: [number, unknown] = [500, {}];
  const { server, counts } = await lossyWorker(socket, () => current);
  try {
    const client = new Client({ socketPath: socket });
    for (const [name, [reply, reason]] of Object.entries(reads)) {
      current = reply;
      const result = await reconcile(client, expected);
      assert.deepEqual(result, { outcome: 'unknown', reason }, name);
    }
    assert.equal(counts.mutations, 0, 'reconciliation reads receipts only');
    // A worker that is not there: the read fails, the command stays unknown.
    assert.deepEqual(await reconcile(new Client({ socketPath: join(t.dir, 'gone.sock') }), expected), { outcome: 'unknown', reason: 'receipt_unreadable' }, 'no worker');
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('C2: a worker restart between dispatch and result stays unknown, and the command is never sent again', { timeout: 30_000 }, async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const body = promptBody('c-restart');
  const expected = promptExpected(body);
  // The first worker dispatches and dies before answering: it stops listening and drops the connection.
  let dispatched = 0;
  const first = httpServer(req => {
    dispatched++;
    req.resume();
    req.on('end', () => {
      first.close();
      req.socket.destroy();
    });
  });
  await listen(first, socket);
  try {
    await assert.rejects(new Client({ socketPath: socket }).call('sessions.prompt', { path: { worker_id: 'worker-1' }, body }), isFailure('after_write', 'unknown'), 'the worker died mid-command');
  } finally {
    await close(first);
  }
  // While it is down the receipt is unreadable; after the restart, whatever recovery recorded stays unknown.
  assert.deepEqual(await reconcile(new Client({ socketPath: socket }), expected), { outcome: 'unknown', reason: 'receipt_unreadable' }, 'worker down');
  const recovered: Record<string, [[number, unknown], string]> = {
    'recovered as outcome_unknown': [[200, { ...delivered(expected), state: 'outcome_unknown', stage: 'unknown', effect: 'unknown' }], 'outcome_unknown'],
    'still accepted, dispatch_recorded': [[200, { ...delivered(expected), state: 'accepted', stage: 'dispatch_recorded', effect: 'unknown' }], 'receipt_not_settled'],
    'receipt lost with the restart': [[409, { error: 'unknown_command_id_is_not_proof_of_no_effect', effect: 'unknown' }], 'receipt_missing'],
  };
  let current: [number, unknown] = [500, {}];
  const { server, counts } = await lossyWorker(socket, () => current);
  try {
    const client = new Client({ socketPath: socket });
    for (const [name, [reply, reason]] of Object.entries(recovered)) {
      current = reply;
      const result = await reconcile(client, expected);
      assert.equal(result.outcome, 'unknown', name);
      assert.equal((result as Extract<Reconciliation, { outcome: 'unknown' }>).reason, reason, name);
    }
    assert.equal(dispatched + counts.mutations, 1, 'the prompt was sent once across the restart');
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('C2: create delivered plus first prompt rejected is an acquired worker, not prompted, never a failed acquisition', { timeout: 30_000 }, async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const replies: [number, unknown][] = [];
  const { server, counts } = await fakeWorker(socket, (_req, res) => {
    const reply = replies.shift();
    if (!reply) return void res.socket?.destroy();
    json(res, ...reply);
  });
  const createBody = (command_id: string, first_prompt?: string): RequestBody<'workers.create'> => ({
    command_id,
    cwd: '/home/u/project',
    provider: 'anthropic',
    model: 'claude',
    thinking: 'medium',
    ...(first_prompt === undefined ? {} : { first_prompt: { message: first_prompt } }),
  });
  const createExpected = (b: RequestBody<'workers.create'>): Expected => ({ command_id: b.command_id, operation: 'workers.create', request_hash: requestHash('workers.create', { body: b }) });
  /** The create's 200 reply as the fixture names it, with this request's identity. */
  const createReply = (name: string, b: RequestBody<'workers.create'>): [number, unknown] => [200, { ...fixtureBody('workers.create', name), command_id: b.command_id, request_hash: createExpected(b).request_hash }];
  try {
    const client = new Client({ socketPath: socket });
    const create = async (b: RequestBody<'workers.create'>) => {
      const before = counts.mutations;
      const settled = await client.call('workers.create', { body: b }).then(
        r => classifyReceipt(r, createExpected(b)),
        (e: unknown) => failure(e),
      );
      assert.equal(counts.mutations, before + 1, 'one create');
      return settled;
    };

    // First prompt in the create, refused at admission: the worker exists, idle, with its binding.
    const refusedBody = createBody('c-create-refused', '/compact');
    replies.push(createReply('first-prompt-refused', refusedBody));
    const refused = await create(refusedBody);
    assert.equal(refused instanceof ClientFailure ? 'failure' : refused.outcome, 'observed', 'the create itself was observed');
    assert.deepEqual(acquisition(refused), {
      worker: 'acquired',
      worker_id: 'worker-8',
      binding: { worker_id: 'worker-8', worker_epoch: 'epoch-8', session_id: 'session-8', binding_revision: 1 },
      prompt: 'not_prompted',
      prompt_error: 'slash_commands_use_typed_methods',
    });

    // First prompt in the create, admitted.
    const admittedBody = createBody('c-create-admitted', 'go');
    replies.push(createReply('first-prompt', admittedBody));
    const admitted = acquisition(await create(admittedBody));
    assert.deepEqual(
      { worker: admitted.worker, prompt: 'prompt' in admitted ? admitted.prompt : null, execution_id: 'execution_id' in admitted ? admitted.execution_id : null },
      { worker: 'acquired', prompt: 'prompted', execution_id: 'exec-7' },
    );

    // The first prompt as its own sessions.prompt: refused (HTTP no_effect), lost, or admitted.
    const plainBody = createBody('c-create-plain');
    replies.push(createReply('ok', plainBody));
    const plain = await create(plainBody);
    assert.deepEqual(acquisition(plain), { worker: 'acquired', worker_id: 'worker-1', prompt: 'not_prompted' }, 'no prompt sent yet');
    replies.push([409, { error: 'slash_commands_use_typed_methods', effect: 'no_effect' }]);
    const promptRefused = failure(await client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body: promptBody('c-first-1', '/compact') }).catch((e: unknown) => e));
    assert.deepEqual(acquisition(plain, promptRefused), { worker: 'acquired', worker_id: 'worker-1', prompt: 'not_prompted', prompt_error: 'slash_commands_use_typed_methods' });
    // replies is empty: the next prompt's reply is lost.
    const promptLost = failure(await client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body: promptBody('c-first-2') }).catch((e: unknown) => e));
    assert.equal(promptLost.effect, 'unknown');
    assert.deepEqual(acquisition(plain, promptLost), { worker: 'acquired', worker_id: 'worker-1', prompt: 'unknown' }, 'a lost prompt leaves the worker acquired, the prompt unknown');
    const okPrompt = promptBody('c-first-3');
    replies.push([200, delivered(promptExpected(okPrompt))]);
    const promptOk = classifyReceipt(await client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body: okPrompt }), promptExpected(okPrompt));
    assert.deepEqual(acquisition(plain, promptOk), { worker: 'acquired', worker_id: 'worker-1', prompt: 'unknown', execution_id: 'exec-1' }, 'a receipt without admission proves nothing about the input');
    replies.push([200, { ...delivered(promptExpected(okPrompt)), admission: 'accepted' }]);
    const promptAdmitted = classifyReceipt(await client.call('sessions.prompt', { path: { worker_id: 'worker-1' }, body: okPrompt }), promptExpected(okPrompt));
    assert.deepEqual(acquisition(plain, promptAdmitted), { worker: 'acquired', worker_id: 'worker-1', prompt: 'prompted', execution_id: 'exec-1' });
    // A prompt receipt for another worker is not this worker's input.
    assert.deepEqual(acquisition(plain, classifyReceipt(delivered(promptExpected(okPrompt, 'worker-2')), promptExpected(okPrompt, 'worker-2'))), { worker: 'acquired', worker_id: 'worker-1', prompt: 'unknown' });

    // A create refused with no_effect acquired nothing; a lost create is unknown, never a failure to retry.
    replies.push([409, { error: 'exclusive_environment_already_bound', effect: 'no_effect', holder_worker_id: 'worker-0' }]);
    assert.deepEqual(acquisition(await create(createBody('c-create-busy'))), { worker: 'not_acquired' });
    const lostBody = createBody('c-create-lost');
    const lost = await create(lostBody);
    assert.deepEqual(acquisition(lost), { worker: 'unknown' }, 'a lost create');
    replies.push([200, { ...createReply('first-prompt', lostBody)[1] as Receipt, state: 'outcome_unknown', stage: 'unknown', effect: 'unknown' }]);
    assert.deepEqual(acquisition(await reconcile(client, createExpected(lostBody))), { worker: 'unknown', worker_id: 'worker-7' }, 'an outcome_unknown create names its worker, still unknown');
    replies.push([409, { error: 'unknown_command_id_is_not_proof_of_no_effect', effect: 'unknown' }]);
    assert.deepEqual(acquisition(await reconcile(client, createExpected(lostBody))), { worker: 'unknown' }, 'a missing create receipt');
  } finally {
    await close(server);
    t.cleanup();
  }
});
