/** B2 HTTP router. No TCP listener. Stock Node has no portable SO_PEERCRED API;
 * this slice enforces owned private directory/socket and advertises that limitation.
 */
import { createServer, type ServerResponse, type IncomingMessage, type Server } from 'node:http';
import { readFileSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Refusal, type Binding, type Create, type Prompt, type Cursor } from './types.js';
import { Supervisor } from './supervisor.js';
import type { DurableHost } from './durable-host.js';
function loadSpec(): { components: { schemas: Record<string, Schema> } } {
  try { return JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as { components: { schemas: Record<string, Schema> } }; }
  catch (cause) { throw new Error('cannot load checked-in OpenAPI spec; refusing startup', { cause }); }
}
const spec = loadSpec();
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; minimum?: number; maximum?: number };
function validate(schema: Schema, value: unknown): boolean {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') return typeof value === 'string' && value.length > 0 && value.length <= 128 * 1024;
  if (schema.type === 'integer') return Number.isSafeInteger(value) && Number(value) >= (schema.minimum ?? -Infinity) && Number(value) <= (schema.maximum ?? Infinity);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    if (schema.required?.some(k => !(k in data))) return false;
    if (schema.additionalProperties === false && Object.keys(data).some(k => !(k in (schema.properties ?? {})))) return false;
    return Object.entries(schema.properties ?? {}).every(([k, sub]) => !(k in data) || validate(sub, data[k]));
  }
  return true;
}
async function body(req: IncomingMessage, name: 'Create' | 'Prompt' | 'Binding'): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Refusal('content_type_must_be_json');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 262144) throw new Refusal('request_too_large');
    chunks.push(chunk as Buffer);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Refusal('invalid_json'); }
  if (!validate(spec.components.schemas[name]!, data)) throw new Refusal('request_schema_mismatch');
  const parsed = data as Record<string, unknown>;
  if (String(parsed.command_id).length > 128 || (parsed.cwd && (typeof parsed.cwd !== 'string' || !parsed.cwd.startsWith('/')))) throw new Refusal('invalid_id_or_cwd');
  return parsed;
}
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data) + '\n');
}
function cursor(req: IncomingMessage, url: URL): Cursor | null {
  let value: unknown = null;
  if (url.searchParams.has('seq')) value = { worker_epoch: url.searchParams.get('worker_epoch'), seq: Number(url.searchParams.get('seq')) };
  else if (req.headers['last-event-id']) {
    try { value = JSON.parse(String(req.headers['last-event-id'])); } catch { throw new Refusal('invalid_cursor'); }
  }
  if (value !== null) {
    const c = value as Cursor;
    if (typeof c.worker_epoch !== 'string' || !Number.isSafeInteger(c.seq) || c.seq < 0) throw new Refusal('invalid_cursor');
  }
  return value as Cursor | null;
}
export function router(supervisor: Supervisor | DurableHost): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://a0-unix-socket');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && url.pathname === '/v0/hello') return json(res, supervisor.hello());
      if (url.pathname === '/v0/workers') {
        if (req.method === 'GET') return json(res, supervisor.list());
        if (req.method === 'POST') return json(res, await supervisor.create(await body(req, 'Create') as Create));
      }
      if (req.method === 'GET' && parts[0] === 'v0' && parts[1] === 'receipts' && parts.length === 3) {
        const receipt = supervisor.receipts.all.get(parts[2]!);
        if (!receipt) throw new Refusal('unknown_command_id_is_not_proof_of_no_effect');
        return json(res, receipt);
      }
      if (parts[0] !== 'v0' || parts[1] !== 'workers' || !parts[2]) throw new Refusal('unsupported_method');
      const id = parts[2]; const live = supervisor.require(id);
      if (parts.length === 3 && req.method === 'GET') return json(res, supervisor.get(id));
      if (parts.length !== 4) throw new Refusal('unsupported_method');
      if (parts[3] === 'prompt' && req.method === 'POST') return json(res, await supervisor.prompt(id, await body(req, 'Prompt') as Prompt));
      if (parts[3] === 'stop' && req.method === 'POST') return json(res, await supervisor.stop(id, await body(req, 'Binding') as Binding));
      if (parts[3] === 'history' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Refusal('invalid_history_limit');
        const watermark = url.searchParams.get('watermark');
        supervisor.get(id);
        const page = await live.index.page(watermark ? { watermark, after: url.searchParams.get('after') } : null, limit);
        if ('error' in page) throw new Refusal(page.error);
        return json(res, page);
      }
      if (parts[3] === 'events' && req.method === 'GET') {
        const since = cursor(req, url);
        // Validation/state read before HTTP success; attach repeats synchronously at barrier.
        supervisor.get(id);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const detach = live.hub.attach(() => supervisor.get(id), since, frame => {
          if (res.destroyed) return;
          res.write(`id: ${JSON.stringify(frame.cursor)}\nevent: ${frame.type === 'snapshot' ? 'snapshot' : 'worker_event'}\ndata: ${JSON.stringify(frame)}\n\n`);
          if (res.writableLength > 1048576) res.destroy();
        });
        res.once('close', detach);
        return; // Disconnect never cancels the worker.
      }
      throw new Refusal('unsupported_method');
    })().catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const refusal = error instanceof Refusal ? error : new Refusal('internal_error_reconcile_before_retry', 'unknown');
      json(res, { error: refusal.message, effect: refusal.effect, ...(refusal.uncertain_command_id ? { uncertain_command_id: refusal.uncertain_command_id } : {}) }, refusal.effect === 'unknown' ? 500 : 409);
    });
  });
}
export async function listenPrivate(server: Server, socketPath: string): Promise<void> {
  const dir = lstatSync(dirname(socketPath));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) throw new Error('socket directory must be owned, non-symlink 0700');
  try {
    const sock = lstatSync(socketPath);
    if (!sock.isSocket() || sock.uid !== process.getuid?.()) throw new Error('refusing to unlink non-owned socket');
    unlinkSync(socketPath); // Caller must hold the installation single-supervisor lock.
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
}
