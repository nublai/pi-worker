#!/usr/bin/env node
// npm run generate: api/b2.openapi.yaml → bundle → TS types → validators → route and event tables (worker and client).
// Every output is committed; `npm run check:generated` reruns this and fails on any difference.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { events, grantProfiles, jsonBodyLimit, loadSpec, operations } from './spec.mjs';
import { clientRouteTable, eventTable, routeTable } from './tables.mjs';
import { generateValidators } from './validators.mjs';
import { goOps } from './go.mjs';
import { goFixtures } from './go-fixtures.mjs';
import { checkPins } from './pins.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const bundle = join(root, 'api', 'generated', 'b2.json');
const workerOut = join(root, 'packages', 'worker', 'src', 'generated');
const clientOut = join(root, 'packages', 'client-ts', 'src', 'generated');

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

// 0. Exact pins: every npm dependency, and the installed generators equal their pins.
checkPins(root);

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
mkdirSync(clientOut, { recursive: true });
copyFileSync(join(workerOut, 'api.ts'), join(clientOut, 'api.ts'));
console.log(`wrote ${join(clientOut, 'api.ts').slice(root.length)}`);

// 3. Standalone validators (Ajv 2020).
const validators = generateValidators(spec, ops, eventInfo);
write(join(workerOut, 'validators.js'), validators.js);
write(join(workerOut, 'validators.d.ts'), validators.dts);

// 4. Route table and event manifest with publishers.
write(join(workerOut, 'routes.ts'), routeTable(ops, jsonBodyLimit(spec)));
write(join(workerOut, 'events.ts'), eventTable(eventInfo));
write(join(clientOut, 'routes.ts'), clientRouteTable(ops));

// 5. Go models (oapi-codegen v2.8.2, pinned by the tool directive in tools/go/go.mod) and the Go operation table.
const goOut = join(root, 'clients', 'go', 'b2');
const toolsGo = join(root, 'tools', 'go');
const goEnv = { GOWORK: 'off' };
// Generation runs on exactly the toolchain tools/go/go.mod names (plan 4.4). With GOTOOLCHAIN=local the `toolchain`
// line is not enforced by Go itself, so check it here: another Go fails generation instead of drifting the output.
const wantGo = /^toolchain (go\S+)$/m.exec(readFileSync(join(toolsGo, 'go.mod'), 'utf8'))?.[1];
const goVersion = spawnSync('go', ['env', 'GOVERSION', 'GOROOT'], { cwd: toolsGo, encoding: 'utf8', env: { ...process.env, ...goEnv } });
const [haveGo, goRoot] = (goVersion.stdout ?? '').trim().split('\n');
if (!wantGo || haveGo !== wantGo) {
  throw new Error(`Go generation needs ${wantGo ?? 'a toolchain line in tools/go/go.mod'}, found ${haveGo || 'no go'}; put that Go first on PATH (GOTOOLCHAIN=local)`);
}
const oapi = spawnSync('go', ['tool', 'oapi-codegen', '-config', join(goOut, 'oapi-codegen.yaml'), '-o', join(goOut, 'models.gen.go'), bundle], {
  cwd: toolsGo,
  stdio: 'inherit',
  env: { ...process.env, ...goEnv },
});
if (oapi.error || oapi.status !== 0) throw new Error(`oapi-codegen failed (Go is required for npm run generate): ${oapi.error ?? oapi.status}`);
console.log(`wrote ${join(goOut, 'models.gen.go').slice(root.length)}`);
write(join(goOut, 'ops.gen.go'), goOps(spec, ops, eventInfo, grantProfiles(spec, ops)));
// 6. The Go fake's copy of api/fixtures (wire fixtures and the frozen transitions), embedded so a vendored copy of
// clients/go/workerfake needs nothing outside its directory.
write(join(root, 'clients', 'go', 'workerfake', 'fixtures.gen.json'), goFixtures(root, ops));
run(join(goRoot, 'bin', 'gofmt'), ['-w', join(goOut, 'models.gen.go'), join(goOut, 'ops.gen.go')]);
