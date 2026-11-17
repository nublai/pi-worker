/**
 * The relaunch crash scenario (P2-3): a worker is stopped (its domain observed removed and recorded), relaunched on its
 * session at a new epoch in a new domain, stopped and relaunched again, and left ready; then an in-process restart.
 * The cuts in relaunch.test.ts land on each relaunch's starting row (the new epoch's domain, durable before the
 * dispatch record), its dispatch record, the new process identity, its readiness, and on the native spawn and the
 * reopen of the session file.
 */
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld } from './world.js';

export const RELAUNCHED = 'relaunched';

export async function relaunchScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a = (await createIn(world, RELAUNCHED)).worker!;
  await world.call('stop', bind(a, 'stop-1'), a.worker_id);
  const first = await world.call('relaunch', bind(a, 'relaunch-1'), a.worker_id);
  if (first.state !== 'delivered') throw new Error(`the first relaunch must be delivered: ${JSON.stringify(first)}`);
  const fresh = world.supervisor.get(a.worker_id);
  await world.call('stop', bind(fresh, 'stop-2'), a.worker_id);
  const second = await world.call('relaunch', bind(fresh, 'relaunch-2'), a.worker_id);
  if (second.state !== 'delivered') throw new Error(`the second relaunch must be delivered: ${JSON.stringify(second)}`);
  // Restart in-process: no host is adopted; the relaunched worker becomes cleanup_pending on its newest domain.
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
