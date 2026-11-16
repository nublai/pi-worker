/**
 * The create-with-resume crash scenario (P1 fix rounds 2 and 3): worker A archives its first session with a B2 `new`
 * move, then worker R is created resuming that archived session. A archives its second session, and worker C is
 * created resuming it while pi cancels the switch after running its hooks (the open is a native effect), so C's
 * create ends `outcome_unknown` and fences the target; the owner then resolves it `abandon`. Then an in-process
 * restart. The cuts in resume.test.ts land on R's and C's durable records (the starting row that carries the resume
 * target, the dispatch record, the process identity, pi's temporary session identity, C's failure row with its fence,
 * C's unknown receipt and its resolution) and on each native open before its binding is recorded.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld } from './world.js';

export const RESUMER = 'resume-r';
/** The create-with-resume whose open pi cancels after its switch hooks ran (world provider `cancel-open`). */
export const CANCELLED = 'resume-c';

export async function resumeScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a = (await createIn(world, 'worker-a')).worker!;
  await world.call('rebind', { ...bind(a, 'archive'), action: 'new' }, a.worker_id);
  const cwd = join(root, RESUMER);
  mkdirSync(cwd, { recursive: true });
  await world.call('create', { command_id: RESUMER, cwd, provider: 'fixture', model: 'fixture', thinking: 'off', resume_session_id: a.session_id });
  const a2 = world.supervisor.get(a.worker_id);
  await world.call('rebind', { ...bind(a2, 'archive-2'), action: 'new' }, a.worker_id);
  const cancelledCwd = join(root, CANCELLED);
  mkdirSync(cancelledCwd, { recursive: true });
  const cancelled = await world.call('create', { command_id: CANCELLED, cwd: cancelledCwd, provider: 'cancel-open', model: 'fixture', thinking: 'off', resume_session_id: a2.session_id });
  if (cancelled.state !== 'outcome_unknown') throw new Error(`the cancelled resume must be outcome_unknown: ${JSON.stringify(cancelled)}`);
  const c = world.supervisor.get(cancelled.worker_id!);
  await world.call('resolve', { ...bind(c, 'resolve-c'), uncertain_command_id: CANCELLED, fence_generation: c.fence!.fence_generation, disposition: 'abandon' }, c.worker_id);
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
