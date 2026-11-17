/**
 * The features crash scenario (P1-14): `session.configure` delivered, refused by pi before any change, and with a
 * lost reply (outcome_unknown, fenced, kept), and an inventory probe for a cwd in its own cleanup domain (P2-1); then a
 * restart and recovery.
 */
import type { Worker } from '../../src/supervisor/state.js';
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld } from './world.js';

export async function featuresScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = a.worker_id;
  const host = world.hosts[0]!;
  const now = () => world.supervisor.get(id);
  // An inventory probe for a cwd: its domain is recorded before it starts and its removal after it answers.
  await world.supervisor.features.models({ cwd: root });
  await world.call('configure', { ...bind(now(), 'configure-1'), model: { provider: 'p', id: 'm2' }, thinking: 'high', name: 'Chat' }, id);
  // pi refuses before any change: no effect, no fence.
  host.configureRefusal = 'model_not_available';
  await world.call('configure', { ...bind(now(), 'configure-refused'), model: { provider: 'p', id: 'missing' } }, id);
  host.configureRefusal = null;
  // pi changed the session, the reply was lost: outcome_unknown fences the session; the owner keeps it.
  host.configureFailure = true;
  await world.call('configure', { ...bind(now(), 'configure-lost'), thinking: 'low' }, id);
  host.configureFailure = false;
  await world.call('resolve', { ...bind(now(), 'resolve-configure'), uncertain_command_id: 'configure-lost', fence_generation: now().fence!.fence_generation, disposition: 'keep' }, id);
  await world.call('configure', { ...bind(now(), 'configure-2'), name: 'Renamed' }, id);
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
