import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { Journal, parseJournal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { router, listenPrivate } from '../server.js';
import { Client } from '../client.js';
import type { SessionHost, PiRecord, PiResponse } from '../host.js';
import type { Binding, Worker, Receipt } from '../types.js';
class Host extends EventEmitter implements SessionHost {
  pid = undefined; token = null; prompts = 0; stops = 0; stopOk = true;
  beforePrompt = () => {}; failure: Error | null = null;
  cancellations: string[] = []; holdCancellation = false; badState = false;
  async cancelUI(id: string): Promise<void> { this.cancellations.push(id); if (this.holdCancellation) await new Promise<void>(() => {}); }
  constructor(readonly file: string, readonly sessionId: string) { super(); }
  async request(c: PiRecord): Promise<PiResponse> {
    if (c.type === 'get_state') return { type: 'response', id: 'x', success: !this.badState, data: { sessionId: this.sessionId, sessionFile: this.file } };
    this.beforePrompt(); this.prompts++;
    if (this.failure) throw this.failure;
    this.emit('event', { type: 'agent_start' });
    return { type: 'response', id: 'x', success: true, data: { disposition: 'started' } };
  }
  async stop() { this.stops++; this.emit('exit'); return this.stopOk; }
}
function fixture(initHost?: (host: Host) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'a0s2-fix-test-')), journal = new Journal(join(dir, 'journal'));
  const hosts: Host[] = [];
  const supervisor = new Supervisor(dir, journal, '1.5.2', () => {
    const sid = `session-${hosts.length}`, file = join(dir, `${sid}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'session', id: sid, version: 3 }) + '\n');
    const host = new Host(file, sid); initHost?.(host); hosts.push(host); return host;
  });
  async function create() {
    const cwd = join(dir, `cwd-${hosts.length}`); mkdirSync(cwd);
    const r = await supervisor.create({ command_id: `create-${hosts.length}`, cwd, provider: 'p', model: 'm', thinking: 'off' });
    assert.equal(r.state, 'delivered'); return supervisor.get(r.worker_id!);
  }
  const headers = { Authorization: `Bearer ${(JSON.parse(readFileSync(join(dir, 'grants', 'owner.json'), 'utf8')) as { token: string }).token}` };
  return { dir, journal, supervisor, hosts, headers, create, cleanup() { journal.close(); rmSync(dir, { recursive: true }); } };
}
const binding = (w: Worker, command_id: string): Binding => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision });
function latestWorker(file: string, id: string): Worker {
  return parseJournal(readFileSync(file)).records.filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === id).at(-1)!.value.worker as Worker;
}
test('supervisor dispatch marker with execution ID is fsynced before the host receives prompt (M2)', async () => {
  const f = fixture(); try {
    const w = await f.create();
    f.hosts[0]!.beforePrompt = () => {
      const records = parseJournal(readFileSync(f.journal.file)).records;
      const last = records.at(-1)!;
      assert.equal(last.kind, 'receipt'); assert.equal(last.value.state, 'accepted');
      assert.equal(last.value.execution_id, f.supervisor.get(w.worker_id).execution?.execution_id);
      assert.equal(last.value.command_id, 'ordered');
      assert.ok(records.some(r => r.kind === 'receipt' && r.value.command_id === 'ordered' && r.value.state === 'intent'));
    };
    const r = await f.supervisor.prompt(w.worker_id, { ...binding(w, 'ordered'), message: 'hi' });
    assert.equal(r.state, 'delivered'); assert.equal(f.hosts[0]!.prompts, 1);
  } finally { f.cleanup(); }
});
for (const failure of ['pi prompt response timeout', 'stdin write failed']) test(`HTTP ${failure}: unknown and durable fence before response headers (M1, M6)`, async () => {
  const f = fixture(), server = router(f.supervisor); try {
    await listenPrivate(server, join(f.dir, 'socket'));
    const w = await f.create(); f.hosts[0]!.failure = new Error(failure);
    const r = await new Promise<Receipt>((resolve, reject) => {
      const data = JSON.stringify({ ...binding(w, 'uncertain'), message: 'hello' });
      const req = request({ socketPath: join(f.dir, 'socket'), method: 'POST', path: `/v0/workers/${w.worker_id}/prompt`, headers: { ...f.headers, 'Content-Type': 'application/json' } }, res => {
        try {
          // Inspect disk as headers arrive, before the HTTP result promise resolves.
          const persisted = latestWorker(f.journal.file, w.worker_id);
          assert.equal(persisted.fence?.command_id, 'uncertain');
          assert.equal(persisted.execution?.state, 'outcome_unknown');
          assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'uncertain');
          assert.equal(res.statusCode, 200);
        } catch (error) { res.resume(); reject(error); return; }
        let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
        res.on('end', () => resolve(JSON.parse(text) as Receipt)); res.on('error', reject);
      });
      req.on('error', reject); req.end(data);
    });
    assert.equal(r.state, 'outcome_unknown');
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...binding(w, 'next'), message: 'no' }), /session_fenced/);
    assert.equal(f.hosts[0]!.prompts, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
});
test('Pi exit fences an admitted run durably without rewriting delivered admission (M9)', async () => {
  const f = fixture(); try {
    const w = await f.create(), p = { ...binding(w, 'running'), message: 'hi' };
    const delivered = await f.supervisor.prompt(w.worker_id, p);
    f.hosts[0]!.emit('exit');
    assert.equal(latestWorker(f.journal.file, w.worker_id).fence?.command_id, 'running');
    assert.equal(latestWorker(f.journal.file, w.worker_id).execution?.state, 'outcome_unknown');
    assert.deepEqual(await f.supervisor.prompt(w.worker_id, p), delivered);
  } finally { f.cleanup(); }
});
test('unknown stop never replaces the prompt fence; two restarts preserve fence and delivered receipt', async () => {
  const f = fixture(); try {
    const w = await f.create();
    const delivered = await f.supervisor.prompt(w.worker_id, { ...binding(w, 'active'), message: 'hi' });
    f.hosts[0]!.stopOk = false;
    assert.equal((await f.supervisor.stop(w.worker_id, binding(w, 'unknown-stop'))).state, 'outcome_unknown');
    const fence = f.supervisor.get(w.worker_id).fence; assert.equal(fence?.command_id, 'active');
    for (let i = 0; i < 2; i++) {
      const log = new Journal(f.journal.file);
      try {
        const next = new Supervisor(f.dir, log, '1.5.2', () => { assert.fail('no replay'); });
        await next.recover();
        assert.deepEqual(next.get(w.worker_id).fence, fence);
        assert.deepEqual(next.receipts.all.get('active'), delivered);
      } finally { log.close(); }
    }
  } finally { f.cleanup(); }
});
for (const failure of ['journal', 'header']) test(`${failure} failure in a Pi event faults only that worker and keeps inventory readable`, async () => {
  const f = fixture(); try {
    const w = await f.create(), healthy = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...binding(w, 'active'), message: 'hi' });
    if (failure === 'journal') f.journal.failed = true;
    else writeFileSync(f.hosts[0]!.file, JSON.stringify({ type: 'session', id: 'wrong-header' }) + '\n');
    assert.doesNotThrow(() => f.hosts[0]!.emit('event', { type: 'agent_settled' }));
    await new Promise<void>(r => setImmediate(r));
    assert.ok(f.hosts[0]!.stops > 0); assert.equal(f.hosts[1]!.stops, 0);
    assert.equal(f.supervisor.get(w.worker_id).status, 'failed');
    assert.equal(f.supervisor.get(w.worker_id).fence, null, 'observed settlement is not a new uncertainty');
    assert.equal(f.supervisor.list().find(x => x.worker_id === healthy.worker_id)?.status, 'ready');
    assert.equal(f.supervisor.hello().protocol.major, 0);
    if (failure === 'journal') await assert.rejects(f.supervisor.prompt(healthy.worker_id, { ...binding(healthy, 'blocked'), message: 'no' }), /journal_failed/);
    else assert.equal((await f.supervisor.prompt(healthy.worker_id, { ...binding(healthy, 'allowed'), message: 'yes' })).state, 'delivered');
  } finally { f.cleanup(); }
});
test('validation refusals consume no durable storage, ordinary capacity never blocks termination', async () => {
  const f = fixture(); try {
    const w = await f.create(), before = readFileSync(f.journal.file);
    for (let i = 0; i < 520; i++) await assert.rejects(f.supervisor.prompt(w.worker_id, { ...binding(w, `stale-${i}`), binding_revision: 99, message: 'no' }), /stale_binding/);
    assert.deepEqual(readFileSync(f.journal.file), before); assert.equal(f.supervisor.receipts.all.size, 1);
    // Fill the real ordinary quota with accepted/handled no-run commands.
    f.hosts[0]!.request = async c => c.type === 'prompt' ? { type: 'response', id: 'x', success: true, data: { disposition: 'handled' } } : assert.fail('unexpected');
    for (let i = 0; i < 511; i++) assert.equal((await f.supervisor.prompt(w.worker_id, { ...binding(w, `handled-${i}`), message: 'hi' })).state, 'delivered');
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...binding(w, 'full'), message: 'no' }), /receipt_capacity/);
    assert.equal((await f.supervisor.stop(w.worker_id, binding(w, 'stop'))).state, 'delivered');
  } finally { f.cleanup(); }
});
test('failed create preserves the same group-only cleanup and cwd reservation as stop (m-1)', async () => {
  const f = fixture(h => { h.badState = true; }); try {
    const cwd = join(f.dir, 'failed-cwd'); mkdirSync(cwd);
    const c = { command_id: 'failed-create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    assert.equal((await f.supervisor.create(c)).state, 'outcome_unknown');
    const w = f.supervisor.list()[0]!;
    assert.equal(w.status, 'failed'); assert.match(w.cleanup, /escaped_descendants_unproven/);
    await assert.rejects(f.supervisor.create({ ...c, command_id: 'replacement' }), /exclusive_environment_already_bound/);
    assert.equal(f.hosts.length, 1);
  } finally { f.cleanup(); }
});
test('unsupported UI dialogs auto-cancel without resolver-consumed claims (m-2)', async () => {
  const f = fixture(); try {
    const w = await f.create(), h = f.hosts[0]!;
    for (const [i, method] of ['select', 'confirm', 'input', 'editor'].entries()) h.emit('event', { type: 'extension_ui_request', id: `q-${i}`, method });
    assert.equal(f.supervisor.get(w.worker_id).pending_interactions.length, 4);
    await new Promise<void>(r => setImmediate(r));
    assert.deepEqual(h.cancellations, ['q-0', 'q-1', 'q-2', 'q-3']);
    assert.deepEqual(f.supervisor.get(w.worker_id).pending_interactions, []);
  } finally { f.cleanup(); }
});
for (const end of ['tool_execution_end', 'agent_settled', 'expiry']) test(`pending unsupported interactions close on ${end} (m-2)`, async () => {
  const f = fixture(h => { h.holdCancellation = true; }); try {
    const w = await f.create(), h = f.hosts[0]!;
    h.emit('event', { type: 'extension_ui_request', id: 'q', method: 'input', timeout: end === 'expiry' ? 5 : 30000 });
    assert.equal(f.supervisor.get(w.worker_id).pending_interactions.length, 1);
    if (end === 'expiry') await new Promise<void>(r => setTimeout(r, 20));
    else h.emit('event', { type: end });
    assert.deepEqual(f.supervisor.get(w.worker_id).pending_interactions, []);
  } finally { f.cleanup(); }
});
test('pending unsupported dialogs are bounded and cancellation failure faults closed (m-2)', async () => {
  const f = fixture(h => { h.holdCancellation = true; }); try {
    const w = await f.create(), h = f.hosts[0]!;
    for (let i = 0; i < 33; i++) h.emit('event', { type: 'extension_ui_request', id: `q-${i}`, method: 'select' });
    await new Promise<void>(r => setImmediate(r));
    assert.equal(f.supervisor.get(w.worker_id).status, 'failed');
    assert.deepEqual(f.supervisor.get(w.worker_id).pending_interactions, []);
    assert.equal(h.cancellations.length, 32);
  } finally { f.cleanup(); }
  const g = fixture(); try {
    const w = await g.create(), h = g.hosts[0]!;
    h.cancelUI = async () => { throw new Error('stdin failure'); };
    h.emit('event', { type: 'extension_ui_request', id: 'q', method: 'confirm' });
    await new Promise<void>(r => setImmediate(r));
    assert.equal(g.supervisor.get(w.worker_id).status, 'failed');
    assert.deepEqual(g.supervisor.get(w.worker_id).pending_interactions, []);
  } finally { g.cleanup(); }
});
test('socket directory rejects symlink, public mode and foreign ownership before listening (M5)', async () => {
  const f = fixture(); try {
    const dir = join(f.dir, 'private'); mkdirSync(dir, { mode: 0o700 });
    const link = join(f.dir, 'link'); symlinkSync(dir, link);
    for (const path of [join(link, 'socket'), join(dir, 'socket')]) {
      if (path.startsWith(dir)) chmodSync(dir, 0o755);
      const server = router(f.supervisor);
      try { await assert.rejects(listenPrivate(server, path), /socket directory must/); }
      finally { server.closeAllConnections(); server.close(); }
    }
    chmodSync(dir, 0o700);
    if (process.getuid?.() === 0) chownSync(dir, 65534, 65534);
    const foreign = process.getuid?.() === 0 ? dir : '/root';
    const server = router(f.supervisor);
    try { await assert.rejects(listenPrivate(server, join(foreign, 'a0-refusal-test.sock')), /socket directory must/); }
    finally { server.closeAllConnections(); server.close(); }
  } finally { f.cleanup(); }
});
test('reads publish derived history in memory without journal writes or stopping workers (N-1)', async () => {
  const f = fixture(); try {
    const w = await f.create(), frames: unknown[] = [];
    const detach = f.supervisor.require(w.worker_id).hub.attach(() => f.supervisor.get(w.worker_id), null, x => frames.push(x));
    const before = readFileSync(f.journal.file);
    writeFileSync(f.hosts[0]!.file, readFileSync(f.hosts[0]!.file, 'utf8') + JSON.stringify({ type: 'message', id: 'new-leaf', parentId: null }) + '\n');
    f.journal.failed = true;
    assert.equal(f.supervisor.get(w.worker_id).leaf_id, 'new-leaf');
    f.supervisor.list(); detach();
    assert.deepEqual(readFileSync(f.journal.file), before);
    assert.equal(f.hosts[0]!.stops, 0);
    assert.ok(frames.some(x => (x as { evidence?: string }).evidence === 'observed_memory'));
  } finally { f.cleanup(); }
});
test('fault after settlement never fences the settled execution (N-2)', async () => {
  const f = fixture(); try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...binding(w, 'done'), message: 'hi' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    writeFileSync(f.hosts[0]!.file, JSON.stringify({ type: 'session', id: 'wrong' }) + '\n');
    f.supervisor.get(w.worker_id);
    await new Promise<void>(r => setImmediate(r));
    assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'settled');
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
  } finally { f.cleanup(); }
});
test('restart 1 and restart 2 cannot reuse transport epochs (T-1)', async () => {
  const f = fixture(); try {
    const w = await f.create(); let cursor: import('../types.js').Cursor | undefined;
    for (let i = 0; i < 3; i++) {
      const log = new Journal(f.journal.file);
      try {
        const s = new Supervisor(f.dir, log, '1.5.2', () => { assert.fail('no replay'); }); await s.recover();
        const old = cursor;
        s.require(w.worker_id).hub.attach(() => s.get(w.worker_id), old ?? null, frame => {
          if (old) { assert.notEqual(frame.cursor.worker_epoch, old.worker_epoch); assert.equal((frame as import('../types.js').Snapshot).resync_reason, 'epoch'); }
          cursor = frame.cursor;
        })();
      } finally { log.close(); }
    }
  } finally { f.cleanup(); }
});
test('B2 SSE ends a slow subscriber with explicit overflow after bounded queue (M4)' , async () => {
  const f = fixture(), server = router(f.supervisor); let connection: ReturnType<typeof request> | undefined;
  try {
    const w = await f.create(); await listenPrivate(server, join(f.dir, 'socket'));
    let response!: import('node:http').ServerResponse;
    server.on('request', (_req, res) => { response = res; });
    await new Promise<void>((resolve, reject) => {
      connection = request({ socketPath: join(f.dir, 'socket'), path: `/v0/events?worker_id=${w.worker_id}`, headers: f.headers }, res => {
        res.once('data', () => { res.pause(); resolve(); }); res.on('error', () => {});
      }); connection.on('error', reject); connection.end();
    });
    for (let i = 0; i < 200; i++) f.supervisor.require(w.worker_id).hub.publish('payload', { text: 'x'.repeat(15000) });
    assert.equal(response.writableEnded, true, 'overflow must end the stream and force resnapshot');
    assert.equal(f.supervisor.get(w.worker_id).status, 'ready');
    // Reads still work after dropping only the slow subscriber.
    assert.equal((await new Client(join(f.dir, 'socket')).call('hello')).protocol.major, 0);
  } finally { connection?.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
});
