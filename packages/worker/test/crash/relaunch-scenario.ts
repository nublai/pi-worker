/**
 * The relaunch crash scenario (P2-3): a worker is stopped (its domain observed removed and recorded), relaunched on its
 * session at a new epoch in a new domain, stopped and relaunched again. Then (PR #27) a prompt left running is ended
 * by a stop, which fences it; once that is resolved, a relaunch reopens the session and fails, which fences the session
 * too; once that is resolved, a last relaunch leaves it ready. Then an in-process restart.
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
  const now = () => world.supervisor.get(a.worker_id);
  // A stop of an otherwise unfenced running execution fences it, durably before the kill.
  await world.call('prompt', { ...bind(now(), 'running'), message: 'running' }, a.worker_id);
  await world.call('stop', bind(now(), 'stop-3'), a.worker_id);
  if (now().fence?.command_id !== 'running') throw new Error(`the stop must fence the running execution: ${JSON.stringify(now().fence)}`);
  await world.call('resolve', { ...bind(now(), 'resolve-running'), uncertain_command_id: 'running', fence_generation: now().fence!.fence_generation, disposition: 'keep' }, a.worker_id);
  // A relaunch that reopens the session and then fails is unknown and fences the session.
  const failed = await world.call('relaunch', bind(now(), 'relaunch-3-fails'), a.worker_id);
  if (failed.state !== 'outcome_unknown' || now().fence?.command_id !== 'relaunch-3-fails') throw new Error(`the failed relaunch must fence: ${JSON.stringify([failed, now().fence])}`);
  await world.call('resolve', { ...bind(now(), 'resolve-relaunch'), uncertain_command_id: 'relaunch-3-fails', fence_generation: now().fence!.fence_generation, disposition: 'keep' }, a.worker_id);
  const last = await world.call('relaunch', bind(now(), 'relaunch-4'), a.worker_id);
  if (last.state !== 'delivered') throw new Error(`the last relaunch must be delivered: ${JSON.stringify(last)}`);
  // Restart in-process: no host is adopted; the relaunched worker becomes cleanup_pending on its newest domain.
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
