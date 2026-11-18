/**
 * Packed-consumer check: `npm pack` the client, install the tarball into a scratch project with `strict` and
 * `skipLibCheck: false`, and type-check a file that uses the public types and call signatures. This catches a
 * declaration the build forgot to ship (dist/src/generated/routes.d.ts imports ./validators.js types).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('../../', import.meta.url)); // packages/client-ts (dist/test -> ../../)
const rootDir = join(pkgDir, '..', '..');

const consumer = `import { Client, ClientFailure, routes, type OperationId, type Receipt, type RequestBody, type CallOptions, type EventFrame, type Cursor, type components, type paths } from '@nublai/pi-worker-client';
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
export { route, frame, cursor, receipt, err, c, p };
`;

const run = (cmd: string, args: string[], cwd: string) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } });

test('packed client type-checks for a strict consumer with skipLibCheck false', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'piw-packed-'));
  try {
    const dest = join(dir, 'pack');
    mkdirSync(dest);
    const pack = run('npm', ['pack', '--pack-destination', dest, '--json'], pkgDir);
    assert.equal(pack.status, 0, pack.stderr);
    const tgz = join(dest, readdirSync(dest).find(f => f.endsWith('.tgz')) ?? assert.fail('no tarball'));

    const proj = join(dir, 'consumer');
    mkdirSync(proj);
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    const install = run('npm', ['install', '--offline', '--ignore-scripts', tgz], proj);
    assert.equal(install.status, 0, install.stderr);
    // The client needs @types/node (Buffer, node:net types); link the workspace's copy, as a consumer would install it.
    mkdirSync(join(proj, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(rootDir, 'node_modules', '@types', 'node'), join(proj, 'node_modules', '@types', 'node'), 'dir');
    writeFileSync(join(proj, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, skipLibCheck: false, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', lib: ['ES2023'], types: ['node'], noEmit: true },
      files: ['use.ts'],
    }));
    writeFileSync(join(proj, 'use.ts'), consumer);

    const tsc = run(process.execPath, [join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], proj);
    assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
