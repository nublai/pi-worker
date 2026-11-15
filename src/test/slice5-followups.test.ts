import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { requestHash } from '../receipts.js';
import type { Containment, CleanupUnit } from '../containment.js';
import { Host, bind, tick } from './helpers.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'a0s5-followups-')), cwd = join(root, 'work'); mkdirSync(cwd);
  const journal = new Journal(join(root, 'journal')), hosts: Host[] = [];
  const jail: Containment = { profile: 'test', reserve: epoch => ({ root, name: 'w-' + epoch, boot: 'test' }), spawn: () => { throw new Error('unused'); }, clean: async () => true };
  const factory = (_c: unknown, dir: string) => {
    const sid = 'native-' + hosts.length, file = join(dir, sid + '.jsonl'); writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
    const h = new Host(dir, sid, file); h.pid = 2147483000 + hosts.length; hosts.push(h); return h;
  };
  const s = new Supervisor(root, journal, 'test', factory, jail);
  return { root, cwd, journal, hosts, jail, factory, s, create: () => s.create({ command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const }), close: async () => { jail.clean = async () => true; await s.shutdown(); journal.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const trigger of ['exit', 'stop', 'fault'] as const) for (const lateGone of [true, false]) test(`late ${trigger} cleanup cannot retire a relaunched generation (gone=${lateGone})`, async () => {
  const f = setup();
  const calls: { unit: CleanupUnit; finish: (gone: boolean) => void }[] = [];
  try {
    const made = await f.create(), old = f.s.get(made.worker_id!);
    const oldUnit = f.s.require(old.worker_id).unit!;
    f.jail.clean = unit => new Promise<boolean>(finish => calls.push({ unit, finish }));
    let firstStop: ReturnType<Supervisor['stop']> | undefined;
    if (trigger === 'exit') f.hosts[0]!.emit('exit');
    else if (trigger === 'fault') f.hosts[0]!.emit('event', { type: 'host_identity', sessionId: 'wrong', sessionFile: '/wrong' });
    else firstStop = f.s.stop(old.worker_id, bind(old, 'stop-a'));
    await tick();
    const secondStop = f.s.stop(old.worker_id, bind(old, 'stop-b')); await tick();
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.unit === oldUnit));
    // Leave the fault continuation outstanding too, not only stop's wrapper.
    const early = trigger === 'fault' ? 1 : 0, late = 1 - early;
    calls[early]!.finish(true); await tick();
    assert.equal(f.s.get(old.worker_id).cleanup, 'cgroup_empty_removed');
    assert.equal((await f.s.relaunch(old.worker_id, bind(f.s.get(old.worker_id), 'relaunch'))).state, 'delivered');
    const fresh = f.s.get(old.worker_id), freshUnit = f.s.require(old.worker_id).unit;
    assert.notEqual(freshUnit, oldUnit); assert.notEqual(fresh.worker_epoch, old.worker_epoch);
    calls[late]!.finish(lateGone); await Promise.all([firstStop, secondStop]); await tick();
    assert.equal(f.s.get(old.worker_id).status, 'ready', 'old domain completion must not mark the live replacement stopped or pending');
    assert.equal(f.s.get(old.worker_id).cleanup, 'live_cgroup');
    assert.equal(f.s.require(old.worker_id).unit, freshUnit);
    assert.equal(f.s.require(old.worker_id).pid, f.hosts[1]!.pid, 'replacement process identity is retained');
    assert.equal(f.hosts[1]!.stops, 0);
    const persisted = f.journal.records.filter(r => r.kind === 'worker').at(-1)!.value.worker;
    assert.equal((persisted as { status: string }).status, 'ready');
    await assert.rejects(f.s.relaunch(old.worker_id, bind(fresh, 'second-relaunch')), /cleanup_pending_or_cleanup_unproven/);
    assert.equal(f.hosts.length, 2, 'no second live Pi on the same session');
  } finally { for (const call of calls) call.finish(true); await tick(); await f.close(); }
});

for (const failure of ['spawn', 'get_state'] as const) for (const restart of [false, true]) test(`owner-kept prompt binds to the successful retry after ${failure} failure (restart=${restart})`, async () => {
  const f = setup(); let recovered: Supervisor | undefined, fail = true;
  try {
    const made = await f.create(), old = f.s.get(made.worker_id!);
    const p = { ...bind(old, 'kept'), message: 'EXACT ONCE' };
    f.s.receipts.put({ command_id: p.command_id, worker_id: old.worker_id, operation: 'sessions.prompt', request_hash: requestHash({ ...p, worker_id: old.worker_id, operation: 'sessions.prompt' }), state: 'intent', stage: 'reserved', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: new Date().toISOString() });
    const factory: typeof f.factory = (c, dir) => {
      if (fail && failure === 'spawn') throw new Error('test_spawn_failure');
      const h = f.factory(c, dir), request = h.request.bind(h);
      h.request = async c => fail && c.type === 'get_state' ? { type: 'response', id: 'failed', success: false } : request(c);
      return h;
    };
    recovered = new Supervisor(f.root, f.journal, 'test', factory, f.jail); await recovered.recover();
    await recovered.resolveUnknown(old.worker_id, { ...bind(recovered.get(old.worker_id), 'keep'), uncertain_command_id: p.command_id, fence_generation: 0, disposition: 'keep' });
    const failed = await recovered.relaunch(old.worker_id, bind(recovered.get(old.worker_id), 'failed-relaunch'));
    assert.equal(failed.state, 'outcome_unknown');
    assert.match(failed.error!, failure === 'spawn' ? /test_spawn_failure/ : /initialization_failed/);
    assert.equal(recovered.get(old.worker_id).cleanup, 'cgroup_empty_removed');
    assert.equal(recovered.receipts.all.get(p.command_id)!.state, 'intent_ready');
    fail = false;
    if (restart) { recovered = new Supervisor(f.root, f.journal, 'test', factory, f.jail); await recovered.recover(); }
    const retry = await recovered.relaunch(old.worker_id, bind(recovered.get(old.worker_id), 'retry-relaunch'));
    assert.equal(retry.state, 'delivered');
    const fresh = recovered.get(old.worker_id), host = f.hosts.at(-1)!;
    assert.equal(fresh.session_id, old.session_id); assert.equal(fresh.binding_revision, old.binding_revision);
    assert.equal(host.file, f.hosts[0]!.file); assert.equal(host.prompts, 0, 'neither recovery nor relaunch sends the kept prompt');
    await assert.rejects(recovered.prompt(old.worker_id, { ...p, message: 'changed payload' }), /command_id_conflict/);
    assert.throws(() => recovered!.followUp(old.worker_id, { ...p, execution_id: 'wrong-operation' }), /command_id_conflict/);
    await assert.rejects(recovered.prompt(old.worker_id, { ...bind(old, 'ordinary-stale'), message: p.message }), /stale_binding/);
    const sent = await recovered.prompt(old.worker_id, p).catch(error => assert.fail(`exact owner-kept retry refused: ${String(error)}`));
    assert.equal(sent.state, 'delivered'); assert.deepEqual(await recovered.prompt(old.worker_id, p), sent);
    assert.equal(host.prompts, 1); assert.deepEqual(host.commands.filter(c => c.type === 'prompt'), [{ type: 'prompt', message: p.message }]);
    assert.equal(f.hosts.reduce((n, h) => n + h.prompts, 0), 1);
  } finally { if (recovered) await recovered.shutdown(); await f.close(); }
});

test('a second successful relaunch does not rebind an undispatched owner-kept prompt', async () => {
  const f = setup(); let recovered: Supervisor | undefined;
  try {
    const made = await f.create(), old = f.s.get(made.worker_id!);
    const p = { ...bind(old, 'kept'), message: 'NOT REBOUND' };
    f.s.receipts.put({ command_id: p.command_id, worker_id: old.worker_id, operation: 'sessions.prompt', request_hash: requestHash({ ...p, worker_id: old.worker_id, operation: 'sessions.prompt' }), state: 'intent', stage: 'reserved', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: new Date().toISOString() });
    recovered = new Supervisor(f.root, f.journal, 'test', f.factory, f.jail); await recovered.recover();
    await recovered.resolveUnknown(old.worker_id, { ...bind(recovered.get(old.worker_id), 'keep'), uncertain_command_id: p.command_id, fence_generation: 0, disposition: 'keep' });
    assert.equal((await recovered.relaunch(old.worker_id, bind(recovered.get(old.worker_id), 'first'))).state, 'delivered');
    const first = recovered.get(old.worker_id);
    await recovered.stop(old.worker_id, bind(first, 'stop-first'));
    assert.equal((await recovered.relaunch(old.worker_id, bind(first, 'second'))).state, 'delivered');
    await assert.rejects(recovered.prompt(old.worker_id, p), /stale_binding/);
    assert.equal(f.hosts.reduce((n, h) => n + h.prompts, 0), 0);
  } finally { if (recovered) await recovered.shutdown(); await f.close(); }
});
