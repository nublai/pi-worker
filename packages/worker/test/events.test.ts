/**
 * Events (P1-8): the supervisor-wide stream, its attach barrier, bounded queues, overflow and per-frame validation.
 * The SSE cases of A0 `src/test/transport.test.ts` and `src/test/supervisor.test.ts` are ported here with their
 * assertions; A0's free-form event types (`chosen`, `burst`, `worker_changed`) become manifest types, since the hub
 * only publishes events the spec declares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client, ClientFailure, ResyncRequired } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { EventHub, FRAME_BYTES, QUEUE_BYTES, QUEUE_EVENTS, type Snapshot } from '../src/events/hub.js';
import { validateEventFrame, type EventFrame, type EventOf } from '../src/generated/events.js';
import type { Worker } from '../src/supervisor/state.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';
import { ownerGrant, sseRecords, type SseRecord } from './helpers.js';

type Frame = EventFrame;
const settled = (w: Worker, disposition: string) => ({ worker_id: w.worker_id, execution_id: 'x', data: { command_id: 'c', disposition } });

async function serve(f: Fixture): Promise<{ socket: string; grantFile: string; headers: Record<string, string>; close: () => Promise<void> }> {
  const owner = ownerGrant(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, piVersion: '1.5.2', grants: owner.grants }).handle);
  const socket = join(f.dir, 'b2.sock');
  await listenPrivate(server, socket);
  return {
    socket,
    grantFile: owner.file,
    headers: owner.headers,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test('events: one supervisor stream filters workers/types, snapshot barrier, bounded explicit overflow and resync', { timeout: 20_000 }, async () => {
  const f = fixture();
  try {
    const a = await f.create();
    const b = await f.create();
    const frames: Frame[] = [];
    const subscription = f.supervisor.subscribe(frame => void frames.push(frame), { workerIds: [a.worker_id], types: ['execution.settled'] });
    f.supervisor.events.publish('worker.updated', { worker_id: a.worker_id, execution_id: null, data: { worker: a } });
    f.supervisor.events.publish('execution.settled', settled(b, 'chosen'));
    f.supervisor.events.publish('execution.settled', settled(a, 'chosen'));
    subscription.close();
    assert.equal(frames.length, 2);
    const snapshot = frames[0]!;
    assert.equal(snapshot.type, 'snapshot');
    assert.equal((snapshot as Snapshot).workers.length, 1);
    assert.ok(frames[1]!.cursor.seq > snapshot.cursor.seq);
    const bounded = new EventHub('epoch', 2, 4096, () => {});
    const overflow: Frame[] = [];
    let closed = 0;
    bounded.subscribe(
      () => [a, b],
      frame => {
        overflow.push(frame);
        return false;
      },
      { onEnd: () => closed++ },
    );
    for (let i = 0; i < 100; i++) bounded.publish('execution.settled', settled(a, 'burst'));
    assert.equal(closed, 1);
    assert.deepEqual(
      overflow.map(x => x.type),
      ['snapshot', 'overflow'],
    );
    assert.equal((overflow[1] as EventOf<'overflow'>).data.resync_required, true);
    bounded
      .subscribe(
        () => [a, b],
        frame => {
          assert.equal((frame as Snapshot).resync_reason, 'overflow');
        },
        { since: overflow[1]!.cursor, overflowResync: true },
      )
      .close();
  } finally {
    f.cleanup();
  }
});

test('events: SSE attach barrier: snapshot is first, no duplicate or missing event under reentrant emission', { timeout: 20_000 }, async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const hub = new EventHub(w.worker_epoch, 2, QUEUE_BYTES, () => {});
    hub.publish('execution.settled', settled(w, 'before'));
    const frames: Frame[] = [];
    const sub = hub.subscribe(
      () => [w],
      frame => {
        frames.push(frame);
        if (frame.type === 'snapshot') hub.publish('execution.settled', settled(w, 'during'));
      },
    );
    hub.publish('execution.settled', settled(w, 'after'));
    sub.close();
    hub.publish('execution.settled', settled(w, 'detached'));
    assert.deepEqual(
      frames.map(x => (x.type === 'snapshot' ? 'snapshot' : (x as EventOf<'execution.settled'>).data.disposition)),
      ['snapshot', 'during', 'after'],
    );
    assert.deepEqual(
      frames.map(x => x.cursor.seq),
      [1, 2, 3],
    );
    const snapshot = frames[0] as Snapshot;
    assert.equal(snapshot.workers[0]!.history.evidence, 'pi_session_file');
    assert.equal(snapshot.workers[0]!.session_id, w.session_id);
    const reattached: Frame[] = [];
    hub.subscribe(() => [w], frame => void reattached.push(frame), { since: snapshot.cursor }).close();
    assert.equal((reattached[0] as Snapshot).resync_reason, 'gap');
    assert.equal(reattached.length, 1);
    hub.subscribe(() => [w], frame => assert.equal((frame as Snapshot).resync_reason, 'epoch'), { since: { transport_epoch: 'old', seq: 1 } }).close();
    hub.subscribe(() => [w], frame => assert.equal((frame as Snapshot).resync_reason, 'current'), { since: { transport_epoch: w.worker_epoch, seq: 4 } }).close();
    hub.subscribe(() => [w], frame => assert.equal((frame as Snapshot).resync_reason, 'ahead'), { since: { transport_epoch: w.worker_epoch, seq: 99 } }).close();
  } finally {
    f.cleanup();
  }
});

test('events: supervisor projects admission, settlement, fence and stop to an already connected watcher', { timeout: 20_000 }, async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const id = w.worker_id;
    const frames: Frame[] = [];
    const sub = f.supervisor.subscribe(frame => void frames.push(frame), { workerIds: [id] });
    await f.supervisor.prompt(id, { ...bind(w, 'turn'), message: 'hello' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await f.supervisor.prompt(id, { ...bind(w, 'crash'), message: 'crash' });
    f.hosts[0]!.emit('exit');
    await f.supervisor.stop(id, bind(w, 'stop'));
    sub.close();
    const changes = frames.filter((x): x is EventOf<'worker.updated'> => x.type === 'worker.updated');
    const workers = changes.map(x => x.data.worker);
    assert.ok(workers.some(x => x.execution?.state === 'admitted'));
    assert.ok(workers.some(x => x.execution?.state === 'settled'));
    assert.ok(workers.some(x => x.fence?.command_id === 'crash'));
    assert.ok(workers.some(x => x.status === 'stopped'));
    assert.ok(changes.every(x => x.producer === 'supervisor'));
    const durable = changes.filter(x => x.evidence === 'supervisor_journal_fsynced').map(x => x.data.worker);
    assert.ok(durable.some(x => x.execution?.state === 'admitted'));
    assert.ok(durable.some(x => x.execution?.state === 'settled'));
    assert.ok(durable.some(x => x.fence?.command_id === 'crash'));
    assert.ok(durable.some(x => x.status === 'stopped'));
    assert.ok(frames.some(x => x.type === 'execution.settled' && x.execution_id === workers.find(y => y.execution?.command_id === 'turn')?.execution?.execution_id));
  } finally {
    f.cleanup();
  }
});

test('events: transport epoch changes across supervisor restart even when new seq catches the old cursor', { timeout: 20_000 }, async () => {
  const f = fixture();
  try {
    const w = await f.create();
    let old!: Snapshot;
    f.supervisor.subscribe(frame => void (old = frame as Snapshot), { workerIds: [w.worker_id] }).close();
    const next = await f.restart();
    for (let i = 0; i <= old.cursor.seq; i++) next.events.publish('execution.settled', settled(w, 'padding'));
    next
      .subscribe(
        frame => {
          const fresh = frame as Snapshot;
          assert.equal(fresh.resync_reason, 'epoch');
          assert.notEqual(fresh.cursor.transport_epoch, old.cursor.transport_epoch);
          assert.equal(fresh.workers[0]!.worker_epoch, old.workers[0]!.worker_epoch);
        },
        { since: old.cursor, workerIds: [w.worker_id] },
      )
      .close();
  } finally {
    f.cleanup();
  }
});

test('events: public client retains no_effect HTTP detail and the supervisor-wide snapshot; overflow disables controls', { timeout: 20_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const w = await f.create();
    const client = new Client({ socketPath: s.socket, grantFile: s.grantFile });
    await assert.rejects(
      client.call('sessions.prompt', { path: { worker_id: w.worker_id }, body: { ...bind(w, 'stale'), binding_revision: 50, message: 'no' } }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'http' && e.effect === 'no_effect' && e.details.received_binding_revision === 50,
    );
    await client.watch(frame => {
      assert.equal(frame.type, 'snapshot');
      assert.equal((frame as Snapshot).workers.length, 1);
      return false;
    });
    assert.equal(client.resyncRequired, false);
    // Synchronous events exceed the bounded subscriber queue while the transport is backpressured.
    const row = f.supervisor.get(w.worker_id);
    const overflowed = client.watch(
      frame => {
        if (frame.type === 'snapshot') for (let i = 0; i < 300; i++) f.supervisor.events.publish('worker.updated', { worker_id: w.worker_id, execution_id: null, data: { worker: { ...row, resources: { pad: 'x'.repeat(15000) } } } });
        return true;
      },
      { workerIds: [w.worker_id] },
    );
    overflowed.catch(() => {});
    // Bounded wait: without the queue bound the stream never overflows, and this fails by assertion, not a hang.
    const deadline = new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('no overflow within 5 s')), 5000).unref());
    await assert.rejects(Promise.race([overflowed, deadline]), (e: unknown) => e instanceof ResyncRequired && e.reason === 'overflow');
    assert.equal(client.resyncRequired, true);
    await client.watch(
      frame => {
        assert.equal(frame.type, 'snapshot');
        assert.equal((frame as Snapshot).resync_reason, 'overflow');
        return false;
      },
      { workerIds: [w.worker_id], overflowResync: true },
    );
    assert.equal(client.resyncRequired, false);
    assert.equal(f.supervisor.get(w.worker_id).status, 'ready');
    // The peer's close reaches the server asynchronously; the overflowed subscription was dropped at once.
    for (let i = 0; i < 200 && f.supervisor.events.size > 0; i++) await tick();
    assert.equal(f.supervisor.events.size, 0, 'the overflowed and finished subscriptions are gone');
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('events: an invalid frame is never sent; its subscribers get overflow, the stream closes and invalid_frame is logged', { timeout: 20_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  const logged: Record<string, unknown>[] = [];
  const hubLog = f.supervisor.events.log;
  // SAFETY: the test swaps the hub's log sink to observe it; the hub calls log only with a record.
  (f.supervisor.events as { log: typeof hubLog }).log = record => void logged.push(record);
  try {
    const a = await f.create();
    const b = await f.create();
    const bad = { ...f.supervisor.get(a.worker_id), status: 'not-a-status' } as unknown as Worker;
    // In process first: the invalid frame's subscriber gets overflow at once, never the frame.
    const direct: Frame[] = [];
    f.supervisor.subscribe(frame => void direct.push(frame), { workerIds: [a.worker_id] });
    f.supervisor.events.publish('worker.updated', { worker_id: a.worker_id, execution_id: null, data: { worker: bad } });
    assert.deepEqual(
      direct.map(x => x.type),
      ['snapshot', 'overflow'],
    );
    assert.equal(f.supervisor.events.size, 0);
    const onB: SseRecord[] = [];
    const watchB = sseRecords(
      s.socket,
      `/b2/events?worker_id=${b.worker_id}`,
      r => {
        onB.push(r);
        return onB.length < 2;
      },
      s.headers,
    );
    const seen = await sseRecords(
      s.socket,
      `/b2/events?worker_id=${a.worker_id}`,
      record => {
        if (record.event === 'snapshot') f.supervisor.events.publish('worker.updated', { worker_id: a.worker_id, execution_id: null, data: { worker: bad } });
        return true;
      },
      s.headers,
    );
    assert.equal(seen.status, 200);
    assert.equal(seen.contentType, 'text/event-stream');
    assert.deepEqual(
      seen.records.map(r => r.event),
      ['snapshot', 'overflow'],
    );
    assert.equal(seen.ended, true, 'the worker ended the stream');
    assert.equal((JSON.parse(seen.records[1]!.data) as EventOf<'overflow'>).data.reason, 'invalid_frame');
    assert.equal(seen.records.some(r => r.data.includes('not-a-status')), false, 'the invalid frame never crossed the socket');
    assert.ok(logged.some(r => r.event === 'invalid_frame' && r.type === 'worker.updated'));
    // A subscriber that does not see that worker is untouched.
    f.supervisor.events.publish('execution.settled', settled(b, 'still-open'));
    const other = await watchB;
    assert.deepEqual(
      other.records.map(r => r.event),
      ['snapshot', 'execution.settled'],
    );
    // An invalid snapshot is never sent either: the attach gets overflow only.
    const hub = new EventHub('epoch', QUEUE_EVENTS, QUEUE_BYTES, record => void logged.push(record));
    const frames: Frame[] = [];
    hub.subscribe(() => [bad], frame => void frames.push(frame));
    assert.deepEqual(
      frames.map(x => x.type),
      ['overflow'],
    );
    // A frame whose record exceeds the spec's frame cap is treated the same way.
    const big: Frame[] = [];
    hub.subscribe(() => [a], frame => void big.push(frame));
    hub.publish('worker.updated', { worker_id: a.worker_id, execution_id: null, data: { worker: { ...a, resources: { pad: 'x'.repeat(FRAME_BYTES) } } } });
    assert.deepEqual(
      big.map(x => x.type),
      ['snapshot', 'overflow'],
    );
  } finally {
    (f.supervisor.events as { log: typeof hubLog }).log = hubLog;
    await s.close();
    f.cleanup();
  }
});

test('events: every frame a scenario produces validates against its schema, and records carry the cursor id and type', { timeout: 20_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const w = await f.create();
    const id = w.worker_id;
    const records: SseRecord[] = [];
    let attached!: () => void;
    const snapshot = new Promise<void>(r => (attached = r));
    const watching = sseRecords(
      s.socket,
      '/b2/events',
      record => {
        records.push(record);
        if (record.event === 'snapshot') attached();
        return !(record.event === 'worker.updated' && record.data.includes('"status":"stopped"'));
      },
      s.headers,
    );
    await snapshot;
    await f.supervisor.prompt(id, { ...bind(w, 'turn'), message: 'hello' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    f.hosts[0]!.failure = true;
    await f.supervisor.prompt(id, { ...bind(w, 'lost'), message: 'lost' });
    f.hosts[0]!.failure = false;
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const fenced = f.supervisor.get(id);
    await f.supervisor.resolveUnknown(id, { ...bind(fenced, 'resolve'), uncertain_command_id: 'lost', fence_generation: fenced.fence!.fence_generation, disposition: 'abandon' });
    await f.supervisor.newSession(id, bind(f.supervisor.get(id), 'new'));
    await f.supervisor.stop(id, bind(f.supervisor.get(id), 'stop'));
    const result = await watching;
    assert.equal(result.status, 200);
    const types = new Set(records.map(r => r.event));
    for (const type of ['snapshot', 'worker.updated', 'execution.settled', 'fence.resolved', 'session.rebound']) assert.ok(types.has(type), `${type} was published`);
    for (const record of records) {
      const frame = JSON.parse(record.data) as Frame;
      assert.equal(validateEventFrame(frame), true, `${record.event}: ${JSON.stringify(validateEventFrame.errors)}`);
      assert.equal(record.event, frame.type);
      assert.deepEqual(JSON.parse(record.id!), frame.cursor);
      assert.ok(record.bytes <= FRAME_BYTES);
    }
    const seqs = records.map(r => (JSON.parse(r.data) as Frame).cursor.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'cursors only move forward');
    const rebound = records.map(r => JSON.parse(r.data) as Frame).find((x): x is EventOf<'session.rebound'> => x.type === 'session.rebound')!;
    assert.equal(rebound.evidence, 'supervisor_journal_fsynced');
    assert.equal(rebound.data.action, 'new');
    assert.equal(rebound.data.binding_revision, 2);
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('events: the stream refuses an unknown event type or a malformed Last-Event-ID before it opens, no_effect', { timeout: 20_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    await f.create();
    const unknown = await sseRecords(s.socket, '/b2/events?types=chosen', undefined, s.headers);
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.body, { error: 'unknown_event_type', effect: 'no_effect' });
    const cursor = await sseRecords(s.socket, '/b2/events', undefined, { ...s.headers, 'Last-Event-ID': '{"transport_epoch":1}' });
    assert.equal(cursor.status, 400);
    assert.deepEqual(cursor.body, { error: 'invalid_last_event_id', effect: 'no_effect' });
    const resumed = await sseRecords(s.socket, '/b2/events', () => false, { ...s.headers, 'Last-Event-ID': JSON.stringify({ transport_epoch: 'older-start', seq: 4 }) });
    assert.equal((JSON.parse(resumed.records[0]!.data) as Snapshot).resync_reason, 'epoch');
  } finally {
    await s.close();
    f.cleanup();
  }
});
