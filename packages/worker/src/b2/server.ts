/**
 * B2 over HTTP/1.1 on a private Unix socket. There is no TCP listener: `listenPrivate` only takes a socket path.
 * Stock Node has no peer-credential API, so the boundary is an owned 0700 directory, a 0600 socket and (P1-9) the
 * bearer grant. `listenPrivate` is ported from A0 `src/server.ts`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { acquireLock } from '../lock.js';
import type { B2Request, B2Stream, RequestHandler, StreamSink } from './router.js';

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) out[key] = Array.isArray(value) ? value.join(', ') : value;
  return out;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(text);
}

/** Starts an SSE response: headers now, then one validated record per hub frame until the hub or the peer ends it. */
function stream(res: ServerResponse, b2: B2Stream): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'close', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let ended = false;
  const sink: StreamSink = {
    write: record => (res.destroyed || ended ? false : res.write(record)),
    end: () => {
      if (ended) return;
      ended = true;
      res.end();
      // A peer that never drains cannot keep even the final bounded transport buffer forever.
      setTimeout(() => {
        if (!res.destroyed) res.destroy();
      }, 1000).unref();
    },
    destroy: () => res.destroy(),
    onDrain: listener => res.on('drain', listener),
    onClose: listener => res.once('close', listener),
  };
  b2.sse(sink);
}

/** An HTTP server that answers every request through `handle`. One request per connection (no keep-alive). */
export function createB2Server(handle: RequestHandler): Server {
  const server = createServer((req, res) => {
    const request: B2Request = { method: req.method ?? 'GET', url: req.url ?? '/', headers: headersOf(req), body: req };
    handle(request).then(
      response => (response.stream ? stream(res, response.stream) : send(res, response.status, response.body)),
      () => {
        // handle() turns every failure into a validated reply; reaching here means the reply itself failed.
        if (res.headersSent) res.destroy();
        else send(res, 500, { error: 'internal_error_reconcile_before_retry', effect: 'unknown' });
      },
    );
  });
  server.keepAliveTimeout = 0;
  return server;
}

function liveSocket(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Listen on `socketPath`. The parent directory must be an owned, non-symlink 0700 directory.
 *
 * Takeover is serialized by an exclusive lock on `<socketPath>.lock`, taken before the socket is examined and held
 * until the server closes. Under the lock, a stale socket is removed only if it is a socket we own and nothing
 * answers on it. So of two concurrent starts over one stale socket only one gets past the lock, and a second
 * supervisor never replaces a live one (review F2). The lock dies with the process, so a SIGKILLed supervisor's
 * stale socket is taken over by the next start. On close, Node removes the socket file before the lock is released.
 * The caller sets `process.umask(0o077)` first, so the socket and lock are never wider than 0600.
 */
export async function listenPrivate(server: Server, socketPath: string): Promise<void> {
  if (!isAbsolute(socketPath)) throw new Error('socket path must be absolute');
  const dir = lstatSync(dirname(socketPath));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) {
    throw new Error('socket directory must be owned, non-symlink 0700');
  }
  const lock = acquireLock(`${socketPath}.lock`);
  try {
    try {
      const sock = lstatSync(socketPath);
      if (!sock.isSocket() || sock.uid !== process.getuid?.()) throw new Error('refusing to unlink a non-owned or non-socket path');
      if (await liveSocket(socketPath)) throw new Error('another process answers on the socket; refusing to replace it');
      unlinkSync(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    lock.release();
    throw error;
  }
  server.once('close', () => lock.release());
}
