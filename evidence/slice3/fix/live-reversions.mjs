// Authored VM-only child mutations. Isolated copies and owned child processes only.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync('/tmp/a0s3fix/live-reversions-'), rows = [];
for (const kind of ['missing-child-abort', 'missing-child-gate-denial']) {
  const dest = join(root, kind); mkdirSync(dest);
  for (const file of ['src', 'evidence', 'package.json', 'tsconfig.json', 'openapi.json']) cpSync(resolve(file), join(dest, file), { recursive: true });
  symlinkSync(resolve('node_modules'), join(dest, 'node_modules'), 'dir');
  const path = join(dest, 'src/sdk-child.ts'), body = readFileSync(path, 'utf8');
  const old = kind === 'missing-child-abort' ? "case 'navigate': cancelAll(); reply(" : '  for (const gate of gates.values()) { gate.resolve(false); gate.acknowledge?.({ released: false }); }\n  gates.clear();';
  const replacement = kind === 'missing-child-abort' ? "case 'navigate': reply(" : '  // MUTANT: gates incorrectly survive a binding move.';
  assert.equal(body.split(old).length, 2); writeFileSync(path, body.replace(old, replacement));
  const build = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', dest], { encoding: 'utf8', timeout: 60000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const live = spawnSync(process.execPath, ['evidence/slice3/fix/live.mjs'], { cwd: dest, env: { ...process.env, A0_HOSTS: 'sdk' }, encoding: 'utf8', timeout: 180000 });
  const output = live.stdout + live.stderr; writeFileSync(join(dest, 'live.txt'), output);
  assert.equal(live.signal, null, 'must fail by assertion, not timeout or killed child'); assert.equal(live.status, 1, output); assert.match(output, /AssertionError/); assert.doesNotMatch(output, /timeout:|response timeout/);
  rows.push({ kind, built: true, exit: live.status, assertion_observed: true, output: join(dest, 'live.txt') });
}
writeFileSync(join(root, 'summary.json'), JSON.stringify({ root, rows }, null, 2)); console.log(JSON.stringify({ root, rows }, null, 2));
