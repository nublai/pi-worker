/**
 * Label coverage (plan section 5): every durable label has a SIGKILL cut scenario, and each scenario really reaches
 * the labels it claims. A label added without a cut fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DURABLE_LABELS } from '../../src/journal/labels.js';
import { durable, UnknownDurableLabel } from '../../src/journal/fsync.js';
import { CUT_SCENARIOS } from './cuts.js';
import { run, tempRoot } from './harness.js';

test('crash: every durable label has a cut scenario, and every scenario label is registered', () => {
  const covered = new Set(CUT_SCENARIOS.flatMap(s => s.labels));
  const missing = DURABLE_LABELS.filter(label => !covered.has(label));
  assert.deepEqual(missing, [], `durable labels without a cut scenario: ${missing.join(', ')}`);
  const registered = new Set<string>(DURABLE_LABELS);
  assert.deepEqual(
    [...covered].filter(label => !registered.has(label)),
    [],
    'a cut scenario names a label that is not registered',
  );
  for (const s of CUT_SCENARIOS) {
    const compiled = fileURLToPath(new URL(`./${s.file.replace(/\.ts$/, '.js')}`, import.meta.url));
    assert.ok(existsSync(compiled), `${s.scenario}: crash test file ${s.file} exists`);
  }
});

for (const s of CUT_SCENARIOS) {
  test(`crash: scenario ${s.scenario} reaches exactly the labels it claims`, { timeout: 120_000 }, () => {
    const { root, cleanup } = tempRoot(`labels-${s.scenario}`);
    try {
      const full = run(s.scenario, root);
      assert.equal(full.status, 0, full.stderr.slice(-4000));
      const reached = new Set(full.points.map(p => p.label));
      assert.deepEqual([...s.labels].filter(l => !reached.has(l)), [], `${s.scenario} never reaches these claimed labels`);
      assert.deepEqual([...reached].filter(l => !s.labels.includes(l)).sort(), [], `${s.scenario} reaches labels it does not claim`);
    } finally {
      cleanup();
    }
  });
}

test('crash: durable() refuses an unregistered label before any fsync', () => {
  // SAFETY: deliberately bypasses the DurableLabel type to prove the runtime check.
  assert.throws(() => durable(0, 'not.a.label' as never), UnknownDurableLabel);
});
