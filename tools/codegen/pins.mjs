// Exact pins (plan section 4.4): every npm dependency is an exact version, and the generators that write committed
// files run at exactly their pinned version. `npm run generate` checks this first, so `check:generated` fails on a
// range or on an installed generator that differs from its pin.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const EXACT = /^\d+\.\d+\.\d+$/;
const GENERATORS = ['@redocly/cli', 'openapi-typescript', 'ajv', 'typescript'];

export function checkPins(root) {
  const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const rootPkg = read('package.json');
  const problems = [];
  for (const file of ['package.json', ...rootPkg.workspaces.map(w => join(w, 'package.json'))]) {
    const pkg = read(file);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(pkg[field] ?? {})) {
        if (!EXACT.test(version)) problems.push(`${file} ${field}.${name} is "${version}", not an exact version`);
      }
    }
  }
  const require = createRequire(join(root, 'package.json'));
  for (const name of GENERATORS) {
    const pinned = rootPkg.devDependencies?.[name];
    if (!pinned) {
      problems.push(`generator ${name} is not pinned in the root devDependencies`);
      continue;
    }
    const installed = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
    if (installed !== pinned) problems.push(`generator ${name} is ${installed}, pinned ${pinned}; run npm ci --ignore-scripts`);
  }
  if (problems.length) throw new Error(`pins:\n  ${problems.join('\n  ')}`);
}
