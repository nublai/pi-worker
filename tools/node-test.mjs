#!/usr/bin/env node
// Runs `node --test` with options before file globs. npm appends `npm test -- <args>` after the
// script's globs, and node ignores test options that follow a positional argument, so a bare
// `node --test 'dist/**/*.test.js' --test-name-pattern=x` would silently run every test.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const options = args.filter(a => a.startsWith('-'));
const files = args.filter(a => !a.startsWith('-'));
if (files.length === 0) {
  console.error('node-test: no test file glob given');
  process.exit(2);
}
const result = spawnSync(process.execPath, ['--test', ...options, ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
