#!/usr/bin/env node
// Runs `node --test` with options before file globs. npm appends `npm test -- <args>` after the
// script's globs, and node ignores test options that follow a positional argument, so a bare
// `node --test 'dist/**/*.test.js' --test-name-pattern=x` would silently run every test.
//
// Arguments: options (`--x`), file globs (anything with `*`, `/` or ending `.js`), and filter words. A filter word
// that names test files (a file's stem, `x` for `x.test.js`, or one of its dash-separated parts) restricts the run
// to those files; any other word becomes a `--test-name-pattern`. So `npm test -- receipts` runs `receipts.test.js`
// files and `npm run test:conformance -- 02 03` runs the tests whose names contain `02` or `03`.
//
// A hung test must fail by itself: unless the caller passes `--test-timeout`, every test gets PIW_TEST_TIMEOUT_MS
// (default 120000). A test's own `{ timeout }` option wins over this default, so the long kernel and crash tests that
// set one keep it; only a test with no timeout of its own is held to 120 s.
//
// `--no-todo` (this wrapper's own option): the run fails if any test result is marked todo, read from the runner's
// own results (tools/todo-reporter.mjs), not from a list in a test file. Node exits 0 when a todo test fails, so a
// frozen conformance row marked todo would otherwise pass silently (plan section 5.1: from P1-11 none may be todo).
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const noTodo = args.includes('--no-todo');
const options = args.filter(a => a.startsWith('-') && a !== '--no-todo');
if (!options.some(a => a === '--test-timeout' || a.startsWith('--test-timeout='))) {
  options.push(`--test-timeout=${process.env.PIW_TEST_TIMEOUT_MS ?? 120000}`);
}
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
const scratch = noTodo ? mkdtempSync(join(tmpdir(), 'node-test-')) : null;
const todoFile = scratch ? join(scratch, 'todo.jsonl') : null;
const reporters = todoFile
  ? ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${fileURLToPath(new URL('./todo-reporter.mjs', import.meta.url))}`, `--test-reporter-destination=${todoFile}`]
  : [];
const result = spawnSync(process.execPath, ['--test', ...reporters, ...options, ...patterns, ...selected], { stdio: 'inherit' });
if (result.error) throw result.error;
let status = result.status ?? 1;
if (todoFile) {
  let todos = [];
  try {
    todos = readFileSync(todoFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    console.error('node-test: --no-todo could not read the todo report');
    status = status || 1;
  }
  rmSync(scratch, { recursive: true, force: true });
  if (todos.length) {
    // The `✖ <name>` lines name each todo result as a failure (tools/reversions.mjs reads them).
    for (const t of todos) console.log(`✖ todo is not allowed: ${t.name}`);
    console.error(`node-test: ${todos.length} test result(s) marked todo (${todos.filter(t => t.failed).length} failing); --no-todo allows none`);
    status = 1;
  }
}
process.exit(status);
