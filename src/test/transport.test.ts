import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { Client, ClientFailure, ResyncRequired } from '../client.js';
import { EventHub, type Frame } from '../events.js';
import { router, listenPrivate } from '../server.js';
import { fixture, bind } from './helpers.js';

test('one supervisor stream filters workers/types, snapshot barrier, bounded explicit overflow and resync', async () => {
  const f = fixture(); try {
    const a = await f.create(), b = await f.create(), frames: Frame[] = [];
    const subscription = f.supervisor.events.subscribe(() => f.supervisor.list(), null, frame => { frames.push(frame); }, { workerIds: [a.worker_id], types: ['chosen'] });
    f.supervisor.require(a.worker_id).hub.publish('other', {}); f.supervisor.require(b.worker_id).hub.publish('chosen', {}); f.supervisor.require(a.worker_id).hub.publish('chosen', {});
    subscription.close();
    assert.equal(frames.length, 2); const snapshot = frames[0]!;
    assert.equal(snapshot.type, 'snapshot'); assert.equal((snapshot as import('../types.js').Snapshot).workers.length, 1);
    assert.ok(frames[1]!.cursor.seq > snapshot.cursor.seq);
    const bounded = new EventHub('epoch', 2, 4096), overflow: Frame[] = []; let closed = 0;
    bounded.subscribe(() => [a, b], null, frame => { overflow.push(frame); return false; }, { onOverflow: () => closed++ });
    for (let i = 0; i < 100; i++) bounded.publish('burst', {});
    assert.equal(closed, 1); assert.deepEqual(overflow.map(x => x.type), ['snapshot', 'overflow']);
    assert.equal((overflow[1] as import('../types.js').WorkerEvent).data.resync_required, true);
    bounded.subscribe(() => [a, b], overflow[1]!.cursor, frame => { assert.equal((frame as import('../types.js').Snapshot).resync_reason, 'overflow'); }, { overflowResync: true }).close();
  } finally { f.cleanup(); }
});
test('client failure before connect is no_effect; after write is unknown, one attempt and keepalive disabled', async () => {
  const f = fixture(); try {
    const w = await f.create(), socket = join(f.dir, 'disconnect.sock');
    const body = { ...bind(w, 'request'), message: 'do not replay' };
    await assert.rejects(new Client(socket).call('sessions.prompt', { id: w.worker_id, body }), (e: unknown) => e instanceof ClientFailure && e.phase === 'before_write' && e.effect === 'no_effect');
    let attempts = 0; let data = '';
    const server = netServer(connection => { attempts++; connection.once('data', bytes => { data += bytes.toString().replace(/^Authorization:.*$/mi, 'Authorization: [redacted]'); connection.destroy(); }); });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try { await assert.rejects(new Client(socket).call('sessions.prompt', { id: w.worker_id, body }), (e: unknown) => e instanceof ClientFailure && e.phase === 'after_write' && e.effect === 'unknown'); }
    finally { await new Promise<void>(r => server.close(() => r())); }
    assert.equal(attempts, 1); assert.match(data, /Connection: close/i); assert.match(data, /do not replay/);
  } finally { f.cleanup(); }
});
test('public client retains no_effect HTTP detail and supervisor-wide snapshot; overflow disables controls', async () => {
  const f = fixture(), server = router(f.supervisor); try {
    const w = await f.create(); const socket = join(f.dir, 'socket'); await listenPrivate(server, socket);
    const client = new Client(socket);
    await assert.rejects(client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, 'stale'), binding_revision: 50, message: 'no' } }), (e: unknown) => e instanceof ClientFailure && e.phase === 'http' && e.effect === 'no_effect' && e.details.received_binding_revision === 50);
    await client.watch(null, frame => { assert.equal(frame.type, 'snapshot'); assert.equal((frame as import('../types.js').Snapshot).workers.length, 1); return false; });
    assert.equal(client.resyncRequired, false);
    // Synchronous events exceed the bounded subscriber queue while the transport is backpressured.
    await assert.rejects(client.watch(w.worker_id, frame => {
      if (frame.type === 'snapshot') for (let i = 0; i < 300; i++) f.supervisor.require(w.worker_id).hub.publish('burst', { text: 'x'.repeat(15000) });
      return true;
    }), (e: unknown) => e instanceof ResyncRequired && e.reason === 'overflow');
    assert.equal(client.resyncRequired, true);
    await client.watch(w.worker_id, frame => { assert.equal(frame.type, 'snapshot'); assert.equal((frame as import('../types.js').Snapshot).resync_reason, 'overflow'); return false; }, undefined, { overflowResync: true });
    assert.equal(client.resyncRequired, false); assert.equal(f.supervisor.get(w.worker_id).status, 'ready');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
});
