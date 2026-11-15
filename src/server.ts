/** B2 HTTP router. No TCP listener. Stock Node has no portable SO_PEERCRED API;
 * this slice enforces owned private directory/socket and advertises that limitation.
 */
import { createServer, type ServerResponse, type IncomingMessage, type Server } from 'node:http';
import { readFileSync, lstatSync, chmodSync, unlinkSync, cpSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { inside } from './sandbox.js';
import { Refusal, type Binding, type Create, type Prompt, type Cursor, type Resolve, type Rebind, type FollowUp, type Control, type ChildLaunch, type Report } from './types.js';
import type { Supervisor } from './supervisor.js';
import type { Answer } from './interactions.js';
function loadSpec(): { components: { schemas: Record<string, Schema> } } {
  try { return JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as { components: { schemas: Record<string, Schema> } }; }
  catch (cause) { throw new Error('cannot load checked-in OpenAPI spec; refusing startup', { cause }); }
}
const spec = loadSpec();
type Schema = { $ref?: string; anyOf?: Schema[]; const?: unknown; type?: string; items?: Schema; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number };
function validate(schema: Schema, value: unknown): boolean {
  if (schema.$ref) return validate(spec.components.schemas[schema.$ref.split('/').at(-1)!]!, value);
  if (schema.anyOf) return schema.anyOf.some(s => validate(s, value));
  if ('const' in schema && schema.const !== value) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.every(v => !schema.items || validate(schema.items, v));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 1) && value.length <= (schema.maxLength ?? 128 * 1024);
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
async function body(req: IncomingMessage, name: 'Create' | 'Prompt' | 'Binding' | 'Resolve' | 'Rebind' | 'FollowUp' | 'Control' | 'ChildLaunch' | 'Report' | 'Answer' | 'FileRead'): Promise<Record<string, unknown>> {
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
export type ParentChannel = { workerId: string; epoch: string };
export function router(supervisor: Supervisor, channel?: ParentChannel): Server {
  const owned = (id: string) => !channel || id === channel.workerId || supervisor.require(id).worker.parent_worker_id === channel.workerId;
  const methods = ['hello', 'workers.list', 'workers.get', 'workers.create', 'sessions.prompt', 'workers.stop', 'events.subscribe', 'history.page', 'receipts.get'];
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://a0-unix-socket');
      const parent = channel ? supervisor.require(channel.workerId).worker : undefined;
      if (channel && (parent!.worker_epoch !== channel.epoch || !['starting', 'ready'].includes(parent!.status))) throw new Refusal('parent_channel_retired');
      // The channel is the authority. Its compatibility config contains a PUBLIC
      // placeholder, not a B2 bearer. Real credentials never enter the sandbox.
      const token = parent ? supervisor.grants.active(parent.grant_source_id ?? 'owner').token : req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
      const caller = supervisor.grants.authenticate(token);
      const check = (method: string, id?: string, cwd?: string) => {
        if (channel && (!methods.includes(method) || (id && !owned(id)) || (cwd && !inside(realpathSync(join(parent!.cwd, '.a0-worktrees')), realpathSync(cwd))))) throw new Refusal('parent_channel_scope_denied');
        if (channel && (supervisor.require(channel.workerId).worker.worker_epoch !== channel.epoch || !['starting', 'ready'].includes(supervisor.require(channel.workerId).worker.status))) throw new Refusal('parent_channel_retired');
        return supervisor.grants.check(token, method, id ? supervisor.require(id).worker : undefined, cwd);
      };
      const visible = (grant: typeof caller, id: string) => owned(id) && supervisor.grants.allowsWorker(grant, supervisor.require(id).worker);
      let parts: string[];
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new Refusal('invalid_path_encoding'); }
      const guard = (method: string, id?: string, cwd?: string) => Object.assign(() => { check(method, id, cwd); }, { actor: caller.caller, grant_id: caller.grant_id, grant_state_dir: supervisor.stateDir });
      const run = <T>(method: string, action: () => T, id?: string, cwd?: string): T => {
        const check = guard(method, id, cwd); check();
        return supervisor.callerGrant.run(supervisor.grants.authenticate(token), () => supervisor.authority.run(check, action));
      };
      if (req.method === 'GET' && url.pathname === '/v0/events') {
        const initialGrant = check('events.subscribe');
        const since = cursor(req, url);
        const workerIds = url.searchParams.get('worker_id')?.split(',');
        if (workerIds) for (const id of workerIds) check('events.subscribe', id);
        const types = url.searchParams.get('types')?.split(',');
        supervisor.list();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const subscription = supervisor.events.subscribe(() => supervisor.list().filter(w => visible(initialGrant, w.worker_id)), since, frame => {
          if (res.destroyed) return false;
          try { check('events.subscribe'); } catch { res.end(); return false; }
          return res.write(`id: ${JSON.stringify(frame.cursor)}\nevent: ${frame.type === 'snapshot' ? 'snapshot' : frame.type === 'overflow' ? 'overflow' : 'worker_event'}\ndata: ${JSON.stringify(frame)}\n\n`);
        }, { workerIds, types, acceptWorker: id => visible(initialGrant, id), overflowResync: url.searchParams.get('resync') === 'overflow', onOverflow: () => {
          res.end();
          // A peer that never drains cannot retain even the bounded final transport buffer forever.
          const timer = setTimeout(() => { if (!res.destroyed) res.destroy(); }, 1000); timer.unref();
        } });
        res.on('drain', subscription.drain); res.once('close', () => { subscription.close(); res.off('drain', subscription.drain); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v0/hello') return json(res, run('hello', () => supervisor.hello()));
      if (url.pathname === '/v0/workers') {
        if (req.method === 'GET') return json(res, run('workers.list', () => { const g = check('workers.list'); return supervisor.list().filter(w => visible(g, w.worker_id)); }));
        if (req.method === 'POST') {
          const c = await body(req, 'Create') as Create;
          if (channel) {
            if (c.parent?.worker_id !== channel.workerId || !c.launch_spec) throw new Refusal('parent_channel_requires_own_child');
            check('workers.create', channel.workerId, c.cwd);
            const profile = join(parent!.cwd, '.a0-agent'), childProfile = join(realpathSync(c.cwd), '.a0-agent');
            const remap = (path: string) => {
              if (!inside(profile, realpathSync(path))) throw new Refusal('parent_channel_resource_outside_profile');
              return join(childProfile, relative(profile, path));
            };
            c.launch_spec.resources = { extensions: c.launch_spec.resources.extensions.map(remap), skills: c.launch_spec.resources.skills.map(remap) };
            cpSync(profile, childProfile, { recursive: true, dereference: true, errorOnExist: true, force: false });
            c.host = 'sdk'; c.launch_spec.environment.filesystem = 'bwrap'; c.launch_spec.environment.root = realpathSync(c.cwd);
          }
          return json(res, await run('workers.create', () => supervisor.create(c), c.parent?.worker_id, c.cwd));
        }
      }
      if (req.method === 'GET' && parts[0] === 'v0' && parts[1] === 'receipts' && parts.length === 3) {
        check('receipts.get');
        const receipt = supervisor.receipts.all.get(parts[2]!);
        if (!receipt) throw new Refusal('unknown_command_id_is_not_proof_of_no_effect', 'unknown');
        const grant = check('receipts.get', receipt.worker_id);
        if (!receipt.worker_id && !grant.scope.worker_ids.includes('*')) throw new Refusal('grant_scope_unknown_receipt');
        return json(res, receipt);
      }
      if (parts[0] !== 'v0' || parts[1] !== 'workers' || !parts[2]) throw new Refusal('unsupported_method');
      const id = parts[2]; const live = supervisor.require(id);
      if (parts.length === 3 && req.method === 'GET') return json(res, run('workers.get', () => supervisor.get(id), id));
      if (parts[3] === 'interactions') {
        if (parts.length === 4 && req.method === 'GET') return json(res, run('interactions.list', () => supervisor.interactions.list(id), id));
        if (parts.length === 5 && parts[4] === 'status' && req.method === 'GET') return json(res, run('interactions.status', () => supervisor.interactions.status(id, url.searchParams.get('interaction_id') ?? ''), id));
        if (parts.length === 5 && parts[4] === 'answer_if_current' && req.method === 'POST') { const a = await body(req, 'Answer') as Answer; return json(res, await run('interactions.answer_if_current', () => supervisor.answer(id, a), id)); }
      }
      if (parts.length === 5 && parts[3] === 'files' && parts[4] === 'read' && req.method === 'POST') {
        const request = await body(req, 'FileRead') as { path: string; roots: string[] };
        return json(res, run('files.read', () => supervisor.readFile(id, request), id));
      }
      if (parts.length !== 4) throw new Refusal('unsupported_method');
      if (parts[3] === 'prompt' && req.method === 'POST') { const p = await body(req, 'Prompt') as Prompt; return json(res, await run('sessions.prompt', () => supervisor.prompt(id, p), id)); }
      if (parts[3] === 'relaunch' && req.method === 'POST') { const b = await body(req, 'Binding') as Binding; return json(res, await run('workers.relaunch', () => supervisor.relaunch(id, b), id)); }
      if (parts[3] === 'stop' && req.method === 'POST') { const b = await body(req, 'Binding') as Binding; return json(res, await run('workers.stop', () => supervisor.stop(id, b), id)); }
      if (parts[3] === 'resolve_unknown' && req.method === 'POST') { const r = await body(req, 'Resolve') as Resolve; return json(res, await run('sessions.resolve_unknown', () => supervisor.resolveUnknown(id, r), id)); }
      if (parts[3] === 'rebind' && req.method === 'POST') { const b = await body(req, 'Rebind') as Rebind; return json(res, await run('sessions.rebind', () => supervisor.rebind(id, b), id)); }
      if (parts[3] === 'follow_up' && req.method === 'POST') { const p = await body(req, 'FollowUp') as FollowUp; return json(res, await run('sessions.follow_up', () => supervisor.followUp(id, p), id)); }
      if (parts[3] === 'children' && req.method === 'POST') { const p = await body(req, 'ChildLaunch') as ChildLaunch; return json(res, await run('children.launch', () => supervisor.launchChild(id, p), id, p.launch.cwd)); }
      if (parts[3] === 'report' && req.method === 'POST') { const r = await body(req, 'Report') as Report; return json(res, await run('children.report', () => supervisor.report(id, r), id)); }
      if (['cancel', 'interrupt'].includes(parts[3]!) && req.method === 'POST') { const b = await body(req, 'Control') as Control, interrupt = parts[3] === 'interrupt'; return json(res, await run(interrupt ? 'executions.interrupt' : 'executions.cancel', () => supervisor.control(id, b, interrupt), id)); }
      if (parts[3] === 'history' && req.method === 'GET') {
        check('history.page', id);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Refusal('invalid_history_limit');
        const watermark = url.searchParams.get('watermark');
        supervisor.get(id);
        const page = live.index.page(watermark ? { watermark, after: url.searchParams.get('after') } : null, limit);
        if ('error' in page) throw new Refusal(page.error);
        return json(res, page);
      }
      if (req.method !== 'GET' && live.worker.fence) throw new Refusal('session_fenced', 'no_effect', live.worker.fence.command_id);
      throw new Refusal('unsupported_method');
    })().catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const refusal = error instanceof Refusal ? error : new Refusal('internal_error_reconcile_before_retry', 'unknown');
      json(res, { error: refusal.message, effect: refusal.effect, ...(refusal.uncertain_command_id ? { uncertain_command_id: refusal.uncertain_command_id } : {}), ...refusal.details }, refusal.effect === 'unknown' ? 500 : 409);
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
