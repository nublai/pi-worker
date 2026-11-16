/**
 * Fence crash cuts (P1-6): a real SIGKILL after every fsync of the fence scenario and after every native effect.
 * Besides the recovery oracle, the fence of every worker must equal exactly its uncertainties (ported from A0
 * `crash-matrix.test.ts`'s bucket and fence oracle): every unresolved outcome_unknown session-directed receipt, an
 * unsettled dispatched execution unless it was resolved and the worker was no longer live, and every unresolved
 * uncertainty already in the persisted fence (which must have dispatched evidence). No spurious empty fence.
 *
 * Which operations are session writes comes from the contract (`FENCES_WHEN_UNKNOWN` below), never from the
 * implementation: an oracle that imported the supervisor's own set agreed with its omission of `sessions.new`
 * (review F4), and a table that called every `workers.create` non-fencing agreed with an unfenced unknown
 * create-with-resume (fix round 3). Whether a create named an existing session comes from the client's request log.
 * The table and the oracle live in `fence-oracle.ts` (P1-12, moved unchanged); this file re-exports them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINDS_EXISTING_SESSION, SESSION_DIRECTED } from '../../src/supervisor/fence.js';
import { checkRecovery } from './oracle.js';
import { FENCES_WHEN_UNKNOWN, NAMES_EXISTING_SESSION, fences } from './fence-oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

export { FENCES_WHEN_UNKNOWN, fences };

test('fence: the supervisor recovers exactly the contract session writes as fencing uncertainties', () => {
  const contract = (rule: boolean | typeof NAMES_EXISTING_SESSION) =>
    Object.entries(FENCES_WHEN_UNKNOWN)
      .filter(([, fences]) => fences === rule)
      .map(([operation]) => operation)
      .sort();
  assert.deepEqual([...SESSION_DIRECTED].sort(), contract(true));
  assert.deepEqual([...BINDS_EXISTING_SESSION].sort(), contract(NAMES_EXISTING_SESSION), 'create-with-resume fences when unknown');
});

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
