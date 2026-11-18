/**
 * Grants (P1-9). Ported from A0 `src/test/grants.test.ts` (all three cases) and the two grant cases of
 * `src/test/slice2-fix.test.ts`, with every assertion; A0's `hello().prototype` flag does not exist in production
 * `hello`, so that line asserts the scoped grant's hello succeeds instead. New cases cover the bearer hash at rest,
 * registration by local file access only, scope on receipts, and revocation ending an event stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, ClientFailure } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { Refusal } from '../src/b2/errors.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { authority } from '../src/grants/authority.js';
import { GrantStore, writeBearerFile, type Scope } from '../src/grants/store.js';
import { routes } from '../src/generated/routes.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';
import { bundledSpec, sseRecords, specOperationIds } from './helpers.js';

const grantCommand = fileURLToPath(new URL('../src/grant.js', import.meta.url));

async function serve(f: Fixture): Promise<{ socket: string; grants: GrantStore; close: () => Promise<void> }> {
  const grants = new GrantStore(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, grants, piVersion: '1.5.2' }).handle);
  const socket = join(f.dir, 'socket');
  await listenPrivate(server, socket);
  return {
    socket,
    grants,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Registers a grant and writes its bearer file, as the owner's `grant register` does. */
function register(grants: GrantStore, dir: string, caller: string, scope: Scope, methods: string[], id?: string): string {
  const { grant, token } = grants.register({ caller, scope, methods, ...(id ? { grant_id: id } : {}) });
  const file = join(dir, `${grant.grant_id}.bearer.json`);
  writeBearerFile(file, token);
  return file;
}

const raw = (socketPath: string, method: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ error: string; effect: string }>((resolve, reject) => {
    const req = request({ socketPath, path, method, agent: false, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
      });
      res.on('end', () => resolve(JSON.parse(text) as { error: string; effect: string }));
    });
    req.on('error', reject);
    req.end();
  });

test('grants: every OpenAPI method requires a bearer, including hello, history, SSE and receipts', { timeout: 30_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const spec = bundledSpec();
    let checked = 0;
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods).filter(m => ['get', 'put', 'post', 'delete', 'patch'].includes(m))) {
        const value = await raw(s.socket, method.toUpperCase(), path.replace(/\{[^}]+\}/g, 'test'));
        assert.equal(value.error, 'bearer_grant_required', `${method} ${path}`);
        assert.equal(value.effect, 'no_effect');
        const forged = await raw(s.socket, method.toUpperCase(), path.replace(/\{[^}]+\}/g, 'test'), { authorization: `Bearer piw1.owner.${'A'.repeat(43)}` });
        assert.equal(forged.error, 'invalid_grant', `${method} ${path} with a forged bearer`);
        assert.equal(forged.effect, 'no_effect');
        checked++;
      }
    }
    assert.equal(checked, specOperationIds().length);
    assert.ok(['hello', 'history.page', 'events.subscribe', 'receipts.get'].every(op => specOperationIds().includes(op)));
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('grants: registered caller/method/scope enforced and scoped inventory/SSE cannot disclose another worker', { timeout: 30_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const a = await f.create();
    const b = await f.create();
    const file = register(s.grants, f.dir, 'observer', { worker_ids: [a.worker_id], cwd_roots: [] }, ['hello', 'workers.get', 'workers.list', 'events.subscribe']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const client = new Client({ socketPath: s.socket, grantFile: file });
    assert.equal((await client.call('hello')).pi_version, '1.5.2');
    assert.deepEqual(
      (await client.call('workers.list')).map(w => w.worker_id),
      [a.worker_id],
    );
    await assert.rejects(client.call('workers.get', { path: { worker_id: b.worker_id } }), /grant_scope_denied/);
    await assert.rejects(client.call('sessions.prompt', { path: { worker_id: a.worker_id }, body: { ...bind(a, 'denied'), message: 'no' } }), /grant_method_denied/);
    await client.watch(frame => {
      assert.equal(frame.type, 'snapshot');
      assert.deepEqual(
        frame.type === 'snapshot' ? frame.workers.map(w => w.worker_id) : [],
        [a.worker_id],
      );
      return false;
    });
    assert.equal(f.hosts[0]!.prompts, 0);
    assert.equal(f.hosts[1]!.prompts, 0);
    const creator = register(s.grants, f.dir, 'environment', { worker_ids: [], cwd_roots: [a.cwd] }, ['workers.create']);
    await assert.rejects(new Client({ socketPath: s.socket, grantFile: creator }).call('workers.create', { body: { command_id: 'outside', cwd: b.cwd, provider: 'p', model: 'm', thinking: 'off' } }), /grant_scope_denied/);
    symlinkSync(b.cwd, join(a.cwd, 'escape'));
    await assert.rejects(new Client({ socketPath: s.socket, grantFile: creator }).call('workers.create', { body: { command_id: 'symlink', cwd: join(a.cwd, 'escape'), provider: 'p', model: 'm', thinking: 'off' } }), /grant_scope_denied/);
    // A filtered event stream naming a worker outside the scope is refused before it opens.
    const filtered = await sseRecords(s.socket, `/b2/events?worker_id=${b.worker_id}`, undefined, { authorization: `Bearer ${(JSON.parse(readFileSync(file, 'utf8')) as { token: string }).token}` });
    assert.deepEqual(filtered.body, { error: 'grant_scope_denied', effect: 'no_effect' });
    // An event about the other worker never reaches this subscriber; one about its own worker does.
    const seen: string[] = [];
    const watching = client.watch(frame => {
      if (frame.type === 'snapshot') {
        f.supervisor.events.publish('execution.settled', { worker_id: b.worker_id, execution_id: 'x', data: { command_id: 'c', disposition: 'hidden' } });
        f.supervisor.events.publish('execution.settled', { worker_id: a.worker_id, execution_id: 'x', data: { command_id: 'c', disposition: 'visible' } });
        return true;
      }
      seen.push(frame.type === 'execution.settled' ? frame.data.disposition : frame.type);
      return false;
    });
    await watching;
    assert.deepEqual(seen, ['visible']);
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('grants: revocation between queue admission and dispatch blocks the actual Pi write', { timeout: 30_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
    const file = register(s.grants, f.dir, 'controller', { worker_ids: [w.worker_id], cwd_roots: [] }, ['sessions.follow_up', 'workers.get'], 'controller');
    const client = new Client({ socketPath: s.socket, grantFile: file });
    const queued = await client.call('sessions.follow_up', { path: { worker_id: w.worker_id }, body: { ...bind(w, 'queued'), execution_id, message: 'must not dispatch' } });
    assert.equal(queued.state, 'queued');
    s.grants.revoke('controller');
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await tick();
    await tick();
    assert.equal(f.hosts[0]!.prompts, 1);
    assert.equal(f.supervisor.receipts.all.get('queued')?.effect, 'no_effect');
    assert.match(f.supervisor.receipts.all.get('queued')!.error!, /grant_revoked/);
    await assert.rejects(client.call('workers.get', { path: { worker_id: w.worker_id } }), (e: unknown) => e instanceof ClientFailure && e.effect === 'no_effect' && /grant_revoked/.test(e.message));
  } finally {
    await s.close();
    f.cleanup();
  }
});

const revoked = Object.assign(
  () => {
    throw new Refusal('grant_revoked');
  },
  { grant_id: 'revoked' },
);

test('grants: direct revoked prompt leaves no running execution and never fences on exit', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const r = await authority.run(revoked, () => f.supervisor.prompt(w.worker_id, { ...bind(w, 'revoked'), message: 'no' }));
    assert.equal(r.state, 'rejected');
    assert.equal(r.effect, 'no_effect');
    const now = f.supervisor.get(w.worker_id);
    assert.equal(now.execution, null);
    assert.equal(now.foreground, 'idle');
    assert.equal(f.hosts[0]!.prompts, 0);
    f.hosts[0]!.emit('exit');
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
  } finally {
    f.cleanup();
  }
});

test('grants: direct revoked create leaves no ghost worker or cwd reservation', async () => {
  const f = fixture();
  try {
    const cwd = join(f.dir, 'revoked-cwd');
    mkdirSync(cwd);
    const c = { command_id: 'revoked-create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await authority.run(revoked, () => f.supervisor.create(c));
    assert.equal(r.state, 'rejected');
    assert.equal(r.effect, 'no_effect');
    assert.equal(f.supervisor.list().length, 0);
    assert.equal(f.hosts.length, 0);
    assert.equal((await f.supervisor.create({ ...c, command_id: 'valid-create' })).state, 'delivered');
  } finally {
    f.cleanup();
  }
});

test('grants: the grant command registers by local file access; the registry keeps only a hash; revoke takes effect at the next request', { timeout: 30_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const out = join(f.dir, 'bridge.json');
    const env = { PATH: process.env.PATH, PIW_STATE_DIR: f.dir, PIW_SOCKET: s.socket };
    const registered = spawnSync(process.execPath, [grantCommand, 'register', '--caller', 'shep-bridge', '--method', 'hello', '--method', 'workers.list', '--worker', '*', '--answers-for-person', '--out', out], { env, encoding: 'utf8' });
    assert.equal(registered.status, 0, registered.stderr);
    const token = (JSON.parse(readFileSync(out, 'utf8')) as { token: string }).token;
    assert.match(token, /^piw1\.[0-9a-f]{24}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(`${registered.stdout}${registered.stderr}`.includes(token), false, 'the command never prints the bearer');
    const { grant_id } = JSON.parse(registered.stdout) as { grant_id: string };
    const record = readFileSync(join(f.dir, 'grants', `${grant_id}.json`), 'utf8');
    assert.equal(record.includes(token), false, 'the registry never holds the bearer');
    assert.equal((JSON.parse(record) as { token_sha256: string }).token_sha256, createHash('sha256').update(token).digest('hex'));
    assert.equal((JSON.parse(record) as { answers_for_person: boolean }).answers_for_person, true);
    assert.equal(statSync(join(f.dir, 'grants')).mode & 0o777, 0o700);
    for (const name of readdirSync(join(f.dir, 'grants'))) assert.equal(statSync(join(f.dir, 'grants', name)).mode & 0o777, 0o600);
    // The running daemon accepts it without a restart, and refuses methods it does not hold.
    const client = new Client({ socketPath: s.socket, grantFile: out });
    assert.equal((await client.call('hello')).protocol.major, 0);
    await assert.rejects(client.call('workers.create', { body: { command_id: 'no', cwd: f.dir, provider: 'p', model: 'm', thinking: 'off' } }), /grant_method_denied/);
    const listed = spawnSync(process.execPath, [grantCommand, 'list'], { env, encoding: 'utf8' });
    assert.equal(listed.status, 0);
    assert.equal(listed.stdout.includes(token) || listed.stdout.includes('token_sha256'), false, 'list shows neither bearer nor hash');
    const revoke = spawnSync(process.execPath, [grantCommand, 'revoke', grant_id], { env, encoding: 'utf8' });
    assert.equal(revoke.status, 0, revoke.stderr);
    await assert.rejects(client.call('hello'), (e: unknown) => e instanceof ClientFailure && e.message === 'grant_revoked' && e.effect === 'no_effect');
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('grants: no B2 operation manages grants; registration is local file access only', () => {
  for (const op of specOperationIds()) assert.equal(/grant/.test(op), false, `${op} manages grants over HTTP`);
  for (const route of Object.values(routes)) assert.equal(/grant/.test(route.path), false, route.path);
});

test('grants: receipts of workers outside the scope are not readable', { timeout: 30_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const a = await f.create();
    const b = await f.create();
    await f.supervisor.prompt(b.worker_id, { ...bind(b, 'b-prompt'), message: 'b' });
    await f.supervisor.prompt(a.worker_id, { ...bind(a, 'a-prompt'), message: 'a' });
    const file = register(s.grants, f.dir, 'reader', { worker_ids: [a.worker_id], cwd_roots: [] }, ['receipts.get']);
    const client = new Client({ socketPath: s.socket, grantFile: file });
    assert.equal((await client.call('receipts.get', { path: { command_id: 'a-prompt' } })).worker_id, a.worker_id);
    await assert.rejects(client.call('receipts.get', { path: { command_id: 'b-prompt' } }), (e: unknown) => e instanceof ClientFailure && e.message === 'grant_scope_denied' && e.effect === 'no_effect');
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('grants: a revoked grant ends its event stream at the next frame: no event after the revocation, only its typed end', { timeout: 30_000 }, async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const w = await f.create();
    const file = register(s.grants, f.dir, 'watcher', { worker_ids: ['*'], cwd_roots: [] }, ['events.subscribe'], 'watcher');
    const token = (JSON.parse(readFileSync(file, 'utf8')) as { token: string }).token;
    let revokedAt = -1;
    const result = await sseRecords(
      s.socket,
      '/b2/events',
      record => {
        if (record.event === 'snapshot') {
          f.supervisor.events.publish('execution.settled', { worker_id: w.worker_id, execution_id: 'x', data: { command_id: 'c', disposition: 'before' } });
          return true;
        }
        // A frame after the revocation means the guard failed: stop reading so the assertion below reports it.
        if (record.data.includes('"after"')) return false;
        if (revokedAt < 0) {
          s.grants.revoke('watcher');
          revokedAt = 1;
          f.supervisor.events.publish('execution.settled', { worker_id: w.worker_id, execution_id: 'x', data: { command_id: 'c', disposition: 'after' } });
        }
        return true;
      },
      { authorization: `Bearer ${token}` },
    );
    assert.equal(result.ended, true, 'the worker ended the stream');
    assert.deepEqual(
      result.records.map(r => (r.event === 'execution.settled' ? (JSON.parse(r.data) as { data: { disposition: string } }).data.disposition : r.event)),
      ['snapshot', 'before', 'overflow'],
    );
    // The end names the refusal; it carries no event.
    assert.equal((JSON.parse(result.records[2]!.data) as { data: { reason: string } }).data.reason, 'grant_revoked');
    assert.equal(f.supervisor.events.size, 0);
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('grants: a scoped grant cannot tell a worker outside its scope from a missing one (worker routes and filtered streams)', async () => {
  const f = fixture();
  try {
    const a = await f.create();
    const b = await f.create();
    const grants = f.supervisor.state.grants!;
    const { token } = grants.register({ caller: 'scoped', grant_id: 'scoped', scope: { worker_ids: [a.worker_id], cwd_roots: [] }, methods: ['*'] });
    const api = createMemoryTransport(createApp({ supervisor: f.supervisor, grants }).handle, { authorization: `Bearer ${token}` });
    const missing = 'no-such-worker';
    for (const path of ['', '/history', '/interactions']) {
      const other = await api.request('GET', `/b2/workers/${b.worker_id}${path}`);
      const absent = await api.request('GET', `/b2/workers/${missing}${path}`);
      assert.equal(absent.status, other.status, path);
      assert.deepEqual(absent.body, other.body, `${path}: the same refusal for a missing and an out-of-scope worker`);
      assert.deepEqual(other.body, { error: 'grant_scope_denied', effect: 'no_effect' });
    }
    const otherStream = await api.request('GET', `/b2/events?worker_id=${b.worker_id}`);
    const absentStream = await api.request('GET', `/b2/events?worker_id=${missing}`);
    assert.equal(absentStream.status, otherStream.status);
    assert.deepEqual(absentStream.body, otherStream.body);
    // A grant over every worker learns nothing from the difference: it still gets unknown_worker.
    const { token: all } = grants.register({ caller: 'all', grant_id: 'all', scope: { worker_ids: ['*'], cwd_roots: [] }, methods: ['*'] });
    const wide = createMemoryTransport(createApp({ supervisor: f.supervisor, grants }).handle, { authorization: `Bearer ${all}` });
    assert.deepEqual((await wide.request('GET', `/b2/workers/${missing}`)).body, { error: 'unknown_worker', effect: 'no_effect' });
  } finally {
    f.cleanup();
  }
});
