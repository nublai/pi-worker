/**
 * The lifecycle crash scenario (P1-4): creates, a failed launch, a pi exit, a stop, a worker fault, then an in-process
 * restart that recovers every holding worker to cleanup_pending.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWorld, type World } from './world.js';
import { bind } from '../supervisor-fixture.js';

export async function createIn(world: World, name: string, provider = 'fixture') {
  const cwd = join(world.root, name);
  mkdirSync(cwd, { recursive: true });
  const r = await world.call('create', { command_id: name, cwd, provider, model: 'fixture', thinking: 'off' });
  return { receipt: r, worker: r.worker_id ? world.supervisor.get(r.worker_id) : undefined };
}

export async function lifecycleScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a = (await createIn(world, 'worker-a')).worker!;
  await createIn(world, 'worker-fail', 'fail');
  const b = (await createIn(world, 'worker-b')).worker!;
  world.hosts.at(-1)!.emit('exit');
  await world.call('stop', bind(a, 'stop-a'), a.worker_id);
  const c = (await createIn(world, 'worker-c')).worker!;
  const host = world.hosts.at(-1)!;
  // pi reporting another identity outside a binding change faults only this worker.
  host.emit('event', { type: 'host_identity', sessionId: 'another-session', sessionFile: join(root, 'another.jsonl'), leafId: null });
  await new Promise(r => setImmediate(r));
  void b;
  void c;
  // Restart in-process: no host is adopted; holding workers become cleanup_pending.
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
