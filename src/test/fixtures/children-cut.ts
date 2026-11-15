/** A0 slice 4: separate native effect and report delivery oracles. */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Supervisor } from '../../supervisor.js';
import { Journal } from '../../journal.js';
import { Host, bind, tick } from '../helpers.js';
import type { Create } from '../../types.js';
const [mode, root] = process.argv.slice(2) as [string, string];
mkdirSync(root, { recursive: true, mode: 0o700 });
let effectCount = 0;
const effect = (data: Record<string, unknown>) => { appendFileSync(join(root, 'effects'), JSON.stringify(data) + '\n'); if (process.env.A0_CRASH_EFFECT === String(++effectCount)) process.kill(process.pid, 'SIGKILL'); };
const journal = new Journal(join(root, 'journal'));
const hosts: Host[] = [];
const s = new Supervisor(root, journal, '1.5.2', c => {
  assert.equal(mode, 'scenario', 'recovery must not spawn');
  const file = join(root, `native-${hosts.length}.jsonl`), id = `sid-${hosts.length}`;
  writeFileSync(file, JSON.stringify({ type: 'session', id }) + '\n');
  effect({ kind: 'spawn', command_id: c.command_id, file, session_id: id, parent: c.parent });
  const host = new class extends Host {
    override async stop(): Promise<boolean> {
      const gone = await super.stop();
      effect({ kind: 'stop', command_id: 'stop-child', session_id: this.sid });
      return gone;
    }
  }(root, id, file); hosts.push(host); return host;
});
if (mode === 'scenario') {
  const spec: NonNullable<Create['launch_spec']> = { environment: { id: root, revision: 1, allowed_methods: ['children.report'] }, role: 'test', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
  const source = s.grants.register('orchestrator', { worker_ids: ['*'], cwd_roots: ['*'] }, ['workers.create', 'children.report'], 'orchestrator');
  const grant = JSON.parse(readFileSync(source, 'utf8'));
  const cwd = join(root, 'parent'); mkdirSync(cwd);
  const p = await s.callerGrant.run(grant, () => s.create({ command_id: 'parent', cwd, provider: 'p', model: 'm', thinking: 'off', launch_spec: spec }));
  const parent = s.get(p.worker_id!);
  await s.prompt(parent.worker_id, { ...bind(parent, 'parent-prompt'), message: 'work' });
  hosts[0]!.emit('event', { type: 'agent_settled' });
  const work = join(root, 'child'); mkdirSync(work);
  const request: Create = { command_id: 'child-create', cwd: work, provider: 'p', model: 'm', thinking: 'off', launch_spec: spec, parent: { worker_id: parent.worker_id, worker_epoch: parent.worker_epoch, session_id: parent.session_id!, binding_revision: parent.binding_revision, execution_id: s.get(parent.worker_id).execution!.execution_id, task_id: 'job', generation_id: 'generation' } };
  writeFileSync(join(root, 'request'), JSON.stringify(request));
  const c = await s.callerGrant.run(grant, () => s.create(request));
  const child = s.get(c.worker_id!);
  await s.prompt(child.worker_id, { ...bind(child, 'child-prompt'), message: 'write' });
  hosts[1]!.emit('event', { type: 'agent_settled' });
  s.events.subscribe(() => s.list(), null, event => { if (event.type === 'child_report') effect({ kind: 'report_delivery', worker_id: child.worker_id }); });
  const report = { report_id: 'claim', kind: 'result', message: 'claimed complete' };
  appendFileSync(hosts[1]!.file, JSON.stringify({ type: 'message', id: 'assistant-final', message: { role: 'assistant', content: [{ type: 'text', text: 'claimed complete' }] } }) + '\n');
  effect({ kind: 'report_fd', worker_id: child.worker_id, report });
  hosts[1]!.emit('report', report); await tick(); await tick();
  hosts[1]!.emit('report', report); await tick(); await tick();
  await s.stop(child.worker_id, bind(child, 'stop-child'));
  journal.close();
} else {
  await s.recover();
  if (existsSync(join(root, 'request'))) {
    const request = JSON.parse(readFileSync(join(root, 'request'), 'utf8')) as Create;
    const receipt = s.receipts.all.get(request.command_id);
    if (receipt) assert.deepEqual(await s.create(request), receipt);
  }
  console.log(JSON.stringify({ workers: s.list(), receipts: [...s.receipts.all.values()] })); journal.close();
}
