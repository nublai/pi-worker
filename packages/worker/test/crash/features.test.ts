/**
 * Features crash cuts (P1-14): a real SIGKILL after every fsync of the features scenario and after every native
 * effect. Every `session.configure` pi performed has an effect-bearing receipt; the fence is exactly the
 * uncertainties by the contract's independent table (fence.test.ts, `session.configure` is a session write). An
 * inventory probe's cleanup domain (P2-1) is recorded before the probe starts, and recovery never confirms the cleanup
 * of a probe it did not observe removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import { checkRecovery, preCrash } from './oracle.js';
import { fences } from './fence.test.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

/** Inventory probes whose domain the journal records and does not confirm removed. */
function pendingProbes(root: string): string[] {
  const pending = new Set<string>();
  for (const r of parseJournal(readFileSync(journalPath(root))).records) {
    if (r.kind !== 'inventory') continue;
    if (r.value.state === 'cleaned') pending.delete(String(r.value.inventory_id));
    else pending.add(String(r.value.inventory_id));
  }
  return [...pending].sort();
}

test('crash: SIGKILL after every features-scenario fsync: configure receipts keep their bucket, exact fences', { timeout: 600_000 }, async () => {
  const base = tempRoot('features-base');
  let points: FsyncPoint[];
  try {
    const full = run('features', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('features-cut');
    try {
      cutAt('features', cut.root, point);
      const recorded = pendingProbes(cut.root);
      // The recovering world's domains cannot prove a dead world's domain removed: a probe cut before its removal was
      // recorded stays recorded, and a confirmed one is never revived.
      await checkRecovery(cut.root, [fences, (_pre, after) => assert.deepEqual([...after.probes].sort(), recorded, `${point.label}: recovery confirms no probe cleanup it did not observe`)]);
      if (point.label === 'inventory.start') assert.equal(recorded.length, 1, 'the probe is recorded before it starts');
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every configure effect finds an effect-bearing receipt and fences it', { timeout: 300_000 }, async () => {
  const base = tempRoot('features-effects');
  let count: number;
  try {
    assert.equal(run('features', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  let configured = 0;
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('features-effect');
    try {
      assert.equal(run('features', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      const pre = preCrash(cut.root);
      const after = await checkRecovery(cut.root, [fences]);
      const last = effectsAt(cut.root).at(-1)!;
      if (last.operation !== 'configure') continue;
      configured++;
      // The cut is right after pi changed the session and before any result: the receipt is unknown and fences.
      assert.equal(pre.receipts.get(last.command_id)?.state, 'accepted', last.command_id);
      const receipt = after.receipts.find(r => r.command_id === last.command_id)!;
      assert.deepEqual([receipt.state, receipt.effect], ['outcome_unknown', 'unknown'], last.command_id);
      const worker = after.workers.find(w => w.worker_id === receipt.worker_id)!;
      assert.ok(worker.fence?.uncertain_command_ids?.includes(last.command_id), 'an unknown configure fences its session after the restart');
    } finally {
      cut.cleanup();
    }
  }
  assert.ok(configured >= 3, `the scenario cuts every configure effect (${configured})`);
});
