/** @nublai/pi-worker-client against the real B2 server over its Unix socket. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { acquisition, classifyReceipt, Client, ClientFailure, reconcile, requestHash, type Expected } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { response_hello_200 } from '../src/generated/validators.js';
import { ownerGrant, privateTmp } from './helpers.js';
import { fixture } from './supervisor-fixture.js';

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
