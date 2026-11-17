/**
 * Phone inventory (P1-14, contract 8.1, Shep's answers S-1, S-6, S-8): worker row fields, `sessions.list` and
 * `sessions.get` over the resume catalog, `sessions.history` (complete session-file lines by byte range, with or
 * without a worker, reset and typed offset errors, the watermark `history.appended` carries), the router's checks on
 * an ndjson reply, and configurable socket group access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { jpegBytes } from './images.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client, ClientFailure } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport, type MemoryResponse } from '../src/b2/memory.js';
import { createRouter } from '../src/b2/router.js';
import type { Handlers } from '../src/b2/types.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { resolveSocketAccess } from '../src/config.js';
import { INTERRUPT_MARKER } from '../src/history/session-file.js';
import type { EventFrame } from '../src/generated/events.js';
import { error as validateError } from '../src/generated/validators.js';
import { GrantStore } from '../src/grants/store.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';
import { ownerGrant, privateTmp } from './helpers.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const at = (ts: string, extra: Record<string, unknown>) => `${JSON.stringify({ timestamp: ts, ...extra })}\n`;
const user = (id: string, parentId: string | null, text: string, ts: string) => at(ts, { type: 'message', id, parentId, message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (id: string, parentId: string | null, text: string, ts: string, model = 'm', cost = 0.01, tokens = 10) =>
  at(ts, {
    type: 'message',
    id,
    parentId,
    message: { role: 'assistant', provider: 'p', model, content: [{ type: 'text', text }, { type: 'toolCall', id: 't', name: 'read', arguments: {} }], usage: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { total: cost } }, stopReason: 'stop' },
  });

function api(f: Fixture, grants?: GrantStore, headers?: Record<string, string>) {
  const owner = grants ? { grants, headers: headers! } : ownerGrant(f.dir);
  return { memory: createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers), grants: owner.grants };
}

const history = (memory: ReturnType<typeof api>['memory'], session: string, q: Record<string, string | number> = {}) =>
  memory.request('GET', `/b2/sessions/${session}/history?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`);

test('inventory: worker rows carry the phone fields (status_since, settle count, lineage, repo label, title, preview without the marker, activity)', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, '.git'));
    const w = await f.create();
    const live = f.supervisor.state.require(w.worker_id);
    assert.equal(w.lineage, 'root');
    assert.equal(w.repo_label, f.dir.split('/').at(-1), 'the Git work tree holding the cwd names the row');
    assert.equal(w.settle_count, 0);
    assert.deepEqual(w.model, { provider: 'p', id: 'm' });
    assert.equal(w.thinking, 'off');
    assert.ok(w.status_since && !Number.isNaN(Date.parse(w.status_since)));
    assert.equal(w.preview, null);
    // pi writes the transcript; the row's preview and activity come from the file, without the worker's marker.
    appendFileSync(live.sessionFile!, user('u1', null, `${INTERRUPT_MARKER}\nkeep going`, '2026-11-16T05:00:00.000Z'));
    appendFileSync(live.sessionFile!, at('2026-11-16T05:00:01.000Z', { type: 'session_info', id: 'i1', parentId: 'u1', name: 'Login bug' }));
    f.hosts[0]!.emit('event', { type: 'host_leaf', leafId: 'i1' });
    let row = f.supervisor.get(w.worker_id);
    assert.equal(row.preview, 'keep going', 'S-8: the preview never shows the interrupt marker');
    assert.equal(row.last_activity_at, '2026-11-16T05:00:01.000Z');
    assert.equal(row.title, 'Login bug');
    // A settlement counts; a status change moves status_since.
    const r = await f.supervisor.prompt(w.worker_id, { ...bind(row, 'p1'), message: 'hi' });
    assert.equal(r.state, 'delivered');
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await tick();
    row = f.supervisor.get(w.worker_id);
    assert.equal(row.settle_count, 1);
    const since = row.status_since!;
    await new Promise(res => setTimeout(res, 5));
    await f.supervisor.stop(w.worker_id, bind(row, 'stop'));
    row = f.supervisor.get(w.worker_id);
    assert.equal(row.status, 'stopped');
    assert.ok(row.status_since! > since, 'status_since moves when the status changes');
    // A child carries its parent and lineage child; both survive a restart.
    const cwd = join(f.dir, 'child-cwd');
    mkdirSync(cwd);
    const child = await f.supervisor.lifecycle.create({ command_id: 'child', cwd, provider: 'p', model: 'm', thinking: 'off' }, { parent_worker_id: w.worker_id, parent_launch_command_id: 'launch' });
    assert.equal(f.supervisor.get(child.worker_id!).lineage, 'child');
    await f.restart();
    assert.equal(f.supervisor.get(child.worker_id!).lineage, 'child');
    assert.equal(f.supervisor.get(w.worker_id).settle_count, 1, 'the settle counter is durable');
  } finally {
    f.cleanup();
  }
});

test('inventory: sessions.list and sessions.get list the catalog per cwd, newest first, with holder, fence and per-model stats', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const a = await f.create();
    const b = await f.create();
    const fileA = f.supervisor.state.require(a.worker_id).sessionFile!;
    appendFileSync(fileA, user('u1', null, 'first question', '2026-11-16T01:00:00.000Z'));
    appendFileSync(fileA, assistant('a1', 'u1', 'first answer', '2026-11-16T01:00:05.000Z', 'm', 0.25, 100));
    appendFileSync(fileA, assistant('a2', 'a1', 'second answer', '2026-11-16T01:00:06.000Z', 'other', 0.5, 50));
    const fileB = f.supervisor.state.require(b.worker_id).sessionFile!;
    appendFileSync(fileB, user('v1', null, 'newer chat', '2026-11-16T02:00:00.000Z'));
    // A's /new leaves its first session archived in the catalog: no worker holds it.
    const moved = await f.supervisor.newSession(a.worker_id, bind(f.supervisor.get(a.worker_id), 'new-a'));
    assert.equal(moved.state, 'delivered');
    const all = await memory.request('GET', '/b2/sessions');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const rows = (all.body as { sessions: { session_id: string; holder_worker_id: string | null; last_activity_at: string | null }[] }).sessions;
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.session_id, b.session_id, 'newest activity first');
    assert.equal(rows[1]!.session_id, a.session_id);
    assert.equal(rows.find(r => r.session_id === a.session_id)!.holder_worker_id, null, 'an archived session is open in no worker');
    assert.equal(rows.find(r => r.session_id === b.session_id)!.holder_worker_id, b.worker_id);
    const one = await memory.request('GET', `/b2/sessions/${a.session_id}`);
    assert.equal(one.status, 200);
    const row = one.body as Record<string, unknown> & { stats: { models: { model: string; cost_total: number }[]; cost_total: number; tool_calls: number; tokens: { total: number } } };
    assert.equal(row.preview, 'second answer');
    assert.equal(row.message_count, 3);
    assert.equal(row.last_worker_id, a.worker_id);
    assert.equal(row.fenced, false);
    assert.equal(row.stats.tool_calls, 2);
    assert.equal(row.stats.tokens.total, 150);
    assert.equal(row.stats.cost_total, 0.75);
    assert.deepEqual(row.stats.models.map(m => [m.model, m.cost_total]).sort(), [['m', 0.25], ['other', 0.5]], 'per-model cost from the assistant messages');
    // Per cwd, up to the limit.
    const cwdA = f.supervisor.get(a.worker_id).cwd;
    const perCwd = await memory.request('GET', `/b2/sessions?cwd=${encodeURIComponent(cwdA)}&limit=1`);
    const body = perCwd.body as { sessions: { cwd: string }[]; truncated: boolean };
    assert.deepEqual([body.sessions.length, body.truncated, body.sessions[0]!.cwd], [1, true, cwdA]);
    // A grant over every worker learns that a session is unknown; the catalog never reads a client path.
    assert.deepEqual((await memory.request('GET', '/b2/sessions/not-a-session')).body, { error: 'unknown_session', effect: 'no_effect' });
    // The row survives a restart (the catalog is rebuilt from the journal).
    await f.restart();
    const again = await createMemoryTransport(createApp({ supervisor: f.supervisor, grants: new GrantStore(f.dir) }).handle, ownerGrant(f.dir, 'owner-2').headers).request('GET', `/b2/sessions/${a.session_id}`);
    assert.equal((again.body as { message_count: number }).message_count, 3);
  } finally {
    f.cleanup();
  }
});

test('inventory: an archived session reads by session_id with no worker bound to it, within the grant scope only', async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const a = await f.create();
    const b = await f.create();
    const file = f.supervisor.state.require(a.worker_id).sessionFile!;
    appendFileSync(file, user('u1', null, 'archived question', '2026-11-16T01:00:00.000Z'));
    await f.supervisor.stop(a.worker_id, bind(f.supervisor.get(a.worker_id), 'stop-a'));
    assert.equal(f.supervisor.get(a.worker_id).status, 'stopped');
    const app = createApp({ supervisor: f.supervisor, grants: owner.grants }).handle;
    const read = await createMemoryTransport(app, owner.headers).request('GET', `/b2/sessions/${a.session_id}/history`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.contentType, 'application/x-ndjson');
    assert.deepEqual(read.body, readFileSync(file), 'the whole file: complete lines, unparsed');
    assert.equal(read.headers!['piw-reset'], 'false');
    // A grant scoped to the other worker's cwd cannot read it, list it or tell it from an unknown session.
    const scoped = owner.grants.register({ caller: 'scoped', scope: { worker_ids: [b.worker_id], cwd_roots: [b.cwd] }, methods: ['*'] });
    const other = createMemoryTransport(app, { authorization: `Bearer ${scoped.token}` });
    for (const path of [`/b2/sessions/${a.session_id}/history`, `/b2/sessions/${a.session_id}`, '/b2/sessions/not-a-session/history']) {
      assert.deepEqual((await other.request('GET', path)).body, { error: 'grant_scope_denied', effect: 'no_effect' }, path);
    }
    const listed = (await other.request('GET', '/b2/sessions')).body as { sessions: { session_id: string }[] };
    assert.deepEqual(listed.sessions.map(s => s.session_id), [b.session_id]);
    // A grant scoped to A's cwd reads it.
    const mine = owner.grants.register({ caller: 'mine', scope: { worker_ids: [], cwd_roots: [a.cwd] }, methods: ['sessions.history'] });
    const ok = await createMemoryTransport(app, { authorization: `Bearer ${mine.token}` }).request('GET', `/b2/sessions/${a.session_id}/history`);
    assert.equal(ok.status, 200);
    // Its own grant method: a grant without sessions.history is refused.
    const noMethod = owner.grants.register({ caller: 'list-only', scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods: ['sessions.list'] });
    assert.deepEqual((await createMemoryTransport(app, { authorization: `Bearer ${noMethod.token}` }).request('GET', `/b2/sessions/${a.session_id}/history`)).body, {
      error: 'grant_method_denied',
      effect: 'no_effect',
    });
  } finally {
    f.cleanup();
  }
});

test('inventory: sessions.history reads complete lines in bounded chunks and its watermark is the one history.appended carries', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const w = await f.create();
    const live = f.supervisor.state.require(w.worker_id);
    const frames: EventFrame[] = [];
    const sub = f.supervisor.subscribe(frame => void frames.push(frame), { types: ['history.appended'] });
    const long = 'x'.repeat(5000);
    appendFileSync(live.sessionFile!, user('u1', null, 'short', '2026-11-16T01:00:00.000Z'));
    appendFileSync(live.sessionFile!, user('u2', 'u1', long, '2026-11-16T01:00:01.000Z'));
    appendFileSync(live.sessionFile!, user('u3', 'u2', 'tail', '2026-11-16T01:00:02.000Z'));
    appendFileSync(live.sessionFile!, '{"type":"message","id":"partial"'); // pi is still writing this line
    f.hosts[0]!.emit('event', { type: 'host_leaf', leafId: 'u3' });
    const appended = frames.filter((e): e is Extract<EventFrame, { type: 'history.appended' }> => e.type === 'history.appended').at(-1)!;
    const complete = readFileSync(live.sessionFile!).subarray(0, readFileSync(live.sessionFile!).lastIndexOf(0x0a) + 1);
    assert.equal(appended.data.watermark, complete.length, 'the event watermark is the complete size');
    assert.equal(appended.data.session_id, w.session_id);
    // Bounded chunks: each ends on a line boundary; a line longer than max_bytes comes alone; the next offset chains.
    const chunks: Buffer[] = [];
    let offset = 0;
    let tail: string | undefined;
    for (let i = 0; i < 10 && offset < complete.length; i++) {
      const r = await history(memory, w.session_id!, { offset, max_bytes: 300, identity: appended.data.file_identity, ...(tail ? { tail } : {}) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const body = r.body as Buffer;
      assert.equal(body.at(-1), 0x0a, 'complete lines only');
      assert.equal(Number(r.headers!['piw-watermark']), appended.data.watermark, 'Piw-Watermark equals history.appended');
      assert.equal(r.headers!['piw-file-identity'], appended.data.file_identity);
      assert.equal(r.headers!['piw-reset'], 'false');
      assert.equal(Number(r.headers!['piw-offset']), offset);
      chunks.push(body);
      offset = Number(r.headers!['piw-next-offset']);
      tail = r.headers!['piw-tail-sha256'];
      assert.equal(tail, sha(body.subarray(body.lastIndexOf(0x0a, body.length - 2) + 1)), 'the tail names the last line read');
    }
    assert.ok(chunks.some(c => c.length > 300), 'a line longer than max_bytes comes alone, so a reader always progresses');
    assert.deepEqual(Buffer.concat(chunks), complete, 'the chunks are exactly the complete lines; the partial line is never served');
    const end = await history(memory, w.session_id!, { offset, identity: appended.data.file_identity, tail: tail! });
    assert.deepEqual([(end.body as Buffer).length, end.headers!['piw-reset']], [0, 'false'], 'at the watermark: nothing new, no reset');
    sub.close();
  } finally {
    f.cleanup();
  }
});

test('inventory: sessions.history resets on a replaced, shrunk or rewritten file, and a bad offset is a typed 400, never an empty page', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const w = await f.create();
    const file = f.supervisor.state.require(w.worker_id).sessionFile!;
    appendFileSync(file, user('u1', null, 'one', '2026-11-16T01:00:00.000Z'));
    appendFileSync(file, user('u2', 'u1', 'two', '2026-11-16T01:00:01.000Z'));
    const first = await history(memory, w.session_id!);
    const identity = first.headers!['piw-file-identity']!;
    const next = Number(first.headers!['piw-next-offset']);
    const tail = first.headers!['piw-tail-sha256']!;
    const refused = (r: MemoryResponse, error: string) => {
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.deepEqual(r.body, { error, effect: 'no_effect' });
      assert.equal(validateError(r.body), true);
    };
    // Without a tail: past the watermark or inside a line is a caller error.
    refused(await history(memory, w.session_id!, { offset: next + 10 }), 'history_offset_past_watermark');
    refused(await history(memory, w.session_id!, { offset: 3 }), 'history_offset_not_line_start');
    // Nothing changed, but the caller's tail names another line than the one before its offset: it resets, by the tail
    // alone (same identity, the offset on a line start).
    const otherLine = sha(`${readFileSync(file, 'utf8').split('\n')[0]}\n`);
    let named = await history(memory, w.session_id!, { offset: next, identity, tail: otherLine });
    assert.deepEqual([named.headers!['piw-reset'], named.headers!['piw-offset'], named.headers!['piw-file-identity']], ['true', '0', identity], 'a tail that is not the line before the offset resets');
    named = await history(memory, w.session_id!, { offset: next, identity, tail });
    assert.deepEqual([named.headers!['piw-reset'], named.headers!['piw-offset']], ['false', String(next)], 'the right tail does not');
    // The same for a prefix that is not the SHA-256 of the bytes before the offset.
    named = await history(memory, w.session_id!, { offset: next, identity, tail, prefix: sha('another prefix') });
    assert.deepEqual([named.headers!['piw-reset'], named.headers!['piw-offset'], named.headers!['piw-file-identity']], ['true', '0', identity], 'a prefix that is not the bytes before the offset resets');
    named = await history(memory, w.session_id!, { offset: next, identity, tail, prefix: first.headers!['piw-prefix-sha256']! });
    assert.deepEqual([named.headers!['piw-reset'], named.headers!['piw-offset']], ['false', String(next)], 'the right prefix does not');
    assert.equal(first.headers!['piw-prefix-sha256'], sha(readFileSync(file).subarray(0, next)), 'Piw-Prefix-Sha256 is the SHA-256 of the bytes before Piw-Next-Offset');
    // Rewritten in place (same inode, same header): the line before the offset is not the caller's tail.
    const lines = readFileSync(file, 'utf8').split('\n');
    writeFileSync(file, `${lines[0]}\n${user('z1', null, 'rewritten so the same offset sits elsewhere', '2026-11-16T03:00:00.000Z')}`);
    let r = await history(memory, w.session_id!, { offset: next, identity, tail });
    assert.equal(r.headers!['piw-reset'], 'true', 'in-place rewrite resets');
    assert.equal(Number(r.headers!['piw-offset']), 0);
    assert.deepEqual(r.body, readFileSync(file));
    // Shrunk below the caller's offset.
    const now = { identity: r.headers!['piw-file-identity']!, next: Number(r.headers!['piw-next-offset']), tail: r.headers!['piw-tail-sha256']! };
    writeFileSync(file, `${lines[0]}\n`);
    r = await history(memory, w.session_id!, { offset: now.next, identity: now.identity, tail: now.tail });
    assert.deepEqual([r.headers!['piw-reset'], r.headers!['piw-offset']], ['true', '0'], 'a shrunk file resets');
    // Replaced (a new inode): another identity resets even at offset 0.
    const replacement = `${file}.new`;
    writeFileSync(replacement, readFileSync(file));
    renameSync(replacement, file);
    r = await history(memory, w.session_id!, { offset: 0, identity: now.identity });
    assert.equal(r.headers!['piw-reset'], 'true', 'a replaced file has another identity');
    assert.notEqual(r.headers!['piw-file-identity'], now.identity);
  } finally {
    f.cleanup();
  }
});

test('inventory: a same-size rewrite in place that keeps the header and the last line resets sessions.history and refreshes the summary; appends keep the identity', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const w = await f.create();
    const file = f.supervisor.state.require(w.worker_id).sessionFile!;
    const frames: EventFrame[] = [];
    const sub = f.supervisor.subscribe(frame => void frames.push(frame), { types: ['history.appended'] });
    appendFileSync(file, user('u1', null, 'aaaaaa first', '2026-11-16T01:00:00.000Z'));
    appendFileSync(file, at('2026-11-16T01:00:01.000Z', { type: 'custom', id: 'c1', parentId: 'u1', customType: 'x' }));
    const first = await history(memory, w.session_id!);
    const cursor = { identity: first.headers!['piw-file-identity']!, offset: Number(first.headers!['piw-next-offset']), tail: first.headers!['piw-tail-sha256']! };
    assert.equal((await memory.request('GET', `/b2/sessions/${w.session_id}`) as MemoryResponse & { body: { preview: string } }).body.preview, 'aaaaaa first');
    // An append keeps the identity and serves only the new line.
    appendFileSync(file, at('2026-11-16T01:00:02.000Z', { type: 'custom', id: 'c2', parentId: 'c1', customType: 'x' }));
    const appended = await history(memory, w.session_id!, cursor);
    assert.deepEqual([appended.headers!['piw-reset'], appended.headers!['piw-file-identity']], ['false', cursor.identity], 'an append is not a rewrite');
    const now = { identity: cursor.identity, offset: Number(appended.headers!['piw-next-offset']), tail: appended.headers!['piw-tail-sha256']! };
    // Six bytes of user text change in place: same inode, same size, same header, same last line, another mtime.
    const before = statSync(file);
    const bytes = readFileSync(file);
    const at6 = bytes.indexOf('aaaaaa');
    bytes.write('bbbbbb', at6);
    writeFileSync(file, bytes);
    utimesSync(file, before.atime, new Date(before.mtimeMs + 5000));
    const after = statSync(file);
    assert.deepEqual([after.ino, after.size], [before.ino, before.size], 'same inode, same size');
    assert.notEqual(after.mtimeMs, before.mtimeMs, 'another mtime');
    const r = await history(memory, w.session_id!, now);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers!['piw-reset'], 'true', 'a same-size rewrite in place resets');
    assert.notEqual(r.headers!['piw-file-identity'], now.identity, 'a rewrite changes the identity');
    assert.equal(Number(r.headers!['piw-offset']), 0);
    assert.deepEqual(r.body, readFileSync(file));
    const row = (await memory.request('GET', `/b2/sessions/${w.session_id}`)).body as { preview: string };
    assert.equal(row.preview, 'bbbbbb first', 'the summary cache follows the rewrite');
    // history.appended announces the rewritten file under its new identity.
    f.hosts[0]!.emit('event', { type: 'host_leaf', leafId: 'c2' });
    sub.close();
    const announced = frames.filter((e): e is Extract<EventFrame, { type: 'history.appended' }> => e.type === 'history.appended').at(-1);
    assert.equal(announced?.data.file_identity, r.headers!['piw-file-identity'], 'history.appended carries the new identity');
    // The new identity is stable across the next append.
    const settled = { identity: r.headers!['piw-file-identity']!, offset: Number(r.headers!['piw-next-offset']), tail: r.headers!['piw-tail-sha256']! };
    appendFileSync(file, at('2026-11-16T01:00:03.000Z', { type: 'custom', id: 'c3', parentId: 'c2', customType: 'x' }));
    const next = await history(memory, w.session_id!, settled);
    assert.deepEqual([next.headers!['piw-reset'], next.headers!['piw-file-identity']], ['false', settled.identity]);
  } finally {
    f.cleanup();
  }
});

/** A session with a user entry and a custom tail, read once (the reader's cursor) and summarized (the summary cache). */
async function rewriteFixture(f: Fixture, memory: ReturnType<typeof api>['memory']) {
  const w = await f.create();
  const file = f.supervisor.state.require(w.worker_id).sessionFile!;
  appendFileSync(file, user('u1', null, 'aaaaaa first', '2026-11-16T01:00:00.000Z'));
  appendFileSync(file, at('2026-11-16T01:00:01.000Z', { type: 'custom', id: 'c1', parentId: 'u1', customType: 'x' }));
  const first = await history(memory, w.session_id!);
  assert.equal(first.headers!['piw-reset'], 'false');
  assert.equal(((await memory.request('GET', `/b2/sessions/${w.session_id}`)).body as { preview: string }).preview, 'aaaaaa first');
  const cursor = { identity: first.headers!['piw-file-identity']!, offset: Number(first.headers!['piw-next-offset']), tail: first.headers!['piw-tail-sha256']!, prefix: first.headers!['piw-prefix-sha256']! };
  /** Six bytes of the earlier user text change in place: same inode, same size, same header, same last line. */
  const rewrite = () => {
    const before = statSync(file);
    const bytes = readFileSync(file);
    bytes.write('bbbbbb', bytes.indexOf('aaaaaa'));
    writeFileSync(file, bytes);
    utimesSync(file, before.atime, new Date(before.mtimeMs + 5000));
    const after = statSync(file);
    assert.deepEqual([after.ino, after.size], [before.ino, before.size], 'same inode, same size');
    assert.equal(sha(`${readFileSync(file, 'utf8').trimEnd().split('\n').at(-1)}\n`), cursor.tail, 'the line before the cursor is unchanged');
  };
  return { w, file, cursor, rewrite };
}

test('inventory: a rewrite in place followed by an append before any read resets sessions.history (identity and tail alone) and refreshes the summary', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const { w, file, cursor, rewrite } = await rewriteFixture(f, memory);
    rewrite();
    // pi appends before any reader looks: the file grew, but the bytes the reader has were rewritten.
    appendFileSync(file, at('2026-11-16T01:00:02.000Z', { type: 'custom', id: 'c2', parentId: 'c1', customType: 'x' }));
    const r = await history(memory, w.session_id!, { identity: cursor.identity, offset: cursor.offset, tail: cursor.tail });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.headers!['piw-reset'], r.headers!['piw-offset']], ['true', '0'], 'a rewrite before an append is not an append');
    assert.notEqual(r.headers!['piw-file-identity'], cursor.identity, 'the rewrite changes the identity');
    assert.deepEqual(r.body, readFileSync(file), 'the rewritten entry is sent again');
    const row = (await memory.request('GET', `/b2/sessions/${w.session_id}`)).body as { preview: string; message_count: number };
    assert.deepEqual([row.preview, row.message_count], ['bbbbbb first', 1], 'the summary follows the rewrite');
    // A genuine append after that keeps the new identity and serves only the new line.
    const settled = { identity: r.headers!['piw-file-identity']!, offset: Number(r.headers!['piw-next-offset']), tail: r.headers!['piw-tail-sha256']!, prefix: r.headers!['piw-prefix-sha256']! };
    const line = at('2026-11-16T01:00:03.000Z', { type: 'custom', id: 'c3', parentId: 'c2', customType: 'x' });
    appendFileSync(file, line);
    const next = await history(memory, w.session_id!, settled);
    assert.deepEqual([next.headers!['piw-reset'], next.headers!['piw-file-identity'], (next.body as Buffer).toString()], ['false', settled.identity, line]);
  } finally {
    f.cleanup();
  }
});

test('inventory: a rewrite in place while the supervisor is down resets sessions.history by the cursor prefix; a restart alone does not', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const { w, cursor, rewrite } = await rewriteFixture(f, memory);
    await f.restart();
    // Each restarted supervisor gets a fresh API over the same state directory (a new grant id: ids are unique).
    const reopen = (id: string) => {
      const g = ownerGrant(f.dir, id);
      return api(f, g.grants, g.headers).memory;
    };
    let b2 = reopen('owner-1');
    const kept = await history(b2, w.session_id!, cursor);
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.deepEqual([kept.headers!['piw-reset'], kept.headers!['piw-file-identity'], (kept.body as Buffer).length], ['false', cursor.identity, 0], 'a restart alone keeps the cursor');
    rewrite();
    await f.restart();
    b2 = reopen('owner-2');
    const r = await history(b2, w.session_id!, cursor);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.headers!['piw-reset'], r.headers!['piw-offset']], ['true', '0'], 'the bytes before the offset are not the ones the reader has');
    assert.ok((r.body as Buffer).includes('bbbbbb first'), 'the rewritten entry is sent again');
    assert.equal(((await b2.request('GET', `/b2/sessions/${w.session_id}`)).body as { preview: string }).preview, 'bbbbbb first');
  } finally {
    f.cleanup();
  }
});

test('inventory: a user message with four photos over the summary line limit still counts, with its caption as the preview and its activity', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const w = await f.create();
    const live = f.supervisor.state.require(w.worker_id);
    appendFileSync(live.sessionFile!, user('u0', null, 'earlier', '2026-11-16T01:00:00.000Z'));
    // Four photos of 1.5 MiB each (base64 in pi's line): one user entry of about 8 MiB.
    const photo = Buffer.alloc(1536 * 1024, 7).toString('base64');
    const content = [{ type: 'text', text: 'four photos of the bug' }, ...[1, 2, 3, 4].map(() => ({ type: 'image', data: photo, mimeType: 'image/jpeg' }))];
    const line = at('2026-11-16T01:00:09.000Z', { type: 'message', id: 'u1', parentId: 'u0', message: { role: 'user', content } });
    assert.ok(line.length > 4 * 1024 * 1024 + 1024 * 1024, 'over the summary line limit and longer than one read chunk');
    appendFileSync(live.sessionFile!, line);
    f.hosts[0]!.emit('event', { type: 'host_leaf', leafId: 'u1' });
    const row = (await memory.request('GET', `/b2/sessions/${w.session_id}`)).body as { preview: string; last_activity_at: string; message_count: number; stats: { user_messages: number } };
    assert.equal(row.stats.user_messages, 2, 'the photo message counts');
    assert.equal(row.message_count, 2);
    assert.equal(row.preview, 'four photos of the bug');
    assert.equal(row.last_activity_at, '2026-11-16T01:00:09.000Z');
    const worker = f.supervisor.get(w.worker_id);
    assert.deepEqual([worker.preview, worker.last_activity_at], ['four photos of the bug', '2026-11-16T01:00:09.000Z'], 'the worker row too');
  } finally {
    f.cleanup();
  }
});

test('inventory: a symlink at the catalog path is never followed: sessions.history is 409 session_file_not_regular, the summary and blobs.read see nothing of its target', async () => {
  const f = fixture();
  try {
    const { memory } = api(f);
    const w = await f.create();
    const file = f.supervisor.state.require(w.worker_id).sessionFile!;
    appendFileSync(file, user('u1', null, 'own text', '2026-11-16T01:00:00.000Z'));
    // Another session file, with an image entry, that a writer in the supervisor's uid links in place of the catalog path.
    const other = join(f.dir, 'other.jsonl');
    const image = jpegBytes(64);
    writeFileSync(
      other,
      `${JSON.stringify({ type: 'session', id: w.session_id, version: 3 })}\n` +
        at('2026-11-16T02:00:00.000Z', { type: 'message', id: 'o1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'OTHER-SESSION-SECRET' }, { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' }] } }),
    );
    rmSync(file);
    symlinkSync(other, file);
    const r = await history(memory, w.session_id!);
    assert.deepEqual([r.status, r.body], [409, { error: 'session_file_not_regular', effect: 'no_effect' }], 'a symlink at the catalog path is refused, not followed');
    const row = await memory.request('GET', `/b2/sessions/${w.session_id}`);
    assert.equal(row.status, 200, JSON.stringify(row.body));
    assert.equal(JSON.stringify(row.body).includes('OTHER-SESSION-SECRET'), false, 'the summary never reads the target');
    assert.equal((row.body as { preview: string | null }).preview, null);
    const blob = await memory.request('GET', `/b2/sessions/${w.session_id}/entries/o1/blobs/0`);
    assert.notEqual(blob.status, 200, 'blobs.read never serves the target');
    assert.equal(Buffer.isBuffer(blob.body) && (blob.body as Buffer).equals(image), false);
    // A FIFO there is refused too, without blocking the supervisor.
    rmSync(file);
    execFileSync('mkfifo', [file]);
    const fifo = await history(memory, w.session_id!);
    assert.deepEqual([fifo.status, fifo.body], [409, { error: 'session_file_not_regular', effect: 'no_effect' }], 'a FIFO at the catalog path is refused');
  } finally {
    f.cleanup();
  }
});

test('inventory: an ndjson reply that is not complete JSON lines, or whose headers fail their schema, is never sent', async () => {
  let reply: unknown;
  // SAFETY: a deliberately wrong handler, to prove the router checks a byte reply before sending it.
  const handlers = { 'sessions.history': () => reply } as unknown as Handlers;
  const memory = createMemoryTransport(createRouter({ handlers }));
  const headers = { 'piw-session-id': 's', 'piw-file-identity': 'a'.repeat(64), 'piw-offset': 0, 'piw-next-offset': 3, 'piw-watermark': 3, 'piw-reset': false, 'piw-prefix-sha256': sha('{}\n'), 'piw-history-line-max': 1 };
  reply = { contentType: 'application/x-ndjson', headers, body: Buffer.from('{}\n') };
  assert.equal((await memory.request('GET', '/b2/sessions/s/history')).status, 200, 'the valid reply passes');
  const cases: [string, unknown][] = [
    ['torn last line', { contentType: 'application/x-ndjson', headers, body: Buffer.from('{}\n{"a"') }],
    ['not JSON', { contentType: 'application/x-ndjson', headers, body: Buffer.from('{}\nnope\n') }],
    ['bad header', { contentType: 'application/x-ndjson', headers: { ...headers, 'piw-reset': 'maybe' }, body: Buffer.from('{}\n') }],
    ['missing header', { contentType: 'application/x-ndjson', headers: { ...headers, 'piw-watermark': undefined }, body: Buffer.from('{}\n') }],
    ['wrong media type', { contentType: 'application/json', headers, body: Buffer.from('{}\n') }],
  ];
  for (const [label, value] of cases) {
    reply = value;
    const r = await memory.request('GET', '/b2/sessions/s/history');
    assert.equal(r.status, 500, label);
    assert.equal((r.body as { error: string; effect: string }).error, 'response_schema_mismatch', label);
    assert.equal((r.body as { effect: string }).effect, 'no_effect', label);
  }
});

test('inventory: the TypeScript client reads sessions.history bytes and headers over the socket', { timeout: 20_000 }, async () => {
  const f = fixture();
  const owner = ownerGrant(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle);
  const socket = join(f.dir, 'b2.sock');
  await listenPrivate(server, socket);
  try {
    const w = await f.create();
    const file = f.supervisor.state.require(w.worker_id).sessionFile!;
    appendFileSync(file, user('u1', null, 'over the socket', '2026-11-16T01:00:00.000Z'));
    const client = new Client({ socketPath: socket, grantFile: owner.file });
    const read = await client.read('sessions.history', { path: { session_id: w.session_id! }, query: { max_bytes: 4096 } });
    assert.equal(read.contentType, 'application/x-ndjson');
    assert.deepEqual(read.body, readFileSync(file));
    assert.equal(Number(read.headers['piw-watermark']), read.body.length);
    await assert.rejects(client.read('sessions.history', { path: { session_id: w.session_id! }, query: { offset: 1 } }), (e: ClientFailure) => e.message === 'history_offset_not_line_start' && e.effect === 'no_effect');
  } finally {
    await new Promise<void>(r => {
      server.closeAllConnections();
      server.close(() => r());
    });
    f.cleanup();
  }
});

test('inventory: socket group access (S-6) listens 0750/0660 in the named group, and refuses any other directory mode', { timeout: 20_000 }, async () => {
  const tmp = privateTmp();
  try {
    const gid = process.getgid!();
    const access = resolveSocketAccess({ PIW_SOCKET_GROUP: String(gid) });
    assert.deepEqual(access, { mode: 'group', gid });
    assert.deepEqual(resolveSocketAccess({}), { mode: 'owner' });
    const groupFile = join(tmp.dir, 'group');
    writeFileSync(groupFile, `piw:x:${gid}:\n`);
    assert.deepEqual(resolveSocketAccess({ PIW_SOCKET_GROUP: 'piw' }, groupFile), { mode: 'group', gid });
    assert.throws(() => resolveSocketAccess({ PIW_SOCKET_GROUP: 'nogroup-here' }, groupFile), /names no group/);
    const dir = join(tmp.dir, 'run');
    mkdirSync(dir);
    chmodSync(dir, 0o750);
    const socket = join(dir, 'b2.sock');
    const server = createB2Server(async () => ({ status: 404, body: { error: 'unknown_route', effect: 'no_effect' } }));
    await listenPrivate(server, socket, access);
    try {
      assert.equal(statSync(socket).mode & 0o777, 0o660);
      assert.equal(statSync(socket).gid, gid);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
    // A listen that should have been refused fails by assertion and never leaves a server open.
    const refused = async (a: Parameters<typeof listenPrivate>[2], pattern: RegExp, label: string) => {
      const server = createB2Server(async () => ({ status: 404, body: {} }));
      let error: unknown;
      try {
        await listenPrivate(server, socket, a);
      } catch (e) {
        error = e;
      } finally {
        if (server.listening) await new Promise<void>(r => server.close(() => r()));
      }
      assert.ok(error instanceof Error && pattern.test(error.message), `${label}: refused (${String(error)})`);
    };
    // Any directory mode but exactly 0750 is refused in group mode: never world-accessible, never group-writable.
    for (const mode of [0o755, 0o770, 0o700]) {
      chmodSync(dir, mode);
      await refused(access, /must be owned, non-symlink 0750/, mode.toString(8));
    }
    // The owner default is unchanged: 0700 and 0600.
    chmodSync(dir, 0o750);
    await refused(undefined, /0700/, 'owner mode');
  } finally {
    tmp.cleanup();
  }
});
