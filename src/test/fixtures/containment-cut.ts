/** Deterministic lifecycle effect seam. Not real cgroup/real Pi evidence. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, parseJournal } from '../../journal.js';
import { Supervisor } from '../../supervisor.js';
import { requestHash } from '../../receipts.js';
import type { Containment, CleanupUnit } from '../../containment.js';
import type { Prompt } from '../../types.js';
import type { PiRecord } from '../../host.js';
import { Host, bind, tick } from '../helpers.js';
const [mode, root] = process.argv.slice(2) as [string, string];
mkdirSync(root, { recursive: true });
const effects = join(root, 'effects'), journalPath = join(root, 'journal'); let ordinal = 0;
const records = () => parseJournal(readFileSync(journalPath)).records;
function effect(data: Record<string, unknown>) {
  appendFileSync(effects, JSON.stringify({ ...data, seq: records().length }) + '\n');
  if (process.env.A0_CRASH_EFFECT === String(++ordinal)) process.kill(process.pid, 'SIGKILL');
}
let explicitCommand = 'recovery';
const jail: Containment = {
  profile: 'test_cgroup', reserve: epoch => ({ root, name: 'w-' + epoch, boot: 'test' }), spawn: () => { throw new Error('factory seam'); },
  clean: async unit => {
    const last = records().filter(r => r.kind === 'worker' && (r.value.unit as CleanupUnit)?.name === unit.name).at(-1)!;
    assert.equal((last.value.worker as { status: string }).status, 'cleanup_pending', 'pending must be durable BEFORE native kill');
    rmSync(join(root, unit.name), { force: true });
    if (mode !== 'recover') effect({ kind: 'kill', unit, command_id: explicitCommand });
    return true;
  },
};
const journal = new Journal(journalPath); let host: Host;
const supervisor = new Supervisor(join(root, 'state'), journal, 'test', (c, dir, context) => {
  assert.notEqual(mode, 'recover', 'recovery never spawns');
  assert.ok(context?.unit);
  const reserved = records().findLast(r => r.kind === 'worker' && (r.value.unit as CleanupUnit)?.name === context.unit!.name);
  assert.ok(reserved, 'spawn requires durable domain reservation');
  assert.equal(existsSync(join(root, context.unit.name)), false);
  writeFileSync(join(root, context.unit.name), 'populated');
  const sid = 'native-' + context.unit.name, file = join(dir, sid + '.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
  effect({ kind: 'spawn', unit: context.unit, command_id: c.command_id === 'sandbox-child' ? 'sandbox-child' : mode === 'seed' ? 'create' : 'relaunch', ...(context.parent ? { parent: context.parent } : {}) });
  host = new Host(dir, sid, file);
  const request = host.request.bind(host);
  host.request = async (c: PiRecord) => {
    const response = await request(c);
    if (c.type === 'switch_session') effect({ kind: 'switch', command_id: 'relaunch' });
    if (c.type === 'prompt') {
      appendFileSync(join(root, 'native-input'), 'ONCE\n');
      effect({ kind: 'prompt', command_id: 'work' });
    }
    return response;
  };
  return host;
}, jail);
if (mode === 'seed') {
  const cwd = join(root, 'worktree'); mkdirSync(cwd);
  const c = await supervisor.create({ command_id: 'create', cwd, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', launch_spec: { environment: { id: 'fixture', revision: 1, allowed_methods: ['children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' } }); assert.equal(c.state, 'delivered');
  const w = supervisor.get(c.worker_id!);
  const p = { ...bind(w, 'work'), message: 'work' };
  writeFileSync(join(root, 'request'), JSON.stringify({ id: w.worker_id, p }));
  // Actual reserved intent fsync; the seed dies before dispatch or an execution.
  process.env.A0_CRASH_AT = 'receipt.sessions.prompt.intent';
  await supervisor.prompt(w.worker_id, p); assert.fail('seed must crash');
} else if (mode === 'scenario') {
  await supervisor.recover();
  const { id, p } = JSON.parse(readFileSync(join(root, 'request'), 'utf8')) as { id: string; p: Prompt };
  assert.equal(supervisor.get(id).cleanup, 'cgroup_empty_removed');
  assert.equal(supervisor.receipts.all.get('work')?.state, 'intent_recovered');
  assert.equal(requestHash({ ...p, worker_id: id, operation: 'sessions.prompt' }), supervisor.receipts.all.get('work')?.request_hash);
  const resolve = { ...bind(supervisor.get(id), 'keep'), uncertain_command_id: 'work', fence_generation: 0, disposition: 'keep' as const };
  assert.equal((await supervisor.resolveUnknown(id, resolve)).state, 'delivered');
  const r = await supervisor.relaunch(id, bind(supervisor.get(id), 'relaunch')); assert.equal(r.state, 'delivered');
  assert.notEqual(supervisor.get(id).worker_epoch, p.worker_epoch);
  assert.equal(existsSync(join(root, 'native-input')), false, 'relaunch opens history; it never prompts');
  const first = await supervisor.prompt(id, p); assert.equal(first.state, 'delivered');
  assert.deepEqual(await supervisor.prompt(id, p), first);
  assert.equal(readFileSync(join(root, 'native-input'), 'utf8'), 'ONCE\n');
  host!.emit('event', { type: 'agent_settled' });
  const parent = supervisor.get(id), childCwd = join(root, 'child-worktree'); mkdirSync(childCwd);
  const childReceipt = await supervisor.create({ ...supervisor.require(id).create!, command_id: 'sandbox-child', cwd: childCwd, parent: { worker_id: id, worker_epoch: parent.worker_epoch, session_id: parent.session_id!, binding_revision: parent.binding_revision, execution_id: parent.execution!.execution_id, task_id: 'sandbox-task', generation_id: 'fixture' }, launch_spec: { ...parent.launch_spec!, role: 'child', environment: { ...parent.launch_spec!.environment, filesystem: 'bwrap', root: childCwd } } });
  assert.equal(childReceipt.state, 'delivered');
  host!.emit('report', { report_id: 'report', kind: 'result', message: 'unverified fixture report' }); await tick();
  effect({ kind: 'report', command_id: `fd-${childReceipt.worker_id}-report` });
  explicitCommand = 'stop-child'; assert.equal((await supervisor.stop(childReceipt.worker_id!, bind(supervisor.get(childReceipt.worker_id!), 'stop-child'))).state, 'delivered');
  explicitCommand = 'stop'; assert.equal((await supervisor.stop(id, bind(supervisor.get(id), 'stop'))).state, 'delivered');
  console.log(JSON.stringify({ effects: ordinal, done: true })); journal.close();
} else {
  const before = existsSync(effects) ? readFileSync(effects, 'utf8') : '';
  await supervisor.recover();
  assert.equal(existsSync(effects) ? readFileSync(effects, 'utf8') : '', before);
  const result = { workers: supervisor.list(), receipts: [...supervisor.receipts.all.values()] };
  console.log(JSON.stringify(result)); journal.close();
}
