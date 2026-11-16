/**
 * The fence crash scenario (P1-6): a lost reply fences and pauses a queued follow-up, keep resumes and flushes it,
 * a second uncertainty raises the generation and is abandoned, an exit after a delivered prompt is resolved observed
 * from settlement evidence, and a running execution at a restart fences again and is kept.
 */
import type { Worker } from '../../src/supervisor/state.js';
import { bind, tick } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld, type World } from './world.js';

const settle = async (world: World, host: number) => {
  world.hosts[host]!.emit('event', { type: 'agent_settled' });
  await tick();
  await tick();
};

export async function fenceScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = a.worker_id;
  const host = world.hosts[0]!;
  const resolve = (cmd: string, uncertain: string, disposition: string) =>
    world.call('resolve', { ...bind(a, cmd), uncertain_command_id: uncertain, fence_generation: world.supervisor.get(id).fence!.fence_generation, disposition }, id);
  // A lost reply while a follow-up is queued: the fence pauses it; keep resumes and flushes it once.
  host.hold();
  const running = world.call('prompt', { ...bind(a, 'lost-1'), message: 'lost-1' }, id);
  await tick();
  await world.call('follow_up', { ...bind(a, 'paused-1'), message: 'paused-1', execution_id: world.supervisor.get(id).execution!.execution_id }, id);
  host.release!();
  await running;
  await settle(world, 0);
  await resolve('resolve-keep', 'lost-1', 'keep');
  await tick();
  await tick();
  await settle(world, 0);
  // A second uncertainty: a new generation, abandoned.
  host.failure = true;
  await world.call('prompt', { ...bind(a, 'lost-2'), message: 'lost-2' }, id);
  host.failure = false;
  await resolve('resolve-abandon', 'lost-2', 'abandon');
  await world.call('cancel', bind(a, 'cancel-a'), id);
  // An exit after a delivered prompt, then exact settlement evidence: resolved observed.
  await world.call('prompt', { ...bind(a, 'observed'), message: 'observed' }, id);
  host.emit('exit');
  host.emit('event', { type: 'agent_settled' });
  await resolve('resolve-observed', 'observed', 'observed');
  // A running execution at a restart fences again; the owner keeps it after the restart.
  const b: Worker = (await createIn(world, 'worker-b')).worker!;
  await world.call('prompt', { ...bind(b, 'run-b'), message: 'run-b' }, b.worker_id);
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  const fenced = world.supervisor.get(b.worker_id);
  await world.call('resolve', { ...bind(b, 'resolve-b'), uncertain_command_id: 'run-b', fence_generation: fenced.fence!.fence_generation, disposition: 'keep' }, b.worker_id);
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
