/**
 * The crash matrix (P1-13), ported from A0 `src/test/crash-matrix.test.ts` onto the shared crash world: a real SIGKILL
 * right after every native effect of each kind (prompt, binding move, create, child launch, cancel and interrupt
 * `clear_queue` and `abort`, stop, and the child's report claim), after every fsync of the matrix scenario, and after
 * every fsync of a recovery seeded by a cut at the first accepted prompt. A0's `checkRecovery` is the shared oracle
 * (oracle.ts: buckets, native-effect evidence, no duplicate, no replay, idempotent recovery) plus its bucket and fence
 * oracle (fence-oracle.ts, child lineage included) and its parent-launch check below. Every assertion of A0's file is
 * kept; A0's `receipt.sessions.prompt.accepted` label is the first `receipt.dispatch` whose record is that prompt's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import { checkRecovery, type Check } from './oracle.js';
import { fences } from './fence-oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt, requestsAt, type Effect, type Logged } from './world.js';

/** A0: a child's spawn needs its parent's launch receipt recovered and not `no_effect` (from the client's request log). */
function parentLaunch(root: string): Check {
  return (_pre, after) => {
    const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
    for (const e of effectsAt(root)) {
      const launch = requestsAt(root).find(q => q.op === 'launch_child' && (q.body.launch as { command_id?: string } | undefined)?.command_id === e.command_id);
      if (e.kind !== 'create' || !launch) continue;
      const r = receipts.get(String(launch.body.command_id));
      assert.ok(r, `child spawn ${e.command_id} needs its parent's launch receipt`);
      assert.notEqual(r.effect, 'no_effect', `the launch of spawned child ${e.command_id} recovered ${r.state}/${r.effect}`);
    }
  };
}

const oracle = (root: string): Check[] => [fences, parentLaunch(root)];

const launches = (requests: Logged[]) => new Set(requests.filter(q => q.op === 'launch_child').map(q => String((q.body.launch as { command_id: string }).command_id)));
const KINDS = ['prompt', 'rebind', 'create', 'child launch', 'cancel clear_queue', 'cancel abort', 'interrupt clear_queue', 'interrupt abort', 'stop', 'report'] as const;
function matches(kind: (typeof KINDS)[number], e: Effect, children: Set<string>): boolean {
  if (kind === 'child launch') return e.kind === 'create' && children.has(e.command_id);
  if (kind === 'create') return e.kind === 'create' && !children.has(e.command_id);
  if (kind === 'rebind') return ['new_session', 'switch_session', 'fork'].includes(e.kind);
  if (kind === 'report') return e.kind === 'report';
  const [control, operation] = kind.split(' ');
  if (operation) return e.kind === operation && e.command_id.endsWith(`-${control}`);
  return e.kind === kind;
}

for (const kind of KINDS) {
  test(`crash matrix: effect cut ${kind}: native evidence forbids no_effect and recovered buckets require fences`, { timeout: 600_000 }, async () => {
    const baseline = tempRoot('matrix-effect-base');
    let points: number[];
    try {
      const full = run('matrix', baseline.root);
      assert.equal(full.status, 0, full.stderr);
      const children = launches(requestsAt(baseline.root));
      points = effectsAt(baseline.root).flatMap((e, i) => (matches(kind, e, children) ? [i + 1] : []));
    } finally {
      baseline.cleanup();
    }
    assert.ok(points.length > 0);
    for (const point of points) {
      const cut = tempRoot('matrix-effect-cut');
      try {
        const killed = run('matrix', cut.root, undefined, { PIW_CRASH_EFFECT: String(point) });
        assert.equal(killed.signal, 'SIGKILL', killed.stderr);
        await checkRecovery(cut.root, oracle(cut.root));
      } finally {
        cut.cleanup();
      }
    }
    console.log(JSON.stringify({ effect_kind: kind, cuts: points.length, result: 'pass' }));
  });
}

test('crash matrix: SIGKILL after EVERY scenario fsync occurrence: recovery buckets, required fences and no duplicate effect', { timeout: 1_800_000 }, async () => {
  const suite = tempRoot('crash-matrix');
  const matrix: { index: number; label: string; occurrence: number; buckets: string[]; effects: number; result: string }[] = [];
  const record = async (root: string, point: FsyncPoint, label = point.label) => {
    const after = await checkRecovery(root, oracle(root));
    matrix.push({ ...point, label, buckets: [...new Set(after.receipts.map(r => `${r.state}/${r.effect}`))].sort(), effects: effectsAt(root).length, result: 'pass' });
  };
  try {
    const baseline = join(suite.root, 'baseline');
    mkdirSync(baseline, { mode: 0o700 });
    const full = run('matrix', baseline);
    assert.equal(full.status, 0, full.stderr);
    const points = full.points;
    assert.ok(points.length > 80, 'scenario must cover control/rebind/queue/resolve/grant fsyncs');
    for (const point of points) {
      const cut = tempRoot('matrix-cut');
      try {
        cutAt('matrix', cut.root, point);
        await record(cut.root, point);
      } finally {
        cut.cleanup();
      }
    }
    // Every recovery fsync occurrence from this single accepted-prompt seed only (A0: the first accepted prompt).
    let seed: FsyncPoint | undefined;
    for (const point of points.filter(p => p.label === 'receipt.dispatch')) {
      const probe = tempRoot('matrix-seed');
      try {
        cutAt('matrix', probe.root, point);
        const last = parseJournal(readFileSync(journalPath(probe.root))).records.at(-1)!;
        if (last.kind === 'receipt' && last.value.operation === 'sessions.prompt' && last.value.state === 'accepted') seed = point;
      } finally {
        probe.cleanup();
      }
      if (seed) break;
    }
    assert.ok(seed, 'the scenario dispatches a prompt');
    let recoveryPoints: FsyncPoint[];
    const probe = tempRoot('matrix-recovery-probe');
    try {
      cutAt('matrix', probe.root, seed);
      const traced = run('matrix-recover', probe.root);
      assert.equal(traced.status, 0, traced.stderr);
      recoveryPoints = traced.points;
    } finally {
      probe.cleanup();
    }
    assert.ok(recoveryPoints.length > 0);
    for (const point of recoveryPoints) {
      const cut = tempRoot('matrix-recovery-cut');
      try {
        cutAt('matrix', cut.root, seed);
        cutAt('matrix-recover', cut.root, point);
        await record(cut.root, point, `recovery:${point.label}`);
      } finally {
        cut.cleanup();
      }
    }
    writeFileSync(join(suite.root, 'matrix.json'), `${JSON.stringify({ model: 'SIGKILL-after-fsync; no power-loss proof', matrix }, null, 2)}\n`);
    console.log(JSON.stringify({ fsync_cuts: matrix.length, result: 'pass' }));
  } finally {
    suite.cleanup();
  }
});
