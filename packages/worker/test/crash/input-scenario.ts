/**
 * The input crash scenario (P1-5): prompts, if_busy follow-up and steer, an explicit steer and follow-ups flushed
 * after settlement, cancel and interrupt that drop queued input, a lost reply, a stop, then a restart.
 */
import type { Worker } from '../../src/supervisor/state.js';
import { bind, tick } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld, type World } from './world.js';

async function settle(world: World, host: number): Promise<void> {
  world.hosts[host]!.emit('event', { type: 'agent_settled' });
  await tick();
  await tick();
}

export async function inputScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = a.worker_id;
  const prompt = (cmd: string, extra: Record<string, unknown> = {}) => world.call('prompt', { ...bind(a, cmd), message: cmd, ...extra }, id);
  await prompt('first');
  await settle(world, 0);
  await prompt('run');
  const execution_id = world.supervisor.get(id).execution!.execution_id;
  await prompt('queued-1', { if_busy: 'follow_up' });
  await world.call('follow_up', { ...bind(a, 'queued-2'), message: 'queued-2', execution_id }, id);
  await world.call('steer', { ...bind(a, 'steer-1'), message: 'steer-1', execution_id }, id);
  await prompt('steer-2', { if_busy: 'steer' });
  await settle(world, 0); // queued-1 dispatches
  await settle(world, 0); // queued-2 dispatches
  await settle(world, 0);
  await prompt('run-2');
  const run2 = world.supervisor.get(id).execution!.execution_id;
  await world.call('follow_up', { ...bind(a, 'queued-3'), message: 'queued-3', execution_id: run2 }, id);
  await world.call('cancel', { ...bind(a, 'cancel-a'), execution_id: run2 }, id);
  await world.call('interrupt', bind(a, 'interrupt-a'), id);
  const b: Worker = (await createIn(world, 'worker-b')).worker!;
  world.hosts[1]!.failure = true;
  await world.call('prompt', { ...bind(b, 'lost'), message: 'lost' }, b.worker_id);
  await world.call('stop', bind(b, 'stop-b'), b.worker_id);
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
