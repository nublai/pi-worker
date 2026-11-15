/** THROWAWAY B2 grants. Honest-component boundary only: same-user code can read these files. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { syncPoint } from './fsync.js';
import { Refusal, type Worker } from './types.js';
export type Scope = { worker_ids: string[]; cwd_roots: string[] };
export type Grant = { grant_id: string; caller: string; scope: Scope; methods: string[]; token: string; revoked: boolean };
export class GrantStore {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, 'grants');
    if (mkdirSync(this.dir, { recursive: true, mode: 0o700 })) {
      const fd = openSync(stateDir, 'r'); try { syncPoint(fd, 'grant.directory_created'); } finally { closeSync(fd); }
    }
  }
  register(caller: string, scope: Scope, methods: string[], id = randomBytes(12).toString('hex')): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !caller || !methods.length) throw new Refusal('invalid_registration');
    const file = join(this.dir, id + '.json');
    const grant: Grant = { grant_id: id, caller, scope, methods, token: id + '.' + randomBytes(32).toString('base64url'), revoked: false };
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(grant) + '\n'); syncPoint(fd, 'grant.register_file'); } finally { closeSync(fd); }
    const dir = openSync(this.dir, 'r'); try { syncPoint(dir, 'grant.register_directory'); } finally { closeSync(dir); }
    return file; // never return a bearer in logs or HTTP responses
  }
  registerOwner(): string {
    const file = join(this.dir, 'owner.json');
    try { lstatSync(file); this.read('owner'); return file; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return this.register('installation-owner', { worker_ids: ['*'], cwd_roots: ['*'] }, ['*'], 'owner');
  }
  private read(id: string): Grant {
    const file = join(this.dir, id + '.json'), st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new Refusal('grant_file_requires_owned_0600');
    let g: Grant;
    try { g = JSON.parse(readFileSync(file, 'utf8')) as Grant; } catch { throw new Refusal('invalid_grant_file'); }
    if (g.grant_id !== id || typeof g.token !== 'string' || !Array.isArray(g.methods) || !Array.isArray(g.scope?.worker_ids) || !Array.isArray(g.scope?.cwd_roots)) throw new Refusal('invalid_grant_file');
    return g;
  }
  active(id: string): Grant {
    const grant = this.read(id);
    if (grant.revoked) throw new Refusal('grant_revoked');
    return grant;
  }
  authenticate(token: string | undefined): Grant {
    if (!token) throw new Refusal('bearer_grant_required');
    const id = token.split('.')[0]!;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Refusal('invalid_grant');
    let grant: Grant;
    try { grant = this.read(id); } catch { throw new Refusal('invalid_grant'); }
    const received = Buffer.from(token), expected = Buffer.from(grant.token);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Refusal('invalid_grant');
    if (grant.revoked) throw new Refusal(`grant_revoked: caller ${grant.caller}`);
    return grant;
  }
  allowsCwd(grant: Grant, cwd: string): boolean {
    if (grant.scope.cwd_roots.includes('*')) return true;
    let path: string; try { path = realpathSync(cwd); } catch { return false; }
    return grant.scope.cwd_roots.some(root => { try { const base = realpathSync(resolve(root)); return path === base || path.startsWith(base + sep); } catch { return false; } });
  }
  allowsWorker(grant: Grant, worker: Worker): boolean { return grant.scope.worker_ids.includes('*') || grant.scope.worker_ids.includes(worker.worker_id) || this.allowsCwd(grant, worker.cwd); }
  check(token: string | undefined, method: string, worker?: Worker, cwd?: string): Grant {
    const grant = this.authenticate(token);
    if (!grant.methods.includes('*') && !grant.methods.includes(method)) throw new Refusal(`grant_method_denied: ${method}`);
    if (worker && !this.allowsWorker(grant, worker)) throw new Refusal(`grant_scope_denied: worker ${worker.worker_id}`);
    if (cwd && !this.allowsCwd(grant, cwd)) throw new Refusal('grant_scope_denied: environment');
    return grant;
  }
  revoke(id: string): void {
    const grant = this.read(id); grant.revoked = true;
    const fd = openSync(join(this.dir, id + '.json'), 'r+');
    try { writeFileSync(fd, JSON.stringify(grant) + '\n'); syncPoint(fd, 'grant.revoke_file'); } finally { closeSync(fd); }
  }
}
