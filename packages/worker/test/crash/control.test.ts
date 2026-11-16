/**
 * Input and control crash cuts (P1-5): a real SIGKILL after every fsync of the input scenario and right after every
 * native effect (prompt, steer, clear_queue, abort, stop). The recovery oracle (oracle.ts) requires an
 * effect-bearing receipt for every native effect, the right bucket for every receipt and no replay; this file adds
 * the execution rule: an unsettled dispatched execution recovers outcome_unknown, an undispatched one settles
 * no_effect_before_dispatch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRecovery, type Check } from './oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

const executions: Check = (pre, after) => {
  const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  for (const w of after.workers) {
    const prior = pre.workers.get(w.worker_id)!;
    if (!prior.execution || prior.execution.state === 'settled') continue;
    const r = receipts.get(prior.execution.command_id);
    if (r?.effect === 'no_effect') assert.equal(w.execution?.disposition, 'no_effect_before_dispatch', w.worker_id);
    else assert.equal(w.execution?.state, 'outcome_unknown', `${w.worker_id}: an unsettled dispatched execution is unknown after a restart`);
  }
};

test('crash: SIGKILL after every input-scenario fsync recovers buckets, executions and no replay', { timeout: 600_000 }, async () => {
  const base = tempRoot('input-base');
  let points: FsyncPoint[];
  try {
    const full = run('input', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  assert.ok(points.length > 60, `only ${points.length} fsyncs`);
  for (const point of points) {
    const cut = tempRoot('input-cut');
    try {
      cutAt('input', cut.root, point);
      await checkRecovery(cut.root, [executions]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: control effect cuts (cancel, interrupt, stop) and input effect cuts find effect-bearing receipts', { timeout: 300_000 }, async () => {
  const base = tempRoot('input-effects');
  let kinds: string[];
  try {
    assert.equal(run('input', base.root).status, 0);
    kinds = effectsAt(base.root).map(e => `${e.kind}:${e.command_id}`);
  } finally {
    base.cleanup();
  }
  for (const want of ['clear_queue:cancel-a', 'abort:cancel-a', 'clear_queue:interrupt-a', 'abort:interrupt-a', 'stop:stop-b', 'prompt:run', 'steer:steer-1', 'prompt:queued-1', 'prompt:lost']) {
    assert.ok(kinds.includes(want), want);
  }
  for (let n = 1; n <= kinds.length; n++) {
    const cut = tempRoot('input-effect');
    try {
      const killed = run('input', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) });
      assert.equal(killed.signal, 'SIGKILL', `${kinds[n - 1]}: ${killed.stderr.slice(-1000)}`);
      await checkRecovery(cut.root, [executions]);
    } finally {
      cut.cleanup();
    }
  }
});
