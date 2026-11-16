/**
 * Client transport classification. The second test is ported from A0 `src/test/transport.test.ts` with every
 * assertion kept; the third keeps the client-side assertions of A0's third test against a fake worker (the
 * supervisor-side ones wait for the event hub in P1-8; see packages/worker/test/PORTED.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as netServer, type Server } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, ClientFailure, ProtocolMismatch, ResyncRequired, type EventFrame } from '../src/index.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'piw-client-'));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const listen = (server: Server | ReturnType<typeof httpServer>, path: string) => new Promise<void>(r => server.listen(path, () => r()));
const close = (server: Server | ReturnType<typeof httpServer>) =>
  new Promise<void>(r => {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => r());
  });
const binding = (command_id: string) => ({ command_id, session_id: 'session-0', worker_epoch: 'epoch-0', binding_revision: 1 });
const worker = {
  worker_id: 'w1', worker_epoch: 'epoch-0', supervisor_epoch: 'se', session_id: 'session-0',
  session_identity_evidence: 'pi_session_file' as const, binding_revision: 1, leaf_id: null, cwd: '/w',
  status: 'ready' as const, foreground: 'idle' as const, execution: null, fence: null,
  history: { last_entry_id: null, lag: false, evidence: 'pi_session_file' as const }, cleanup: 'none', pending_interactions: [],
};
function sse(res: ServerResponse, frames: unknown[], end = false) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  for (const frame of frames) res.write(`id: 1\nevent: frame\ndata: ${JSON.stringify(frame)}\n\n`);
  if (end) res.end();
}

test('client failure before connect is no_effect; after write is unknown, one attempt and keepalive disabled', async () => {
  const t = tmp();
  try {
    const socket = join(t.dir, 'disconnect.sock');
    const body = { ...binding('request'), message: 'do not replay' };
    await assert.rejects(
      new Client({ socketPath: socket }).call('sessions.prompt', { path: { worker_id: 'w1' }, body }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'before_write' && e.effect === 'no_effect',
    );
    let attempts = 0;
    let data = '';
    const server = netServer(connection => {
      attempts++;
      connection.once('data', bytes => {
        data += bytes.toString().replace(/^Authorization:.*$/im, 'Authorization: [redacted]');
        connection.destroy();
      });
    });
    await listen(server, socket);
    try {
      await assert.rejects(
        new Client({ socketPath: socket }).call('sessions.prompt', { path: { worker_id: 'w1' }, body }),
        (e: unknown) => e instanceof ClientFailure && e.phase === 'after_write' && e.effect === 'unknown',
      );
    } finally {
      await close(server);
    }
    assert.equal(attempts, 1);
    assert.match(data, /Connection: close/i);
    assert.match(data, /do not replay/);
  } finally {
    t.cleanup();
  }
});

test('public client retains no_effect HTTP detail and the snapshot; overflow disables controls until a resync snapshot', async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const seen: string[] = [];
  const server = httpServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/b2/workers/w1/prompt')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stale_binding', effect: 'no_effect', expected_binding_revision: 1, received_binding_revision: 50 }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const snapshot = { type: 'snapshot', workers: [worker], cursor: { transport_epoch: 't', seq: 3 }, resync_reason: url.searchParams.get('resync') === 'overflow' ? 'overflow' : 'fresh' };
    if (url.searchParams.get('worker_id') === 'w1' && !url.searchParams.has('resync')) {
      sse(res, [snapshot, { type: 'overflow', cursor: { transport_epoch: 't', seq: 9 }, event_id: 'ev', producer: 'supervisor', execution_id: null, evidence: 'observed_memory', data: { resync_required: true, reason: 'subscriber_queue_overflow' } }]);
      return;
    }
    sse(res, [snapshot]);
  });
  await listen(server, socket);
  try {
    const client = new Client({ socketPath: socket });
    await assert.rejects(
      client.call('sessions.prompt', { path: { worker_id: 'w1' }, body: { ...binding('stale'), binding_revision: 50, message: 'no' } }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'http' && e.effect === 'no_effect' && e.details.received_binding_revision === 50,
    );
    await client.watch(frame => {
      assert.equal(frame.type, 'snapshot');
      assert.equal((frame as Extract<EventFrame, { type: 'snapshot' }>).workers.length, 1);
      return false;
    });
    assert.equal(client.resyncRequired, false);
    const frames: string[] = [];
    await assert.rejects(
      client.watch(frame => void frames.push(frame.type), { workerIds: ['w1'] }),
      (e: unknown) => e instanceof ResyncRequired && e.reason === 'overflow',
    );
    assert.deepEqual(frames, ['snapshot', 'overflow']);
    assert.equal(client.resyncRequired, true);
    await client.watch(
      frame => {
        assert.equal(frame.type, 'snapshot');
        assert.equal((frame as Extract<EventFrame, { type: 'snapshot' }>).resync_reason, 'overflow');
        return false;
      },
      { workerIds: ['w1'], overflowResync: true },
    );
    assert.equal(client.resyncRequired, false);
    assert.ok(seen.includes('GET /b2/events?worker_id=w1&resync=overflow'));
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('client: an HTTP refusal without an explicit no_effect, or an unreadable reply, is unknown', async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const server = httpServer((req, res) => {
    if (req.url === '/b2/workers/w1/stop') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error_reconcile_before_retry', effect: 'unknown', uncertain_command_id: 'stop-1' }));
    } else if (req.url === '/b2/workers/w1/cancel') {
      res.writeHead(502);
      res.end('<html>bad gateway</html>');
    } else {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'operation_not_implemented', effect: 'no_effect' }));
    }
  });
  await listen(server, socket);
  try {
    const client = new Client({ socketPath: socket });
    await assert.rejects(
      client.call('workers.stop', { path: { worker_id: 'w1' }, body: binding('stop-1') }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'http' && e.status === 500 && e.effect === 'unknown' && e.details.uncertain_command_id === 'stop-1',
    );
    await assert.rejects(
      client.call('executions.cancel', { path: { worker_id: 'w1' }, body: binding('cancel-1') }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'after_write' && e.effect === 'unknown',
    );
    await assert.rejects(
      client.call('workers.list'),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'http' && e.status === 501 && e.effect === 'no_effect',
    );
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('client: a timeout after the write is unknown and is not retried', async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  let requests = 0;
  const server = httpServer(() => {
    requests++; // never answers
  });
  await listen(server, socket);
  try {
    await assert.rejects(
      new Client({ socketPath: socket, timeoutMs: 100 }).call('sessions.prompt', { path: { worker_id: 'w1' }, body: { ...binding('slow'), message: 'm' } }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'after_write' && e.effect === 'unknown',
    );
    await new Promise(r => setTimeout(r, 50));
    assert.equal(requests, 1);
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('client: an unreadable grant file fails before the write; a grant is sent as a bearer', async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  let auth: string | undefined;
  const server = httpServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ protocol: { major: 0, minor: 1 } }));
  });
  await listen(server, socket);
  try {
    await assert.rejects(
      new Client({ socketPath: socket, grantFile: join(t.dir, 'missing.json') }).call('hello'),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'before_write' && e.effect === 'no_effect',
    );
    assert.equal(auth, undefined);
    const grant = join(t.dir, 'grant.json');
    writeFileSync(grant, JSON.stringify({ token: 'test-token' }), { mode: 0o600 });
    await new Client({ socketPath: socket, grantFile: grant }).call('hello');
    assert.equal(auth, 'Bearer test-token');
  } finally {
    await close(server);
    t.cleanup();
  }
});

test('client: hello refuses an unknown protocol major', async () => {
  const t = tmp();
  const socket = join(t.dir, 'worker.sock');
  const server = httpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ protocol: { major: 1, minor: 0 } }));
  });
  await listen(server, socket);
  try {
    await assert.rejects(new Client({ socketPath: socket }).hello(), (e: unknown) => e instanceof ProtocolMismatch && e.major === 1);
  } finally {
    await close(server);
    t.cleanup();
  }
});
