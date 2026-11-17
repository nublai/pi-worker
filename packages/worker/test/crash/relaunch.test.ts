/**
 * Relaunch crash cuts (P2-3): a real SIGKILL after every fsync of the relaunch scenario and right after each of its
 * native effects (the spawns, the stops and the relaunches' reopening of the session file), each checked by the
 * recovery oracle. A relaunch is never replayed; a relaunch cut after its dispatch record is `outcome_unknown`, one cut
 * before it `no_effect`; the recovered worker is never live. And at every cut the worker's latest durable row names a
 * domain of its own recorded epoch: the new epoch and its domain become durable together, before anything is spawned,
 * so recovery always kills the domain the latest process ran in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import type { Persisted } from '../../src/supervisor/state.js';
import { checkRecovery, type Check } from './oracle.js';
import { cutAt, run, tempRoot } from './harness.js';
import { effectsAt } from './world.js';

/** Every worker's latest durable row records a domain named for its own epoch (test domains are `w-<epoch>`). */
const domainOfEpoch =
  (root: string): Check =>
  () => {
    const latest = new Map<string, Persisted>();
    for (const record of parseJournal(readFileSync(journalPath(root))).records) {
      // SAFETY: `worker` records are Persisted values written by SupervisorState.persist.
      if (record.kind === 'worker') latest.set(String((record.value as unknown as Persisted).worker.worker_id), record.value as unknown as Persisted);
    }
    for (const p of latest.values()) assert.equal(p.domain?.name, `w-${p.worker.worker_epoch}`, `${p.worker.worker_id}: its domain is its epoch's`);
  };

test('crash: SIGKILL after every relaunch fsync recovers the newest domain pending, right buckets, no replay', { timeout: 300_000 }, async () => {
  const base = tempRoot('relaunch-base');
  let points;
  try {
    const full = run('relaunch', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    assert.deepEqual(
      effectsAt(base.root).map(e => `${e.kind}:${e.command_id}`),
      ['create:relaunched', 'stop:stop-1', 'create:relaunch-1', 'switch_session:relaunch-1', 'stop:stop-2', 'create:relaunch-2', 'switch_session:relaunch-2'],
    );
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('relaunch-cut');
    try {
      cutAt('relaunch', cut.root, point);
      await checkRecovery(cut.root, [domainOfEpoch(cut.root)]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every relaunch native effect (spawn, stop, reopen) finds an effect-bearing receipt', { timeout: 120_000 }, async () => {
  for (let n = 1; n <= 7; n++) {
    const cut = tempRoot('relaunch-effect');
    try {
      const killed = run('relaunch', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      await checkRecovery(cut.root, [domainOfEpoch(cut.root)]);
    } finally {
      cut.cleanup();
    }
  }
});
