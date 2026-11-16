#!/usr/bin/env node
// Reversion runner by guard group (plan sections 10 and 11): reads packages/worker/test/reversions/manifest.json and
// runs tools/reversions.mjs for each named group, which applies each diff, requires a named test to FAIL by
// assertion, and reverts it. Run on a tree with no tracked changes.
//   node harness/lib/reversions.mjs <group>...   |   node harness/lib/reversions.mjs --all
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = join(root, 'packages', 'worker', 'test', 'reversions');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const groups = args.includes('--all') ? Object.keys(manifest.groups) : args;
const unknown = groups.filter(g => !manifest.groups[g]);
if (groups.length === 0 || unknown.length) {
  console.error(`usage: reversions.mjs <group>... | --all (groups: ${Object.keys(manifest.groups).join(', ')})${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}`);
  process.exit(2);
}
const report = [];
let ok = true;
for (const name of groups) {
  const group = manifest.groups[name];
  const diffs = group.diffs.map(d => join('packages', 'worker', 'test', 'reversions', d));
  const out = spawnSync(process.execPath, [join(root, 'tools', 'reversions.mjs'), '--command', group.command, ...diffs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) ok = false;
  let result;
  try {
    result = JSON.parse(out.stdout);
  } catch {
    result = { error: 'runner_failed', status: out.status, stderr: out.stderr.slice(-2000) };
  }
  report.push({ group: name, ...result });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(ok ? 0 : 1);
