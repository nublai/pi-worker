/**
 * History (P1-8): `history.page` and `items.read` over B2. The public-client case is ported from A0
 * `src/test/supervisor.test.ts` with its assertions; the fixture host's session ids replace A0's `native-header`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, ClientFailure } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { SdkHost } from '../src/host/host.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import type { Worker } from '../src/supervisor/state.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { ITEM_MAX_BYTES } from '../src/supervisor/supervisor.js';
import { bind, fixture, type Fixture } from './supervisor-fixture.js';
import { ownerGrant, privateTmp } from './helpers.js';
import { domained } from './domains.js';
import { fakeProvider, providerExtension, realPiSupervisor, until } from './real-pi.js';

async function serve(f: Fixture): Promise<{ socket: string; grantFile: string; headers: Record<string, string>; close: () => Promise<void> }> {
  const owner = ownerGrant(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, piVersion: '1.5.2', grants: owner.grants }).handle);
  const socket = join(f.dir, 'worker.sock');
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

const entry = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => `${JSON.stringify({ type: 'message', id, parentId, message: { role: 'assistant', content: [] }, ...extra })}\n`;

test('history: public HTTP/CLI client: identity, duplicate, stale binding, admission distinct from settlement, history, detach, stop', { timeout: 20_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    assert.equal(statSync(s.socket).mode & 0o777, 0o600);
    assert.equal(statSync(f.dir).mode & 0o777, 0o700);
    const client = new Client({ socketPath: s.socket, grantFile: s.grantFile });
    assert.equal((await client.call('hello')).pi_version, '1.5.2');
    const cwd = join(f.dir, 'work');
    (await import('node:fs')).mkdirSync(cwd);
    const create = { command_id: 'create', cwd, provider: 'test', model: 'test', thinking: 'off' as const };
    const created = await client.call('workers.create', { body: create });
    assert.deepEqual(await client.call('workers.create', { body: create }), created);
    const id = created.worker_id!;
    const w = await client.call('workers.get', { path: { worker_id: id } });
    const host = f.hosts[0]!;
    assert.equal(w.session_id, host.sid);
    assert.equal(w.session_identity_evidence, 'pi_session_file');
    await assert.rejects(client.call('sessions.prompt', { path: { worker_id: id }, body: { ...bind(w, 'stale'), binding_revision: 2, message: 'hello' } }), /stale_binding/);
    assert.equal(host.prompts, 0);
    assert.equal(f.supervisor.receipts.all.has('stale'), false);
    const body = { ...bind(w, 'prompt'), message: 'hello' };
    const first = await client.call('sessions.prompt', { path: { worker_id: id }, body });
    assert.equal(first.admission, 'accepted');
    assert.equal(first.stage, 'forwarded');
    assert.equal(first.history_lag, true);
    assert.equal((await client.call('workers.get', { path: { worker_id: id } })).execution?.state, 'started');
    assert.deepEqual(await client.call('sessions.prompt', { path: { worker_id: id }, body }), first);
    assert.equal(host.prompts, 1);
    await assert.rejects(client.call('sessions.prompt', { path: { worker_id: id }, body: { ...body, message: 'conflict' } }), /command_id_conflict/);
    await client.watch(
      frame => {
        assert.equal(frame.type, 'snapshot');
        return false;
      },
      { workerIds: [id] },
    );
    assert.equal((await client.call('workers.get', { path: { worker_id: id } })).foreground, 'running');
    // agent_end is explicitly NOT settlement.
    host.emit('event', { type: 'agent_end' });
    assert.equal(f.supervisor.get(id).execution?.state, 'started');
    writeFileSync(host.file, readFileSync(host.file, 'utf8') + entry('entry-1', null));
    // The SDK child reports pi's active leaf after every append (host_leaf); the fixture host does it here.
    host.emit('event', { type: 'host_leaf', leafId: 'entry-1' });
    host.emit('event', { type: 'message_end' });
    host.emit('event', { type: 'agent_settled' });
    assert.equal((await client.call('workers.get', { path: { worker_id: id } })).execution?.state, 'settled');
    const history = await client.call('history.page', { path: { worker_id: id } });
    assert.equal(history.entries.length, 1);
    assert.equal(history.watermark, 'entry-1');
    assert.equal(f.supervisor.get(id).history.lag, false);
    const stopped = await client.call('workers.stop', { path: { worker_id: id }, body: bind(w, 'stop') });
    assert.equal(stopped.result?.termination, 'observed_stopped');
    // P2-1: the stop removed the worker's domain and recorded it, so the cwd is free again. A0 refused this replacement
    // under its process-group cleanup, which never proved the descendants gone; an unproven domain still refuses it
    // (security/containment.test.ts).
    assert.equal(f.supervisor.get(id).cleanup, 'cgroup_empty_removed');
    assert.equal((await client.call('workers.create', { body: { ...create, command_id: 'replacement' } })).state, 'delivered');
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('history: pages pin a watermark over B2, page by cursor, stub a too-large entry that items.read returns whole', { timeout: 20_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    const big = 'b'.repeat(300 * 1024);
    appendFileSync(host.file, entry('a', null) + entry('b', 'a', { text: big }) + entry('c', 'b') + entry('branch', 'a'));
    host.emit('event', { type: 'host_leaf', leafId: 'branch' });
    const client = new Client({ socketPath: s.socket, grantFile: s.grantFile });
    const path = { worker_id: w.worker_id };
    const first = await client.call('history.page', { path, query: { watermark: 'c', limit: 2 } });
    assert.deepEqual(
      first.entries.map(e => e.id),
      ['a', 'b'],
    );
    assert.equal(first.entries[1]!.too_large, true, 'an entry larger than a page is a stub');
    assert.deepEqual(first.next, { watermark: 'c', after: 'b' });
    const second = await client.call('history.page', { path, query: { watermark: 'c', after: 'b' } });
    assert.deepEqual(
      second.entries.map(e => e.id),
      ['c'],
    );
    assert.equal(second.next, null);
    assert.equal(second.leafId, 'branch', 'later appends never move a pinned watermark');
    const item = await client.call('items.read', { path: { ...path, entry_id: 'b' } });
    assert.equal(item.entry.text, big);
    assert.equal(item.evidence, 'pi_session_file');
    assert.ok(item.bytes > big.length);
    const refused = async (call: Promise<unknown>, error: string, status: number) => {
      await assert.rejects(call, (e: unknown) => e instanceof ClientFailure && e.message === error && e.effect === 'no_effect' && e.status === status && !JSON.stringify(e.details).includes('nowhere'));
    };
    await refused(client.call('history.page', { path, query: { watermark: 'nowhere' } }), 'history_cursor_not_on_session_path', 400);
    await refused(client.call('history.page', { path, query: { watermark: 'c', after: 'nowhere' } }), 'history_cursor_not_on_session_path', 400);
    await refused(client.call('history.page', { path, query: { after: 'a' } }), 'after_requires_watermark', 400);
    await refused(client.call('items.read', { path: { ...path, entry_id: 'nowhere' } }), 'unknown_entry', 409);
    appendFileSync(host.file, entry('huge', 'c', { text: 'h'.repeat(ITEM_MAX_BYTES) }));
    await refused(client.call('items.read', { path: { ...path, entry_id: 'huge' } }), 'entry_too_large', 409);
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('history: a dialog recorded in the session file never creates a live interaction', { timeout: 20_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const w = await f.create();
    appendFileSync(f.hosts[0]!.file, `${JSON.stringify({ type: 'custom', id: 'old-dialog', parentId: null, customType: 'extension_ui_request', data: { method: 'select', id: 'native-old', options: ['a'] } })}\n`);
    f.hosts[0]!.emit('event', { type: 'host_leaf', leafId: 'old-dialog' });
    const client = new Client({ socketPath: s.socket, grantFile: s.grantFile });
    const page = await client.call('history.page', { path: { worker_id: w.worker_id } });
    assert.equal(page.entries.at(-1)?.id, 'old-dialog');
    let pending: unknown[] = ['unset'];
    await client.watch(
      frame => {
        if (frame.type === 'snapshot') pending = frame.workers[0]!.pending_interactions;
        return false;
      },
      { workerIds: [w.worker_id] },
    );
    assert.deepEqual(pending, []);
    assert.deepEqual(f.supervisor.get(w.worker_id).pending_interactions, []);
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('history: an SDK leaf that is not in the session file is never advertised as file history; lag says it is pending', { timeout: 20_000 }, async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    appendFileSync(host.file, entry('old', null));
    host.emit('event', { type: 'host_leaf', leafId: 'old' });
    assert.deepEqual(f.supervisor.get(w.worker_id).history, { last_entry_id: 'old', lag: false, evidence: 'pi_session_file' });
    // pi selected an entry it has not written yet (the SDK leaf runs ahead of the file).
    host.emit('event', { type: 'host_leaf', leafId: 'not-on-disk' });
    const row = f.supervisor.get(w.worker_id);
    assert.equal(row.leaf_id, 'not-on-disk', "the row's leaf is pi's selection");
    assert.deepEqual(row.history, { last_entry_id: 'old', lag: true, evidence: 'pi_session_file' }, 'the marker is the newest verified entry, and lag is true');
    let snapshot: Worker['history'] | undefined;
    f.supervisor
      .subscribe(frame => {
        if (frame.type === 'snapshot') snapshot = frame.workers[0]!.history;
      })
      .close();
    assert.deepEqual(snapshot, row.history);
    const page = f.supervisor.history(w.worker_id, {});
    assert.equal(page.watermark, 'old', 'the default page pins the verified watermark');
    assert.deepEqual(page.entries.map(e => e.id), ['old']);
    // Once pi writes it, the marker catches up.
    appendFileSync(host.file, entry('not-on-disk', 'old'));
    assert.deepEqual(f.supervisor.get(w.worker_id).history, { last_entry_id: 'not-on-disk', lag: false, evidence: 'pi_session_file' });
  } finally {
    f.cleanup();
  }
});

const FAUX = `import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
export default pi => {
  const core = createFauxCore({ provider: 'faux', models: [{ id: 'faux-1' }] });
  core.setResponses([fauxAssistantMessage('scripted reply')]);
  pi.registerProvider('faux', { baseUrl: 'http://127.0.0.1:9', apiKey: 'faux', api: core.api, streamSimple: core.streamSimple,
    models: [{ id: 'faux-1', name: 'faux', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
};
`;

test('history (real pi): a fresh worker reads as empty history, not a bad cursor; its snapshot claims no unwritten entry', { timeout: 90_000 }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const state = join(root, 'state');
  const agent = join(root, 'agent');
  for (const dir of [cwd, state, join(agent, 'extensions')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agent, 'extensions', 'faux.ts'), FAUX);
  const opened = openState(state);
  const owner = ownerGrant(state);
  const s = new Supervisor(domained({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: state,
    grants: owner.grants,
    factory: launch =>
      new SdkHost(
        { cwd: launch.cwd, sessionDir: launch.sessionDir, provider: launch.create.provider, model: launch.create.model, thinking: launch.create.thinking, projectTrusted: false },
        { env: { PATH: process.env.PATH, HOME: agent, PI_CODING_AGENT_DIR: agent } },
      ),
  }));
  try {
    const api = createMemoryTransport(createApp({ supervisor: s, grants: owner.grants }).handle, owner.headers);
    const created = await api.request('POST', '/b2/workers', { json: { command_id: 'create', cwd, provider: 'faux', model: 'faux-1', thinking: 'off' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = (created.body as { worker_id: string }).worker_id;
    const w = (await api.request('GET', `/b2/workers/${id}`)).body as Worker;
    assert.equal(w.status, 'ready');
    assert.equal(existsSync(s.state.require(id).sessionFile!), false, 'pi keeps setup entries in memory until the first message');
    assert.equal(typeof w.leaf_id, 'string', 'pi has a selected leaf');
    assert.deepEqual(w.history, { last_entry_id: null, lag: true, evidence: 'pi_session_file' });
    const fresh = await api.request('GET', `/b2/workers/${id}/history`);
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.deepEqual(fresh.body, { entries: [], watermark: null, next: null, leafId: null, truncated: false, evidence: 'pi_session_file' });
    const snapshot = ((await api.request('GET', '/b2/events')).body as { type: string; workers: Worker[] }[])[0]!;
    assert.equal(snapshot.type, 'snapshot');
    assert.deepEqual(snapshot.workers[0]!.history, w.history);
    // After one scripted turn pi has written the file: the default page reads it, pinned at the verified leaf. A client
    // that reads history as soon as it sees `execution.settled` gets the turn: the row already names pi's final leaf
    // (the settlement stamp) when the event is published, never the setup entry pi selected before the turn.
    let atSettle: { leaf_id: string | null; history: Worker['history'] } | undefined;
    let settledNow!: () => void;
    const settled = new Promise<void>(resolve => (settledNow = resolve));
    const sub = s.subscribe(
      frame => {
        if (frame.type !== 'execution.settled') return;
        const row = s.state.require(id).worker;
        atSettle = { leaf_id: row.leaf_id, history: structuredClone(row.history) };
        settledNow();
      },
      { workerIds: [id] },
    );
    assert.equal((await api.request('POST', `/b2/workers/${id}/prompt`, { json: { command_id: 'p', worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision, message: 'hi' } })).status, 200);
    await settled;
    sub.close();
    const after = (await api.request('GET', `/b2/workers/${id}`)).body as Worker;
    assert.equal(after.execution?.state, 'settled');
    assert.equal(after.history.lag, false);
    assert.equal(after.history.last_entry_id, after.leaf_id);
    const file = readFileSync(s.state.require(id).sessionFile!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string; customType?: string });
    assert.equal(file.at(-1)!.customType, 'agent_settled', 'the settlement stamp is the last entry of the turn');
    assert.deepEqual(atSettle, { leaf_id: file.at(-1)!.id, history: { last_entry_id: file.at(-1)!.id, lag: false, evidence: 'pi_session_file' } }, 'at execution.settled the row names the leaf after the turn');
    assert.equal(after.leaf_id, file.at(-1)!.id);
    const page = (await api.request('GET', `/b2/workers/${id}/history`)).body as { entries: { id: string; type: string }[]; watermark: string };
    assert.equal(page.watermark, after.leaf_id);
    assert.ok(page.entries.some(e => e.type === 'message'));
  } finally {
    await s.shutdown();
    opened.close();
    tmp.cleanup();
  }
});

test('history (real pi): a rename, a thinking change, a model selection, a compaction, a handled command or a handled prompt with no new turn each move the row to the entry pi appended (#51)', { timeout: 90_000 }, async () => {
  const provider = await fakeProvider();
  const native = `export default pi => {
  pi.registerCommand('native', { handler: async (args, ctx) => (args === 'think' ? pi.setThinkingLevel('high') : args === 'label' ? pi.setLabel(ctx.sessionManager.getLeafId(), 'marked') : pi.setSessionName(args)) });
  pi.on('input', event => (event.text === 'noop' ? { action: 'handled' } : undefined));
};\n`;
  const f = realPiSupervisor({ 'provider.ts': providerExtension(provider.url).replace('reasoning: false', 'reasoning: true'), 'native.ts': native });
  try {
    writeFileSync(join(f.agent, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    const id = await f.create();
    for (const n of [1, 2]) {
      await f.s.prompt(id, { ...bind(f.s.get(id), `turn-${n}`), message: `turn ${n}: ${'words '.repeat(200)}` });
      await until(() => f.s.get(id).foreground === 'idle' && f.s.get(id).execution?.state === 'settled', 20_000, `turn ${n}`);
    }
    const file = f.s.state.require(id).sessionFile!;
    const movedTo = async (type: string, change: () => Promise<{ state: string }>) => {
      const before = f.s.get(id).leaf_id;
      const receipt = await change();
      assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
      const entries = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string; id: string });
      const appended = entries.slice(entries.findIndex(e => e.id === before) + 1).map(e => e.type);
      assert.ok(appended.includes(type), `pi appended ${type}: ${appended.join(', ')}`);
      const row = f.s.get(id);
      assert.deepEqual([row.leaf_id, row.history], [entries.at(-1)!.id, { last_entry_id: entries.at(-1)!.id, lag: false, evidence: 'pi_session_file' }], `after ${type} the row names pi's leaf`);
    };
    await movedTo('session_info', () => f.s.configure(id, { ...bind(f.s.get(id), 'rename'), name: 'Renamed chat' }));
    assert.equal(f.s.get(id).title, 'Renamed chat');
    await movedTo('session_info', () => f.s.invoke(id, { ...bind(f.s.get(id), 'native-rename'), name: 'native', args: 'Renamed natively' }));
    assert.equal(f.s.get(id).title, 'Renamed natively');
    await movedTo('thinking_level_change', () => f.s.invoke(id, { ...bind(f.s.get(id), 'native-think'), name: 'native', args: 'think' }));
    assert.equal(f.s.get(id).thinking, 'high');
    await movedTo('model_change', () => f.s.configure(id, { ...bind(f.s.get(id), 'model'), model: { provider: 'piw-test', id: 'echo' } }));
    await movedTo('compaction', () => f.s.compact(id, bind(f.s.get(id), 'compact')));
    await movedTo('label', () => f.s.invoke(id, { ...bind(f.s.get(id), 'native-label'), name: 'native', args: 'label' }));
    await movedTo('custom', () => f.s.prompt(id, { ...bind(f.s.get(id), 'noop'), message: 'noop' }));
  } finally {
    await f.cleanup();
    await provider.close();
  }
});

test('history (real pi): a configure whose model hook moved pi to another session reports no leaf of the old one (#51)', { timeout: 90_000 }, async () => {
  const provider = await fakeProvider();
  const hook = `let stash;
export default pi => {
  pi.registerCommand('stash', { handler: async (_args, ctx) => { stash = ctx; } });
  pi.on('model_select', async () => {
    const first = stash.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'assistant');
    await stash.fork(first.id, { position: 'at' });
  });
};\n`;
  const models = providerExtension(provider.url).replace("models: [{", "models: [{ id: 'other', name: 'Other', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }, {");
  const f = realPiSupervisor({ 'provider.ts': models, 'hook.ts': hook });
  try {
    const id = await f.create();
    for (const n of [1, 2]) {
      await f.s.prompt(id, { ...bind(f.s.get(id), `turn-${n}`), message: `turn ${n}` });
      await until(() => f.s.get(id).foreground === 'idle' && f.s.get(id).execution?.state === 'settled', 20_000, `turn ${n}`);
    }
    assert.equal((await f.s.invoke(id, { ...bind(f.s.get(id), 'stash'), name: 'stash' })).state, 'delivered');
    const before = f.s.get(id);
    const receipt = await f.s.configure(id, { ...bind(before, 'model'), model: { provider: 'piw-test', id: 'other' } });
    assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
    await until(() => f.s.get(id).binding_revision === before.binding_revision + 1, 10_000, 'the native fork');
    const file = f.s.state.require(id).sessionFile!;
    const tail = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string }).at(-1)!.id;
    assert.deepEqual([f.s.get(id).leaf_id, f.s.get(id).history.last_entry_id], [tail, tail], 'the row names the forked session’s leaf');
  } finally {
    await f.cleanup();
    await provider.close();
  }
});

test('history (real pi): a configure or command that forks and appends in withSession is delivered with the row on pi’s leaf (#51)', { timeout: 90_000 }, async () => {
  const provider = await fakeProvider();
  const hook = `let stash;
const forkWithMessage = async ctx => {
  const first = ctx.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'assistant');
  await ctx.fork(first.id, { position: 'at', withSession: async next => next.sendMessage({ customType: 'after-fork', content: 'after fork', display: false }, { triggerTurn: false }) });
};
export default pi => {
  pi.registerCommand('stash', { handler: async (_args, ctx) => { stash = ctx; } });
  pi.registerCommand('forkmsg', { handler: async (_args, ctx) => forkWithMessage(ctx) });
  pi.on('model_select', async () => forkWithMessage(stash));
};\n`;
  const models = providerExtension(provider.url).replace("models: [{", "models: [{ id: 'other', name: 'Other', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }, {");
  const f = realPiSupervisor({ 'provider.ts': models, 'hook.ts': hook });
  try {
    const id = await f.create();
    for (const n of [1, 2]) {
      await f.s.prompt(id, { ...bind(f.s.get(id), `turn-${n}`), message: `turn ${n}` });
      await until(() => f.s.get(id).foreground === 'idle' && f.s.get(id).execution?.state === 'settled', 20_000, `turn ${n}`);
    }
    assert.equal((await f.s.invoke(id, { ...bind(f.s.get(id), 'stash'), name: 'stash' })).state, 'delivered');
    const atDelivered = async (what: string, run: () => Promise<{ state: string }>) => {
      const receipt = await run();
      assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
      const entries = readFileSync(f.s.state.require(id).sessionFile!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string; customType?: string });
      assert.equal(entries.at(-1)!.customType, 'after-fork', `${what}: the withSession message is pi's last entry`);
      const row = f.s.get(id);
      assert.deepEqual([row.leaf_id, row.history.last_entry_id], [entries.at(-1)!.id, entries.at(-1)!.id], `${what}: at delivered the row names pi's leaf`);
    };
    await atDelivered('configure', () => f.s.configure(id, { ...bind(f.s.get(id), 'model'), model: { provider: 'piw-test', id: 'other' } }));
    await atDelivered('invoke', () => f.s.invoke(id, { ...bind(f.s.get(id), 'forkmsg'), name: 'forkmsg' }));
  } finally {
    await f.cleanup();
    await provider.close();
  }
});
