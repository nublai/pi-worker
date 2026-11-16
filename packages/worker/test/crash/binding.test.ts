/**
 * Binding crash cuts (P1-7): a real SIGKILL after every fsync of the binding scenario and after every native move
 * effect. Recovery must find an effect-bearing receipt for every B2 move pi performed, keep each worker's binding at
 * its last durable revision, and fence exactly the uncertainties (a move whose outcome became unknown included).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRecovery, type Check } from './oracle.js';
import { fences } from './fence.test.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

const bindings: Check = (pre, after) => {
  for (const w of after.workers) {
    const prior = pre.workers.get(w.worker_id)!;
    assert.equal(w.binding_revision, prior.binding_revision, `${w.worker_id}: the binding is its last durable revision`);
    assert.equal(w.session_id, prior.session_id, w.worker_id);
  }
};

test('crash: SIGKILL after every binding-scenario fsync keeps the durable binding and exact fences', { timeout: 600_000 }, async () => {
  const base = tempRoot('binding-base');
  let points: FsyncPoint[];
  try {
    const full = run('binding', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('binding-cut');
    try {
      cutAt('binding', cut.root, point);
      await checkRecovery(cut.root, [bindings, fences]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every binding move effect finds an effect-bearing receipt', { timeout: 300_000 }, async () => {
  const base = tempRoot('binding-effects');
  let count: number;
  try {
    assert.equal(run('binding', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('binding-effect');
    try {
      assert.equal(run('binding', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      await checkRecovery(cut.root, [bindings, fences]);
    } finally {
      cut.cleanup();
    }
  }
});
