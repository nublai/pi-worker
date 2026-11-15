import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
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
