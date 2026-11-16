/** The Unix-socket server and the daemon entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { response_hello_200 } from '../src/generated/validators.js';
import { privateTmp, socketCall } from './helpers.js';

const close = (server: { close: (cb: () => void) => void; closeAllConnections?: () => void }) =>
  new Promise<void>(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

test('server: listens only on a 0600 socket in an owned 0700 directory and answers B2 over HTTP', async () => {
  const tmp = privateTmp();
  const server = createB2Server(createApp().handle);
  try {
    const socket = join(tmp.dir, 'b2.sock');
    await listenPrivate(server, socket);
    assert.equal(server.address(), socket, 'a Unix socket path, never a TCP address');
    assert.equal(lstatSync(socket).mode & 0o777, 0o600);
    const hello = await socketCall(socket, 'GET', '/b2/hello');
    assert.equal(hello.status, 200);
    assert.equal(response_hello_200(hello.body), true);
    const prompt = await socketCall(socket, 'POST', '/b2/workers/w1/prompt', { command_id: 'c', worker_epoch: 'e', session_id: 's', binding_revision: 1, message: 'm' });
    assert.deepEqual(prompt, { status: 501, body: { error: 'operation_not_implemented', effect: 'no_effect' } });
  } finally {
    await close(server);
    tmp.cleanup();
  }
});

test('server: refuses a socket directory that is not owned 0700 or is a symlink', async () => {
  const tmp = privateTmp();
  try {
    const open = join(tmp.dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    await assert.rejects(listenPrivate(createB2Server(createApp().handle), join(open, 'b2.sock')), /0700/);
    const real = join(tmp.dir, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(tmp.dir, 'link'));
    await assert.rejects(listenPrivate(createB2Server(createApp().handle), join(tmp.dir, 'link', 'b2.sock')), /0700/);
    await assert.rejects(listenPrivate(createB2Server(createApp().handle), 'relative.sock'), /absolute/);
  } finally {
    tmp.cleanup();
  }
});

test('server: never replaces a live socket or a non-socket file; removes a stale socket', async () => {
  const tmp = privateTmp();
  const live = netServer();
  try {
    const socket = join(tmp.dir, 'b2.sock');
    live.listen(socket);
    await once(live, 'listening');
    await assert.rejects(listenPrivate(createB2Server(createApp().handle), socket), /another process answers/);
    // A stale socket: its listener was SIGKILLed, so the file stays and nothing answers.
    const stale = join(tmp.dir, 'stale.sock');
    const holder = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(stale)}, () => console.log('up'))`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await once(holder.stdout, 'data');
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    assert.ok(existsSync(stale));
    const server = createB2Server(createApp().handle);
    await listenPrivate(server, stale);
    assert.equal((await socketCall(stale, 'GET', '/b2/hello')).status, 200);
    await close(server);
    const file = join(tmp.dir, 'file.sock');
    writeFileSync(file, '');
    await assert.rejects(listenPrivate(createB2Server(createApp().handle), file), /non-socket/);
  } finally {
    await close(live);
    tmp.cleanup();
  }
});

/** A socket file whose listener was SIGKILLed: the path stays and nothing answers on it. */
async function staleSocket(path: string): Promise<void> {
  const holder = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await once(holder.stdout, 'data');
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  assert.ok(existsSync(path));
}

test('server: concurrent starts over one stale socket: exactly one listens, the other never replaces it (review F2)', async () => {
  const tmp = privateTmp();
  const servers = [0, 1, 2].map(() => createB2Server(createApp().handle));
  try {
    const socket = join(tmp.dir, 'b2.sock');
    await staleSocket(socket);
    const results = await Promise.allSettled(servers.map(server => listenPrivate(server, socket)));
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
    assert.equal(won.length, 1, `exactly one start wins, got ${JSON.stringify(results.map(r => r.status))}`);
    for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /another supervisor|another process answers/);
    const winner = servers[won[0]!]!;
    assert.equal(winner.listening, true);
    assert.equal(servers.filter(s => s.listening).length, 1);
    const before = lstatSync(socket).ino;
    assert.equal((await socketCall(socket, 'GET', '/b2/hello')).status, 200);
    // A later start while the winner lives is refused and leaves the winner's socket in place.
    await assert.rejects(listenPrivate(createB2Server(createApp().handle), socket), /another supervisor|another process answers/);
    assert.equal(lstatSync(socket).ino, before);
    assert.equal((await socketCall(socket, 'GET', '/b2/hello')).status, 200);
    // Closing the winner removes its socket and frees the path for the next start.
    await close(winner);
    assert.equal(existsSync(socket), false);
    const next = createB2Server(createApp().handle);
    await listenPrivate(next, socket);
    assert.equal((await socketCall(socket, 'GET', '/b2/hello')).status, 200);
    await close(next);
  } finally {
    for (const server of servers) if (server.listening) await close(server);
    tmp.cleanup();
  }
});

test('server: a SIGKILLed daemon leaves its socket stale; the next daemon takes it over', async () => {
  const tmp = privateTmp();
  const socket = join(tmp.dir, 'run', 'b2.sock');
  const daemons: ReturnType<typeof startDaemon>[] = [];
  try {
    const first = startDaemon(socket, join(tmp.dir, 'state'));
    daemons.push(first);
    await first.listening;
    first.child.kill('SIGKILL');
    await once(first.child, 'exit');
    assert.ok(existsSync(socket), 'SIGKILL leaves the socket file');
    const second = startDaemon(socket, join(tmp.dir, 'state'));
    daemons.push(second);
    await second.listening;
    assert.equal((await socketCall(socket, 'GET', '/b2/hello')).status, 200);
    // A third start while the second lives exits non-zero and leaves the socket answering.
    const third = startDaemon(socket, join(tmp.dir, 'state'));
    daemons.push(third);
    await assert.rejects(third.listening, /exited 1/);
    assert.equal((await socketCall(socket, 'GET', '/b2/hello')).status, 200);
  } finally {
    for (const d of daemons) if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGKILL');
    tmp.cleanup();
  }
});

function startDaemon(socket: string, stateDir: string) {
  const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [main], {
    env: { PATH: process.env.PATH, PIW_SOCKET: socket, PIW_STATE_DIR: stateDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  const listening = new Promise<void>((resolve, reject) => {
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.includes('"listening"')) resolve();
    });
    child.once('exit', code => reject(new Error(`daemon exited ${code}: ${stderr}`)));
  });
  listening.catch(() => {});
  return { child, listening };
}

test('main: the daemon creates private directories, serves hello on PIW_SOCKET and removes the socket on SIGTERM', async () => {
  const tmp = privateTmp();
  const socket = join(tmp.dir, 'run', 'pi-worker', 'b2.sock');
  const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [main], {
    env: { PATH: process.env.PATH, PIW_SOCKET: socket, PIW_STATE_DIR: join(tmp.dir, 'state') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('"listening"')) resolve();
      });
      child.once('exit', code => reject(new Error(`daemon exited ${code}: ${stderr}`)));
    });
    assert.equal(lstatSync(join(tmp.dir, 'state')).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(tmp.dir, 'run', 'pi-worker')).mode & 0o777, 0o700);
    assert.equal(lstatSync(socket).mode & 0o777, 0o600);
    const hello = await socketCall(socket, 'GET', '/b2/hello');
    assert.equal(hello.status, 200);
    assert.deepEqual((hello.body as { protocol: unknown }).protocol, { major: 0, minor: 1 });
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(existsSync(socket), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    tmp.cleanup();
  }
});
