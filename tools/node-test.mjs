#!/usr/bin/env node
// Runs `node --test` with options before file globs. npm appends `npm test -- <args>` after the
// script's globs, and node ignores test options that follow a positional argument, so a bare
// `node --test 'dist/**/*.test.js' --test-name-pattern=x` would silently run every test.
//
// Arguments: options (`--x`), file globs (anything with `*`, `/` or ending `.js`), and filter words. A filter word
// that names test files (a file's stem, `x` for `x.test.js`, or one of its dash-separated parts) restricts the run
// to those files; any other word becomes a `--test-name-pattern`. So `npm test -- receipts` runs `receipts.test.js`
// files and `npm run test:conformance -- 02 03` runs the tests whose names contain `02` or `03`.
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const options = args.filter(a => a.startsWith('-'));
const positional = args.filter(a => !a.startsWith('-'));
const isGlob = a => a.includes('*') || a.includes('/') || a.endsWith('.js');
const globs = positional.filter(isGlob);
const words = positional.filter(a => !isGlob(a));
if (globs.length === 0) {
  console.error('node-test: no test file glob given');
  process.exit(2);
}
const files = [...new Set(globs.flatMap(g => globSync(g)))].sort();
const stem = f => basename(f).replace(/\.test\.(c|m)?js$/, '');
const names = (f, w) => stem(f) === w || stem(f).split('-').includes(w);
const fileWords = words.filter(w => files.some(f => names(f, w)));
const nameWords = words.filter(w => !fileWords.includes(w));
const selected = fileWords.length ? files.filter(f => fileWords.some(w => names(f, w))) : globs;
const regexLiteral = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = nameWords.map(w => `--test-name-pattern=${regexLiteral(w)}`);
if (words.length) console.error(`node-test: files ${fileWords.length ? selected.join(' ') : '(all)'}; name patterns ${nameWords.join(' ') || '(none)'}`);
const result = spawnSync(process.execPath, ['--test', ...options, ...patterns, ...selected], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
