/**
 * The crash-matrix scenario (P1-13), ported from A0 `src/test/fixtures/crash-child.ts` mode `scenario`: one worker
 * prompts, moves (new, resume, fork), loses its pi with a run in flight and is resolved `observed` from settlement
 * evidence, then stopped; for `keep` and for `abandon`, a worker whose held prompt's reply is lost queues a follow-up
 * and an untyped child launch under that run, is resolved with that disposition, cancelled, interrupted, sends a
 * report (from the child that `keep` launched, a claim written to the child's report artifact first; from the parent
 * under `abandon`, as A0 did) and is stopped; finally the owner registers and revokes a grant. No restart: recovery is
 * `matrix-recover`, so its own fsyncs can be cut.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Worker } from '../../src/supervisor/state.js';
import { bind, tick } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { effect, openWorld, type World } from './world.js';

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick();
};

async function settle(world: World, host: number): Promise<void> {
  world.hosts[host]!.emit('event', { type: 'agent_settled' });
  await ticks(2);
}

export async function matrixScenario(root: string): Promise<void> {
  const world = openWorld(root, true);
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = a.worker_id;
  const now = () => world.supervisor.get(id);
  await world.call('prompt', { ...bind(a, 'first'), message: 'first' }, id);
  await settle(world, 0);
  await world.call('rebind', { ...bind(now(), 'new'), action: 'new' }, id);
  await world.call('rebind', { ...bind(now(), 'resume'), action: 'resume', target_session_id: a.session_id }, id);
  await world.call('rebind', { ...bind(now(), 'fork'), action: 'fork', source_leaf_id: now().leaf_id, entry_id: 'first' }, id);
  await world.call('prompt', { ...bind(now(), 'observed'), message: 'observed' }, id);
  world.hosts[0]!.emit('exit');
  world.hosts[0]!.emit('event', { type: 'agent_settled' });
  await world.call('resolve', { ...bind(now(), 'resolve-observed'), uncertain_command_id: 'observed', fence_generation: now().fence!.fence_generation, disposition: 'observed' }, id);
  await world.call('stop', bind(now(), 'stop-a'), id);
  for (const disposition of ['keep', 'abandon'] as const) {
    const w: Worker = (await createIn(world, `worker-${disposition}`)).worker!;
    const host = world.hosts.length - 1;
    const h = world.hosts[host]!;
    h.hold();
    const pending = world.call('prompt', { ...bind(w, `${disposition}-run`), message: `${disposition}-run` }, w.worker_id);
    await tick();
    const execution_id = world.supervisor.get(w.worker_id).execution!.execution_id;
    await world.call('follow_up', { ...bind(w, `${disposition}-follow`), execution_id, message: `${disposition}-follow` }, w.worker_id);
    const cwd = join(root, `child-${disposition}`);
    mkdirSync(cwd);
    await world.call('launch_child', { ...bind(w, `${disposition}-child`), execution_id, launch: { command_id: `${disposition}-launch`, cwd, provider: 'p', model: 'm', thinking: 'off' } }, w.worker_id);
    h.release!();
    await pending;
    await settle(world, host);
    const fence = world.supervisor.get(w.worker_id).fence!;
    await world.call('resolve', { ...bind(w, `${disposition}-resolve`), uncertain_command_id: `${disposition}-run`, fence_generation: fence.fence_generation, disposition }, w.worker_id);
    await ticks(4);
    // keep: the follow-up runs, then the child launches when it settles; abandon dropped both.
    await settle(world, host);
    await ticks(4);
    await world.call('cancel', bind(w, `${disposition}-cancel`), w.worker_id);
    await world.call('interrupt', bind(w, `${disposition}-interrupt`), w.worker_id);
    const child = world.supervisor.list().find(c => c.parent_worker_id === w.worker_id);
    assert.equal(!!child, disposition === 'keep', `${disposition}: the queued child launch ${disposition === 'keep' ? 'ran' : 'was dropped'}`);
    const reporter = child ?? w;
    const report = `${disposition}-report`;
    const native_file = join(root, 'native-controls.jsonl');
    appendFileSync(native_file, `${JSON.stringify({ command_id: `claim:${report}`, operation: 'report' })}\n`);
    effect(root, { kind: 'report', command_id: `claim:${report}`, operation: 'report', native_file });
    await world.call('report', { ...bind(reporter, report), task_id: child ? `${disposition}-child` : 'task', result_digest: 'sha256:fixture', kind: 'result', message: 'done' }, reporter.worker_id);
    await world.call('stop', bind(world.supervisor.get(w.worker_id), `${disposition}-stop`), w.worker_id);
  }
  const grants = world.supervisor.state.grants!;
  grants.register({ caller: 'crash-fixture', scope: { worker_ids: [], cwd_roots: [] }, methods: ['hello'], grant_id: 'fixture' });
  grants.revoke('fixture');
  world.state.close();
}

/** `matrix-recover`: one restart's recovery over the matrix scenario's state, nothing else (its fsyncs are cut). */
export async function matrixRecover(root: string): Promise<void> {
  const world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
