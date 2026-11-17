/**
 * The containment crash scenario (P2-4), ported from A0 `src/test/fixtures/containment-cut.ts` onto the shared crash
 * world. `containment-seed`: a typed parent is created in its domain, then a prompt dies right after its intent fsync
 * (the process SIGKILLed before any dispatch). `containment`, on that root: recovery cleans the parent's domain and
 * recovers the prompt `intent_recovered`; the owner keeps it, the worker is relaunched (history only, no prompt), the
 * exact kept prompt dispatches once, a bwrap-declared typed child is launched under it (lineage and confinement in the
 * child's starting row before its spawn), the child writes a result report to its FD 3, the child and the parent are
 * stopped, then an in-process restart recovers.
 *
 * Native artifacts besides the world's: `kills.jsonl`, each domain kill with the status of the latest durable row
 * naming that domain at the moment of the kill (A0 asserted it inside `clean`, where a thrown assertion is swallowed).
 * The worktrees live beside the state (`<root>-trees`): a sandbox root never overlaps the supervisor's state.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import { requestHash } from '../../src/receipts/receipts.js';
import type { Create, Persisted, Prompt } from '../../src/supervisor/state.js';
import { bind, tick } from '../supervisor-fixture.js';
import { effect, openWorld, type World } from './world.js';

/** The worktrees of a containment scenario root: beside the state directory, never inside it. */
export const treesOf = (root: string) => `${root}-trees`;

const SPEC: NonNullable<Create['launch_spec']> = {
  environment: { id: 'fixture', revision: 1, allowed_methods: ['children.report'] },
  role: 'parent',
  tools: [],
  denied_tools: [],
  resources: { extensions: [], skills: [] },
  grant_methods: ['children.report'],
  seed_mode: 'standalone',
};

/** Records every domain kill with the status of the latest durable row naming that domain. */
function recordKills(world: World): void {
  const clean = world.domains.clean.bind(world.domains);
  world.domains.clean = async domain => {
    const rows = parseJournal(readFileSync(journalPath(world.root)))
      .records.filter(r => r.kind === 'worker')
      // SAFETY: `worker` records are Persisted values written by SupervisorState.persist.
      .map(r => r.value as unknown as Persisted);
    const latest = rows.filter(p => p.domain?.name === domain.name).at(-1);
    appendFileSync(join(world.root, 'kills.jsonl'), `${JSON.stringify({ domain: domain.name, status: latest?.worker.status ?? null })}\n`);
    return clean(domain);
  };
}

export async function containmentSeed(root: string): Promise<void> {
  const world = openWorld(root, true);
  recordKills(world);
  const cwd = join(treesOf(root), 'worktree');
  mkdirSync(cwd, { recursive: true });
  const c = await world.call('create', { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off', launch_spec: { ...SPEC, environment: { ...SPEC.environment, root: treesOf(root) } } });
  assert.equal(c.state, 'delivered');
  const w = world.supervisor.get(c.worker_id!);
  const p: Prompt = { ...bind(w, 'work'), message: 'work' };
  writeFileSync(join(root, 'request.json'), JSON.stringify({ id: w.worker_id, p }));
  // The prompt's intent fsync (the create's was the first): the seed dies before any dispatch or execution.
  process.env.PIW_CRASH_AT ||= 'receipt.intent@2';
  await world.call('prompt', p as unknown as Record<string, unknown>, w.worker_id);
  assert.fail('the seed must die at the prompt intent');
}

export async function containmentScenario(root: string): Promise<void> {
  // The seed's hosts died with its process: its domains are proven gone, as a removed cgroup would prove.
  let world = openWorld(root, true, { confirmUnknown: true });
  recordKills(world);
  await world.supervisor.recover();
  const { id, p } = JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')) as { id: string; p: Prompt };
  const s = world.supervisor;
  assert.equal(s.get(id).cleanup, 'cgroup_empty_removed');
  assert.equal(s.receipts.all.get('work')?.state, 'intent_recovered');
  assert.equal(requestHash({ ...p, worker_id: id, operation: 'sessions.prompt' }), s.receipts.all.get('work')?.request_hash);
  const keep = await world.call('resolve', { ...bind(s.get(id), 'keep'), uncertain_command_id: 'work', fence_generation: 0, disposition: 'keep' }, id);
  assert.equal(keep.state, 'delivered');
  const relaunched = await world.call('relaunch', bind(s.get(id), 'relaunch'), id);
  assert.equal(relaunched.state, 'delivered', JSON.stringify(relaunched));
  assert.notEqual(s.get(id).worker_epoch, p.worker_epoch);
  assert.equal(world.hosts.at(-1)!.prompts, 0, 'a relaunch opens history; it never prompts');
  // The exact kept prompt dispatches once on the relaunched epoch; its duplicate returns the same receipt.
  const first = await world.call('prompt', p as unknown as Record<string, unknown>, id);
  assert.equal(first.state, 'delivered', JSON.stringify(first));
  assert.deepEqual(await world.call('prompt', p as unknown as Record<string, unknown>, id), first);
  // A bwrap-declared typed child under the running execution.
  const parent = s.get(id);
  const childCwd = join(treesOf(root), 'child-worktree');
  mkdirSync(childCwd, { recursive: true });
  const child: Create = {
    command_id: 'sandbox-child',
    cwd: childCwd,
    provider: 'p',
    model: 'm',
    thinking: 'off',
    parent: { worker_id: id, worker_epoch: parent.worker_epoch, session_id: parent.session_id!, binding_revision: parent.binding_revision, execution_id: parent.execution!.execution_id, task_id: 'sandbox-task', generation_id: 'fixture' },
    launch_spec: { ...SPEC, role: 'child', environment: { ...SPEC.environment, filesystem: 'bwrap', root: childCwd } },
  };
  const created = await world.call('create', child as unknown as Record<string, unknown>);
  assert.equal(created.state, 'delivered', JSON.stringify(created));
  const childId = created.worker_id!;
  world.hosts.find(h => h.file === s.state.require(id).sessionFile)!.emit('event', { type: 'agent_settled' });
  // The child's claim on its FD 3: the native write first, then the report.
  const native_file = join(root, 'native-controls.jsonl');
  appendFileSync(native_file, `${JSON.stringify({ command_id: 'claim:report', operation: 'report_fd' })}\n`);
  effect(root, { kind: 'report_fd', command_id: 'claim:report', operation: 'report_fd', native_file });
  world.hosts.find(h => h.file === s.state.require(childId).sessionFile)!.emit('report', { report_id: 'report', kind: 'result', message: 'unverified fixture report' });
  await tick();
  await tick();
  assert.equal((await world.call('stop', bind(s.get(childId), 'stop-child'), childId)).state, 'delivered');
  assert.equal((await world.call('stop', bind(s.get(id), 'stop'), id)).state, 'delivered');
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
