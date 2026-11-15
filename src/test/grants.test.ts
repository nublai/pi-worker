import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { Client, ClientFailure } from '../client.js';
import { router, listenPrivate } from '../server.js';
import { fixture, bind, tick } from './helpers.js';

test('every OpenAPI method requires a bearer, including hello, history, SSE and receipts', async () => {
  const f = fixture(), server = router(f.supervisor); try {
    const socket = join(f.dir, 'socket'); await listenPrivate(server, socket);
    const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    for (const [path, methods] of Object.entries(spec.paths)) for (const method of Object.keys(methods)) {
      const value = await new Promise<{ error: string; effect: string }>((resolve, reject) => {
        const req = request({ socketPath: socket, path: path.replace(/\{[^}]+\}/g, 'test'), method: method.toUpperCase(), agent: false }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text) as { error: string; effect: string })); }); req.on('error', reject); req.end();
      });
      assert.equal(value.error, 'bearer_grant_required', method + ' ' + path); assert.equal(value.effect, 'no_effect');
    }
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
});
test('registered caller/method/scope enforced and scoped inventory/SSE cannot disclose another worker', async () => {
  const f = fixture(), server = router(f.supervisor); try {
    const a = await f.create(), b = await f.create(), socket = join(f.dir, 'socket'); await listenPrivate(server, socket);
    const file = f.supervisor.grants.register('observer', { worker_ids: [a.worker_id], cwd_roots: [] }, ['hello', 'workers.get', 'workers.list', 'events.subscribe']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const client = new Client(socket, file);
    assert.equal((await client.call('hello')).prototype, true);
    assert.deepEqual((await client.call('workers.list')).map(w => w.worker_id), [a.worker_id]);
    await assert.rejects(client.call('workers.get', { id: b.worker_id }), /grant_scope_denied/);
    await assert.rejects(client.call('sessions.prompt', { id: a.worker_id, body: { ...bind(a, 'denied'), message: 'no' } }), /grant_method_denied/);
    await client.watch(null, frame => { assert.equal(frame.type, 'snapshot'); assert.deepEqual((frame as import('../types.js').Snapshot).workers.map(w => w.worker_id), [a.worker_id]); return false; });
    assert.equal(f.hosts[0]!.prompts, 0); assert.equal(f.hosts[1]!.prompts, 0);
    const creator = f.supervisor.grants.register('environment', { worker_ids: [], cwd_roots: [a.cwd] }, ['workers.create']);
    await assert.rejects(new Client(socket, creator).call('workers.create', { body: { command_id: 'outside', cwd: b.cwd, provider: 'p', model: 'm', thinking: 'off' } }), /grant_scope_denied/);
    symlinkSync(b.cwd, join(a.cwd, 'escape'));
    await assert.rejects(new Client(socket, creator).call('workers.create', { body: { command_id: 'symlink', cwd: join(a.cwd, 'escape'), provider: 'p', model: 'm', thinking: 'off' } }), /grant_scope_denied/);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
});
test('revocation between queue admission and dispatch blocks the actual Pi write', async () => {
  const f = fixture(), server = router(f.supervisor); try {
    const w = await f.create(), socket = join(f.dir, 'socket'); await listenPrivate(server, socket);
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
    const file = f.supervisor.grants.register('controller', { worker_ids: [w.worker_id], cwd_roots: [] }, ['sessions.follow_up', 'workers.get']);
    const client = new Client(socket, file);
    const queued = await client.call('sessions.follow_up', { id: w.worker_id, body: { ...bind(w, 'queued'), execution_id, message: 'must not dispatch' } });
    assert.equal(queued.state, 'queued');
    const id = JSON.parse(readFileSync(file, 'utf8')).grant_id as string; f.supervisor.grants.revoke(id);
    f.hosts[0]!.emit('event', { type: 'agent_settled' }); await tick(); await tick();
    assert.equal(f.hosts[0]!.prompts, 1); assert.equal(f.supervisor.receipts.all.get('queued')?.effect, 'no_effect');
    assert.match(f.supervisor.receipts.all.get('queued')!.error!, /grant_revoked/);
    await assert.rejects(client.call('workers.get', { id: w.worker_id }), (e: unknown) => e instanceof ClientFailure && e.effect === 'no_effect' && /grant_revoked/.test(e.message));
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
});
