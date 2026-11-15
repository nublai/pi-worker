/** THROWAWAY hand-written Unix HTTP/SSE client over generated API types. No retries. */
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { operations } from './api.generated.js';
import type { Cursor } from './types.js';
import type { Frame } from './events.js';
type Op = keyof operations;
type Response<O extends Op> = operations[O] extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type Body<O extends Op> = operations[O] extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
const routes = {
  hello: ['GET', '/v0/hello'], 'workers.create': ['POST', '/v0/workers'], 'workers.list': ['GET', '/v0/workers'],
  'workers.get': ['GET', '/v0/workers/:id'], 'sessions.prompt': ['POST', '/v0/workers/:id/prompt'],
  'workers.stop': ['POST', '/v0/workers/:id/stop'], 'history.page': ['GET', '/v0/workers/:id/history'],
  'events.subscribe': ['GET', '/v0/events'], 'receipts.get': ['GET', '/v0/receipts/:id'],
  'sessions.resolve_unknown': ['POST', '/v0/workers/:id/resolve_unknown'],
  'sessions.rebind': ['POST', '/v0/workers/:id/rebind'], 'sessions.follow_up': ['POST', '/v0/workers/:id/follow_up'],
  'children.launch': ['POST', '/v0/workers/:id/children'], 'children.report': ['POST', '/v0/workers/:id/report'],
  'executions.cancel': ['POST', '/v0/workers/:id/cancel'], 'executions.interrupt': ['POST', '/v0/workers/:id/interrupt'],
} as const satisfies Record<Op, readonly [string, string]>;
export class ClientFailure extends Error {
  constructor(message: string, readonly effect: 'no_effect' | 'unknown', readonly phase: 'before_write' | 'after_write' | 'http', readonly status?: number, readonly details: Record<string, unknown> = {}) { super(message); }
}
export class ResyncRequired extends Error { constructor(readonly reason: string) { super(`SSE ${reason}; fresh snapshot required before controls`); } }
export class Client {
  resyncRequired = true;
  constructor(readonly socketPath: string, readonly grantFile = process.env.A0_GRANT_FILE ?? join(dirname(socketPath), 'grants', 'owner.json')) {}
  private headers(): Record<string, string> {
    try { return { Authorization: `Bearer ${(JSON.parse(readFileSync(this.grantFile, 'utf8')) as { token: string }).token}` }; }
    catch { return {}; } // Missing/invalid grant is refused by the server, never retried.
  }
  call<O extends Op>(op: O, options: { id?: string; body?: Body<O>; query?: Record<string, string> } = {}): Promise<Response<O>> {
    const [method, template] = routes[op];
    const path = template.replace(':id', encodeURIComponent(options.id ?? '')) + (options.query ? '?' + new URLSearchParams(options.query) : '');
    const data = options.body ? JSON.stringify(options.body) : undefined;
    return new Promise((resolve, reject) => {
      let wrote = false;
      const fail = (e: unknown) => reject(e instanceof ClientFailure ? e : new ClientFailure(e instanceof Error ? e.message : 'transport_failure', wrote ? 'unknown' : 'no_effect', wrote ? 'after_write' : 'before_write'));
      const req = request({ socketPath: this.socketPath, method, path, agent: false, headers: { ...this.headers(), Connection: 'close', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 2 * 1024 * 1024) { res.destroy(new Error('response too large')); return; } chunks.push(b); });
        res.on('error', fail); res.on('aborted', () => fail(new Error('response_aborted_reconcile_command_id')));
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            if (res.statusCode !== 200) reject(new ClientFailure(String(value.error ?? 'HTTP refusal'), value.effect === 'no_effect' ? 'no_effect' : 'unknown', 'http', res.statusCode, value)); else resolve(value as Response<O>);
          } catch (error) { fail(error); }
        });
      });
      req.setTimeout(60000, () => req.destroy(new Error('HTTP timeout; reconcile command_id, never blind replay')));
      req.on('error', fail);
      // Nothing is written until connect. Once end() is attempted, every ambiguous failure is unknown.
      req.once('socket', socket => { socket.once('connect', () => { wrote = true; req.end(data); }); });
    });
  }
  watch(id: string | null, onFrame: (frame: Frame) => boolean, since?: Cursor, options: { types?: string[]; overflowResync?: boolean } = {}): Promise<void> {
    this.resyncRequired = true;
    const query = new URLSearchParams(); if (id) query.set('worker_id', id);
    if (options.types) query.set('types', options.types.join(',')); if (options.overflowResync) query.set('resync', 'overflow');
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (error: Error) => { if (done) return; done = true; this.resyncRequired = true; req.destroy(); reject(error); };
      const req = request({ socketPath: this.socketPath, path: '/v0/events?' + query, agent: false, headers: { ...this.headers(), Connection: 'close', ...(since ? { 'Last-Event-ID': JSON.stringify(since) } : {}) } }, res => {
        if (res.statusCode !== 200) { res.resume(); fail(new ResyncRequired(`HTTP ${res.statusCode}`)); return; }
        let pending = ''; res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          pending += chunk;
          for (;;) {
            const end = pending.indexOf('\n\n'); if (end < 0 || done) break;
            const record = pending.slice(0, end); pending = pending.slice(end + 2);
            const data = record.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
            if (!data) continue;
            try {
              const frame = JSON.parse(data) as Frame;
              if (frame.type === 'snapshot') this.resyncRequired = false;
              if (frame.type === 'overflow') { onFrame(frame); fail(new ResyncRequired('overflow')); break; }
              if (!onFrame(frame)) { done = true; req.destroy(); resolve(); }
            } catch (error) { fail(error instanceof Error ? error : new Error('invalid_SSE_frame')); }
          }
          if (pending.length > 1024 * 1024) fail(new ResyncRequired('frame_too_large'));
        });
        res.on('error', fail); res.on('aborted', () => fail(new ResyncRequired('disconnected')));
        res.on('end', () => fail(new ResyncRequired('disconnected')));
      });
      req.on('error', fail); req.end();
    });
  }
}
