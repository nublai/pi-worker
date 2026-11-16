#!/usr/bin/env node
// Proves each custom B2 lint rule fires: api/lint-fixtures/<rule>.yaml must fail with exactly `piw/<rule>`,
// and api/lint-fixtures/valid.yaml (the baseline every fixture is derived from) must pass with no problems.
// Every rule the `piw` plugin exports needs a fixture; a fixture without a rule is an error too.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin from '../../api/redocly/piw-rules.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = createRequire(import.meta.url).resolve('@redocly/cli/bin/cli.js');
const fixtures = join(root, 'api', 'lint-fixtures');
const rules = Object.keys(plugin().rules.oas3);

function lint(file) {
  const run = spawnSync(process.execPath, [cli, 'lint', '--config', join(root, 'api', 'redocly.yaml'), file, '--format=json'], {
    encoding: 'utf8',
    env: { ...process.env, REDOCLY_TELEMETRY: 'off', REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true' },
  });
  if (run.error) throw run.error;
  const start = run.stdout.indexOf('{');
  if (start < 0) throw new Error(`no JSON from redocly for ${file}:\n${run.stdout}\n${run.stderr}`);
  return { status: run.status, ruleIds: JSON.parse(run.stdout.slice(start)).problems.map(p => p.ruleId) };
}

const failures = [];
const files = readdirSync(fixtures).filter(f => f.endsWith('.yaml'));
for (const rule of rules) if (!files.includes(`${rule}.yaml`)) failures.push(`rule piw/${rule} has no failing example`);
for (const file of files) {
  const name = file.slice(0, -'.yaml'.length);
  const { status, ruleIds } = lint(join(fixtures, file));
  if (name === 'valid') {
    if (status !== 0 || ruleIds.length) failures.push(`valid.yaml must pass cleanly, got [${ruleIds}] (exit ${status})`);
    else console.log('ok   valid.yaml passes');
  } else if (!rules.includes(name)) {
    failures.push(`${file} names no piw rule`);
  } else if (status === 0 || ruleIds.length === 0 || ruleIds.some(id => id !== `piw/${name}`)) {
    failures.push(`${file} must fail with only piw/${name}, got [${ruleIds}] (exit ${status})`);
  } else {
    console.log(`ok   ${file} fails with piw/${name} (${ruleIds.length} problem${ruleIds.length > 1 ? 's' : ''})`);
  }
}
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
