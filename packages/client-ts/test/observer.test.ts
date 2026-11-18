/**
 * C3 (P3 plan section 4): the owned observer over a scripted fake worker on a real Unix socket. Each test drives the
 * stream frame by frame, ends it, and checks what the next request carried and what the observer surfaced. The fake
 * counts every request; the observer only ever reads. Assertion messages name cases, never frame or reply values.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  Observer,
  ObserverStateInvalid,
  requestHash,
  type Cursor,
  type EventFrame,
  type Expected,
  type Notice,
  type ObserverBatch,
  type ObserverOptions,
  type ObserverStop,
  type Receipt,
  type ResyncReason,
  type TimerHandle,
  type components,
} from '../src/index.js';

type Worker = components['schemas']['Worker'];
type Interaction = components['schemas']['Interaction'];

const wire = (op: string, name: string) => JSON.parse(readFileSync(new URL(`../../../../api/fixtures/wire/${op}/${name}.json`, import.meta.url), 'utf8')) as { response: Record<string, unknown> };
const baseWorker = (wire('events.subscribe', 'ok').response.frames as { workers: Worker[] }[])[0]!.workers[0]!;
const baseInteraction = (wire('interactions.list', 'ok').response.body as Interaction[])[0]!;
const baseReceipt = wire('receipts.get', 'ok').response.body as unknown as Receipt;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'piw-c3-'));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const row = (worker_id: string, o: Partial<Worker> = {}): Worker => ({ ...structuredClone(baseWorker), worker_id, settle_count: 0, recent_settlements: [], ...o });
const settlement = (n: string) => ({ execution_id: `exec-${n}`, command_id: `cmd-${n}`, disposition: 'started', settled_at: '2026-11-18T00:00:00Z' });
const interaction = (n: string, worker_id = 'w1'): Interaction => ({ ...structuredClone(baseInteraction), interaction_id: `int-${n}`, native_id: `native-${n}`, worker_id });
const claim = (n: string) => ({ command_id: `rep-${n}`, kind: 'result' as const, message: 'claim', claim_not_verified: true as const });
const snapshot = (workers: Worker[], cursor: Cursor, resync_reason: ResyncReason): EventFrame => ({ type: 'snapshot', workers, cursor, resync_reason });
const meta = (cursor: Cursor) => ({ cursor, event_id: `ev-${cursor.transport_epoch}-${cursor.seq}`, producer: 'supervisor' as const });
const updated = (w: Worker, cursor: Cursor): EventFrame => ({ type: 'worker.updated', ...meta(cursor), execution_id: null, evidence: 'supervisor_journal_fsynced', worker_id: w.worker_id, data: { worker: w } });
const settled = (worker_id: string, n: string, cursor: Cursor): EventFrame => ({
  type: 'execution.settled',
  ...meta(cursor),
  execution_id: `exec-${n}`,
  evidence: 'observed_memory',
  worker_id,
  data: { command_id: `cmd-${n}`, disposition: 'started' },
});
const changed = (worker_id: string, list: Interaction[], cursor: Cursor): EventFrame => ({
  type: 'interactions.changed',
  ...meta(cursor),
  execution_id: null,
  evidence: 'observed_memory',
  worker_id,
  data: { interactions: list },
});
const reported = (worker_id: string, n: string, cursor: Cursor): EventFrame => ({
  type: 'child.reported',
  ...meta(cursor),
  execution_id: null,
  evidence: 'supervisor_journal_fsynced',
  worker_id,
  data: { report_command_id: `rep-${n}`, task_id: 'task-1', parent_worker_id: 'parent-1', kind: 'result', claim_not_verified: true },
});
const rebound = (worker_id: string, session_id: string, binding_revision: number, cursor: Cursor): EventFrame => ({
  type: 'session.rebound',
  ...meta(cursor),
  execution_id: null,
  evidence: 'supervisor_journal_fsynced',
  worker_id,
  data: { session_id, binding_revision, action: 'new' },
});
const overflow = (cursor: Cursor): EventFrame => ({ type: 'overflow', ...meta(cursor), execution_id: null, evidence: 'observed_memory', data: { resync_required: true, reason: 'subscriber_queue_overflow' } });

interface Stream {
  req: IncomingMessage;
  res: ServerResponse;
  lastEventId: string | undefined;
  resync: string | null;
  controlsAtRequest: boolean | undefined;
}

/**
 * A fake worker: `/b2/events` streams are handed to `onStream` (default: held open, nothing sent); `/b2/receipts/{id}`
 * answers with `receipt`. Every request is counted; anything but a GET is a mutation the observer must never send.
 */
async function fakeWorker(socket: string) {
  const streams: Stream[] = [];
  const counts = { requests: 0, mutations: 0, receipts: 0, streams: 0 };
  const fake = {
    streams,
    counts,
    observer: undefined as Observer | undefined,
    onStream: (_s: Stream, _i: number) => {},
    receipt: (_commandId: string): { status: number; body: unknown } => ({ status: 409, body: { error: 'unknown_command_id_is_not_proof_of_no_effect', effect: 'no_effect' } }),
    server: undefined as unknown as Server,
  };
  const server = createServer((req, res) => {
    counts.requests++;
    if (req.method !== 'GET') counts.mutations++;
    const url = new URL(req.url ?? '/', 'http://worker');
    if (req.method === 'GET' && url.pathname.startsWith('/b2/receipts/')) {
      counts.receipts++;
      const r = fake.receipt(decodeURIComponent(url.pathname.slice('/b2/receipts/'.length)));
      res.writeHead(r.status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(r.body));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/b2/events') {
      counts.streams++;
      const header = req.headers['last-event-id'];
      const s: Stream = { req, res, lastEventId: typeof header === 'string' ? header : undefined, resync: url.searchParams.get('resync'), controlsAtRequest: fake.observer?.controls };
      streams.push(s);
      fake.onStream(s, streams.length - 1);
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ error: 'unexpected_request', effect: 'unknown' }));
  });
  fake.server = server;
  await new Promise<void>(r => server.listen(socket, () => r()));
  return fake;
}
const closeServer = (server: Server) =>
  new Promise<void>(r => {
    server.closeAllConnections();
    server.close(() => r());
  });
const open = (s: Stream) => s.res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
const send = (s: Stream, ...frames: EventFrame[]) => {
  for (const f of frames) s.res.write(`id: ${JSON.stringify(f.cursor)}\nevent: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
};

async function until(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting: ${label}`);
    await new Promise(r => setTimeout(r, 2));
  }
}
/** A run's end within a bound: a guard that never stops fails here by assertion, not by hanging the file. */
async function ended(done: Promise<ObserverStop>, label: string, ms = 5000): Promise<ObserverStop> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`observer did not stop: ${label}`)), ms);
  });
  try {
    return await Promise.race([done, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Timers that record each requested delay and how many are pending. */
function trackedTimers() {
  const live = new Set<TimerHandle>();
  const delays: number[] = [];
  return {
    delays,
    live,
    timers: {
      set(callback: () => void, ms: number): TimerHandle {
        delays.push(ms);
        const handle = setTimeout(() => {
          live.delete(handle);
          callback();
        }, 1);
        live.add(handle);
        return handle;
      },
      clear(handle: TimerHandle) {
        live.delete(handle);
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
  };
}

/** Every observer a test started: aborted after the file, so a guard removed by a reversion cannot keep it alive. */
const started = new Set<AbortController>();
after(() => {
  for (const ac of started) ac.abort();
});

function start(fake: Awaited<ReturnType<typeof fakeWorker>>, client: Client, extra: Partial<ObserverOptions> = {}) {
  const ac = new AbortController();
  started.add(ac);
  const batches: ObserverBatch[] = [];
  const controls: boolean[] = [];
  const observer = new Observer({
    client,
    signal: ac.signal,
    deliver: b => void batches.push(structuredClone(b)),
    onControls: e => void controls.push(e),
    backoff: { initialMs: 1, maxMs: 4 },
    ...extra,
  });
  fake.observer = observer;
  const done = observer.run();
  return { observer, batches, controls, ac, done, notices: () => batches.flatMap(b => b.notices) };
}

/** A notice's kind and identity, for comparing what surfaced without printing any payload. */
const key = (n: Notice): string => {
  switch (n.kind) {
    case 'interaction':
      return `interaction:${n.interaction_id}`;
    case 'settlement':
      return `settlement:${n.execution_id}`;
    case 'child_report':
      return `child_report:${n.report_command_id}`;
    case 'receipt':
      return `receipt:${n.expected.command_id}:${n.reconciliation.outcome}`;
    default:
      return `${n.kind}:${n.worker_id}`;
  }
};
const keys = (ns: Notice[]) => ns.map(key).sort();

test('C3: a cold start seeds silently; every reconnect sends Last-Event-ID and diffs each resync reason (fresh, current, gap, epoch, ahead, evicted, overflow) once', { timeout: 30_000 }, async () => {
  const t = tmp();
  const fake = await fakeWorker(join(t.dir, 'w.sock'));
  const client = new Client({ socketPath: join(t.dir, 'w.sock') });
  let o: ReturnType<typeof start> | undefined;
  try {
    // The reconnect reasons in order; the stream before `overflow` ends with an overflow frame.
    const reasons: ResyncReason[] = ['current', 'gap', 'epoch', 'ahead', 'evicted', 'overflow', 'fresh'];
    let epoch = 't-1';
    let seq = 10;
    const sent: (Cursor | undefined)[] = [];
    // Server-side world: settlements, the one pending interaction and the child reports, as rows carry them.
    let recent = [settlement('0')];
    let pending: Interaction[] = [interaction('0')];
    let reports = [claim('0')];
    const w1 = () => row('w1', { settle_count: recent.length, recent_settlements: [...recent].reverse().slice(0, 8), pending_interactions: pending, child_reports: reports, parent_worker_id: 'parent-1' });
    fake.onStream = (s, i) => {
      open(s);
      const step = i - 1;
      const reason: ResyncReason = i === 0 ? 'fresh' : (reasons[step] ?? 'current');
      if (reason === 'epoch') {
        epoch = 't-2';
        seq = 0;
      }
      // `ahead`: the worker's cursor is behind the one the client sent.
      if (reason === 'ahead') seq = 1;
      if (i > 0 && reason !== 'current' && step < reasons.length) {
        recent = [...recent, settlement(String(i))];
        pending = [interaction(String(i))];
        reports = [...reports, claim(String(i))];
      }
      const snap = { transport_epoch: epoch, seq: ++seq };
      send(s, snapshot([w1()], snap, reason));
      // One live frame advances the cursor; the next reconnect must send it.
      const live = { transport_epoch: epoch, seq: ++seq };
      send(s, updated(w1(), live));
      sent.push(live);
      if (reasons[i] === 'overflow') {
        const last = { transport_epoch: epoch, seq: ++seq };
        send(s, overflow(last));
        sent[sent.length - 1] = last;
      }
      if (i <= reasons.length) setTimeout(() => s.res.end(), 5);
    };
    o = start(fake, client);
    await until(() => fake.streams.length === reasons.length + 2 && o!.batches.length === reasons.length + 2, 'every reconnect delivered its snapshot');

    const [seed, ...resyncs] = o.batches;
    assert.equal(seed!.seeded, true, 'cold start seeds');
    assert.equal(seed!.resync, 'fresh');
    assert.deepEqual(seed!.notices, [], 'a cold start surfaces nothing');
    assert.equal(fake.streams[0]!.lastEventId, undefined, 'the first attach has no cursor');
    for (const [i, reason] of reasons.entries()) {
      const s = fake.streams[i + 1]!;
      assert.deepEqual(s.lastEventId === undefined ? undefined : JSON.parse(s.lastEventId), sent[i], `${reason}: Last-Event-ID is the last cursor seen`);
      assert.equal(s.resync, reason === 'overflow' ? 'overflow' : null, `${reason}: resync=overflow only after an overflow`);
      assert.equal(s.controlsAtRequest, false, `${reason}: controls gated while reconnecting`);
      const batch = resyncs[i]!;
      assert.equal(batch.resync, reason, `${reason}: the batch names the reason`);
      assert.equal(batch.seeded, undefined, `${reason}: a reconnect never seeds`);
      const n = String(i + 1);
      const expected = reason === 'current' ? [] : [`child_report:rep-${n}`, `interaction:int-${n}`, `settlement:exec-${n}`];
      assert.deepEqual(keys(batch.notices), expected, `${reason}: the missed interaction, settlement and report surface once`);
      assert.ok(
        batch.notices.every(x => !('source' in x) || x.source === 'snapshot'),
        `${reason}: recovered from the snapshot`,
      );
    }
    // The last stream repeats the previous snapshot's rows: the same snapshot twice surfaces nothing.
    assert.deepEqual(resyncs[reasons.length]!.notices, [], 'the same snapshot twice: nothing new');
    const all = keys(o.notices());
    assert.equal(new Set(all).size, all.length, 'no identity surfaced twice');
    assert.equal(o.observer.controls, true, 'controls open after the last snapshot');
    assert.deepEqual(o.controls.slice(0, 4), [true, false, true, false], 'controls close at each break and open at each snapshot');
    assert.equal(fake.counts.mutations, 0, 'never a mutation');
    assert.equal(fake.counts.receipts, 0, 'no gap: no receipt read');
  } finally {
    o?.ac.abort();
    await closeServer(fake.server);
    t.cleanup();
    if (o) await ended(o.done, 'cleanup');
  }
});

test('C3: controls are gated from a disconnect, overflow or malformed frame until a validated snapshot; an invalid snapshot or a stream without one changes nothing', { timeout: 30_000 }, async () => {
  const t = tmp();
  const fake = await fakeWorker(join(t.dir, 'w.sock'));
  const client = new Client({ socketPath: join(t.dir, 'w.sock') });
  let o: ReturnType<typeof start> | undefined;
  try {
    const c = (seq: number): Cursor => ({ transport_epoch: 't-1', seq });
    const plan: ((s: Stream) => void)[] = [
      s => send(s, snapshot([row('w1')], c(1), 'fresh')),
      // A malformed frame (a settlement without its execution id) ends the stream; it is never applied.
      s => {
        send(s, snapshot([row('w1')], c(2), 'gap'));
        s.res.write(`data: ${JSON.stringify({ ...settled('w1', 'bad', c(3)), execution_id: undefined })}\n\n`);
      },
      // An invalid snapshot (its worker row lacks a required field) never opens controls.
      s => s.res.write(`data: ${JSON.stringify({ ...snapshot([row('w1')], c(4), 'gap'), workers: [{ ...row('w1'), status: undefined }] })}\n\n`),
      // A stream whose first frame is not a snapshot is not applied: its settlement never surfaces.
      s => send(s, settled('w1', 'early', c(5))),
      // A valid snapshot then an overflow.
      s => send(s, snapshot([row('w1')], c(6), 'gap'), overflow(c(7))),
      s => send(s, snapshot([row('w1', { settle_count: 1, recent_settlements: [settlement('late')] })], c(8), 'overflow')),
    ];
    fake.onStream = (s, i) => {
      open(s);
      plan[i]?.(s);
      if (i === 0) setTimeout(() => s.res.end(), 20);
    };
    o = start(fake, client, { backoff: { initialMs: 1, maxMs: 4, maxProtocolFailures: 5 } });
    await until(() => o!.observer.controls, 'first snapshot');
    const handle = o.observer.binding('w1');
    assert.ok(handle && o.observer.isCurrent(handle), 'a handle from the snapshot is current');
    await until(() => fake.streams.length === plan.length && o!.batches.length === 4, 'the plan ran');
    // Every stream but the first after a break began gated.
    assert.deepEqual(
      fake.streams.slice(1).map(s => s.controlsAtRequest),
      [false, false, false, false, false],
      'gated at every reconnect',
    );
    assert.deepEqual(o.controls, [true, false, true, false, true, false, true], 'only the three valid snapshots opened controls');
    assert.deepEqual(keys(o.notices()), ['settlement:exec-late'], 'nothing from the malformed frame or the stream without a snapshot');
    assert.equal(fake.streams[5]!.resync, 'overflow', 'after the overflow');
    // A disconnect closes controls; meanwhile no handle is current and none is handed out.
    fake.streams[5]!.res.end();
    fake.onStream = () => {};
    await until(() => !o!.observer.controls, 'disconnect gates');
    assert.equal(o.observer.isCurrent(handle), false, 'gated: the old handle is not current');
    assert.equal(o.observer.binding('w1'), undefined, 'gated: no binding');
    assert.equal(fake.counts.mutations, 0, 'never a mutation');
  } finally {
    o?.ac.abort();
    await closeServer(fake.server);
    t.cleanup();
    if (o) await ended(o.done, 'cleanup');
  }
});

test('C3: live events surface once by identity; removed and rebound workers invalidate old handles', { timeout: 30_000 }, async () => {
  const t = tmp();
  const fake = await fakeWorker(join(t.dir, 'w.sock'));
  const client = new Client({ socketPath: join(t.dir, 'w.sock') });
  let o: ReturnType<typeof start> | undefined;
  try {
    const c = (seq: number): Cursor => ({ transport_epoch: 't-1', seq });
    let first: Stream | undefined;
    fake.onStream = (s, i) => {
      open(s);
      if (i === 0) {
        first = s;
        send(s, snapshot([row('w1'), row('w2')], c(1), 'fresh'));
        return;
      }
      // Reconnect: w2 is gone, w1 relaunched (new epoch); the settlement and interaction already seen live repeat.
      const w1 = row('w1', { worker_epoch: 'epoch-2', session_id: 'session-2', binding_revision: 2, settle_count: 1, recent_settlements: [settlement('1')], pending_interactions: [interaction('1')] });
      send(s, snapshot([w1], c(10 + i), 'gap'));
      if (i === 1) setTimeout(() => s.res.end(), 5);
    };
    o = start(fake, client);
    await until(() => o!.observer.controls, 'first snapshot');
    const h1 = o.observer.binding('w1')!;
    const h2 = o.observer.binding('w2')!;
    assert.ok(o.observer.isCurrent(h1) && o.observer.isCurrent(h2), 'both handles current');
    // Live: a settlement (twice: the event and the row), an interaction (twice), a report (twice).
    const w1 = row('w1', { settle_count: 1, recent_settlements: [settlement('1')], pending_interactions: [interaction('1')] });
    send(first!, updated(w1, c(2)), settled('w1', '1', c(3)), changed('w1', [interaction('1')], c(4)), changed('w1', [interaction('1')], c(5)), reported('w1', 'r', c(6)), reported('w1', 'r', c(7)));
    // The session moves: the old handle is stale, the new binding current.
    send(first!, rebound('w1', 'session-9', 2, c(8)));
    await until(() => o!.notices().some(n => n.kind === 'worker_rebound'), 'rebound seen');
    assert.deepEqual(keys(o.notices()), ['child_report:rep-r', 'interaction:int-1', 'settlement:exec-1', 'worker_rebound:w1'], 'each live identity once');
    assert.equal(o.observer.isCurrent(h1), false, 'rebound: the old handle is stale');
    const moved = o.observer.binding('w1')!;
    assert.equal(moved.binding_revision, 2);
    assert.ok(o.observer.isCurrent(moved) && o.observer.isCurrent(h2), 'the new binding and the other worker are current');
    const live = o.notices().length;
    first!.res.end();
    await until(() => fake.streams.length === 3 && o!.batches.length >= 3, 'two reconnect snapshots');
    const after = o.notices().slice(live);
    assert.deepEqual(keys(after), ['worker_rebound:w1', 'worker_removed:w2'], 'the reconnect diff: removed and rebound, nothing seen live again');
    assert.equal(o.observer.isCurrent(h2), false, 'removed: its handle is stale');
    assert.equal(o.observer.binding('w2'), undefined, 'removed: no binding');
    assert.equal(o.observer.isCurrent(moved), false, 'relaunched: the session handle is stale');
    assert.equal(o.observer.binding('w1')!.worker_epoch, 'epoch-2');
    assert.deepEqual(o.batches.at(-1)!.notices, [], 'the same snapshot twice: nothing new');
  } finally {
    o?.ac.abort();
    await closeServer(fake.server);
    t.cleanup();
    if (o) await ended(o.done, 'cleanup');
  }
});

test('C3: eight missed settlements come from the snapshot alone; more than eight surface a gap and reconcile pending receipts, never an invented settlement', { timeout: 30_000 }, async () => {
  const t = tmp();
  const fake = await fakeWorker(join(t.dir, 'w.sock'));
  const client = new Client({ socketPath: join(t.dir, 'w.sock') });
  let o: ReturnType<typeof start> | undefined;
  try {
    const c = (seq: number): Cursor => ({ transport_epoch: 't-1', seq });
    const list = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => settlement(String(to - k)));
    const rows = [
      row('w1', { settle_count: 0 }),
      // Eight missed: all eight listed.
      row('w1', { settle_count: 8, recent_settlements: list(1, 8) }),
      // Eleven more missed (9..19): only 12..19 are listed; 9..11 are only in history.
      row('w1', { settle_count: 19, recent_settlements: list(12, 19) }),
    ];
    fake.onStream = (s, i) => {
      open(s);
      send(s, snapshot([rows[i] ?? rows[2]!], c(i + 1), i === 0 ? 'fresh' : 'gap'));
      if (i < 2) setTimeout(() => s.res.end(), 5);
    };
    const body = (id: string) => ({ command_id: id, worker_epoch: 'epoch-1', session_id: 'session-1', binding_revision: 1, message: 'm' });
    const expect = (id: string): Expected => ({ command_id: id, operation: 'sessions.prompt', worker_id: 'w1', request_hash: requestHash('sessions.prompt', { path: { worker_id: 'w1' }, body: body(id) }) });
    // Pending: cmd-10 settled unlisted, cmd-19 listed, cmd-other on another worker.
    const pending = [expect('cmd-10'), expect('cmd-19'), { ...expect('cmd-other'), worker_id: 'w9' }];
    const reads: string[] = [];
    fake.receipt = id => {
      reads.push(id);
      const e = pending.find(p => p.command_id === id)!;
      return { status: 200, body: { ...baseReceipt, command_id: id, operation: 'sessions.prompt', request_hash: e.request_hash, worker_id: 'w1', state: 'delivered', effect: 'observed' } };
    };
    o = start(fake, client, { pending: () => pending });
    await until(() => o!.batches.length === 3, 'three snapshots');
    const [, eight, beyond] = o.batches;
    assert.deepEqual(keys(eight!.notices), list(1, 8).map(s => `settlement:${s.execution_id}`).sort(), 'eight: every settlement from the list');
    assert.ok(!eight!.notices.some(n => n.kind === 'settlement_gap' || n.kind === 'receipt'), 'eight: no gap');
    const settlements = beyond!.notices.filter(n => n.kind === 'settlement');
    assert.deepEqual(keys(settlements), list(12, 19).map(s => `settlement:${s.execution_id}`).sort(), 'beyond eight: only listed settlements, none invented');
    const gap = beyond!.notices.find(n => n.kind === 'settlement_gap');
    assert.ok(gap && gap.kind === 'settlement_gap' && gap.missed === 11 && gap.listed === 8, 'beyond eight: the gap names missed and listed counts');
    assert.deepEqual(reads, ['cmd-10'], 'only the unlisted pending command of this worker is read');
    assert.deepEqual(keys(beyond!.notices.filter(n => n.kind === 'receipt')), ['receipt:cmd-10:observed'], 'its receipt reconciles');
    assert.equal(fake.counts.mutations, 0, 'never a mutation');
  } finally {
    o?.ac.abort();
    await closeServer(fake.server);
    t.cleanup();
    if (o) await ended(o.done, 'cleanup');
  }
});

test('C3: a restart restores the persisted state: no cold seed, what a crash kept from the outbox surfaces again, nothing persisted twice', { timeout: 30_000 }, async () => {
  const t = tmp();
  const fake = await fakeWorker(join(t.dir, 'w.sock'));
  const client = new Client({ socketPath: join(t.dir, 'w.sock') });
  const runs: ReturnType<typeof start>[] = [];
  try {
    const c = (seq: number, epoch = 't-1'): Cursor => ({ transport_epoch: epoch, seq });
    let persisted: ObserverBatch['state'] | undefined;
    let crash = false;
    let first: Stream | undefined;
    const after = row('w1', { settle_count: 1, recent_settlements: [settlement('1')], pending_interactions: [interaction('1')], parent_worker_id: 'parent-1', child_reports: [claim('2')] });
    fake.onStream = (s, i) => {
      open(s);
      if (i === 0) {
        first = s;
        send(s, snapshot([row('w1')], c(1), 'fresh'));
      } else send(s, snapshot([after], c(1, 't-2'), 'epoch'));
    };
    // The consumer's outbox: a batch is persisted atomically, or (crash) not at all.
    const deliver = (b: ObserverBatch) => {
      if (crash) throw new Error('outbox write failed');
      persisted = structuredClone(b.state);
    };
    const a = start(fake, client, { deliver });
    runs.push(a);
    await until(() => persisted !== undefined, 'seed persisted');
    send(first!, changed('w1', [interaction('1')], c(2)));
    await until(() => persisted!.workers.w1!.interactions.includes('int-1'), 'the interaction persisted');
    crash = true;
    send(first!, settled('w1', '1', c(3)));
    const stop = await ended(a.done, 'delivery failure');
    assert.equal(stop.reason, 'delivery_failed', 'a failed delivery stops the observer');
    assert.equal(fake.streams.length, 1, 'a failed delivery is not retried by reconnecting');
    assert.ok(!persisted!.workers.w1!.settlements.includes('exec-1'), 'the crashed batch was not persisted');

    // The restarted process restores what was persisted. Its first snapshot is a diff, not a seed.
    crash = false;
    const batches: ObserverBatch[] = [];
    const b = start(fake, client, { restored: persisted!, deliver: x => void batches.push(structuredClone(x)) });
    runs.push(b);
    await until(() => batches.length === 1, 'restored snapshot');
    assert.deepEqual(JSON.parse(fake.streams[1]!.lastEventId!), c(2), 'the restored cursor is sent');
    assert.equal(batches[0]!.seeded, undefined, 'a restored state is never a cold seed');
    assert.deepEqual(keys(batches[0]!.notices), ['child_report:rep-2', 'settlement:exec-1'], 'the lost settlement and the missed report surface; the persisted interaction does not');

    // Without a restored state the same snapshot is a silent seed: the pending outcomes would be lost.
    const cold: ObserverBatch[] = [];
    const coldRun = start(fake, client, { deliver: x => void cold.push(structuredClone(x)) });
    runs.push(coldRun);
    await until(() => cold.length === 1, 'cold snapshot');
    assert.equal(cold[0]!.seeded, true);
    assert.deepEqual(cold[0]!.notices, [], 'cold: silent');

    // A restored state that is not a valid observer state is refused, never treated as a cold start.
    for (const [label, bad] of [
      ['version', { ...persisted, version: 2 }],
      ['cursor', { ...persisted, cursor: { seq: -1 } }],
      ['identities', { ...persisted, workers: { w1: { ...persisted!.workers.w1, settlements: [1] } } }],
      ['not an object', 'state'],
    ] as const) {
      assert.throws(() => new Observer({ client, signal: AbortSignal.abort(), deliver: () => {}, restored: bad as never }), ObserverStateInvalid, `invalid restored state: ${label}`);
    }
    assert.equal(fake.counts.mutations, 0, 'never a mutation');
  } finally {
    for (const r of runs) r.ac.abort();
    await closeServer(fake.server);
    t.cleanup();
    for (const r of runs) await ended(r.done, 'cleanup');
  }
});

test('C3: abort closes the stream and clears the backoff timer; backoff is capped; authorization failures and refusals stop at once, protocol failures after the bound', { timeout: 30_000 }, async () => {
  const t = tmp();
  const socket = join(t.dir, 'w.sock');
  const fake = await fakeWorker(socket);
  const client = new Client({ socketPath: socket });
  try {
    // Abort with a stream open: the worker sees the connection close, and run resolves.
    {
      let closed = false;
      fake.onStream = s => {
        s.req.socket.on('close', () => (closed = true));
        open(s);
        send(s, snapshot([row('w1')], { transport_epoch: 't-1', seq: 1 }, 'fresh'));
      };
      const tracked = trackedTimers();
      const o = start(fake, client, { timers: tracked.timers });
      await until(() => o.observer.controls, 'stream open');
      o.ac.abort();
      assert.deepEqual(await ended(o.done, 'abort with stream open'), { reason: 'aborted' });
      await until(() => closed, 'the stream is closed on abort', 2000);
      assert.equal(tracked.live.size, 0, 'no timer left');
      assert.equal(o.observer.controls, false, 'aborted: gated');
    }
    // Server errors back off exponentially up to the cap; abort during the backoff clears its timer.
    {
      const before = fake.counts.streams;
      fake.onStream = s => {
        s.res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
        s.res.end(JSON.stringify({ error: 'busy', effect: 'no_effect' }));
      };
      const held: (() => void)[] = [];
      const pending = new Set<TimerHandle>();
      const delays: number[] = [];
      let token = 0;
      const timers = {
        set(callback: () => void, ms: number): TimerHandle {
          delays.push(ms);
          const handle = ++token;
          pending.add(handle);
          // Fire at once, except the eighth: it stays pending until abort.
          if (delays.length < 8)
            setImmediate(() => {
              pending.delete(handle);
              callback();
            });
          else held.push(callback);
          return handle;
        },
        clear(handle: TimerHandle) {
          pending.delete(handle);
        },
      };
      const o = start(fake, client, { timers, random: () => 1, backoff: { initialMs: 10, maxMs: 80 } });
      await until(() => delays.length === 8, 'eight backoffs');
      assert.deepEqual(delays, [10, 20, 40, 80, 80, 80, 80, 80], 'exponential and capped at maxMs');
      o.ac.abort();
      assert.deepEqual(await ended(o.done, 'abort during backoff'), { reason: 'aborted' });
      assert.equal(pending.size, 0, 'the backoff timer was cleared');
      assert.equal(fake.counts.streams - before, 8, 'one stream per backoff, none after abort');
    }
    // Authorization failures and refusals stop after one request.
    for (const [status, reason] of [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [409, 'refused'],
      [400, 'refused'],
    ] as const) {
      const before = fake.counts.streams;
      fake.onStream = s => {
        s.res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
        s.res.end(JSON.stringify({ error: 'grant_refused', effect: 'no_effect' }));
      };
      const o = start(fake, client);
      const stop = await ended(o.done, `HTTP ${status}`);
      assert.equal(stop.reason, reason, `HTTP ${status} stops`);
      assert.equal(fake.counts.streams - before, 1, `HTTP ${status}: exactly one request`);
    }
    // An unreadable grant stops before anything is sent.
    {
      const before = fake.counts.requests;
      const grantFile = join(t.dir, 'grant.json');
      writeFileSync(grantFile, 'not json', { mode: 0o600 });
      const o = start(fake, new Client({ socketPath: socket, grantFile }));
      assert.equal((await ended(o.done, 'unreadable grant')).reason, 'unauthorized');
      assert.equal(fake.counts.requests - before, 0, 'unreadable grant: nothing sent');
    }
    // Malformed streams stop after maxProtocolFailures consecutive attempts.
    {
      const before = fake.counts.streams;
      fake.onStream = s => {
        open(s);
        s.res.end('data: {not json}\n\n');
      };
      const o = start(fake, client, { backoff: { initialMs: 1, maxMs: 2, maxProtocolFailures: 3 } });
      const stop = await ended(o.done, 'malformed forever');
      assert.equal(stop.reason, 'protocol', 'protocol failures stop');
      assert.equal(fake.counts.streams - before, 3, 'after exactly maxProtocolFailures streams');
    }
    assert.equal(fake.counts.mutations, 0, 'never a mutation');
  } finally {
    for (const ac of started) ac.abort();
    await closeServer(fake.server);
    t.cleanup();
  }
});

test('C3: deliveries arrive in order with the state that counts them; a consumer that falls behind drops the stream and resyncs instead of buffering', { timeout: 30_000 }, async () => {
  const t = tmp();
  const fake = await fakeWorker(join(t.dir, 'w.sock'));
  const client = new Client({ socketPath: join(t.dir, 'w.sock') });
  let o: ReturnType<typeof start> | undefined;
  try {
    const c = (seq: number): Cursor => ({ transport_epoch: 't-1', seq });
    let first: Stream | undefined;
    fake.onStream = (s, i) => {
      open(s);
      if (i === 0) first = s;
      const recent = Array.from({ length: 6 }, (_, k) => settlement(String(6 - k)));
      send(s, snapshot([row('w1', i === 0 ? {} : { settle_count: 6, recent_settlements: recent })], c(i === 0 ? 1 : 100), i === 0 ? 'fresh' : 'gap'));
    };
    let release: () => void = () => {};
    let gate = Promise.resolve();
    const seen: ObserverBatch[] = [];
    o = start(fake, client, {
      maxPendingBatches: 2,
      deliver: async b => {
        seen.push(structuredClone(b));
        await gate;
      },
    });
    await until(() => seen.length === 1, 'seed');
    gate = new Promise<void>(r => (release = r));
    // Six live settlements while the consumer is stuck on the first: past two pending batches the stream drops.
    send(first!, ...Array.from({ length: 6 }, (_, k) => settled('w1', String(k + 1), c(2 + k))));
    await until(() => !o!.observer.controls, 'the stream dropped');
    release();
    await until(() => fake.streams.length === 2 && o!.observer.controls, 'resynced');
    await until(() => seen.length >= 3, 'deliveries drained');
    const order = seen.flatMap(b => b.notices).filter(n => n.kind === 'settlement').map(n => (n.kind === 'settlement' ? n.execution_id : ''));
    assert.deepEqual(order, ['exec-1', 'exec-2', 'exec-3', 'exec-4', 'exec-5', 'exec-6'], 'each settlement once, in order, across the drop and resync');
    for (const b of seen) {
      for (const n of b.notices) if (n.kind === 'settlement') assert.ok(b.state.workers.w1!.settlements.includes(n.execution_id), 'the batch state counts its own notices');
    }
    assert.equal(fake.counts.mutations, 0, 'never a mutation');
  } finally {
    o?.ac.abort();
    await closeServer(fake.server);
    t.cleanup();
    if (o) await ended(o.done, 'cleanup');
  }
});
