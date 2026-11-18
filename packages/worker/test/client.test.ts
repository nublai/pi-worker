/** @nublai/pi-worker-client against the real B2 server over its Unix socket. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { acquisition, classifyReceipt, Client, ClientFailure, Observer, reconcile, requestHash, type Expected, type Notice, type ObserverBatch, type TimerHandle } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { response_hello_200 } from '../src/generated/validators.js';
import { ownerGrant, privateTmp } from './helpers.js';
import { bind, fixture } from './supervisor-fixture.js';

test('client-ts: hello succeeds and a refused read is an HTTP 409 no_effect refusal', async () => {
  const tmp = privateTmp();
  const owner = ownerGrant(tmp.dir);
  const server = createB2Server(createApp({ grants: owner.grants }).handle);
  try {
    const socketPath = join(tmp.dir, 'b2.sock');
    await listenPrivate(server, socketPath);
    const client = new Client({ socketPath, grantFile: owner.file });
    const hello = await client.hello();
    assert.equal(response_hello_200(hello), true);
    // files.read is served from P2-4; this app has no supervisor state, so its handler refuses typed.
    await assert.rejects(
      client.call('files.read', { path: { worker_id: 'w1' }, body: { path: '/r/file', roots: ['/r'] } }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'http' && e.status === 409 && e.effect === 'no_effect' && e.message === 'supervisor_state_unavailable',
    );
    await assert.rejects(
      client.call('sessions.prompt', {
        path: { worker_id: 'w1' },
        // SAFETY: deliberately invalid body (missing message) to see the server's 400.
        body: { command_id: 'c1', worker_epoch: 'e1', session_id: 's1', binding_revision: 1 } as never,
      }),
      (e: unknown) => e instanceof ClientFailure && e.status === 400 && e.effect === 'no_effect' && e.message === 'request_schema_mismatch',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    tmp.cleanup();
  }
});

/**
 * C2 against the real supervisor (P3-2): the client's requestHash is the hash the worker records, so reconcile
 * resolves a real create and prompt; a lost prompt reply stays unknown, also after a supervisor restart, and is never
 * sent again.
 */
test('client-ts: requestHash matches the real worker\'s receipts; reconcile resolves create and prompt, and a lost prompt stays unknown across a restart', { timeout: 60_000 }, async () => {
  const f = fixture();
  const owner = ownerGrant(f.dir);
  const serve = async (name: string) => {
    const server = createB2Server(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle);
    const socketPath = join(f.dir, `${name}.sock`);
    await listenPrivate(server, socketPath);
    return { server, client: new Client({ socketPath, grantFile: owner.file }) };
  };
  const stop = async (server: ReturnType<typeof createB2Server>) => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  };
  let first: Awaited<ReturnType<typeof serve>> | undefined;
  let second: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    first = await serve('b2');
    const { client } = first;
    const created = [];
    for (const name of ['a', 'b']) {
      const cwd = join(f.dir, name);
      mkdirSync(cwd);
      const body = { command_id: `create-${name}`, cwd, provider: 'test', model: 'test', thinking: 'off' as const };
      const expected: Expected = { command_id: body.command_id, operation: 'workers.create', request_hash: requestHash('workers.create', { body }) };
      const reply = await client.call('workers.create', { body });
      assert.equal(classifyReceipt(reply, expected).outcome, 'observed', `create ${name}: the reply`);
      const read = await reconcile(client, expected);
      assert.equal(read.outcome, 'observed', `create ${name}: the receipt`);
      const acquired = acquisition(read);
      assert.equal(acquired.worker, 'acquired', `create ${name}: acquired`);
      created.push(await client.call('workers.get', { path: { worker_id: reply.worker_id! } }));
    }
    const [a, b] = created as [(typeof created)[0], (typeof created)[0]];
    const binding = (w: typeof a, command_id: string) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision });

    const promptA = { ...binding(a, 'prompt-a'), message: 'hello' };
    const expectedA: Expected = { command_id: 'prompt-a', operation: 'sessions.prompt', worker_id: a.worker_id, request_hash: requestHash('sessions.prompt', { path: { worker_id: a.worker_id }, body: promptA }) };
    const replyA = await client.call('sessions.prompt', { path: { worker_id: a.worker_id }, body: promptA });
    assert.equal(classifyReceipt(replyA, expectedA).outcome, 'observed', 'prompt: the reply');
    assert.equal((await reconcile(client, expectedA)).outcome, 'observed', 'prompt: the receipt');
    // Another message under the same command id is another request: its hash does not match the receipt.
    const other = requestHash('sessions.prompt', { path: { worker_id: a.worker_id }, body: { ...promptA, message: 'other' } });
    assert.deepEqual(await reconcile(client, { ...expectedA, request_hash: other }), { outcome: 'unknown', reason: 'receipt_mismatch' }, 'another request');
    assert.deepEqual(await reconcile(client, { ...expectedA, worker_id: b.worker_id }), { outcome: 'unknown', reason: 'receipt_mismatch' }, 'another worker');
    assert.deepEqual(await reconcile(client, { ...expectedA, command_id: 'never-sent' }), { outcome: 'unknown', reason: 'receipt_missing' }, 'never sent');

    // pi takes the prompt and its reply is lost: unknown, and the session is fenced on it.
    const hostB = f.hosts[1]!;
    hostB.failure = true;
    const promptB = { ...binding(b, 'prompt-b'), message: 'lost' };
    const expectedB: Expected = { command_id: 'prompt-b', operation: 'sessions.prompt', worker_id: b.worker_id, request_hash: requestHash('sessions.prompt', { path: { worker_id: b.worker_id }, body: promptB }) };
    const lost = await client.call('sessions.prompt', { path: { worker_id: b.worker_id }, body: promptB }).then(
      r => classifyReceipt(r, expectedB),
      (e: unknown) => (e instanceof ClientFailure ? { outcome: e.effect } : assert.fail('not a ClientFailure')),
    );
    assert.equal(lost.outcome, 'unknown', 'the lost prompt');
    const before = await reconcile(client, expectedB);
    assert.equal(before.outcome, 'unknown', 'reconciled before the restart');
    assert.equal('reason' in before && before.reason, 'outcome_unknown');
    assert.equal(hostB.prompts, 1);

    // The supervisor restarts (as after SIGKILL): the receipt is still unknown, and nothing was sent again.
    await stop(first.server);
    first = undefined;
    await f.restart();
    second = await serve('b2-after');
    const after = await reconcile(second.client, expectedB);
    assert.equal(after.outcome, 'unknown', 'reconciled after the restart');
    assert.equal('reason' in after && after.reason, 'outcome_unknown');
    assert.equal((await reconcile(second.client, expectedA)).outcome, 'observed', 'a settled receipt survives the restart');
    assert.equal(hostB.prompts, 1, 'the lost prompt was never sent again');
  } finally {
    if (first) await stop(first.server);
    if (second) await stop(second.server);
    f.cleanup();
  }
});

/**
 * C3 against the real supervisor (P3-3): the observer seeds silently, sees a settlement live, loses its SSE stream,
 * misses a settlement while gated, reconnects with Last-Event-ID and recovers that settlement once from the snapshot;
 * after a supervisor restart (a new transport epoch) the journaled settlements surface nothing twice.
 */
test('client-ts: the observer recovers a settlement missed across a real SSE disconnect once, and nothing twice across a supervisor restart', { timeout: 60_000 }, async () => {
  const f = fixture();
  const owner = ownerGrant(f.dir);
  const socketPath = join(f.dir, 'b2.sock');
  const serve = async () => {
    const server = createB2Server(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle);
    await listenPrivate(server, socketPath);
    return server;
  };
  const stop = async (server: ReturnType<typeof createB2Server>) => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  };
  const until = async (cond: () => boolean, label: string) => {
    const end = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > end) assert.fail(`timed out waiting: ${label}`);
      await new Promise(r => setTimeout(r, 5));
    }
  };
  // Reconnects wait for the test: each backoff timer is held until released.
  const held: (() => void)[] = [];
  const live = new Set<TimerHandle>();
  let token = 0;
  const timers = {
    set(callback: () => void, _ms: number): TimerHandle {
      const handle = ++token;
      live.add(handle);
      held.push(() => {
        live.delete(handle);
        callback();
      });
      return handle;
    },
    clear(handle: TimerHandle) {
      live.delete(handle);
    },
  };
  const ac = new AbortController();
  const batches: ObserverBatch[] = [];
  let server: ReturnType<typeof createB2Server> | undefined;
  let done: Promise<unknown> | undefined;
  try {
    const w = await f.create();
    server = await serve();
    const observer = new Observer({ client: new Client({ socketPath, grantFile: owner.file }), signal: ac.signal, timers, deliver: b => void batches.push(structuredClone(b)) });
    done = observer.run();
    await until(() => batches.length === 1, 'seed');
    assert.equal(batches[0]!.seeded, true, 'cold start seeds');
    assert.deepEqual(batches[0]!.notices, [], 'silently');
    const settlements = () => batches.flatMap(b => b.notices).filter((n): n is Extract<Notice, { kind: 'settlement' }> => n.kind === 'settlement');

    // Live: one prompt settles while the stream is up.
    const one = await f.supervisor.prompt(w.worker_id, { ...bind(f.supervisor.get(w.worker_id), 'p-one'), message: 'one' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await until(() => settlements().length === 1, 'live settlement');
    assert.equal(settlements()[0]!.execution_id, one.execution_id);
    assert.equal(settlements()[0]!.source, 'live');

    // The worker drops the SSE connection; controls close and the reconnect is held.
    server.closeAllConnections();
    await until(() => !observer.controls && held.length === 1, 'disconnect gates');
    const handle = { ...bind(f.supervisor.get(w.worker_id), 'x'), worker_id: w.worker_id };
    assert.equal(observer.isCurrent(handle), false, 'gated: no handle is current');
    // Missed while disconnected.
    const two = await f.supervisor.prompt(w.worker_id, { ...bind(f.supervisor.get(w.worker_id), 'p-two'), message: 'two' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    held.shift()!();
    await until(() => batches.some(b => b.resync !== undefined && !b.seeded), 'reconnect snapshot');
    const resync = batches.find(b => b.resync !== undefined && !b.seeded)!;
    assert.equal(resync.resync, 'gap', 'Last-Event-ID was sent: the worker reports a gap, not a fresh attach');
    assert.deepEqual(
      resync.notices.map(n => (n.kind === 'settlement' ? `${n.execution_id === two.execution_id ? 'two' : 'other'}:${n.source}` : n.kind)),
      ['two:snapshot'],
      'the missed settlement, once, from the snapshot',
    );
    assert.equal(observer.controls, true, 'controls reopen with the snapshot');
    assert.ok(observer.isCurrent(handle), 'the binding is unchanged');

    // The supervisor restarts: a new transport epoch; its journaled rows surface nothing already seen.
    await stop(server);
    server = undefined;
    await until(() => held.length === 1, 'restart gates');
    await f.restart();
    server = await serve();
    const before = batches.length;
    held.shift()!();
    await until(() => batches.length > before && batches.at(-1)!.resync !== undefined, 'snapshot after restart');
    assert.equal(batches.at(-1)!.resync, 'epoch', 'a supervisor restart is a new transport epoch');
    const ids = settlements().map(s => s.execution_id);
    assert.deepEqual(ids, [one.execution_id, two.execution_id], 'each settlement exactly once');
    assert.ok(
      batches.flatMap(b => b.notices).every(n => n.kind !== 'receipt' && n.kind !== 'settlement_gap'),
      'no gap: nothing reconciled, nothing invented',
    );
  } finally {
    ac.abort();
    if (done) await done;
    assert.equal(live.size, 0, 'abort clears the held reconnect');
    if (server) await stop(server);
    f.cleanup();
  }
});
