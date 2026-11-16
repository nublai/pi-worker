/**
 * Binding crash cuts (P1-7): a real SIGKILL after every fsync of the binding scenario and after every native move
 * effect. Recovery must find an effect-bearing receipt for every B2 move pi performed, keep each worker's binding at
 * its last durable revision, and fence exactly the uncertainties (a move whose outcome became unknown included).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind } from '../supervisor-fixture.js';
import { checkRecovery, preCrash, type Check } from './oracle.js';
import { fences } from './fence.test.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt, openWorld, recoverWorld } from './world.js';

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

test('crash: SIGKILL right after the sessions.new dispatch record: the unknown move fences durably and resolves', { timeout: 300_000 }, async () => {
  const base = tempRoot('binding-new-base');
  let dispatches: FsyncPoint[];
  try {
    const full = run('binding', base.root);
    assert.equal(full.status, 0, full.stderr);
    dispatches = full.points.filter(p => p.label === 'receipt.dispatch');
  } finally {
    base.cleanup();
  }
  // The cut whose last fsync is the dispatch record of the scenario's sessions.new command.
  let found = false;
  for (const point of dispatches) {
    const cut = tempRoot('binding-new-cut');
    try {
      cutAt('binding', cut.root, point);
      if (preCrash(cut.root).receipts.get('sessions-new')?.state !== 'accepted') continue;
      found = true;
      const after = await checkRecovery(cut.root, [bindings, fences]);
      const receipt = after.receipts.find(r => r.command_id === 'sessions-new')!;
      assert.deepEqual([receipt.operation, receipt.state, receipt.effect], ['sessions.new', 'outcome_unknown', 'unknown']);
      const worker = after.workers.find(w => w.worker_id === receipt.worker_id)!;
      assert.equal(worker.status, 'cleanup_pending');
      assert.deepEqual(worker.fence?.uncertain_command_ids, ['sessions-new'], 'the unknown sessions.new fences its session after the restart');
      // Resolvable through the ordinary fence operation, and the resolution survives the next restart.
      const world = openWorld(cut.root, false);
      try {
        await world.supervisor.recover();
        const w = world.supervisor.get(worker.worker_id);
        const resolved = await world.supervisor.resolveUnknown(w.worker_id, {
          ...bind(w, 'resolve-new'),
          uncertain_command_id: 'sessions-new',
          fence_generation: w.fence!.fence_generation,
          disposition: 'abandon',
        });
        assert.equal(resolved.state, 'delivered', JSON.stringify(resolved));
        assert.equal(world.supervisor.get(w.worker_id).fence, null);
      } finally {
        world.state.close();
      }
      const again = await recoverWorld(cut.root);
      assert.equal(again.workers.find(w => w.worker_id === worker.worker_id)!.fence, null, 'a resolved unknown never relatches');
      break;
    } finally {
      cut.cleanup();
    }
  }
  assert.ok(found, 'the binding scenario reaches the sessions.new dispatch record');
});
