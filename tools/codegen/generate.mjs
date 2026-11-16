#!/usr/bin/env node
// npm run generate: api/b2.openapi.yaml → bundle → TS types → validators → route and event tables.
// Every output is committed; `npm run check:generated` reruns this and fails on any difference.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { events, loadSpec, operations } from './spec.mjs';
import { eventTable, routeTable } from './tables.mjs';
import { generateValidators } from './validators.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const bundle = join(root, 'api', 'generated', 'b2.json');
const workerOut = join(root, 'packages', 'worker', 'src', 'generated');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`wrote ${file.slice(root.length)}`);
}

// 1. Bundle (Redocly). Lint runs separately in `npm run api:lint`.
run(process.execPath, [require.resolve('@redocly/cli/bin/cli.js'), 'bundle', '--config', 'api/redocly.yaml', 'b2'], {
  REDOCLY_TELEMETRY: 'off',
  REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true',
});
const spec = loadSpec(bundle);
const ops = operations(spec);
const eventInfo = events(spec);

// 2. TypeScript types (openapi-typescript).
const openapiTs = join(dirname(require.resolve('openapi-typescript/package.json')), 'bin', 'cli.js');
run(process.execPath, [openapiTs, bundle, '-o', join(workerOut, 'api.ts')]);

// 3. Standalone validators (Ajv 2020).
const validators = generateValidators(spec, ops, eventInfo);
write(join(workerOut, 'validators.js'), validators.js);
write(join(workerOut, 'validators.d.ts'), validators.dts);

// 4. Route table and event manifest with publishers.
write(join(workerOut, 'routes.ts'), routeTable(ops));
write(join(workerOut, 'events.ts'), eventTable(eventInfo));
