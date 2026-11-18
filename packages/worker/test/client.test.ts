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

/**
 * C3 against the real supervisor (PR #38 astra finding 1): an input an extension handles without a run is listed in
 * `recent_settlements` but not counted by `settle_count`, so a full list can push an entry out unseen. Restored from
 * persisted state (nine handled inputs) and across a live SSE disconnect (nine mixed inputs), the observer surfaces a
 * possible gap and reconciles exactly the pending command pushed out, by its real receipt; it never invents one.
 */
test('client-ts: the observer reconciles a settlement a handled input pushed out of the list, restored and live, all-handled and mixed', { timeout: 60_000 }, async () => {
  const f = fixture();
  const owner = ownerGrant(f.dir);
  const socketPath = join(f.dir, 'b2.sock');
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
  const controllers: AbortController[] = [];
  const runs: Promise<unknown>[] = [];
  let server: ReturnType<typeof createB2Server> | undefined;
  try {
    const w = await f.create();
    server = createB2Server(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle);
    await listenPrivate(server, socketPath);
    const client = new Client({ socketPath, grantFile: owner.file });
    // The host answers a prompt as an input hook that handled it (no run), or starts a run the test settles.
    const host = f.hosts[0]!;
    const native = host.request.bind(host);
    let handled = true;
    host.request = async c => (c.type === 'prompt' && handled ? (host.prompts++, { type: 'response', id: 'x', success: true, data: { disposition: 'handled' } }) : native(c));

    // The consumer: what it sent, what is resolved (by a settlement or receipt notice), and its persisted state.
    const sent: Expected[] = [];
    const resolved = new Set<string>();
    const batches: ObserverBatch[] = [];
    let persisted: ObserverBatch['state'] | undefined;
    const deliver = (b: ObserverBatch) => {
      batches.push(structuredClone(b));
      persisted = structuredClone(b.state);
      for (const n of b.notices) {
        if (n.kind === 'settlement') resolved.add(n.command_id);
        if (n.kind === 'receipt') resolved.add(n.expected.command_id);
      }
    };
    const pending = () => sent.filter(e => !resolved.has(e.command_id));
    const observe = (restored?: ObserverBatch['state']) => {
      const ac = new AbortController();
      controllers.push(ac);
      const observer = new Observer({ client, signal: ac.signal, timers, deliver, pending, ...(restored ? { restored } : {}) });
      runs.push(observer.run());
      return { observer, ac };
    };
    const prompt = async (command_id: string, run: boolean) => {
      handled = !run;
      const body = { ...bind(f.supervisor.get(w.worker_id), command_id), message: 'm' };
      sent.push({ command_id, operation: 'sessions.prompt', worker_id: w.worker_id, request_hash: requestHash('sessions.prompt', { path: { worker_id: w.worker_id }, body }) });
      const reply = await client.call('sessions.prompt', { path: { worker_id: w.worker_id }, body });
      assert.equal(reply.state, 'delivered', 'each prompt is delivered');
      if (run) host.emit('event', { type: 'agent_settled' });
    };
    const gaps = (b: ObserverBatch) => b.notices.flatMap(n => (n.kind === 'settlement_gap' ? [`${n.cause}:${n.missed}:${n.listed}`] : []));
    const receipts = (b: ObserverBatch) => b.notices.flatMap(n => (n.kind === 'receipt' ? [`${n.expected.command_id}:${n.reconciliation.outcome}`] : []));
    const settled = (b: ObserverBatch) => b.notices.flatMap(n => (n.kind === 'settlement' ? [n.command_id] : [])).sort();
    const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => `${prefix}-${from + k}`).sort();

    // A cold start seeds; the consumer persists the state and the process exits.
    const seed = observe();
    await until(() => batches.length === 1, 'seed');
    assert.equal(batches[0]!.seeded, true, 'cold start seeds');
    seed.ac.abort();
    await runs[0];

    // Nine inputs handled while no observer runs: the producer lists eight and counts none.
    for (let n = 1; n <= 9; n++) await prompt(`handled-${n}`, false);
    const row = f.supervisor.get(w.worker_id);
    assert.equal(row.settle_count ?? 0, 0, 'handled inputs are not counted');
    assert.equal(row.recent_settlements?.length, 8, 'the list is full');
    assert.ok(!row.recent_settlements!.some(s => s.command_id === 'handled-1'), 'the first handled input was pushed out');

    // The restarted process restores its state: a possible gap, and the pushed-out command's receipt is read.
    const restored = observe(persisted!);
    await until(() => batches.length === 2, 'restored snapshot');
    assert.equal(batches[1]!.seeded, undefined, 'restored: a diff, never a seed');
    assert.deepEqual(settled(batches[1]!), ids('handled', 2, 9), 'all-handled: only the listed settlements');
    assert.deepEqual(gaps(batches[1]!), ['retention:0:8'], 'all-handled: a possible gap though settle_count did not move');
    assert.deepEqual(receipts(batches[1]!), ['handled-1:observed'], 'all-handled: the pushed-out command reconciles by its receipt');

    // Live: the SSE stream drops; nine mixed inputs (three run) while the reconnect is held.
    server.closeAllConnections();
    await until(() => !restored.observer.controls && held.length === 1, 'disconnect gates');
    for (let n = 1; n <= 9; n++) await prompt(`mixed-${n}`, n % 3 === 1);
    const mixed = f.supervisor.get(w.worker_id);
    assert.equal(mixed.settle_count, 3, 'three runs counted');
    assert.ok(!mixed.recent_settlements!.some(s => s.command_id === 'mixed-1'), 'the first mixed input was pushed out');
    held.shift()!();
    await until(() => batches.length === 3 && restored.observer.controls, 'reconnect snapshot');
    assert.deepEqual(settled(batches[2]!), ids('mixed', 2, 9), 'mixed: only the listed settlements');
    assert.deepEqual(gaps(batches[2]!), ['retention:3:8'], 'mixed: a possible gap though settle_count grew less than the list');
    assert.deepEqual(receipts(batches[2]!), ['mixed-1:observed'], 'mixed: the pushed-out command reconciles by its receipt');
    assert.deepEqual(pending(), [], 'every sent command is resolved');
    assert.equal(host.prompts, 18, 'each prompt reached pi once; nothing was resent');
  } finally {
    for (const ac of controllers) ac.abort();
    await Promise.all(runs);
    assert.equal(live.size, 0, 'abort clears the held reconnect');
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(r => server!.close(() => r()));
    }
    f.cleanup();
  }
});
