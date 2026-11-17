/** Test helpers: repository paths, wire fixtures, a temporary private directory and a raw socket HTTP call. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrantStore, writeBearerFile } from '../src/grants/store.js';

/** Tests run from packages/worker/dist/test. */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export interface WireFixture {
  /** `headers` carry header parameters and a binary body's Content-Type; `bodyBase64` is a binary body. */
  request: { path?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; bodyBase64?: string };
  /** An ndjson or binary 200 carries its wire headers, media type and `bodyText` (ndjson) or `bodyBase64` bytes. */
  response: { status: number; body?: unknown; frames?: unknown[]; headers?: Record<string, string>; contentType?: string; bodyText?: string; bodyBase64?: string };
}

export function wireFixtures(): { operationId: string; name: string; fixture: WireFixture }[] {
  const dir = join(repoRoot, 'api', 'fixtures', 'wire');
  return readdirSync(dir).flatMap(operationId =>
    readdirSync(join(dir, operationId))
      .filter(f => f.endsWith('.json'))
      .map(name => ({ operationId, name, fixture: JSON.parse(readFileSync(join(dir, operationId, name), 'utf8')) as WireFixture })),
  );
}

export function bundledSpec(): {
  paths: Record<string, Record<string, { operationId: string; 'x-piw-status'?: string }>>;
} {
  return JSON.parse(readFileSync(join(repoRoot, 'api', 'generated', 'b2.json'), 'utf8'));
}

export function specOperationIds(): string[] {
  return Object.values(bundledSpec().paths).flatMap(item =>
    Object.entries(item)
      .filter(([m]) => ['get', 'put', 'post', 'delete', 'patch'].includes(m))
      .map(([, op]) => op.operationId),
  );
}

/** A fresh 0700 directory under TMPDIR, removed by cleanup(). */
export function privateTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'piw-test-'));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A fixed installation id for a test directory, for a containment that has no state of its own (a state's id is
 * `openState(dir).installation`, random and recorded).
 */
export function testInstallation(dir: string): string {
  return createHash('sha256').update(dir).digest('hex').slice(0, 20);
}

/** One HTTP request over a Unix socket; resolves with status and parsed JSON body. */
export function socketCall(socketPath: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: { Connection: 'close', ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (error) {
            reject(error as Error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * One HTTP request with a raw body over a Unix socket, written in `chunk`-byte pieces (Transfer-Encoding: chunked
 * unless `headers` sets Content-Length). Resolves with the status and JSON body, even if the worker answers and
 * closes before the whole body is written.
 */
export function socketRaw(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
  chunk = 64 * 1024,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = request({ socketPath, method, path, agent: false, headers: { Connection: 'close', ...headers } }, res => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error as Error);
        }
      });
    });
    req.on('error', error => {
      if (!answered) reject(error);
    });
    (async () => {
      for (let at = 0; at < body.length && !answered && !req.destroyed; at += chunk) {
        if (!req.write(body.subarray(at, at + chunk))) await new Promise(r => req.once('drain', r));
      }
      if (!req.destroyed) req.end();
    })().catch(() => {});
  });
}

/** Builds `/b2/...?...` for an operation from its route path and a wire fixture request. */
export function urlFor(path: string, request: WireFixture['request']): string {
  const filled = path.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(request.path?.[name] ?? ''));
  const query = new URLSearchParams(request.query ?? {}).toString();
  return query ? `${filled}?${query}` : filled;
}

/** One raw SSE record as it crossed the socket: its field lines and the record's byte size. */
export interface SseRecord {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
  readonly bytes: number;
}

/**
 * Opens an SSE GET over the socket and hands each complete record to `onRecord` until it returns false or the
 * worker ends the stream. Resolves with the status, the content type and every record seen. Test-only reader: it
 * splits on blank lines and does not implement the client's limits.
 */
export function sseRecords(
  socketPath: string,
  path: string,
  onRecord: (record: SseRecord) => boolean | void = () => true,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string | undefined; records: SseRecord[]; ended: boolean; body?: unknown }> {
  return new Promise((resolve, reject) => {
    const records: SseRecord[] = [];
    const req = request({ socketPath, method: 'GET', path, agent: false, headers: { Connection: 'close', ...headers } }, res => {
      const contentType = res.headers['content-type'];
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType, records, ended: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        return;
      }
      let buffer = '';
      let done = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (done) return;
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end < 0) break;
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const field = (name: string) => raw.split('\n').find(l => l.startsWith(`${name}: `))?.slice(name.length + 2);
          const record = { id: field('id'), event: field('event'), data: field('data') ?? '', bytes: Buffer.byteLength(raw) + 2 };
          records.push(record);
          if (onRecord(record) === false) {
            done = true;
            req.destroy();
            resolve({ status: 200, contentType, records, ended: false });
            return;
          }
        }
      });
      res.on('end', () => {
        if (!done) resolve({ status: 200, contentType, records, ended: true });
      });
      res.on('error', error => {
        if (!done) reject(error);
      });
    });
    req.on('error', error => reject(error));
    req.end();
  });
}

/** An owner grant (every method, every worker and cwd) in `stateDir`, its bearer file and the header to send. */
export function ownerGrant(stateDir: string, id = 'owner'): { grants: GrantStore; token: string; file: string; headers: Record<string, string> } {
  const grants = new GrantStore(stateDir);
  const { token } = grants.register({ caller: 'test-owner', scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods: ['*'], answers_for_person: true, grant_id: id });
  const file = join(stateDir, `${id}.grant.json`);
  writeBearerFile(file, token);
  return { grants, token, file, headers: { authorization: `Bearer ${token}` } };
}
