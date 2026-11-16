/**
 * History (P1-8): `history.page` and `items.read` over B2. The public-client case is ported from A0
 * `src/test/supervisor.test.ts` with its assertions; the fixture host's session ids replace A0's `native-header`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, ClientFailure } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { ITEM_MAX_BYTES } from '../src/supervisor/supervisor.js';
import { bind, fixture, type Fixture } from './supervisor-fixture.js';
import { ownerGrant } from './helpers.js';

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
    await assert.rejects(client.call('workers.create', { body: { ...create, command_id: 'replacement' } }), /exclusive_environment_already_bound/);
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
