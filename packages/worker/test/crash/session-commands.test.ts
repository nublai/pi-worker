/**
 * Session-command crash cuts (P1-15): a real SIGKILL after every fsync of the session-commands scenario and after
 * every native effect. One effect cut per method finds an effect-bearing receipt, corroborated by an independent
 * artifact (the compaction entry in the session file; the fake host's reload and command logs), and the fence is
 * exactly the uncertainties by the contract's own table (fence.test.ts: compact, reload and invoke are session writes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRecovery, preCrash } from './oracle.js';
import { fences } from './fence.test.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

test('crash: SIGKILL after every session-commands fsync: receipts keep their bucket, exact fences, no replay', { timeout: 900_000 }, async () => {
  const base = tempRoot('session-commands-base');
  let points: FsyncPoint[];
  try {
    const full = run('session-commands', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('session-commands-cut');
    try {
      cutAt('session-commands', cut.root, point);
      await checkRecovery(cut.root, [fences]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after each compact, reload and invoke effect finds an effect-bearing receipt that fences', { timeout: 300_000 }, async () => {
  const base = tempRoot('session-commands-effects');
  let count: number;
  try {
    assert.equal(run('session-commands', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  const cut = new Map<string, number>();
  for (let n = 1; n <= count; n++) {
    const dir = tempRoot('session-commands-effect');
    try {
      assert.equal(run('session-commands', dir.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      const pre = preCrash(dir.root);
      const after = await checkRecovery(dir.root, [fences]);
      const last = effectsAt(dir.root).at(-1)!;
      if (!['compact', 'reload', 'invoke'].includes(last.operation ?? '')) continue;
      cut.set(last.operation!, (cut.get(last.operation!) ?? 0) + 1);
      // Right after pi's change and before any result: unknown, fenced, and the artifact is independent evidence.
      assert.equal(pre.receipts.get(last.command_id)?.state, 'accepted', last.command_id);
      const receipt = after.receipts.find(r => r.command_id === last.command_id)!;
      assert.deepEqual([receipt.state, receipt.effect], ['outcome_unknown', 'unknown'], last.command_id);
      assert.ok(after.workers.find(w => w.worker_id === receipt.worker_id)!.fence?.uncertain_command_ids?.includes(last.command_id));
      if (last.operation === 'compact') {
        const entries = readFileSync(last.native_file!, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; command_id?: string });
        assert.ok(entries.some(e => e.type === 'compaction' && e.command_id === last.command_id), 'the compaction entry is in the session file');
      }
    } finally {
      dir.cleanup();
    }
  }
  for (const op of ['compact', 'reload', 'invoke']) assert.ok((cut.get(op) ?? 0) >= 2, `the scenario cuts ${op} effects (${cut.get(op) ?? 0})`);
});
