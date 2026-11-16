/**
 * Compaction crash cuts (P1-12): a real SIGKILL after every fsync of the compaction scenario (the compacted copy before
 * its rename, the directory after it, and every receipt and worker point around them) and after every native effect.
 * Besides the shared recovery oracle under retention (oracle.ts: a missing receipt must be one the contract lets
 * retention evict, reported expired; an evicted effect was never `no_effect`) and the independent fence oracle:
 * - every command the client was told is `outcome_unknown` and never resolved is still retained, unknown;
 * - every child's launch receipt is retained, so the missing-report fence can still be decided;
 * - a cut after the compacted copy's fsync leaves the old journal whole and the copy beside it, which recovery
 *   removes; the journal never exceeds its bound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { journalPath } from '../../src/journal/state.js';
import { checkRecovery, type Check } from './oracle.js';
import { fences } from './fence-oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { COMPACTION_LIMITS } from './compaction-scenario.js';
import { effectsAt, repliesAt } from './world.js';

/** Unresolved unknowns and child launches stay; the journal stays within its bound. */
function retained(root: string): Check {
  return (pre, after) => {
    const kept = new Map(after.receipts.map(r => [r.command_id, r]));
    const resolvedByClient = new Set(
      pre.requests
        .filter(q => q.op === 'resolve' && repliesAt(root).some(x => x.command_id === q.body.command_id && x.state === 'delivered'))
        .map(q => String(q.body.uncertain_command_id)),
    );
    for (const told of repliesAt(root)) {
      if (told.state !== 'outcome_unknown' || resolvedByClient.has(told.command_id)) continue;
      assert.equal(kept.get(told.command_id)?.state, 'outcome_unknown', `unresolved outcome_unknown ${told.command_id} is never evicted`);
    }
    for (const w of after.workers) {
      if (w.parent_launch_command_id) assert.ok(kept.has(w.parent_launch_command_id), `child launch ${w.parent_launch_command_id} is retained`);
    }
    assert.ok(statSync(journalPath(root)).size <= COMPACTION_LIMITS.journalBytes!, 'the journal stays within its bound');
  };
}

test('crash: SIGKILL after every compaction-scenario fsync recovers; retention keeps every pending decision', { timeout: 900_000 }, async () => {
  const base = tempRoot('compaction-base');
  let points: FsyncPoint[];
  try {
    const full = run('compaction', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    assert.ok(points.filter(p => p.label === 'journal.compact_file').length >= 4, 'the scenario compacts several times');
    await checkRecovery(base.root, [fences, retained(base.root)]);
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('compaction-cut');
    try {
      cutAt('compaction', cut.root, point);
      const copy = existsSync(`${journalPath(cut.root)}.compact`);
      // Before the rename the copy is beside the whole journal; after it there is no copy.
      if (point.label === 'journal.compact_file') assert.ok(copy, 'a cut before the rename leaves the compacted copy');
      if (point.label === 'journal.compact_directory') assert.ok(!copy, 'a cut after the rename leaves no copy');
      await checkRecovery(cut.root, [fences, retained(cut.root)]);
      assert.ok(!existsSync(`${journalPath(cut.root)}.compact`), 'recovery removes a stray compacted copy');
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every compaction-scenario native effect finds its receipt or its expiry', { timeout: 600_000 }, async () => {
  const base = tempRoot('compaction-effects');
  let count: number;
  try {
    assert.equal(run('compaction', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('compaction-effect');
    try {
      assert.equal(run('compaction', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      await checkRecovery(cut.root, [fences, retained(cut.root)]);
    } finally {
      cut.cleanup();
    }
  }
});

