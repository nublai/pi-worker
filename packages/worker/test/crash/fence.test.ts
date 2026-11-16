/**
 * Fence crash cuts (P1-6): a real SIGKILL after every fsync of the fence scenario and after every native effect.
 * Besides the recovery oracle, the fence of every worker must equal exactly its uncertainties (ported from A0
 * `crash-matrix.test.ts`'s bucket and fence oracle): every unresolved outcome_unknown session-directed receipt, an
 * unsettled dispatched execution unless it was resolved and the worker was no longer live, and every unresolved
 * uncertainty already in the persisted fence (which must have dispatched evidence). No spurious empty fence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_DIRECTED } from '../../src/supervisor/fence.js';
import { checkRecovery, type Check } from './oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

export const fences: Check = (pre, after) => {
  const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  for (const w of after.workers) {
    const prior = pre.workers.get(w.worker_id)!;
    const resolved = new Set((prior.resolutions ?? []).map(x => x.command_id));
    const required = new Set<string>();
    for (const r of after.receipts) if (r.worker_id === w.worker_id && SESSION_DIRECTED.has(r.operation) && r.state === 'outcome_unknown' && !resolved.has(r.command_id)) required.add(r.command_id);
    if (prior.execution && prior.execution.state !== 'settled' && (!resolved.has(prior.execution.command_id) || ['ready', 'starting'].includes(prior.status))) {
      if (receipts.get(prior.execution.command_id)?.effect !== 'no_effect') required.add(prior.execution.command_id);
    }
    for (const id of prior.fence?.uncertain_command_ids ?? []) {
      if (resolved.has(id)) continue;
      const r = receipts.get(id);
      assert.ok(r && r.effect !== 'no_effect', 'a persisted fence needs dispatched evidence');
      required.add(id);
    }
    assert.deepEqual([...(w.fence?.uncertain_command_ids ?? [])].sort(), [...required].sort(), `the fence of ${w.worker_id} is exactly its uncertainties`);
    assert.equal(w.fence === null, required.size === 0, 'no spurious empty fence');
  }
};

test('crash: SIGKILL after every fence-scenario fsync: the fence is exactly the uncertainties, no replay', { timeout: 600_000 }, async () => {
  const base = tempRoot('fence-base');
  let points: FsyncPoint[];
  try {
    const full = run('fence', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('fence-cut');
    try {
      cutAt('fence', cut.root, point);
      await checkRecovery(cut.root, [fences]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL after every fence-scenario native effect: effect-bearing receipts and exact fences', { timeout: 300_000 }, async () => {
  const base = tempRoot('fence-effects');
  let count: number;
  try {
    assert.equal(run('fence', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('fence-effect');
    try {
      assert.equal(run('fence', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      await checkRecovery(cut.root, [fences]);
    } finally {
      cut.cleanup();
    }
  }
});
