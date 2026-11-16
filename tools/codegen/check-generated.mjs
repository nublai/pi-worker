#!/usr/bin/env node
// npm run check:generated: regenerate everything, then fail if any generated path differs from the commit
// (modified, deleted or new untracked files). A spec edit without regeneration fails here.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GENERATED_PATHS } from './paths.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const generate = spawnSync(process.execPath, [fileURLToPath(new URL('./generate.mjs', import.meta.url))], { cwd: root, stdio: 'inherit' });
if (generate.status !== 0) process.exit(generate.status ?? 1);

const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...GENERATED_PATHS], { cwd: root, encoding: 'utf8' });
if (status.status !== 0) {
  console.error(status.stderr);
  process.exit(1);
}
if (status.stdout.trim()) {
  console.error('generated files differ from the commit; run `npm run generate` and commit the result:');
  console.error(status.stdout);
  spawnSync('git', ['--no-pager', 'diff', '--stat', '--', ...GENERATED_PATHS], { cwd: root, stdio: 'inherit' });
  process.exit(1);
}
console.log('generated files match the commit');
