/**
 * Children crash cuts (P1-11), ported from A0 `src/test/children-crash.test.ts`: a real SIGKILL after every fsync of
 * the children scenario and after every native effect. Besides the shared recovery oracle and the independent fence
 * oracle (which requires the parent fence of every child that may have launched and left no durable result report):
 * - every child row that recovery finds carries exactly the lineage its create request named (from the client's own
 *   request log), so a spawned child never lacks its parent;
 * - a report delivery notification was sent for exactly one delivered report, and the child's claims list it once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRecovery, type Check } from './oracle.js';
import { fences } from './fence.test.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

const lineage: Check = (pre, after) => {
  for (const q of pre.requests) {
    const body = q.body as { command_id: string; parent?: { worker_id: string } };
    if (q.op !== 'create' || !body.parent) continue;
    const receipt = after.receipts.find(r => r.command_id === body.command_id);
    if (!receipt?.worker_id) continue;
    const child = after.workers.find(w => w.worker_id === receipt.worker_id);
    assert.ok(child, 'every child create with a worker has a recovered row');
    assert.deepEqual(child.parent, body.parent, 'lineage persisted as requested');
    assert.equal(child.parent_worker_id, body.parent.worker_id);
    assert.equal(child.parent_launch_command_id, body.command_id);
  }
  for (const q of pre.requests) {
    const body = q.body as { command_id: string };
    if (q.op !== 'launch_child') continue;
    const child = after.workers.find(w => w.parent_launch_command_id === body.command_id);
    if (child) assert.equal(child.parent_worker_id, q.id, 'an untyped child names the parent that launched it');
  }
};

function delivery(root: string): Check {
  return (_pre, after) => {
    const delivered = after.receipts.filter(r => r.operation === 'children.report' && r.state === 'delivered');
    if (effectsAt(root).some(e => e.kind === 'report_delivery')) assert.equal(delivered.length, 1, 'one report, one receipt');
    assert.ok(delivered.length <= 1, 'a duplicate report id never makes a second receipt');
    for (const w of after.workers) if (w.parent_worker_id) assert.equal(w.child_reports?.length ?? 0, delivered.filter(r => r.worker_id === w.worker_id && r.result?.kind).length);
  };
}

test('crash: SIGKILL after every children fsync: lineage before spawn, one report, missing report fences the parent', { timeout: 600_000 }, async () => {
  const base = tempRoot('children-base');
  let points: FsyncPoint[];
  try {
    const full = run('children', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    assert.ok(effectsAt(base.root).some(e => e.kind === 'report_delivery'));
    assert.equal(effectsAt(base.root).filter(e => e.kind === 'create').length, 4, 'two parents and two children spawned');
    await checkRecovery(base.root, [fences, lineage, delivery(base.root)]);
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('children-cut');
    try {
      cutAt('children', cut.root, point);
      await checkRecovery(cut.root, [fences, lineage, delivery(cut.root)]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every children native effect (spawn, FD report, delivery, stop)', { timeout: 300_000 }, async () => {
  const base = tempRoot('children-effects');
  let count: number;
  try {
    assert.equal(run('children', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('children-effect');
    try {
      assert.equal(run('children', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      await checkRecovery(cut.root, [fences, lineage, delivery(cut.root)]);
    } finally {
      cut.cleanup();
    }
  }
});
