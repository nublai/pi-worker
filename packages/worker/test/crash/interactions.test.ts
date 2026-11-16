/**
 * Interaction crash cuts (P1-10), ported from A0 `src/test/interaction-crash.test.ts`: a real SIGKILL after every
 * fsync of the interactions scenario and after every native effect (an answer the exact resolver received, a native
 * cancel, a tool release, the navigation). Besides the shared recovery oracle and the independent fence oracle:
 * - a deadline cancel is covered by its write-ahead `interaction_effect` marker (a move's cancel by the move's own
 *   dispatch record, which the shared oracle checks through its receipt);
 * - no interaction is pending or accepted after recovery, and a further recovery changes no interaction;
 * - no answer value (nor the changed value a retry sends) ever reaches the journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJournal, type JournalRecord } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import { checkRecovery, type Check } from './oracle.js';
import { fences } from './fence.test.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt, recoverWorld } from './world.js';

const records = (root: string): JournalRecord[] => parseJournal(readFileSync(journalPath(root))).records;
const latest = (root: string) => {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of records(root)) if (r.kind === 'interaction') out.set(String(r.value.interaction_id), r.value);
  return out;
};

async function checkInteractions(root: string): Promise<void> {
  const pre = records(root);
  const markers: Check = () => {
    for (const e of effectsAt(root)) {
      if (!e.command_id.startsWith('timeout:')) continue;
      const nativeId = e.command_id.slice('timeout:'.length);
      const interaction = pre.find(r => r.kind === 'interaction' && r.value.native_id === nativeId);
      assert.ok(interaction, `${nativeId}: the cancelled interaction was recorded before its cancel`);
      assert.ok(
        pre.some(r => r.kind === 'interaction_effect' && r.value.operation === 'cancel' && r.value.interaction_id === interaction.value.interaction_id),
        `${nativeId}: a deadline cancel needs its write-ahead marker`,
      );
    }
  };
  await checkRecovery(root, [fences, markers]);
  const after = latest(root);
  for (const [id, r] of after) assert.ok(!['pending', 'accepted'].includes(String(r.status)), `${id} is ${String(r.status)} after recovery`);
  await recoverWorld(root);
  assert.deepEqual(latest(root), after, 'another recovery changes no interaction');
  const bytes = readFileSync(journalPath(root), 'utf8');
  for (const secret of ['PRIVATE_NO_HASH', 'DIFFERENT_AFTER_RESTART']) assert.equal(bytes.includes(secret), false, `${secret} never reaches the journal`);
}

test('crash: SIGKILL after every interactions fsync: no answer replay, interrupted on restart, exact fences', { timeout: 600_000 }, async () => {
  const base = tempRoot('interactions-base');
  let points: FsyncPoint[];
  try {
    const full = run('interactions', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    for (const label of ['interaction.accept', 'interaction.cancel', 'interaction.release', 'receipt.dispatch']) assert.ok(points.some(p => p.label === label), label);
    await checkInteractions(base.root);
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('interactions-cut');
    try {
      cutAt('interactions', cut.root, point);
      await checkInteractions(cut.root);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every interactions native effect: effect-bearing receipts or write-ahead markers', { timeout: 300_000 }, async () => {
  const base = tempRoot('interactions-effects');
  let count: number;
  try {
    assert.equal(run('interactions', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  assert.ok(count >= 8, `only ${count} native effects`);
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('interactions-effect');
    try {
      assert.equal(run('interactions', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      await checkInteractions(cut.root);
    } finally {
      cut.cleanup();
    }
  }
});
