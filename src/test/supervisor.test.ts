import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { EventHub } from '../events.js';
import { SessionIndex } from '../session.js';
import { router, listenPrivate } from '../server.js';
import { Client } from '../client.js';
import type { SessionHost, PiRecord, PiResponse } from '../host.js';
import type { Worker, Snapshot, WorkerEvent, Binding } from '../types.js';
class FakeHost extends EventEmitter implements SessionHost {
  readonly pid = undefined; readonly token = null; prompts = 0;
  constructor(readonly file: string, readonly sessionId: string) { super(); }
  async request(command: PiRecord): Promise<PiResponse> {
    if (command.type === 'get_state') return { type: 'response', id: 'test', success: true, data: { sessionId: this.sessionId, sessionFile: this.file } };
    this.prompts++; this.emit('event', { type: 'agent_start' });
    return { type: 'response', id: 'test', success: true, data: { disposition: 'started' } };
  }
  async stop(): Promise<boolean> { this.emit('exit'); return true; }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'a0-supervisor-')); const cwd = join(dir, 'work'); mkdirSync(cwd);
  const file = join(dir, 'session.jsonl'); writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'native-header' }) + '\n');
  const host = new FakeHost(file, 'native-header'), journal = new Journal(join(dir, 'journal'));
  const supervisor = new Supervisor(dir, journal, '1.5.2', () => host);
  return { dir, cwd, file, host, journal, supervisor, cleanup: () => { journal.close(); rmSync(dir, { recursive: true }); } };
}
const create = (cwd: string) => ({ command_id: 'create', cwd, provider: 'test', model: 'test', thinking: 'off' as const });
function asBinding(w: Worker, command_id: string): Binding { return { command_id, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision }; }
test('SSE attach barrier: snapshot is first, no duplicate or missing event under reentrant emission', async () => {
  const f = setup(); try {
    const r = await f.supervisor.create(create(f.cwd)), w = f.supervisor.get(r.worker_id!);
    const hub = new EventHub(w.worker_epoch, 2); hub.publish('before', {});
    const frames: (Snapshot | WorkerEvent)[] = [];
    const detach = hub.attach(() => w, null, frame => { frames.push(frame); if (frame.type === 'snapshot') hub.publish('during', {}); });
    hub.publish('after', {}); detach(); hub.publish('detached', {});
    assert.deepEqual(frames.map(x => x.type), ['snapshot', 'during', 'after']);
    assert.deepEqual(frames.map(x => x.cursor.seq), [1, 2, 3]);
    const snapshot = frames[0] as Snapshot;
    assert.equal(snapshot.history.evidence, 'pi_session_file');
    assert.equal(snapshot.worker.session_id, 'native-header');
    const reattached: (Snapshot | WorkerEvent)[] = [];
    hub.attach(() => w, snapshot.cursor, frame => reattached.push(frame))();
    assert.equal((reattached[0] as Snapshot).resync_reason, 'evicted'); assert.equal(reattached.length, 1);
    hub.attach(() => w, { worker_epoch: 'old', seq: 1 }, frame => assert.equal((frame as Snapshot).resync_reason, 'epoch'))();
  } finally { f.cleanup(); }
});
test('public HTTP/CLI client: identity, duplicate, stale binding, admission distinct from settlement, history, detach, stop', async () => {
  const f = setup(), server = router(f.supervisor); const socket = join(f.dir, 'worker.sock');
  try {
    await listenPrivate(server, socket); assert.equal(statSync(socket).mode & 0o777, 0o600); assert.equal(statSync(f.dir).mode & 0o777, 0o700);
    const client = new Client(socket);
    assert.equal((await client.call('hello')).pi_version, '1.5.2');
    const created = await client.call('workers.create', { body: create(f.cwd) });
    assert.deepEqual(await client.call('workers.create', { body: create(f.cwd) }), created);
    const id = created.worker_id!, w = await client.call('workers.get', { id });
    assert.equal(w.session_id, 'native-header'); assert.equal(w.session_identity_evidence, 'pi_session_file');
    const stale = await client.call('sessions.prompt', { id, body: { ...asBinding(w, 'stale'), binding_revision: 2, message: 'hello' } });
    assert.equal(stale.state, 'rejected'); assert.equal(stale.effect, 'no_effect'); assert.equal(f.host.prompts, 0);
    const body = { ...asBinding(w, 'prompt'), message: 'hello' };
    const first = await client.call('sessions.prompt', { id, body });
    assert.equal(first.admission, 'accepted'); assert.equal(first.stage, 'forwarded'); assert.equal(first.history_lag, true);
    assert.equal((await client.call('workers.get', { id })).execution?.state, 'started');
    assert.deepEqual(await client.call('sessions.prompt', { id, body }), first); assert.equal(f.host.prompts, 1);
    await assert.rejects(client.call('sessions.prompt', { id, body: { ...body, message: 'conflict' } }), /command_id_conflict/);
    await client.watch(id, frame => { assert.equal(frame.type, 'snapshot'); return false; });
    assert.equal((await client.call('workers.get', { id })).foreground, 'running');
    // agent_end is explicitly NOT settlement.
    f.host.emit('event', { type: 'agent_end' }); assert.equal(f.supervisor.get(id).execution?.state, 'started');
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + JSON.stringify({ type: 'message', id: 'entry-1', parentId: null, message: { role: 'assistant', content: [] } }) + '\n');
    f.host.emit('event', { type: 'message_end' }); f.host.emit('event', { type: 'agent_settled' });
    assert.equal((await client.call('workers.get', { id })).execution?.state, 'settled');
    const history = await client.call('history.page', { id }); assert.equal(history.entries.length, 1); assert.equal(history.watermark, 'entry-1');
    assert.equal(f.supervisor.get(id).history.lag, false);
    const stopped = await client.call('workers.stop', { id, body: asBinding(w, 'stop') });
    assert.equal(stopped.result?.termination, 'observed_stopped');
    const replacement = await client.call('workers.create', { body: { ...create(f.cwd), command_id: 'replacement' } });
    assert.equal(replacement.state, 'rejected'); assert.equal(replacement.error, 'exclusive_environment_already_bound');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
});
test('crash after admission while running: journal unknown/fence, no prompt replay, rejected future write', async () => {
  const f = setup(); try {
    const created = await f.supervisor.create(create(f.cwd)); const id = created.worker_id!, w = f.supervisor.get(id);
    const p = { ...asBinding(w, 'active'), message: 'do not duplicate' };
    const delivered = await f.supervisor.prompt(id, p); assert.equal(f.host.prompts, 1);
    const reopened = new Journal(f.journal.file);
    const recovered = new Supervisor(f.dir, reopened, '1.5.2', () => { throw new Error('MUST NOT replay'); });
    await recovered.recover();
    assert.deepEqual(recovered.receipts.all.get('active'), delivered);
    assert.equal(recovered.get(id).fence?.command_id, 'active');
    assert.equal(recovered.get(id).execution?.state, 'outcome_unknown');
    const refused = await recovered.prompt(id, { ...p, command_id: 'new' }); assert.equal(refused.state, 'rejected'); assert.equal(refused.effect, 'no_effect'); assert.equal(refused.uncertain_command_id, 'active');
    const again = await recovered.prompt(id, p); assert.deepEqual(again, delivered);
    const fence = recovered.get(id).fence;
    reopened.close();
    for (let restart = 0; restart < 2; restart++) {
      const log = new Journal(f.journal.file);
      const next = new Supervisor(f.dir, log, '1.5.2', () => { throw new Error('MUST NOT replay'); });
      await next.recover();
      assert.deepEqual(next.get(id).fence, fence);
      assert.deepEqual(next.receipts.all.get('active'), delivered);
      log.close();
    }
  } finally { f.cleanup(); }
});
test('execution reservation cut before dispatch stays no_effect on recovery', async () => {
  const f = setup(); try {
    const created = await f.supervisor.create(create(f.cwd)); const id = created.worker_id!, w = f.supervisor.get(id);
    const append = f.journal.append.bind(f.journal);
    const cut = join(f.dir, 'cut-journal');
    f.journal.append = (kind, value) => {
      // Snapshot a real append boundary: reserved execution, just BEFORE dispatch.
      if (kind === 'receipt' && value.command_id === 'reserved' && value.state === 'accepted') writeFileSync(cut, readFileSync(f.journal.file));
      append(kind, value);
    };
    await f.supervisor.prompt(id, { ...asBinding(w, 'reserved'), message: 'fixture' });
    const reopened = new Journal(cut);
    const recovered = new Supervisor(f.dir, reopened, '1.5.2', () => { throw new Error('no launch'); });
    await recovered.recover();
    assert.equal(recovered.receipts.all.get('reserved')?.effect, 'no_effect');
    assert.equal(recovered.receipts.all.get('reserved')?.state, 'intent_recovered');
    assert.throws(() => recovered.receipts.dispatch('reserved'), /owner resolution/);
    assert.equal(recovered.get(id).fence, null);
    assert.equal(recovered.get(id).execution?.disposition, 'no_effect_before_dispatch');
    reopened.close();
  } finally { f.cleanup(); }
});
test('history pages pin a branch watermark and ignore partial final JSONL', () => {
  const f = setup(); try {
    const records = [{ type: 'message', id: 'a', parentId: null }, { type: 'message', id: 'b', parentId: 'a' }, { type: 'message', id: 'branch', parentId: 'a' }];
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + records.map(r => JSON.stringify(r) + '\n').join('') + '{"partial":');
    const index = new SessionIndex(f.file);
    const page = index.page({ watermark: 'b', after: null }, 1); assert.ok(!('error' in page)); assert.equal(page.entries[0]?.id, 'a');
    const next = index.page(page.next!, 1); assert.ok(!('error' in next)); assert.equal(next.entries[0]?.id, 'b'); assert.equal(next.leafId, 'branch');
    assert.equal(index.headerId, 'native-header');
  } finally { f.cleanup(); }
});
