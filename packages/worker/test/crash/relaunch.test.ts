/**
 * Relaunch crash cuts (P2-3): a real SIGKILL after every fsync of the relaunch scenario and right after each of its
 * native effects (the spawns, the prompt, the stops and the relaunches' reopening of the session file), each checked by
 * the recovery oracle and the fence oracle. A relaunch is never replayed; a relaunch cut after its dispatch record is
 * `outcome_unknown` and fences the session, one cut before it `no_effect`; the recovered worker is never live. At every
 * cut the worker's latest durable row names a domain of its own recorded epoch, and (PR #27 GPT 4) the domain each
 * spawn independently reports it ran in was durable before that spawn: the latest row names it, or the row that named
 * it records its removal; recovery cleans the domain a holding worker's latest row names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import type { Persisted } from '../../src/supervisor/state.js';
import { fences } from './fence-oracle.js';
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

/** Every worker row at the cut, in journal order (read before recovery appends anything). */
const rowsAtCut = (root: string): Persisted[] =>
  parseJournal(readFileSync(journalPath(root)))
    .records.filter(r => r.kind === 'worker')
    // SAFETY: `worker` records are Persisted values written by SupervisorState.persist.
    .map(r => r.value as unknown as Persisted);

/**
 * The native evidence, not the journal's own consistency: each worker's latest spawn names the domain it ran in. A row
 * durable at the cut named that domain before the spawn: the latest row names it, or the last row naming it recorded
 * its removal. And recovery cleans the domain a holding worker's latest row names.
 */
const spawnedDomainDurable =
  (root: string, rows: Persisted[]): Check =>
  (_pre, after) => {
    const spawned = new Map<string, string>();
    for (const e of effectsAt(root)) if (e.kind === 'create' && e.worker_id && e.domain) spawned.set(e.worker_id, e.domain);
    for (const [worker, domain] of spawned) {
      const mine = rows.filter(p => p.worker.worker_id === worker);
      const latest = mine.at(-1);
      const naming = mine.filter(p => p.domain?.name === domain).at(-1);
      assert.ok(naming, `${worker}: a durable row named ${domain} before its spawn`);
      assert.ok(latest === naming || naming.worker.cleanup === 'cgroup_empty_removed', `${worker}: the latest row names the spawned domain ${domain}, or its removal is recorded`);
    }
    for (const latest of new Map(rows.map(p => [p.worker.worker_id, p])).values()) {
      if (['starting', 'ready', 'cleanup_pending'].includes(latest.worker.status)) assert.ok(after.cleaned.includes(latest.domain!.name), `recovery cleans ${latest.domain!.name}`);
    }
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
      [
        'create:relaunched',
        'stop:stop-1',
        'create:relaunch-1',
        'switch_session:relaunch-1',
        'stop:stop-2',
        'create:relaunch-2',
        'switch_session:relaunch-2',
        'prompt:running',
        'stop:stop-3',
        'create:relaunch-3-fails',
        'switch_session:relaunch-3-fails',
        'create:relaunch-4',
        'switch_session:relaunch-4',
      ],
    );
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('relaunch-cut');
    try {
      cutAt('relaunch', cut.root, point);
      await checkRecovery(cut.root, [domainOfEpoch(cut.root), spawnedDomainDurable(cut.root, rowsAtCut(cut.root)), fences]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every relaunch native effect (spawn, stop, reopen) finds an effect-bearing receipt', { timeout: 120_000 }, async () => {
  for (let n = 1; n <= 13; n++) {
    const cut = tempRoot('relaunch-effect');
    try {
      const killed = run('relaunch', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      await checkRecovery(cut.root, [domainOfEpoch(cut.root), spawnedDomainDurable(cut.root, rowsAtCut(cut.root)), fences]);
    } finally {
      cut.cleanup();
    }
  }
});
