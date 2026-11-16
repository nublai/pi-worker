/**
 * The test runner's no-todo gate (plan section 5.1, review F3): from P1-11 a run fails on any test result marked
 * todo, read from the runner's own results. Node itself exits 0 when a todo test fails, which is why the wrapper
 * (tools/node-test.mjs `--no-todo`, used by `test`, `test:conformance` and `test:crash`) has to enforce it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateTmp } from '../helpers.js';

const wrapper = fileURLToPath(new URL('../../../../../tools/node-test.mjs', import.meta.url));

function run(source: string, noTodo: boolean): { status: number | null; output: string } {
  const tmp = privateTmp();
  try {
    const file = join(tmp.dir, 'fixture.test.mjs');
    writeFileSync(file, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${source}\n`);
    // A nested run must not report into this run's test context.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [wrapper, ...(noTodo ? ['--no-todo'] : []), file], { encoding: 'utf8', env, timeout: 60_000 });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  } finally {
    tmp.cleanup();
  }
}

const FAILING_TODO = `test('plain', () => {});\ntest('contract 0.1 fixture 05-keep', { todo: true }, () => assert.fail('synthetic frozen row failure'));`;

test('conformance runner: node alone passes a run whose failing test is marked todo (why the gate exists)', () => {
  assert.equal(run(FAILING_TODO, false).status, 0);
});

test('conformance runner: --no-todo fails a run with any todo result, failing or passing, nested or not, and names it', () => {
  const failing = run(FAILING_TODO, true);
  assert.equal(failing.status, 1, failing.output);
  assert.match(failing.output, /✖ todo is not allowed: contract 0\.1 fixture 05-keep/);
  const nested = run(`test('suite', async t => { await t.test('inner', { todo: 'later' }, () => {}); });`, true);
  assert.equal(nested.status, 1, nested.output);
  assert.match(nested.output, /✖ todo is not allowed: inner/);
});

test('conformance runner: --no-todo passes a run with no todo result and keeps a real failure a failure', () => {
  assert.equal(run(`test('plain', () => {});`, true).status, 0);
  assert.equal(run(`test('broken', () => assert.fail('x'));`, true).status, 1);
});
