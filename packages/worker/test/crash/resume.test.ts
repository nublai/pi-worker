/**
 * Create-with-resume crash cuts (P1 fix rounds 2 and 3; frozen invariants 1, 2 and 3). A create that resumes a session
 * reserves the target in memory while it opens it; a SIGKILL in that window used to leave the restarted supervisor
 * with the worker's temporary session id only, so a second resume of the target passed the gates once the target's
 * previous owner was proven clean, while the killed worker's descendants were unproven. And a create-with-resume
 * whose outcome was unknown (pi ran the switch hooks, then cancelled or the supervisor died) never fenced the
 * target, so once cleanup was confirmed the target was resumed and prompted with no resolution (fix round 3).
 *
 * Every cut of the resume scenario recovers through the shared oracle with the independent fence check. Each cut that
 * lands on a resuming worker's own records (its starting row carries the resume target, before any host starts), and
 * the cut right after pi opened the target but before the binding was recorded, then requires after the restart: a
 * second resume of the target is refused naming the killed worker (or its unproven cleanup), still refused once the
 * target's previous owner's cleanup is confirmed, and, when the create is `outcome_unknown` and unresolved, still
 * refused `target_session_fenced` naming the create once the resumer's own cleanup is confirmed. Only
 * `sessions.resolve_unknown` then releases it, and the released session takes a prompt. P1 has no cleanup proof
 * (P2's cgroup domains add it); `confirmCleanup` stands in for that proof on the recovered state, in memory only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../../src/b2/errors.js';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import type { Live, Persisted } from '../../src/supervisor/state.js';
import { bind } from '../supervisor-fixture.js';
import { fences } from './fence.test.js';
import { checkRecovery } from './oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { CANCELLED, RESUMER } from './resume-scenario.js';
import { effectsAt, openWorld, requestsAt, type World } from './world.js';

/** The resume target a create asked for, from the scenario's own request log. */
const targetOf = (root: string, command: string) => String(requestsAt(root).find(r => r.body.command_id === command)!.body.resume_session_id);

/** A resuming worker's last durable record before the cut, if it has one. */
function recordOf(root: string, command: string): Persisted | undefined {
  let last: Persisted | undefined;
  for (const record of parseJournal(readFileSync(journalPath(root))).records) {
    // SAFETY: `worker` records are Persisted values written by SupervisorState.persist.
    const value = record.value as unknown as Persisted;
    if (record.kind === 'worker' && value.create?.command_id === command) last = value;
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

/**
 * After a restart, on a private copy of the cut: the target stays with the killed resumer until its own cleanup is
 * confirmed and, when its create is an unresolved `outcome_unknown`, until `sessions.resolve_unknown`. Returns
 * whether the recovered create fenced the target.
 */
async function targetHeldUntilCleanupConfirmedAndResolved(cutRoot: string, cut: string, command: string): Promise<boolean> {
  const copy = tempRoot('resume-held');
  const root = copy.root;
  cpSync(cutRoot, root, { recursive: true });
  const target = targetOf(root, command);
  const world = openWorld(root, true);
  try {
    await world.supervisor.recover();
    const resumer = worker(world, command);
    const owner = worker(world, 'worker-a');
    const receipt = world.supervisor.receipts.all.get(command);
    const fenced = receipt?.state === 'outcome_unknown' && !(resumer.worker.resolutions ?? []).some(x => x.command_id === command);
    assert.equal(resumer.worker.session_id, target, `${cut}: the killed resumer holds the target as its session`);
    assert.deepEqual(resumer.worker.fence?.uncertain_command_ids ?? [], fenced ? [command] : [], `${cut}: an unknown create-with-resume fences its target, naming the create`);
    const resume = (name: string) => {
      const cwd = join(root, name);
      mkdirSync(cwd, { recursive: true });
      return world.supervisor.create({ command_id: name, cwd, provider: 'fixture', model: 'fixture', thinking: 'off', resume_session_id: target });
    };
    // A holding resumer is named; a failed one (process group gone, descendants unproven) blocks as unproven cleanup.
    const held = (e: unknown) =>
      e instanceof Refusal &&
      e.effect === 'no_effect' &&
      (resumer.worker.status === 'cleanup_pending'
        ? e.message === 'session_already_bound' && e.details.holder_worker_id === resumer.worker.worker_id
        : e.message === 'target_cleanup_unproven');
    const hosts = world.hosts.length;
    await assert.rejects(resume(`${command}-again-1`), held, `${cut}: a second resume after the restart is refused naming the killed resumer`);
    confirmCleanup(owner);
    await assert.rejects(
      resume(`${command}-again-2`),
      held,
      `${cut}: the target's previous owner proven clean does not release it while the killed resumer's cleanup is unproven`,
    );
    confirmCleanup(resumer);
    if (fenced) {
      await assert.rejects(
        resume(`${command}-again-3`),
        (e: unknown) => e instanceof Refusal && e.message === 'target_session_fenced' && e.effect === 'no_effect' && e.uncertain_command_id === command,
        `${cut}: confirmed cleanup alone does not release a target the unknown create fenced`,
      );
      const row = world.supervisor.get(resumer.worker.worker_id);
      const resolved = await world.supervisor.resolveUnknown(row.worker_id, {
        ...bind(row, `${command}-resolve`),
        uncertain_command_id: command,
        fence_generation: row.fence!.fence_generation,
        disposition: 'abandon',
      });
      assert.equal(resolved.state, 'delivered', `${cut}: resolve_unknown lifts the create's fence: ${JSON.stringify(resolved)}`);
    }
    assert.equal(world.hosts.length, hosts, `${cut}: a refused resume spawns nothing`);
    const released = await resume(`${command}-again-4`);
    assert.equal(released.state, 'delivered', `${cut}: the target is released once the resumer's cleanup is confirmed and its uncertainty resolved: ${JSON.stringify(released)}`);
    const next = world.supervisor.get(released.worker_id!);
    assert.equal(next.session_id, target);
    const prompted = await world.supervisor.prompt(next.worker_id, { ...bind(next, `${command}-prompt`), message: `${command}-prompt` });
    assert.equal(prompted.state, 'delivered', `${cut}: the released session takes input`);
    return fenced;
  } finally {
    world.state.close();
    copy.cleanup();
  }
}

test('crash: SIGKILL after every resume-scenario fsync; the resume target stays reserved until the resumer cleanup is confirmed and an unknown create is resolved', { timeout: 900_000 }, async () => {
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
  const fencedAt = new Set<string>();
  for (const point of points) {
    const cut = tempRoot('resume-cut');
    try {
      cutAt('resume', cut.root, point);
      // The durable records at the cut, before recovery adds its own.
      const record = recordOf(cut.root, RESUMER);
      const cancelled = recordOf(cut.root, CANCELLED);
      await checkRecovery(cut.root, [fences]);
      const at = `${point.label}@${point.occurrence}`;
      if (!record) continue; // Before the resumer's starting row nothing was spawned or opened.
      if (record.worker.session_id !== targetOf(cut.root, RESUMER)) window.add(point.label);
      await targetHeldUntilCleanupConfirmedAndResolved(cut.root, at, RESUMER);
      if (!cancelled) continue;
      if (await targetHeldUntilCleanupConfirmedAndResolved(cut.root, at, CANCELLED)) fencedAt.add(point.label);
    } finally {
      cut.cleanup();
    }
  }
  // The durable target point and every record before the open (starting row, dispatch, spawn, pi's temporary identity).
  assert.deepEqual([...window].sort(), ['receipt.dispatch', 'worker.create', 'worker.identity', 'worker.spawned'], 'the cuts cover the window before the binding is recorded');
  // The cancelled resume is fenced from its dispatch record through pi's exit, its failure row and its unknown receipt
  // until the owner's resolution is durable (the resolution's own intent and dispatch records included).
  assert.deepEqual(
    [...fencedAt].sort(),
    ['receipt.dispatch', 'receipt.intent', 'receipt.result', 'worker.exit', 'worker.failed', 'worker.identity', 'worker.spawned'],
    'the cuts cover an unknown create-with-resume before and after its fence is durable',
  );
});

/** The cut right after `command`'s native open of its resume target, before its binding (or failure) is recorded. */
async function afterOpen(command: string): Promise<void> {
  const base = tempRoot('resume-effects');
  let open: number;
  try {
    assert.equal(run('resume', base.root).status, 0);
    const effects = effectsAt(base.root);
    open = effects.findIndex(e => e.kind === 'switch_session' && e.command_id === command) + 1;
    assert.ok(open > 0, 'the scenario opens the target natively');
  } finally {
    base.cleanup();
  }
  const cut = tempRoot('resume-open');
  try {
    assert.equal(run('resume', cut.root, undefined, { PIW_CRASH_EFFECT: String(open) }).signal, 'SIGKILL');
    const record = recordOf(cut.root, command)!;
    assert.notEqual(record.worker.session_id, targetOf(cut.root, command), 'the cut lands before the binding to the target is recorded');
    await checkRecovery(cut.root, [fences]);
    assert.equal(await targetHeldUntilCleanupConfirmedAndResolved(cut.root, 'after open', command), true, 'the dispatched create recovers outcome_unknown and fences');
  } finally {
    cut.cleanup();
  }
}

test('crash: SIGKILL right after pi opened the resume target, before the binding is recorded: the target stays reserved and fenced', { timeout: 120_000 }, async () => {
  await afterOpen(RESUMER);
});

test('crash: SIGKILL right after pi ran the switch hooks of a resume it then cancels: the target is fenced until resolve_unknown', { timeout: 120_000 }, async () => {
  await afterOpen(CANCELLED);
});
