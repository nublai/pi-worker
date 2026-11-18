/**
 * Packed-consumer check: `npm pack` the client, install the tarball into a scratch project with `strict` and
 * `skipLibCheck: false`, and type-check a file that uses the public types and call signatures. This catches a
 * declaration the build forgot to ship (dist/src/generated/routes.d.ts imports ./validators.js types). npm runs with a
 * minimal environment of its own: PATH to this Node's directory, and HOME and the npm cache under the scratch
 * directory, so no user config, cache or variable of the calling shell reaches it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('../../', import.meta.url)); // packages/client-ts (dist/test -> ../../)
const rootDir = join(pkgDir, '..', '..');

const consumer = `import { Client, ClientFailure, Observer, ObserverStateInvalid, parseObserverState, acquisition, classifyReceipt, reconcile, requestHash, routes, type Expected, type Reconciliation, type OperationId, type Receipt, type RequestBody, type CallOptions, type EventFrame, type Cursor, type Notice, type ObserverBatch, type ObserverState, type ObserverStop, type Binding, type components, type paths } from '@nublai/pi-worker-client';
const client = new Client({ socketPath: '/nonexistent.sock' });
const id: OperationId = 'workers.create';
const route = routes[id];
type Body = RequestBody<'sessions.prompt'>;
declare const body: Body;
export const b: Body = body;
declare const opts: CallOptions<'sessions.prompt'>;
declare const frame: EventFrame;
declare const cursor: Cursor;
declare const receipt: Receipt;
declare const err: ClientFailure;
declare const c: components;
declare const p: paths;
export const use = async () => client.call('sessions.prompt', opts);
const expected: Expected = { command_id: 'c', operation: 'sessions.prompt', worker_id: 'w', request_hash: requestHash('sessions.prompt', { path: { worker_id: 'w' }, body }) };
export const settled = async (): Promise<Reconciliation> => reconcile(client, expected);
export const direct: Reconciliation = classifyReceipt(receipt, expected);
export const acquired = acquisition(direct, err).worker;
declare const persisted: unknown;
const restored: ObserverState = parseObserverState(persisted);
const observer = new Observer({ client, signal: AbortSignal.abort(), restored, pending: () => [expected], deliver: async (batch: ObserverBatch) => { const n: Notice[] = batch.notices; void n; } });
export const stopped: Promise<ObserverStop> = observer.run();
export const handle: Binding | undefined = observer.binding('w');
export const invalid = new ObserverStateInvalid('state');
export { route, frame, cursor, receipt, err, c, p };
`;

/** npm's whole environment: this Node first on PATH, HOME and the cache in the scratch directory, nothing inherited. */
const npmEnv = (scratch: string) => ({
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: join(scratch, 'home'),
  npm_config_cache: join(scratch, 'npm-cache'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
});
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env });

test('packed client type-checks for a strict consumer with skipLibCheck false', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'piw-packed-'));
  try {
    const env = npmEnv(dir);
    mkdirSync(env.HOME);
    const dest = join(dir, 'pack');
    mkdirSync(dest);
    const pack = run('npm', ['pack', '--pack-destination', dest, '--json'], pkgDir, env);
    assert.equal(pack.status, 0, pack.stderr);
    const tgz = join(dest, readdirSync(dest).find(f => f.endsWith('.tgz')) ?? assert.fail('no tarball'));

    const proj = join(dir, 'consumer');
    mkdirSync(proj);
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    const install = run('npm', ['install', '--offline', '--ignore-scripts', tgz], proj, env);
    assert.equal(install.status, 0, install.stderr);
    // The client needs @types/node (Buffer, node:net types); link the workspace's copy, as a consumer would install it.
    mkdirSync(join(proj, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(rootDir, 'node_modules', '@types', 'node'), join(proj, 'node_modules', '@types', 'node'), 'dir');
    writeFileSync(join(proj, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, skipLibCheck: false, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', lib: ['ES2023'], types: ['node'], noEmit: true },
      files: ['use.ts'],
    }));
    writeFileSync(join(proj, 'use.ts'), consumer);

    const tsc = run(process.execPath, [join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], proj, env);
    assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
