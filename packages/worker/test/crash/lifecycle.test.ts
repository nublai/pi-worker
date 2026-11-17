/**
 * Lifecycle crash cuts (P1-4): a real SIGKILL after every fsync of the lifecycle scenario and after every native
 * effect, each checked by the recovery oracle (oracle.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRecovery } from './oracle.js';
import { cutAt, run, tempRoot } from './harness.js';
import { effectsAt } from './world.js';

test('crash: SIGKILL after every lifecycle fsync recovers cleanup_pending holders, right buckets, no replay', { timeout: 300_000 }, async () => {
  const base = tempRoot('lifecycle-base');
  let points;
  try {
    const full = run('lifecycle', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    assert.deepEqual(
      effectsAt(base.root).map(e => `${e.kind}:${e.command_id}`),
      ['create:worker-a', 'create:worker-fail', 'create:worker-b', 'stop:stop-a', 'create:worker-c', 'create:worker-d'],
    );
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('lifecycle-cut');
    try {
      cutAt('lifecycle', cut.root, point);
      await checkRecovery(cut.root);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every lifecycle native effect (spawn, stop) finds an effect-bearing receipt', { timeout: 120_000 }, async () => {
  for (let n = 1; n <= 6; n++) {
    const cut = tempRoot('lifecycle-effect');
    try {
      const killed = run('lifecycle', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      await checkRecovery(cut.root);
    } finally {
      cut.cleanup();
    }
  }
});
