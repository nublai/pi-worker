/**
 * The children crash scenario (P1-11), ported from A0 `src/test/fixtures/children-cut.ts`: a typed parent created
 * under a grant runs a prompt, launches a typed child (lineage in the child's starting row), the child runs, writes a
 * result report to its FD twice (one claim, one receipt, one notification), and is stopped. An untyped child is then
 * launched through `children.launch` under a second parent's running execution and flushed when it settles. A third
 * (typed) parent's child then dies without a report: the live parent is fenced on its launch and a replacement is
 * refused before any spawn (invariant 4a, live; A0 W-4).
 * Native effects: each spawn (with the lineage its request named), the FD write (`claim:`), the report's delivery
 * notification (after its receipt is durable) and the stop.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { authority } from '../../src/grants/authority.js';
import type { Create, Worker } from '../../src/supervisor/state.js';
import { bind, tick } from '../supervisor-fixture.js';
import { effect, openWorld } from './world.js';

export async function childrenScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const grants = world.supervisor.state.grants!;
  const { grant } = grants.register({ caller: 'orchestrator', scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods: ['workers.create', 'children.report', 'sessions.prompt'], grant_id: 'orchestrator' });
  const guard = Object.assign(
    () => {
      if (grants.read('orchestrator').revoked) throw new Error('grant_revoked');
    },
    { grant_id: grant.grant_id, caller_name: grant.caller, methods: grant.methods },
  );
  const spec: NonNullable<Create['launch_spec']> = { environment: { id: root, revision: 1, allowed_methods: ['children.report'] }, role: 'test', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
  const dir = (name: string) => {
    const cwd = join(root, name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  };
  const created = await authority.run(guard, () => world.call('create', { command_id: 'parent', cwd: dir('parent'), provider: 'p', model: 'm', thinking: 'off', launch_spec: spec }));
  const parent: Worker = world.supervisor.get(created.worker_id!);
  await world.call('prompt', { ...bind(parent, 'parent-prompt'), message: 'parent-prompt' }, parent.worker_id);
  const running = world.supervisor.get(parent.worker_id);
  const request: Create = {
    command_id: 'child-create',
    cwd: dir('child'),
    provider: 'p',
    model: 'm',
    thinking: 'off',
    launch_spec: spec,
    parent: { worker_id: parent.worker_id, worker_epoch: parent.worker_epoch, session_id: parent.session_id!, binding_revision: parent.binding_revision, execution_id: running.execution!.execution_id, task_id: 'job', generation_id: 'generation' },
  };
  const c = await authority.run(guard, () => world.call('create', request as unknown as Record<string, unknown>));
  const child: Worker = world.supervisor.get(c.worker_id!);
  world.hosts[0]!.emit('event', { type: 'agent_settled' });
  await world.call('prompt', { ...bind(child, 'child-prompt'), message: 'child-prompt' }, child.worker_id);
  world.hosts[1]!.emit('event', { type: 'agent_settled' });
  const sub = world.supervisor.subscribe(frame => {
    if (frame.type !== 'child.reported') return;
    const native_file = join(root, 'native-controls.jsonl');
    appendFileSync(native_file, `${JSON.stringify({ command_id: frame.data.report_command_id, operation: 'report_delivery' })}\n`);
    effect(root, { kind: 'report_delivery', command_id: frame.data.report_command_id, operation: 'report_delivery', native_file });
  });
  const report = { report_id: 'claim', kind: 'result', message: 'claimed complete' };
  const native_file = join(root, 'native-controls.jsonl');
  appendFileSync(native_file, `${JSON.stringify({ command_id: 'claim:claim', operation: 'report_fd' })}\n`);
  effect(root, { kind: 'report_fd', command_id: 'claim:claim', operation: 'report_fd', native_file });
  world.hosts[1]!.emit('report', report);
  await tick();
  await tick();
  world.hosts[1]!.emit('report', report);
  await tick();
  await tick();
  sub.close();
  await world.call('stop', bind(world.supervisor.get(child.worker_id), 'stop-child'), child.worker_id);
  // An untyped child under a root parent's running execution: queued, then launched when the parent settles.
  const root2 = await world.call('create', { command_id: 'parent-2', cwd: dir('parent-2'), provider: 'p', model: 'm', thinking: 'off' });
  const p2: Worker = world.supervisor.get(root2.worker_id!);
  await world.call('prompt', { ...bind(p2, 'p2-prompt'), message: 'p2-prompt' }, p2.worker_id);
  const executionId = world.supervisor.get(p2.worker_id).execution!.execution_id;
  await world.call('launch_child', { ...bind(p2, 'p2-launch'), execution_id: executionId, launch: { command_id: 'p2-child', cwd: dir('p2-child'), provider: 'p', model: 'm', thinking: 'off' } }, p2.worker_id);
  world.hosts.at(-1)!.emit('event', { type: 'agent_settled' });
  for (let i = 0; i < 4; i++) await tick();
  // A typed child that dies without a report: its live parent is fenced on that launch at once (invariant 4a, not
  // only after a restart), so a replacement is refused before anything spawns.
  const created3 = await authority.run(guard, () => world.call('create', { command_id: 'parent-3', cwd: dir('parent-3'), provider: 'p', model: 'm', thinking: 'off', launch_spec: spec }));
  const p3: Worker = world.supervisor.get(created3.worker_id!);
  await world.call('prompt', { ...bind(p3, 'p3-prompt'), message: 'p3-prompt' }, p3.worker_id);
  const lost: Create = {
    ...request,
    command_id: 'p3-child',
    cwd: dir('p3-child'),
    parent: { worker_id: p3.worker_id, worker_epoch: p3.worker_epoch, session_id: p3.session_id!, binding_revision: p3.binding_revision, execution_id: world.supervisor.get(p3.worker_id).execution!.execution_id, task_id: 'job-3', generation_id: 'generation' },
  };
  const c3 = await authority.run(guard, () => world.call('create', lost as unknown as Record<string, unknown>));
  world.hosts.find(h => h.file === world.supervisor.state.require(c3.worker_id!).sessionFile)!.emit('exit');
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(world.supervisor.get(p3.worker_id).fence?.uncertain_command_ids, ['p3-child'], 'the live parent is fenced on the dead child launch');
  const spawned = world.hosts.length;
  await assert.rejects(
    authority.run(guard, () => world.call('create', { ...lost, command_id: 'p3-replacement', cwd: dir('p3-replacement') } as unknown as Record<string, unknown>)),
    /fenced/,
  );
  assert.equal(world.hosts.length, spawned, 'no replacement spawned');
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
