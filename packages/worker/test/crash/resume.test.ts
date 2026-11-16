/**
 * Create-with-resume crash cuts (P1 fix round 2; frozen invariants 1 and 2). A create that resumes a session reserves
 * the target in memory while it opens it; a SIGKILL in that window used to leave the restarted supervisor with the
 * worker's temporary session id only, so a second resume of the target passed the gates once the target's previous
 * owner was proven clean, while the killed worker's descendants were unproven.
 *
 * Every cut of the resume scenario recovers through the shared oracle. Each cut that lands on the resuming worker's
 * own records (its starting row carries the resume target, before any host starts), and the cut right after pi opened
 * the target but before the binding was recorded, then requires after the restart: a second resume of the target is
 * refused naming the killed worker, still refused once the target's previous owner's cleanup is confirmed, and
 * delivered only after the killed worker's own cleanup is confirmed. P1 has no cleanup proof (P2's cgroup domains
 * add it); `confirmCleanup` stands in for that proof on the recovered state, in memory only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../../src/b2/errors.js';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import type { Live, Persisted } from '../../src/supervisor/state.js';
import { checkRecovery } from './oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { RESUMER } from './resume-scenario.js';
import { effectsAt, openWorld, requestsAt, type World } from './world.js';

/** The resume target the scenario asked for, from its own request log. */
const targetOf = (root: string) => String(requestsAt(root).find(r => r.body.command_id === RESUMER)!.body.resume_session_id);

/** The resuming worker's last durable record before the cut, if it has one. */
function resumerRecord(root: string): Persisted | undefined {
  let last: Persisted | undefined;
  for (const record of parseJournal(readFileSync(journalPath(root))).records) {
    // SAFETY: `worker` records are Persisted values written by SupervisorState.persist.
    const value = record.value as unknown as Persisted;
    if (record.kind === 'worker' && value.create?.command_id === RESUMER) last = value;
  }
  return last;
}

/** Stands in for P2's confirmed cleanup (group and every descendant observed gone), in memory only. */
function confirmCleanup(live: Live): void {
  live.worker.status = 'stopped';
  live.worker.cleanup = 'test_stand_in_for_confirmed_cleanup';
  live.pid = null;
}

const worker = (world: World, command: string): Live => [...world.supervisor.state.workers.values()].find(l => l.create?.command_id === command)!;

/** After a restart: the target stays with the killed resumer until its own cleanup is confirmed. */
async function targetHeldUntilResumerCleanupConfirmed(root: string, cut: string): Promise<void> {
  const target = targetOf(root);
  const world = openWorld(root, true);
  try {
    await world.supervisor.recover();
    const resumer = worker(world, RESUMER);
    const owner = worker(world, 'worker-a');
    assert.equal(resumer.worker.status, 'cleanup_pending', `${cut}: the killed resumer is cleanup_pending`);
    const resume = (name: string) => {
      const cwd = join(root, name);
      mkdirSync(cwd, { recursive: true });
      return world.supervisor.create({ command_id: name, cwd, provider: 'fixture', model: 'fixture', thinking: 'off', resume_session_id: target });
    };
    const heldByResumer = (e: unknown) =>
      e instanceof Refusal && e.message === 'session_already_bound' && e.effect === 'no_effect' && e.details.holder_worker_id === resumer.worker.worker_id;
    const hosts = world.hosts.length;
    await assert.rejects(resume('second-resume-1'), heldByResumer, `${cut}: a second resume after the restart is refused naming the killed resumer`);
    confirmCleanup(owner);
    await assert.rejects(
      resume('second-resume-2'),
      heldByResumer,
      `${cut}: the target's previous owner proven clean does not release it while the killed resumer's cleanup is unproven`,
    );
    assert.equal(world.hosts.length, hosts, `${cut}: a refused resume spawns nothing`);
    confirmCleanup(resumer);
    const released = await resume('second-resume-3');
    assert.equal(released.state, 'delivered', `${cut}: the target is released once the resumer's cleanup is confirmed: ${JSON.stringify(released)}`);
    assert.equal(world.supervisor.get(released.worker_id!).session_id, target);
  } finally {
    world.state.close();
  }
}

test('crash: SIGKILL after every resume-scenario fsync; the resume target stays reserved until the resumer cleanup is confirmed', { timeout: 600_000 }, async () => {
  const base = tempRoot('resume-base');
  let points: FsyncPoint[];
  try {
    const full = run('resume', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  const window = new Set<string>();
  for (const point of points) {
    const cut = tempRoot('resume-cut');
    try {
      cutAt('resume', cut.root, point);
      const record = resumerRecord(cut.root);
      await checkRecovery(cut.root);
      if (!record) continue; // Before the resumer's starting row nothing was spawned or opened.
      if (record.worker.session_id !== targetOf(cut.root)) window.add(point.label);
      await targetHeldUntilResumerCleanupConfirmed(cut.root, `${point.label}@${point.occurrence}`);
    } finally {
      cut.cleanup();
    }
  }
  // The durable target point and every record before the open (starting row, dispatch, spawn, pi's temporary identity).
  assert.deepEqual([...window].sort(), ['receipt.dispatch', 'worker.create', 'worker.identity', 'worker.spawned'], 'the cuts cover the window before the binding is recorded');
});

test('crash: SIGKILL right after pi opened the resume target, before the binding is recorded: the target stays reserved', { timeout: 120_000 }, async () => {
  const base = tempRoot('resume-effects');
  let open: number;
  try {
    assert.equal(run('resume', base.root).status, 0);
    const effects = effectsAt(base.root);
    open = effects.findIndex(e => e.kind === 'switch_session' && e.command_id === RESUMER) + 1;
    assert.ok(open > 0, 'the scenario opens the target natively');
  } finally {
    base.cleanup();
  }
  const cut = tempRoot('resume-open');
  try {
    assert.equal(run('resume', cut.root, undefined, { PIW_CRASH_EFFECT: String(open) }).signal, 'SIGKILL');
    const record = resumerRecord(cut.root)!;
    assert.notEqual(record.worker.session_id, targetOf(cut.root), 'the cut lands before the binding to the target is recorded');
    await checkRecovery(cut.root);
    await targetHeldUntilResumerCleanupConfirmed(cut.root, 'after open');
  } finally {
    cut.cleanup();
  }
});
