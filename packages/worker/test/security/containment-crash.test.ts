/**
 * Containment crash cuts (P2-4), ported from A0 `src/test/containment-crash.test.ts` onto the shared crash world
 * (test/crash): a real SIGKILL after every fsync and right after every native effect of the containment seed (a contained
 * initial create) and of the containment scenario (recovery, owner keep, relaunch, the kept prompt, a bwrap-declared
 * typed child with an FD report, stops), each checked by the recovery oracle, the fence oracle and A0's containment
 * checks: every spawn and kill names its exact durable domain, a kill finds that domain's row `cleanup_pending`, a
 * sandboxed spawn's lineage and `bwrap` declaration are durable before it, every effect follows its durable dispatch,
 * the kept prompt runs at most once, and an unreported sandboxed child fences its parent. Deterministic seams, not real
 * cgroup or bwrap evidence (security/sandbox.test.ts and security/containment.test.ts are the kernel tier).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal, type JournalRecord } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import type { Persisted } from '../../src/supervisor/state.js';
import { treesOf } from '../crash/containment-scenario.js';
import { fences } from '../crash/fence-oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from '../crash/harness.js';
import { checkRecovery, type Check } from '../crash/oracle.js';
import { effectsAt, requestsAt } from '../crash/world.js';

const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as T)
    : [];

/** A0's containment checks over the cut root (records and native artifacts read before recovery appends anything). */
function containment(root: string): Check {
  const records: JournalRecord[] = parseJournal(readFileSync(journalPath(root))).records;
  // SAFETY: `worker` records are Persisted values written by SupervisorState.persist.
  const row = (r: JournalRecord) => r.value as unknown as Persisted;
  const effects = effectsAt(root);
  const requests = requestsAt(root);
  const settled = new Set(records.filter(r => r.kind === 'settlement').map(r => String(r.value.command_id)));
  return (_pre, after) => {
    for (const kill of lines<{ domain: string; status: string | null }>(join(root, 'kills.jsonl'))) {
      assert.equal(kill.status, 'cleanup_pending', `pending is durable BEFORE the native kill of ${kill.domain}`);
    }
    for (const e of effects) {
      assert.ok(typeof e.records === 'number', 'every effect names the durable records before it');
      const at = records.slice(0, e.records);
      if (e.kind === 'create') {
        // EVERY spawn requires its exact durable domain, not just a worker that happens to have one.
        const w = at.filter(r => r.kind === 'worker' && row(r).worker.worker_id === e.worker_id).at(-1);
        assert.ok(w && row(w).domain?.name === e.domain, `spawn ${e.command_id}: its domain ${e.domain} is the durable row's`);
        const asked = requests.find(q => q.op === 'create' && q.body.command_id === e.command_id)?.body;
        if (asked?.parent) {
          assert.deepEqual(row(w).worker.parent, asked.parent, 'a sandboxed spawn cannot lose lineage');
          assert.equal(row(w).worker.launch_spec?.environment.filesystem, 'bwrap', 'the confinement declaration precedes the spawn');
        }
      }
      if (e.command_id.startsWith('claim:')) continue;
      const r = at.filter(x => x.kind === 'receipt' && x.value.command_id === e.command_id).at(-1);
      assert.ok(r && r.value.state !== 'intent', `${e.kind} ${e.command_id} must follow its durable dispatch, not only its intent`);
    }
    assert.ok(effects.filter(e => e.kind === 'prompt').length <= 1, 'the kept prompt runs at most once');
    if (effects.some(e => e.kind === 'prompt' && e.command_id === 'work') && !settled.has('work')) {
      assert.ok(after.workers.some(w => w.fence?.uncertain_command_ids?.includes('work')), 'a dispatch after the owner keep still fences after a crash');
    }
    for (const e of effects.filter(x => x.kind === 'create' && x.command_id === 'sandbox-child')) {
      const child = after.workers.find(w => w.worker_id === e.worker_id);
      assert.ok(child, 'the sandboxed child is recovered');
      const reported = after.receipts.some(r => r.worker_id === child.worker_id && r.operation === 'children.report' && r.state === 'delivered' && r.result?.kind === 'result');
      if (!reported) assert.ok(after.workers.find(w => w.worker_id === child.parent_worker_id)?.fence?.uncertain_command_ids?.includes('sandbox-child'), 'an unreported sandboxed spawn fences its parent');
    }
  };
}

/** A fresh scenario root and its worktrees beside it, removed together. */
function fresh(name: string): { root: string; cleanup: () => void } {
  const t = tempRoot(name);
  return {
    root: t.root,
    cleanup: () => {
      t.cleanup();
      rmSync(treesOf(t.root), { recursive: true, force: true });
    },
  };
}

/** A root the seed has run on, up to its own crash at the prompt intent. */
function seeded(): { root: string; cleanup: () => void } {
  const t = fresh('containment');
  const seed = run('containment-seed', t.root);
  assert.equal(seed.signal, 'SIGKILL', seed.stderr);
  return t;
}

const check = (root: string) => checkRecovery(root, [containment(root), fences]);

test('containment crash: a contained initial create reserves its domain before every spawn and survives every fsync and effect cut', { timeout: 300_000 }, async () => {
  let points: FsyncPoint[];
  const base = fresh('containment-create');
  try {
    const baseline = run('containment-seed', base.root);
    assert.equal(baseline.signal, 'SIGKILL', baseline.stderr);
    points = baseline.points;
    assert.equal(points.at(-1)?.label, 'receipt.intent', 'the seed dies at the prompt intent');
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = fresh('containment-create-cut');
    try {
      cutAt('containment-seed', cut.root, point);
      await check(cut.root);
    } finally {
      cut.cleanup();
    }
  }
  const cut = fresh('containment-create-effect');
  try {
    assert.equal(run('containment-seed', cut.root, undefined, { PIW_CRASH_EFFECT: '1' }).signal, 'SIGKILL');
    await check(cut.root);
  } finally {
    cut.cleanup();
  }
  console.log(JSON.stringify({ containment_create_fsync_cuts: points.length, containment_create_effect_cuts: 1 }));
});

test('containment crash: SIGKILL after every recovery, keep, relaunch, sandboxed child, report and stop fsync and native effect', { timeout: 600_000 }, async () => {
  let points: FsyncPoint[];
  let effects: number;
  const base = seeded();
  try {
    const before = effectsAt(base.root).length;
    const full = run('containment', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    effects = effectsAt(base.root).length - before;
    assert.deepEqual(
      effectsAt(base.root)
        .slice(before)
        .map(e => `${e.kind}:${e.command_id}`),
      ['create:relaunch', 'switch_session:relaunch', 'prompt:work', 'create:sandbox-child', 'report_fd:claim:report', 'stop:stop-child', 'stop:stop'],
    );
    await check(base.root);
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = seeded();
    try {
      cutAt('containment', cut.root, point);
      await check(cut.root);
    } finally {
      cut.cleanup();
    }
  }
  for (let n = 1; n <= effects; n++) {
    const cut = seeded();
    try {
      const killed = run('containment', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) });
      assert.equal(killed.signal, 'SIGKILL', `effect ${n}: ${killed.stderr.slice(-2000)}`);
      await check(cut.root);
    } finally {
      cut.cleanup();
    }
  }
  console.log(JSON.stringify({ containment_fsync_cuts: points.length, containment_effect_cuts: effects }));
});
