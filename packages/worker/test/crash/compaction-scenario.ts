/**
 * The compaction crash scenario (P1-12): a supervisor under tight retention (`world.json`: 12 receipts, a 256 KiB
 * journal, no minimum age) runs enough commands that count- and byte-triggered compactions evict delivered receipts
 * while a fenced `outcome_unknown`, a resolved one, an uncertain stop no fence names, quota-exempt controls and an
 * untyped child with no report stay
 * where retention must keep them. A reuse of an evicted command id is refused `receipt_expired`. Then a restart.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../../src/b2/errors.js';
import type { Worker } from '../../src/supervisor/state.js';
import { bind, tick } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld, type World, type WorldLimits } from './world.js';

export const COMPACTION_LIMITS: WorldLimits = { journalBytes: 256 * 1024, controlReserveBytes: 8 * 1024, receipts: 12, minAgeMs: 0, expiredIds: 256 };

async function settle(world: World, host: number): Promise<void> {
  world.hosts[host]!.emit('event', { type: 'agent_settled' });
  await tick();
  await tick();
}

export async function compactionScenario(root: string): Promise<void> {
  writeFileSync(join(root, 'world.json'), JSON.stringify(COMPACTION_LIMITS));
  let world = openWorld(root, true);
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const run = async (w: Worker, host: number, cmd: string) => {
    const r = await world.call('prompt', { ...bind(world.supervisor.get(w.worker_id), cmd), message: cmd }, w.worker_id);
    await settle(world, host);
    return r;
  };
  for (let i = 0; i < 8; i++) {
    await run(a, 0, `a-${i}`);
    if (i % 4 === 3) await world.call('interrupt', bind(world.supervisor.get(a.worker_id), `a-interrupt-${i}`), a.worker_id);
  }
  // An unresolved outcome_unknown fences b: retention never evicts it.
  const b: Worker = (await createIn(world, 'worker-b')).worker!;
  world.hosts[1]!.failure = true;
  assert.equal((await world.call('prompt', { ...bind(b, 'b-lost'), message: 'b-lost' }, b.worker_id)).state, 'outcome_unknown');
  // A resolved one may go once it is old enough.
  const c: Worker = (await createIn(world, 'worker-c')).worker!;
  world.hosts[2]!.failure = true;
  await world.call('prompt', { ...bind(c, 'c-lost'), message: 'c-lost' }, c.worker_id);
  await settle(world, 2);
  const fenced = world.supervisor.get(c.worker_id);
  await world.call('resolve', { ...bind(fenced, 'c-resolve'), uncertain_command_id: 'c-lost', fence_generation: fenced.fence!.fence_generation, disposition: 'keep' }, c.worker_id);
  // An uncertain stop (the process group was not observed gone) is an unresolved outcome_unknown that no fence, queue or
  // lineage names: only the unresolved-unknown rule keeps it through the compactions below (review F6).
  const d: Worker = (await createIn(world, 'worker-d')).worker!;
  world.hosts[3]!.stopOk = false;
  assert.equal((await world.call('stop', bind(d, 'd-stop'), d.worker_id)).state, 'outcome_unknown');
  // An untyped child launched under a's running execution never reports: its launch receipt is the parent's pending
  // decision after a restart (invariant 4a), so it is never evicted.
  await world.call('prompt', { ...bind(world.supervisor.get(a.worker_id), 'a-parent'), message: 'a-parent' }, a.worker_id);
  const running = world.supervisor.get(a.worker_id);
  mkdirSync(join(root, 'child'), { recursive: true });
  await world.call('launch_child', { ...bind(running, 'a-launch'), execution_id: running.execution!.execution_id, launch: { command_id: 'a-child', cwd: join(root, 'child'), provider: 'p', model: 'm', thinking: 'off' } }, a.worker_id);
  await settle(world, 0);
  for (let i = 0; i < 4; i++) await tick();
  for (let i = 8; i < 16; i++) await run(a, 0, `a-${i}`);
  await world.call('stop', bind(world.supervisor.get(b.worker_id), 'b-stop'), b.worker_id);
  // By now the first prompts are evicted: their ids are refused, never run again.
  assert.ok(world.supervisor.receipts.expired.has('a-0'), 'the oldest delivered receipt was evicted');
  await assert.rejects(
    world.call('prompt', { ...bind(a, 'a-0'), message: 'a-0' }, a.worker_id),
    (e: unknown) => e instanceof Refusal && e.message === 'receipt_expired' && e.effect === 'unknown',
  );
  assert.ok(world.supervisor.receipts.all.has('b-lost'), 'an unresolved outcome_unknown is never evicted');
  assert.equal(world.supervisor.receipts.all.get('d-stop')?.state, 'outcome_unknown', 'an unresolved outcome_unknown no fence names is never evicted');
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
