import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { Host, bind } from './helpers.js';
import type { Containment } from '../containment.js';

test('relaunch refuses a replacement checkout writer; fresh epoch rejects ordinary stale writes and ignores retired callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s5-relaunch-')), cwd = join(root, 'cwd'); mkdirSync(cwd);
  const j = new Journal(join(root, 'journal')); const hosts: Host[] = [];
  const jail: Containment = { profile: 'test', reserve: epoch => ({ root, name: 'w-' + epoch, boot: 'test' }), spawn: () => { throw new Error('seam'); }, clean: async () => true };
  const s = new Supervisor(root, j, 'test', (_c, dir) => { const sid = 'native-' + hosts.length, file = join(dir, sid + '.jsonl'); writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n'); const h = new Host(dir, sid, file); hosts.push(h); return h; }, jail);
  try {
    const c = { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const a = await s.create(c), old = s.get(a.worker_id!);
    await s.stop(old.worker_id, bind(old, 'stop'));
    const replacement = await s.create({ ...c, command_id: 'replacement' });
    await assert.rejects(s.relaunch(old.worker_id, bind(old, 'relaunch-blocked')), /exclusive_environment/);
    const second = s.get(replacement.worker_id!); await s.stop(second.worker_id, bind(second, 'stop-replacement'));
    const receipt = await s.relaunch(old.worker_id, bind(old, 'relaunch'));
    assert.equal(receipt.state, 'delivered');
    const fresh = s.get(old.worker_id); assert.notEqual(fresh.worker_epoch, old.worker_epoch); assert.equal(fresh.session_id, old.session_id);
    assert.equal(hosts.at(-1)!.prompts, 0, 'relaunch opens history, never prompts');
    hosts[0]!.emit('exit'); hosts[0]!.emit('event', { type: 'host_identity', sessionId: 'WRONG', sessionFile: '/bad' });
    assert.equal(s.get(old.worker_id).status, 'ready'); assert.equal(s.get(old.worker_id).fence, null);
    await assert.rejects(s.prompt(old.worker_id, { ...bind(old, 'stale'), message: 'stale' }), /stale_binding/);
    assert.equal((await s.prompt(old.worker_id, { ...bind(fresh, 'fresh'), message: 'fresh' })).state, 'delivered');
    assert.equal(hosts.at(-1)!.prompts, 1);
    // Cgroup emptiness can be observed before Node delivers the leader's exit
    // callback. Stop must fence the active execution independently of that event.
    await s.stop(fresh.worker_id, bind(fresh, 'stop-running'));
    const stopped = s.get(fresh.worker_id);
    assert.equal(stopped.execution?.state, 'outcome_unknown');
    assert.equal(stopped.fence?.command_id, 'fresh');
    await assert.rejects(s.relaunch(fresh.worker_id, bind(stopped, 'unsafe-relaunch')), /session_fenced/);
  } finally { await s.shutdown(); j.close(); rmSync(root, { recursive: true, force: true }); }
});
