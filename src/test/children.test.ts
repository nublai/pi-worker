import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, bind, tick } from './helpers.js';
import type { Create, Worker } from '../types.js';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';

test('late native exit cannot downgrade a confirmed stop', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.stop = async () => true; // OS probe wins before Node exit event.
    const receipt = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(receipt.state, 'delivered');
    f.hosts[0]!.emit('exit');
    assert.equal(f.supervisor.get(w.worker_id).status, 'stopped');
  } finally { f.cleanup(); }
});
function scopedGrant(f: ReturnType<typeof fixture>, id: string, methods = ['workers.create', 'children.report']) {
  return JSON.parse(readFileSync(f.supervisor.grants.register(id, { worker_ids: ['*'], cwd_roots: ['*'] }, methods, id), 'utf8'));
}
test('help-only durable report does not discharge the parent recovery fence', async () => {
  const f = fixture();
  let recoveredJournal: Journal | undefined;
  try {
    const p = await parent(f), c = child(f, p);
    const r = await f.supervisor.create(c), w = f.supervisor.get(r.worker_id!);
    f.hosts[1]!.emit('report', { report_id: 'help-only', kind: 'help', message: 'blocked' });
    await tick(); await tick();
    assert.equal(f.supervisor.get(w.worker_id).child_reports!.length, 1);
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    recoveredJournal = new Journal(join(f.dir, 'journal'));
    const recovered = new Supervisor(f.dir, recoveredJournal, '1.5.2', () => { throw new Error('no recovery spawn'); });
    await recovered.recover();
    assert.ok(recovered.get(p.worker_id).fence?.uncertain_command_ids?.includes(c.command_id), 'help is not completion');
  } finally { recoveredJournal?.close(); f.cleanup(); }
});
for (const restriction of ['caller', 'parent'] as const) test(`child methods respect distinct ${restriction} grant ceiling`, async () => {
  const f = fixture();
  try {
    const parentSpec = structuredClone(spec);
    if (restriction === 'parent') parentSpec.grant_methods = ['children.report'];
    const parentGrant = scopedGrant(f, 'parent-source');
    assert.notEqual(parentGrant.grant_id, 'owner');
    const p = await f.supervisor.callerGrant.run(parentGrant, () => parent(f, parentSpec));
    const c = child(f, p);
    // The environment permits both methods, so it cannot mask either tested ceiling.
    c.launch_spec!.grant_methods = restriction === 'caller' ? ['children.report'] : ['workers.create'];
    const caller = scopedGrant(f, 'child-caller', restriction === 'caller' ? ['workers.create'] : ['workers.create', 'children.report']);
    await assert.rejects(() => f.supervisor.callerGrant.run(caller, () => f.supervisor.create(c)), restriction === 'caller' ? /child_grant_not_subset/ : /child_authority_not_subset/);
    assert.equal(f.hosts.length, 1); assert.equal(f.supervisor.workers.size, 1);
  } finally { f.cleanup(); }
});
for (const revoked of ['parent-source', 'child-caller'] as const) test(`FD report rechecks distinct ${revoked} revocation`, async () => {
  const f = fixture();
  try {
    const pg = scopedGrant(f, 'parent-source'), cg = scopedGrant(f, 'child-caller');
    const p = await f.supervisor.callerGrant.run(pg, () => parent(f));
    const c = child(f, p), r = await f.supervisor.callerGrant.run(cg, () => f.supervisor.create(c));
    assert.notEqual(pg.grant_id, cg.grant_id);
    f.supervisor.grants.revoke(revoked);
    f.hosts[1]!.emit('report', { report_id: 'revoked', kind: 'result', message: 'must not arrive' });
    await tick(); await tick();
    assert.equal(f.supervisor.get(r.worker_id!).child_reports!.length, 0);
    assert.equal([...f.supervisor.receipts.all.values()].some(receipt => receipt.operation === 'children.report' && receipt.state === 'delivered'), false);
    assert.equal(f.hosts[0]!.stops, 0);
  } finally { f.cleanup(); }
});
test('child create rechecks revoked parent source even with an active independent caller', async () => {
  const f = fixture();
  try {
    const pg = scopedGrant(f, 'parent-source'), cg = scopedGrant(f, 'child-caller');
    const p = await f.supervisor.callerGrant.run(pg, () => parent(f)), c = child(f, p);
    f.supervisor.grants.revoke(pg.grant_id);
    await assert.rejects(() => f.supervisor.callerGrant.run(cg, () => f.supervisor.create(c)), /revoked/);
    assert.equal(f.hosts.length, 1);
  } finally { f.cleanup(); }
});
test('FD report requires children.report in the child grant', async () => {
  const f = fixture();
  try {
    const p = await parent(f), c = child(f, p); c.launch_spec!.grant_methods = [];
    const r = await f.supervisor.create(c);
    f.hosts[1]!.emit('report', { report_id: 'ungranted', kind: 'result', message: 'must not arrive' });
    await tick(); await tick();
    assert.equal(f.supervisor.get(r.worker_id!).child_reports!.length, 0);
  } finally { f.cleanup(); }
});
test('unknown child initialization fences the live parent before another launch', async () => {
  const f = fixture();
  try {
    const p = await parent(f), c = child(f, p);
    const original = f.supervisor.factory;
    // A native get_state timeout after spawn, not a refusal before dispatch.
    const createHost: typeof original = (...args) => {
      const host = original(...args);
      host.request = async () => { throw new Error('get_state timed out'); };
      return host;
    };
    Object.defineProperty(f.supervisor, 'factory', { value: createHost });
    const r = await f.supervisor.create(c);
    assert.equal(r.effect, 'unknown');
    assert.ok(f.supervisor.get(p.worker_id).fence?.uncertain_command_ids?.includes(c.command_id));
    const cwd = join(f.dir, 'replacement'); mkdirSync(cwd);
    await assert.rejects(() => f.supervisor.create({ ...c, cwd, command_id: 'replacement' }), /fenced/);
    assert.equal(f.hosts.length, 2);
  } finally { f.cleanup(); }
});
export const spec: NonNullable<Create['launch_spec']> = { environment: { id: 'test', revision: 1, allowed_methods: ['workers.create', 'children.report'] }, role: 'writer', tools: ['read', 'write', 'caller_ping'], denied_tools: ['bash'], resources: { extensions: [], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
async function parent(f: ReturnType<typeof fixture>, launch_spec = spec): Promise<Worker> {
  const cwd = join(f.dir, 'parent'); mkdirSync(cwd);
  const r = await f.supervisor.create({ command_id: 'parent', cwd, provider: 'p', model: 'm', thinking: 'off', launch_spec });
  const w = f.supervisor.get(r.worker_id!);
  await f.supervisor.prompt(w.worker_id, { ...bind(w, 'task'), message: 'fan out' });
  return f.supervisor.get(w.worker_id);
}
function child(f: ReturnType<typeof fixture>, p: Worker): Create {
  const cwd = join(f.dir, 'child'); mkdirSync(cwd);
  return { command_id: 'child', cwd, provider: 'p', model: 'm', thinking: 'off', parent: { worker_id: p.worker_id, worker_epoch: p.worker_epoch, session_id: p.session_id!, binding_revision: p.binding_revision, execution_id: p.execution!.execution_id, task_id: 'job', generation_id: 'generation' }, launch_spec: { ...structuredClone(spec), grant_methods: ['children.report'] } };
}
test('typed child lineage exists before spawn, narrows authority and reports a claim exactly once', async () => {
  const f = fixture();
  try {
    const p = await parent(f), c = child(f, p);
    await assert.rejects(() => f.supervisor.launchChild(p.worker_id, { ...bind(p, 'legacy-bypass'), execution_id: p.execution!.execution_id, launch: { ...c, parent: undefined, launch_spec: undefined } }), /typed_children_use_workers_create/);
    const created = await f.supervisor.create(c); const w = f.supervisor.get(created.worker_id!);
    assert.deepEqual(w.parent, c.parent); assert.equal(w.parent_launch_command_id, 'child');
    let reports = 0;
    const close = f.supervisor.events.subscribe(() => f.supervisor.list(), null, e => { if (e.type === 'child_report') reports++; }).close;
    const report = { report_id: 'first', kind: 'help', message: 'which file?' };
    f.hosts[1]!.emit('report', report);
    f.hosts[1]!.emit('report', report); await tick(); await tick();
    f.hosts[1]!.emit('report', report); await tick(); await tick();
    assert.equal(reports, 1); assert.equal(f.supervisor.get(w.worker_id).child_reports!.length, 1);
    assert.equal(f.supervisor.get(w.worker_id).child_reports![0]!.claim_not_verified, true);
    assert.equal(f.supervisor.get(p.worker_id).execution!.state, 'started');
    await assert.rejects(() => f.supervisor.report(w.worker_id, { ...bind(w, 'foreign-task'), task_id: 'other', result_digest: 'not-proof' }), /wrong_child_task/);
    close();
  } finally { f.cleanup(); }
});
for (const widen of ['tools', 'denials', 'methods', 'environment', 'resources', 'skills', 'stale', 'execution', 'fence'] as const) test(`typed child refuses ${widen} before any spawn or checkout reservation`, async () => {
  const f = fixture();
  try {
    const p = await parent(f), c = child(f, p);
    if (widen === 'tools') c.launch_spec!.tools.push('edit');
    if (widen === 'denials') c.launch_spec!.denied_tools = [];
    if (widen === 'methods') c.launch_spec!.grant_methods.push('workers.stop');
    if (widen === 'environment') c.launch_spec!.environment.allowed_methods.push('workers.stop');
    if (widen === 'resources') c.launch_spec!.resources.extensions.push('/tmp/foreign.ts');
    if (widen === 'skills') c.launch_spec!.resources.skills.push('/tmp/foreign-skill');
    if (widen === 'execution') c.parent!.execution_id = 'old-execution';
    if (widen === 'stale') c.parent!.binding_revision++;
    if (widen === 'fence') { f.hosts[0]!.emit('exit'); await tick(); }
    await assert.rejects(() => f.supervisor.create(c), /subset|stale_binding|stale_parent_execution|fenced/);
    assert.equal(f.hosts.length, 1); assert.equal(f.supervisor.workers.size, 1);
  } finally { f.cleanup(); }
});
test('FD reports recheck parent grant revocation; siblings and parent remain untouched on child stop', async () => {
  const f = fixture();
  try {
    const grantFile = f.supervisor.grants.register('parent', { worker_ids: ['*'], cwd_roots: ['*'] }, ['workers.create', 'children.report']);
    const grant = JSON.parse(readFileSync(grantFile, 'utf8'));
    const p = await f.supervisor.callerGrant.run(grant, () => parent(f));
    const c = child(f, p), r = await f.supervisor.callerGrant.run(grant, () => f.supervisor.create(c));
    const w = f.supervisor.get(r.worker_id!);
    const cwd = join(f.dir, 'sibling'); mkdirSync(cwd);
    const s = await f.supervisor.create({ ...c, command_id: 'sibling', cwd, parent: { ...c.parent!, task_id: 'sibling' } });
    await f.supervisor.stop(s.worker_id!, bind(f.supervisor.get(s.worker_id!), 'stop-sibling'));
    assert.equal(f.hosts[0]!.stops, 0); assert.equal(f.hosts[1]!.stops, 0);
    f.supervisor.grants.revoke(grant.grant_id);
    f.hosts[1]!.emit('report', { report_id: 'revoked', kind: 'result', message: 'untrusted' }); await tick(); await tick();
    assert.equal(f.supervisor.get(w.worker_id).child_reports!.length, 0);
    assert.equal(f.hosts[0]!.stops, 0);
  } finally { f.cleanup(); }
});
