/**
 * B2 grants: per-caller bearer grants registered by the owner through local file access (the `grant` command of this
 * package, `src/grant.ts`), never over HTTP. Rewritten from A0 `src/grants.ts`; unlike A0 the registry keeps only a
 * SHA-256 of the bearer, never the bearer itself.
 *
 * - One 0600 JSON record per grant in `$STATE/grants/<grant_id>.json` (0700 directory, owned, no symlinks): caller,
 *   scope (worker ids and cwd roots, `*` for all), methods (operationIds, `*` for all), `answers_for_person`, the
 *   bearer's hash and a revoked flag. A record is written to a temporary file, fsynced, then linked (register: a
 *   duplicate id refuses) or renamed (revoke) into place, and the directory fsynced.
 * - The bearer is `piw1.<grant_id>.<secret>`; it is shown once, written by the command to a 0600 file the caller
 *   reads (`{"token": …}`), and compared by hash in constant time.
 * - Every check rereads the record, so a revocation takes effect at the next request, at the next SSE frame (an open
 *   stream also rechecks every 500 ms and ends with an `overflow` naming `grant_revoked`), and at dispatch of
 *   anything a revoked grant had queued.
 *
 * Named limit (invariant 8): same-user code can read the grant files and reach the socket. Grants limit honest
 * components and mistakes; they do not isolate hostile code running as the same OS user.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, type Stats, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Refusal } from '../b2/errors.js';
import { durable } from '../journal/fsync.js';
import type { DurableLabel } from '../journal/labels.js';

export interface Scope {
  readonly worker_ids: readonly string[];
  readonly cwd_roots: readonly string[];
}

export interface GrantRecord {
  readonly grant_id: string;
  readonly caller: string;
  readonly scope: Scope;
  readonly methods: readonly string[];
  /** Only such a grant may answer interactions on behalf of a person (the bridge profile). */
  readonly answers_for_person: boolean;
  /** Lower-case hex SHA-256 of the bearer. The bearer itself is never stored. */
  readonly token_sha256: string;
  readonly revoked: boolean;
  readonly created_at: string;
  readonly revoked_at?: string;
}

/** What a handler learns about the caller: never the bearer or its hash. */
export interface Caller {
  readonly grant_id: string;
  readonly caller: string;
  readonly scope: Scope;
  readonly methods: readonly string[];
  readonly answers_for_person: boolean;
}

export interface Registration {
  readonly caller: string;
  readonly scope: Scope;
  readonly methods: readonly string[];
  readonly answers_for_person?: boolean;
  /** Default: 24 random hex characters. */
  readonly grant_id?: string;
}

const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
export const TOKEN_PREFIX = 'piw1';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function syncDirectory(path: string, label: DurableLabel): void {
  const fd = openSync(path, 'r');
  try {
    durable(fd, label);
  } finally {
    closeSync(fd);
  }
}

function writeDurable(file: string, text: string, label: DurableLabel): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    const data = Buffer.from(text);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    durable(fd, label);
  } finally {
    closeSync(fd);
  }
}

/** Writes the bearer once to a new 0600 file (`{"token": …}`), the form both clients read. Refuses an existing path. */
export function writeBearerFile(file: string, token: string): void {
  writeDurable(file, `${JSON.stringify({ token })}\n`, 'grant.bearer_file');
}

export class GrantStore {
  readonly dir: string;

  constructor(readonly stateDir: string) {
    this.dir = join(stateDir, 'grants');
  }

  private ensureDirectory(): void {
    let created = false;
    try {
      mkdirSync(this.dir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const st = lstatSync(this.dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) {
      throw new Error('the grant directory must be an owned, non-symlink 0700 directory');
    }
    if (created) syncDirectory(this.stateDir, 'grant.directory');
  }

  /** The record of `grant_id`: an owned 0600 regular file whose content names it. */
  read(id: string): GrantRecord {
    if (!ID.test(id)) throw new Refusal('invalid_grant');
    const file = join(this.dir, `${id}.json`);
    let st: Stats;
    try {
      st = lstatSync(file);
    } catch {
      throw new Refusal('invalid_grant');
    }
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new Refusal('grant_file_requires_owned_0600');
    let g: GrantRecord;
    try {
      g = JSON.parse(readFileSync(file, 'utf8')) as GrantRecord;
    } catch {
      throw new Refusal('invalid_grant_file');
    }
    if (
      g?.grant_id !== id ||
      typeof g.caller !== 'string' ||
      !/^[0-9a-f]{64}$/.test(g.token_sha256 ?? '') ||
      !Array.isArray(g.methods) ||
      !Array.isArray(g.scope?.worker_ids) ||
      !Array.isArray(g.scope?.cwd_roots) ||
      typeof g.revoked !== 'boolean'
    ) {
      throw new Refusal('invalid_grant_file');
    }
    return g;
  }

  /** Registers a grant and returns its bearer, which exists nowhere else; the caller writes it to a 0600 file. */
  register(r: Registration): { grant: GrantRecord; token: string } {
    if (typeof r.caller !== 'string' || r.caller.length < 1 || r.caller.length > 128) throw new Refusal('invalid_registration');
    if (!r.methods.length || r.methods.some(m => typeof m !== 'string' || !/^(\*|[a-z_]+(\.[a-z_]+)+|hello)$/.test(m))) throw new Refusal('invalid_registration');
    if (r.scope.worker_ids.some(id => id !== '*' && !ID.test(id)) || r.scope.cwd_roots.some(root => root !== '*' && !root.startsWith('/'))) throw new Refusal('invalid_registration');
    const grant_id = r.grant_id ?? randomBytes(12).toString('hex');
    if (!ID.test(grant_id)) throw new Refusal('invalid_registration');
    this.ensureDirectory();
    const token = `${TOKEN_PREFIX}.${grant_id}.${randomBytes(32).toString('base64url')}`;
    const grant: GrantRecord = {
      grant_id,
      caller: r.caller,
      scope: { worker_ids: [...r.scope.worker_ids], cwd_roots: [...r.scope.cwd_roots] },
      methods: [...r.methods],
      answers_for_person: r.answers_for_person === true,
      token_sha256: sha256(token),
      revoked: false,
      created_at: new Date().toISOString(),
    };
    this.place(grant, false);
    return { grant, token };
  }

  /** Revokes a grant durably; every later check of it refuses `grant_revoked`. */
  revoke(id: string): GrantRecord {
    const grant: GrantRecord = { ...this.read(id), revoked: true, revoked_at: new Date().toISOString() };
    this.place(grant, true);
    return grant;
  }

  /** Every registered grant, without hashes, for the owner's `grant list`. Unreadable records are skipped. */
  list(): Omit<GrantRecord, 'token_sha256'>[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter(n => n.endsWith('.json') && !n.startsWith('.'))
      .flatMap(n => {
        try {
          const { token_sha256: _hash, ...rest } = this.read(n.slice(0, -5));
          return [rest];
        } catch {
          return [];
        }
      });
  }

  /** Write to a temporary file, fsync, then link (a new id; an existing one refuses) or rename into place; fsync the directory. */
  private place(grant: GrantRecord, replace: boolean): void {
    const final = join(this.dir, `${grant.grant_id}.json`);
    const tmp = join(this.dir, `.${grant.grant_id}.${randomBytes(6).toString('hex')}.tmp`);
    writeDurable(tmp, `${JSON.stringify(grant)}\n`, replace ? 'grant.revoke_file' : 'grant.register_file');
    try {
      if (replace) renameSync(tmp, final);
      else {
        try {
          linkSync(tmp, final);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Refusal('grant_id_exists');
          throw error;
        }
        unlinkSync(tmp);
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already moved or never created */
      }
      throw error;
    }
    syncDirectory(this.dir, replace ? 'grant.revoke_directory' : 'grant.register_directory');
  }

  /** The caller of an `Authorization: Bearer …` header, or a refusal. The bearer is compared by hash in constant time. */
  authenticate(authorization: string | undefined): Caller {
    if (!authorization) throw new Refusal('bearer_grant_required');
    const token = /^Bearer ([^\s]+)$/.exec(authorization)?.[1] ?? '';
    const [prefix = '', id = '', secret = '', ...rest] = token.split('.');
    if (rest.length || prefix !== TOKEN_PREFIX || !ID.test(id) || !SECRET.test(secret)) throw new Refusal('invalid_grant');
    let grant: GrantRecord;
    try {
      grant = this.read(id);
    } catch {
      throw new Refusal('invalid_grant');
    }
    const received = Buffer.from(sha256(token), 'hex');
    const expected = Buffer.from(grant.token_sha256, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Refusal('invalid_grant');
    if (grant.revoked) throw new Refusal('grant_revoked');
    return { grant_id: grant.grant_id, caller: grant.caller, scope: grant.scope, methods: grant.methods, answers_for_person: grant.answers_for_person };
  }

  /** The current state of a caller's grant (a revocation since authentication refuses). */
  current(caller: Caller): Caller {
    const grant = this.read(caller.grant_id);
    if (grant.revoked) throw new Refusal('grant_revoked');
    return { grant_id: grant.grant_id, caller: grant.caller, scope: grant.scope, methods: grant.methods, answers_for_person: grant.answers_for_person };
  }
}

export const allowsMethod = (caller: Pick<Caller, 'methods'>, method: string): boolean => caller.methods.includes('*') || caller.methods.includes(method);

/** A cwd is in scope when it resolves (real path) to a scope root or below one. A missing path is out of scope. */
export function allowsCwd(caller: Pick<Caller, 'scope'>, cwd: string): boolean {
  if (caller.scope.cwd_roots.includes('*')) return true;
  let path: string;
  try {
    path = realpathSync(cwd);
  } catch {
    return false;
  }
  return caller.scope.cwd_roots.some(root => {
    try {
      const base = realpathSync(resolve(root));
      return path === base || path.startsWith(base + sep);
    } catch {
      return false;
    }
  });
}

/** A worker is visible by id, or by its cwd under a scope root. */
export const allowsWorker = (caller: Pick<Caller, 'scope'>, worker: { worker_id: string; cwd: string }): boolean =>
  caller.scope.worker_ids.includes('*') || caller.scope.worker_ids.includes(worker.worker_id) || allowsCwd(caller, worker.cwd);
