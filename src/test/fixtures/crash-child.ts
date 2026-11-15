/** THROWAWAY crash harness child: real fsync/SIGKILL, deterministic native-host seam, not live Pi. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from '../../journal.js';
import { Supervisor } from '../../supervisor.js';
import { Host, bind, tick } from '../helpers.js';
import type { PiRecord, PiResponse } from '../../host.js';
import type { Binding, Create, Prompt, Rebind, Resolve, Worker } from '../../types.js';
const [mode, root] = process.argv.slice(2) as [string, string];
assert.ok(root.startsWith('/tmp/a0s2/'));
mkdirSync(root, { recursive: true, mode: 0o700 });
const effects = join(root, 'effects.jsonl'), requests = join(root, 'requests.jsonl');
class EffectHost extends Host {
  gate?: Promise<never>; release?: () => void;
  hold(): void { this.gate = new Promise<never>((_r, reject) => { this.release = () => reject(new Error('dropped_reply')); }); }
  override async request(c: PiRecord): Promise<PiResponse> {
    if (c.type === 'prompt') {
      appendFileSync(effects, JSON.stringify({ kind: 'prompt', id: c.message }) + '\n');
      appendFileSync(this.file, JSON.stringify({ type: 'message', id: String(c.message), parentId: null, message: { role: 'user', content: [] } }) + '\n');
    }
    const result = await super.request(c);
    if (c.type === 'prompt' && this.gate) { const gate = this.gate; this.gate = undefined; await gate; }
    return result;
  }
}
const journal = new Journal(join(root, 'journal'));
const hosts: EffectHost[] = [];
const supervisor = new Supervisor(root, journal, '1.5.2', (c) => {
  assert.equal(mode, 'scenario', 'recovery must never launch/adopt a host');
  const id = `native-${hosts.length}`, file = join(root, id + '.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session', id }) + '\n');
  appendFileSync(effects, JSON.stringify({ kind: 'launch', id: c.cwd }) + '\n');
  const host = new EffectHost(root, id, file); hosts.push(host); return host;
});
type Logged = { op: string; id?: string; body: Record<string, unknown> };
async function call(op: string, body: Record<string, unknown>, id?: string) {
  if (mode === 'scenario') appendFileSync(requests, JSON.stringify({ op, body, id }) + '\n');
  switch (op) {
    case 'create': return supervisor.create(body as Create);
    case 'prompt': return supervisor.prompt(id!, body as Prompt);
    case 'rebind': return supervisor.rebind(id!, body as Rebind);
    case 'resolve': return supervisor.resolveUnknown(id!, body as Resolve);
    case 'stop': return supervisor.stop(id!, body as Binding);
    default: throw new Error('unsupported crash fixture op');
  }
}
const create = async (name: string): Promise<Worker> => {
  const cwd = join(root, name); mkdirSync(cwd, { recursive: true });
  const receipt = await call('create', { command_id: name, cwd, provider: 'fixture', model: 'fixture', thinking: 'off' });
  assert.equal(receipt.state, 'delivered'); return supervisor.get(receipt.worker_id!);
};
if (mode === 'scenario') {
  const a = await create('worker-a'), id = a.worker_id;
  await call('prompt', { ...bind(a, 'first'), message: 'first' }, id); hosts[0]!.emit('event', { type: 'agent_settled' });
  await call('rebind', { ...bind(supervisor.get(id), 'new'), action: 'new' }, id);
  await call('rebind', { ...bind(supervisor.get(id), 'resume'), action: 'resume', target_session_id: a.session_id }, id);
  await call('rebind', { ...bind(supervisor.get(id), 'fork'), action: 'fork', source_leaf_id: supervisor.get(id).leaf_id, entry_id: 'first' }, id);
  await call('prompt', { ...bind(supervisor.get(id), 'observed'), message: 'observed' }, id);
  hosts[0]!.emit('exit');
  await call('resolve', { ...bind(supervisor.get(id), 'resolve-observed'), uncertain_command_id: 'observed', fence_generation: supervisor.get(id).fence!.fence_generation, disposition: 'observed' }, id);
  await call('stop', bind(supervisor.get(id), 'stop-a'), id);
  for (const disposition of ['keep', 'abandon'] as const) {
    const w = await create('worker-' + disposition), h = hosts.at(-1)!; h.hold();
    const pending = call('prompt', { ...bind(w, disposition + '-run'), message: disposition + '-run' }, w.worker_id); await tick();
    const execution_id = supervisor.get(w.worker_id).execution!.execution_id;
    await supervisor.followUp(w.worker_id, { ...bind(w, disposition + '-follow'), execution_id, message: disposition + '-follow' });
    const childCwd = join(root, 'child-' + disposition); mkdirSync(childCwd);
    await supervisor.launchChild(w.worker_id, { ...bind(w, disposition + '-child'), execution_id, launch: { command_id: disposition + '-launch', cwd: childCwd, provider: 'p', model: 'm', thinking: 'off' } });
    h.release!(); await pending; h.emit('event', { type: 'agent_settled' });
    const f = supervisor.get(w.worker_id).fence!;
    await call('resolve', { ...bind(w, disposition + '-resolve'), uncertain_command_id: disposition + '-run', fence_generation: f.fence_generation, disposition }, w.worker_id);
    await tick(); await tick(); h.emit('event', { type: 'agent_settled' }); await tick(); await tick();
    await supervisor.control(w.worker_id, bind(w, disposition + '-cancel'), false);
    await supervisor.control(w.worker_id, bind(w, disposition + '-interrupt'), true);
    await supervisor.report(w.worker_id, { ...bind(w, disposition + '-report'), task_id: 'task', result_digest: 'sha256:fixture' });
    await call('stop', bind(w, disposition + '-stop'), w.worker_id);
  }
  const grant = supervisor.grants.register('crash-fixture', { worker_ids: [], cwd_roots: [] }, ['hello'], 'fixture');
  assert.ok(grant.endsWith('/fixture.json')); supervisor.grants.revoke('fixture');
  journal.close(); process.stdout.write(JSON.stringify({ done: true }) + '\n');
} else {
  await supervisor.recover();
  if (existsSync(requests)) for (const line of readFileSync(requests, 'utf8').trim().split('\n')) {
    const request = JSON.parse(line) as Logged;
    const prior = supervisor.receipts.all.get(String(request.body.command_id));
    if (!prior || prior.state === 'intent_ready') continue; // no automatic dispatch after owner consent either
    const retry = await call(request.op, request.body, request.id);
    assert.deepEqual(retry, prior, 'duplicate lookup must not change a receipt or replay');
  }
  process.stdout.write(JSON.stringify({ receipts: [...supervisor.receipts.all.values()].map(r => ({ command_id: r.command_id, state: r.state, effect: r.effect })), workers: supervisor.list().map(w => ({ worker_id: w.worker_id, execution: w.execution, fence: w.fence, status: w.status, resolutions: w.resolutions ?? [] })) }) + '\n');
  journal.close();
}
