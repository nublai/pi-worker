/**
 * The session-commands crash scenario (P1-15): `sessions.compact`, `resources.reload` and `commands.invoke`, each
 * delivered, refused by pi before any change, and with a lost reply (outcome_unknown, fenced, kept); then a restart.
 */
import type { Worker } from '../../src/supervisor/state.js';
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld } from './world.js';

export async function sessionCommandsScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = a.worker_id;
  const host = world.hosts[0]!;
  const now = () => world.supervisor.get(id);
  const calls: [string, Record<string, unknown>][] = [
    ['compact', { custom_instructions: 'keep TODOs' }],
    ['reload', {}],
    ['invoke', { name: 'deploy', args: 'staging' }],
  ];
  for (const [op, extra] of calls) {
    await world.call(op, { ...bind(now(), `${op}-1`), ...extra }, id);
    // pi refuses before any change: no effect, no fence.
    host.commandRefusal = 'pi_busy';
    await world.call(op, { ...bind(now(), `${op}-refused`), ...extra }, id);
    host.commandRefusal = null;
    // pi ran it, the reply was lost: outcome_unknown fences the session; the owner keeps it.
    host.commandFailure = true;
    await world.call(op, { ...bind(now(), `${op}-lost`), ...extra }, id);
    host.commandFailure = false;
    await world.call('resolve', { ...bind(now(), `resolve-${op}`), uncertain_command_id: `${op}-lost`, fence_generation: now().fence!.fence_generation, disposition: 'keep' }, id);
  }
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
