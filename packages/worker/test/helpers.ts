/** Test helpers: repository paths, wire fixtures, a temporary private directory and a raw socket HTTP call. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tests run from packages/worker/dist/test. */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export interface WireFixture {
  /** `headers` carry header parameters and a binary body's Content-Type; `bodyBase64` is a binary body. */
  request: { path?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; bodyBase64?: string };
  response: { status: number; body?: unknown; frames?: unknown[] };
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

/** One HTTP request over a Unix socket; resolves with status and parsed JSON body. */
export function socketCall(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: { Connection: 'close', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
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
