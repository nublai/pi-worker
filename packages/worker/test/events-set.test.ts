/**
 * The event set Shep's worker driver needs (P1-19, docs/plan/b2-for-shep.md section 3): the execution lifecycle,
 * pi's activity (assistant text and tools, memory only and bounded), receipts, fences and attachments, each with its
 * stated durability; and `recent_settlements`, the journaled settlements in every worker row, so a settlement a
 * disconnected subscriber missed is recoverable from the next snapshot, also after a supervisor restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { type Snapshot } from '../src/events/hub.js';
import { validateEventFrame, type EventFrame, type EventOf } from '../src/generated/events.js';
import type { Worker } from '../src/supervisor/state.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';
import { ownerGrant, sseRecords } from './helpers.js';
import { jpegBytes, sha256 } from './images.js';
import { fakeProvider, providerExtension, realPiSupervisor, sse, until } from './real-pi.js';

type Frame = EventFrame;

// The spec's bounds, stated here rather than imported from the worker so that this file also loads on the revision
// before P1-19 and fails there by assertion (PR #20 GPT 6): AssistantDeltaEvent `tail` maxLength (activity.ts
// TAIL_CHARS) and Worker `recent_settlements` maxItems (input.ts RECENT_SETTLEMENTS).
const TAIL_CHARS = 2048;
const RECENT_SETTLEMENTS = 8;

/** Every frame the supervisor publishes for `worker`, after its snapshot, validated against its schema. */
function watch(f: Fixture, worker: Worker): { frames: Frame[]; of: <T extends Frame['type']>(type: T) => EventOf<T>[]; close: () => void } {
  const frames: Frame[] = [];
  const sub = f.supervisor.subscribe(
    frame => {
      assert.equal(validateEventFrame(frame), true, `${frame.type}: ${JSON.stringify(validateEventFrame.errors)}`);
      frames.push(frame);
    },
    { workerIds: [worker.worker_id] },
  );
  // SAFETY: a frame whose `type` is T is EventOf<T> (the union is discriminated by `type`).
  const of = <T extends Frame['type']>(type: T) => frames.filter(x => x.type === type) as EventOf<T>[];
  return { frames, of, close: () => sub.close() };
}

/** pi's text delta as the SDK child forwards it: the partial assistant message and the delta event. */
const textDelta = (text: string) => ({
  type: 'message_update',
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text }] },
  assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text.slice(-1) },
});

async function* bytes(b: Buffer): AsyncIterable<Uint8Array> {
  yield b;
}

test('events: execution.admitted and execution.started are journaled with the command; execution.settled names it too', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const events = watch(f, w);
    const receipt = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'turn'), message: 'hello' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    events.close();
    const [admitted] = events.of('execution.admitted');
    const [started] = events.of('execution.started');
    const [settled] = events.of('execution.settled');
    assert.ok(admitted && started && settled, `types: ${events.frames.map(x => x.type)}`);
    for (const e of [admitted, started]) {
      assert.equal(e.execution_id, receipt.execution_id);
      assert.equal(e.data.command_id, 'turn');
      assert.equal(e.evidence, 'supervisor_journal_fsynced');
      assert.equal(e.producer, 'supervisor');
    }
    assert.deepEqual([settled.execution_id, settled.data.command_id], [receipt.execution_id, 'turn']);
    assert.ok(admitted.cursor.seq < started.cursor.seq && started.cursor.seq < settled.cursor.seq, 'admitted, started, settled in order');
    // The admitted row is durable before the frame that announces it.
    const rows = f.state.journal.records.filter(r => r.kind === 'worker').map(r => (r.value as { worker: Worker }).worker);
    assert.ok(rows.some(x => x.execution?.execution_id === receipt.execution_id && x.execution?.state === 'admitted'));
  } finally {
    f.cleanup();
  }
});

test('events: assistant.delta carries pi text tail (at most 2048 characters) and its length, producer pi, memory only', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const events = watch(f, w);
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'turn'), message: 'hello' });
    const host = f.hosts[0]!;
    host.emit('event', textDelta('Hel'));
    // Thinking and tool-call deltas are not assistant text.
    host.emit('event', { type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'thinking_delta', delta: 'x' } });
    // The last TAIL_CHARS code units start inside the emoji's surrogate pair.
    const long = `${'a'.repeat(5000)}😀${'b'.repeat(TAIL_CHARS - 1)}`;
    host.emit('event', textDelta(long));
    events.close();
    const deltas = events.of('assistant.delta');
    assert.equal(deltas.length, 2);
    assert.deepEqual(deltas[0]!.data, { tail: 'Hel', length: 3 });
    assert.equal(deltas[0]!.producer, 'pi');
    assert.equal(deltas[0]!.evidence, 'observed_memory');
    assert.equal(deltas[0]!.execution_id, f.supervisor.get(w.worker_id).execution!.execution_id);
    assert.equal(deltas[1]!.data.length, long.length);
    assert.equal(deltas[1]!.data.tail.length, TAIL_CHARS - 1, 'the tail is bounded');
    assert.ok(long.endsWith(deltas[1]!.data.tail), 'the tail is the end of the text');
    assert.ok(deltas[1]!.data.tail.startsWith('b'), 'never half a surrogate pair');
  } finally {
    f.cleanup();
  }
});

test('events: a delta storm to a backpressured subscriber keeps one delta per worker, never overflows, and the latest tail wins', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'turn'), message: 'hello' });
    const frames: Frame[] = [];
    let open = false;
    const ended: string[] = [];
    const sub = f.supervisor.subscribe(
      frame => {
        frames.push(frame);
        // Backpressured from the snapshot on, until the test opens the transport.
        return open;
      },
      { workerIds: [w.worker_id], onEnd: reason => ended.push(reason) },
    );
    // The snapshot left the transport backpressured: everything after it queues.
    assert.deepEqual(
      frames.map(x => x.type),
      ['snapshot'],
    );
    const host = f.hosts[0]!;
    let text = '';
    for (let i = 0; i < 1000; i++) host.emit('event', textDelta((text += `${i} `)));
    host.emit('event', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
    host.emit('event', textDelta((text += 'end')));
    assert.deepEqual(ended, [], 'no overflow');
    open = true;
    sub.drain();
    sub.close();
    assert.deepEqual(
      frames.map(x => x.type),
      ['snapshot', 'tool.started', 'assistant.delta'],
    );
    const delta = frames[2] as EventOf<'assistant.delta'>;
    assert.equal(delta.data.length, text.length);
    assert.ok(text.endsWith(delta.data.tail));
    const seqs = frames.map(x => x.cursor.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'cursors only move forward');
  } finally {
    f.cleanup();
  }
});

test('events: tool.started and tool.finished carry the call id, name and a one-line summary; the finish repeats the summary', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const events = watch(f, w);
    const host = f.hosts[0]!;
    const long = `call-${'x'.repeat(600)}`;
    host.emit('event', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: '  ls  -la\n /tmp ', timeout: 5 } });
    host.emit('event', { type: 'tool_execution_start', toolCallId: long, toolName: 'mystery', args: { n: 1 } });
    host.emit('event', { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [] }, isError: true });
    host.emit('event', { type: 'tool_execution_end', toolCallId: long, toolName: 'mystery', result: {}, isError: false });
    host.emit('event', { type: 'tool_execution_start', toolCallId: 't3', toolName: 'read', args: { path: 'p'.repeat(500) } });
    events.close();
    const started = events.of('tool.started');
    const finished = events.of('tool.finished');
    assert.deepEqual([started.length, finished.length], [3, 2], `types: ${events.frames.map(x => x.type)}`);
    assert.deepEqual(started[0]!.data, { tool_call_id: 't1', name: 'bash', summary: 'ls -la /tmp' });
    assert.equal(started[0]!.producer, 'pi');
    assert.equal(started[0]!.evidence, 'observed_memory');
    assert.equal(started[1]!.data.tool_call_id.length, 512);
    assert.equal(started[1]!.data.summary, null);
    assert.deepEqual(finished[0]!.data, { tool_call_id: 't1', name: 'bash', summary: 'ls -la /tmp', is_error: true });
    assert.equal(finished[1]!.data.tool_call_id, started[1]!.data.tool_call_id, 'a long id is cut the same way in both');
    assert.equal(finished[1]!.data.is_error, false);
    assert.equal(started[2]!.data.summary!.length, 200);
  } finally {
    f.cleanup();
  }
});

test('events: the worker remembers at most 64 unfinished tool calls; the oldest is forgotten first', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const events = watch(f, w);
    const host = f.hosts[0]!;
    for (let i = 0; i <= 64; i++) host.emit('event', { type: 'tool_execution_start', toolCallId: `t${i}`, toolName: 'bash', args: { command: `step ${i}` } });
    host.emit('event', { type: 'tool_execution_end', toolCallId: 't0', toolName: 'bash', isError: false });
    host.emit('event', { type: 'tool_execution_end', toolCallId: 't64', toolName: 'bash', isError: false });
    events.close();
    const finished = events.of('tool.finished');
    assert.deepEqual(
      finished.map(x => [x.data.tool_call_id, x.data.summary]),
      [
        ['t0', null],
        ['t64', 'step 64'],
      ],
    );
  } finally {
    f.cleanup();
  }
});

test('events: receipt.updated publishes each journaled receipt record of a worker command, durable', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const events = watch(f, w);
    const receipt = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'turn'), message: 'hello' });
    // A follow-up queues while the turn runs, then runs once from queue_ready (the Go fake streams the same trace).
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'later'), message: 'and then', if_busy: 'follow_up' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await tick();
    await tick();
    events.close();
    assert.deepEqual(
      events
        .of('receipt.updated')
        .filter(x => x.data.receipt.command_id === 'later')
        .map(x => x.data.receipt.state),
      ['intent', 'queued', 'queue_ready', 'intent', 'accepted', 'delivered'],
    );
    const updates = events.of('receipt.updated').filter(x => x.data.receipt.command_id === 'turn');
    assert.deepEqual(
      updates.map(x => x.data.receipt.state),
      ['intent', 'accepted', 'delivered'],
    );
    assert.ok(updates.every(x => x.evidence === 'supervisor_journal_fsynced' && x.worker_id === w.worker_id));
    assert.deepEqual(updates.at(-1)!.data.receipt, receipt);
    assert.equal(updates.at(-1)!.execution_id, receipt.execution_id);
  } finally {
    f.cleanup();
  }
});

test('events: fence.set names each uncertain command once it is durable; a row with no new uncertainty publishes none', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const events = watch(f, w);
    const host = f.hosts[0]!;
    host.failure = true;
    const lost = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' });
    assert.equal(lost.state, 'outcome_unknown');
    const fenced = f.supervisor.get(w.worker_id);
    // Another write under the fence is refused and changes nothing; cancel persists the row again.
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(fenced, 'refused'), message: 'no' }), /session_fenced/);
    await f.supervisor.control(w.worker_id, { ...bind(fenced, 'cancel') }, false);
    events.close();
    const sets = events.of('fence.set');
    assert.equal(sets.length, 1, `fence.set frames: ${JSON.stringify(sets.map(x => x.data))}`);
    assert.equal(sets[0]!.data.command_id, 'lost');
    assert.equal(sets[0]!.data.fence_generation, 1);
    assert.deepEqual(sets[0]!.data.fence, fenced.fence);
    assert.equal(sets[0]!.execution_id, lost.execution_id);
    assert.equal(sets[0]!.evidence, 'supervisor_journal_fsynced');
    const latched = f.state.journal.records.filter(r => r.kind === 'worker').map(r => (r.value as { worker: Worker }).worker);
    assert.ok(latched.some(x => x.fence?.command_id === 'lost'), 'the fence row is journaled');
  } finally {
    f.cleanup();
  }
});

test('events: attachment.updated follows the attachment record from staged to released, durable', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const events = watch(f, w);
    const photo = jpegBytes(3000);
    const request = { attachment_id: 'photo-1', command_id: 'stage-1', worker_id: w.worker_id, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision, sha256: sha256(photo), content_type: 'image/jpeg' as const };
    assert.equal((await f.supervisor.stageAttachment(request, bytes(photo))).state, 'delivered');
    f.supervisor.attachments.releaseNow(['photo-1'], 'prompt-1');
    events.close();
    const updates = events.of('attachment.updated');
    assert.deepEqual(
      updates.map(x => [x.data.attachment.attachment_id, x.data.attachment.state]),
      [
        ['photo-1', 'staged'],
        ['photo-1', 'released'],
      ],
    );
    assert.ok(updates.every(x => x.evidence === 'supervisor_journal_fsynced' && x.worker_id === w.worker_id));
    assert.equal(updates[1]!.data.attachment.released_by, 'prompt-1');
  } finally {
    f.cleanup();
  }
});

async function serve(f: Fixture, grantId = 'owner'): Promise<{ socket: string; headers: Record<string, string>; close: () => Promise<void> }> {
  const owner = ownerGrant(f.dir, grantId);
  const server = createB2Server(createApp({ supervisor: f.supervisor, piVersion: '1.5.2', grants: owner.grants }).handle);
  const socket = join(f.dir, `b2-${Math.random().toString(16).slice(2)}.sock`);
  await listenPrivate(server, socket);
  return {
    socket,
    headers: owner.headers,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The first frame of a fresh attach over the socket: the snapshot. */
async function snapshotOver(socket: string, headers: Record<string, string>, since?: string): Promise<Snapshot> {
  const seen = await sseRecords(socket, '/b2/events', () => false, since ? { ...headers, 'Last-Event-ID': since } : headers);
  assert.equal(seen.status, 200);
  const frame = JSON.parse(seen.records[0]!.data) as Frame;
  assert.equal(frame.type, 'snapshot', `first frame: ${seen.records[0]!.data.slice(0, 200)}`);
  return frame as Snapshot;
}

test('recent_settlements: two executions settled while a subscriber is away are both in the next snapshot, and after a restart', async () => {
  const f = fixture();
  let s = await serve(f);
  try {
    const w = await f.create();
    const id = w.worker_id;
    // A subscriber reads its snapshot, then goes away.
    const seen = await sseRecords(s.socket, '/b2/events', () => false, s.headers);
    const lastId = seen.records[0]!.id!;
    const first = await f.supervisor.prompt(id, { ...bind(w, 'turn-1'), message: 'one' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const second = await f.supervisor.prompt(id, { ...bind(w, 'turn-2'), message: 'two' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await tick();
    const checkRow = (row: Worker) => {
      assert.equal(row.settle_count, 2);
      assert.ok(Array.isArray(row.recent_settlements), 'the row carries recent_settlements');
      assert.deepEqual(
        row.recent_settlements!.map(x => [x.execution_id, x.command_id]),
        [
          [second.execution_id, 'turn-2'],
          [first.execution_id, 'turn-1'],
        ],
        'newest first',
      );
      for (const x of row.recent_settlements!) {
        assert.ok(x.disposition);
        assert.ok(!Number.isNaN(Date.parse(x.settled_at)));
      }
    };
    // It reconnects: the worker never replays, the snapshot says it missed events and carries both settlements.
    const back = await snapshotOver(s.socket, s.headers, lastId);
    assert.equal(back.resync_reason, 'gap');
    checkRow(back.workers.find(x => x.worker_id === id)!);
    // The settlements are journaled with the row: a supervisor restart keeps them.
    await s.close();
    await f.restart();
    s = await serve(f, 'owner-after-restart');
    const after = await snapshotOver(s.socket, s.headers, lastId);
    assert.equal(after.resync_reason, 'epoch');
    checkRow(after.workers.find(x => x.worker_id === id)!);
  } finally {
    await s.close();
    f.cleanup();
  }
});

test(`recent_settlements: at most ${RECENT_SETTLEMENTS}, newest first, one entry per execution`, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const w = await f.create();
    const id = w.worker_id;
    const executions: string[] = [];
    for (let i = 0; i < RECENT_SETTLEMENTS + 2; i++) {
      executions.push((await f.supervisor.prompt(id, { ...bind(w, `turn-${i}`), message: `m${i}` })).execution_id!);
      f.hosts[0]!.emit('event', { type: 'agent_settled' });
      await tick();
    }
    // A second settlement report for the last execution (pi settles again) adds no entry.
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await tick();
    const row = (await snapshotOver(s.socket, s.headers)).workers.find(x => x.worker_id === id)!;
    assert.equal(row.settle_count, RECENT_SETTLEMENTS + 3);
    assert.ok(Array.isArray(row.recent_settlements), 'the row carries recent_settlements');
    assert.deepEqual(
      row.recent_settlements!.map(x => x.execution_id),
      executions.slice(-RECENT_SETTLEMENTS).reverse(),
    );
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('events (real pi): pi’s own SDK events become tool.started, tool.finished and assistant.delta for the running execution', { timeout: 90_000 }, async () => {
  const provider = await fakeProvider();
  const f = realPiSupervisor({ 'provider.ts': providerExtension(provider.url) });
  try {
    writeFileSync(join(f.cwd, 'note.txt'), 'a note\n');
    // The model asks for one `read` tool call, then answers with the canned text.
    provider.responses.push(
      sse([
        ['message_start', { type: 'message_start', message: { id: 'msg_tool', type: 'message', role: 'assistant', content: [], model: 'echo', stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_read_1', name: 'read', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"note.txt"}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    );
    const id = await f.create();
    const w = f.s.get(id);
    const frames: Frame[] = [];
    const sub = f.s.subscribe(frame => void frames.push(frame), { workerIds: [id] });
    const receipt = await f.s.prompt(id, { ...bind(w, 'turn'), message: 'read the note' });
    await until(() => frames.some(x => x.type === 'execution.settled'), 60_000, 'execution.settled');
    sub.close();
    for (const frame of frames) assert.equal(validateEventFrame(frame), true, `${frame.type}: ${JSON.stringify(validateEventFrame.errors)}`);
    const of = <T extends Frame['type']>(type: T) => frames.filter(x => x.type === type) as EventOf<T>[];
    const [started] = of('tool.started');
    const [finished] = of('tool.finished');
    assert.deepEqual(started?.data, { tool_call_id: 'toolu_read_1', name: 'read', summary: 'note.txt' });
    assert.deepEqual(finished?.data, { tool_call_id: 'toolu_read_1', name: 'read', summary: 'note.txt', is_error: false });
    const deltas = of('assistant.delta');
    assert.deepEqual(deltas.at(-1)?.data, { tail: 'canned reply', length: 'canned reply'.length });
    for (const e of [started!, finished!, ...deltas]) {
      assert.equal(e.execution_id, receipt.execution_id);
      assert.equal(e.producer, 'pi');
    }
    assert.ok(started!.cursor.seq < finished!.cursor.seq && finished!.cursor.seq < deltas.at(-1)!.cursor.seq, 'in the order pi ran them');
  } finally {
    await f.cleanup();
    await provider.close();
  }
});
