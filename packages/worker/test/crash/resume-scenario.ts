/**
 * The create-with-resume crash scenario (P1 fix round 2): worker A archives its first session with a B2 `new` move,
 * then worker R is created resuming that archived session, then an in-process restart. The cuts in resume.test.ts
 * land on R's durable records (the starting row that carries the resume target, the dispatch record, the process
 * identity, pi's temporary session identity) and on R's native open of the target before its binding is recorded.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld } from './world.js';

export const RESUMER = 'resume-r';

export async function resumeScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a = (await createIn(world, 'worker-a')).worker!;
  await world.call('rebind', { ...bind(a, 'archive'), action: 'new' }, a.worker_id);
  const cwd = join(root, RESUMER);
  mkdirSync(cwd, { recursive: true });
  await world.call('create', { command_id: RESUMER, cwd, provider: 'fixture', model: 'fixture', thinking: 'off', resume_session_id: a.session_id });
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
