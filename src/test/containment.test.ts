import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { CgroupContainment, ProcessGroupContainment, type Containment, type CleanupUnit } from '../containment.js';
import { Journal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { Host, bind } from './helpers.js';

test('cleanup_pending is fsynced before kill; failed empty proof blocks resume and replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0s5-cleanup-')); mkdirSync(join(dir, 'work'));
  const journal = new Journal(join(dir, 'journal')); let confirmed = false, cleanCalls = 0;
  const unit = { root: '/fake', name: 'w-test', boot: 'fake' };
  const containment: Containment = { profile: 'test_cgroup', reserve: () => unit, spawn: () => { throw new Error('not used'); }, clean: async () => {
    cleanCalls++;
    const records = readFileSync(join(dir, 'journal'), 'utf8').trim().split('\n').map(l => JSON.parse(l).record);
    const latest = records.filter(r => r.kind === 'worker').at(-1);
    assert.equal(latest.value.worker.status, 'cleanup_pending');
    return confirmed;
  } };
  const factory = (_c: unknown, sessionDir: string) => { const file = join(sessionDir, 's.jsonl'); writeFileSync(file, '{"type":"session","id":"s"}\n'); return new Host(sessionDir, 's', file); };
  const supervisor = new Supervisor(dir, journal, 'test', factory, containment);
  try {
    const c = { command_id: 'create', cwd: join(dir, 'work'), provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await supervisor.create(c); const w = supervisor.get(r.worker_id!);
    const stopped = await supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(stopped.state, 'outcome_unknown'); assert.equal(supervisor.get(w.worker_id).status, 'cleanup_pending');
    await assert.rejects(supervisor.rebind(w.worker_id, { ...bind(w, 'resume'), action: 'resume', target_session_id: 's' }), /cleanup_pending_or_worker_not_ready/);
    await assert.rejects(supervisor.create({ ...c, command_id: 'replacement' }), /exclusive_environment/);
    const recovered = new Supervisor(dir, journal, 'test', factory, containment); await recovered.recover();
    assert.equal(recovered.get(w.worker_id).status, 'cleanup_pending'); assert.equal(cleanCalls, 2);
    confirmed = true; await recovered.recover();
    assert.equal(recovered.get(w.worker_id).cleanup, 'cgroup_empty_removed');
    assert.equal(recovered.get(w.worker_id).status, 'stopped');
    assert.match(recovered.hello().cleanup_profile, /test_cgroup/);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a failed journal still permits fault termination but never records cleanup as confirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0s5-storage-')), cwd = join(dir, 'work'); mkdirSync(cwd);
  const journal = new Journal(join(dir, 'journal')); let killed = 0;
  const jail: Containment = { profile: 'test', reserve: epoch => ({ root: dir, name: 'w-' + epoch, boot: 'test' }), spawn: () => { throw new Error('seam'); }, clean: async () => { killed++; return true; } };
  let host: Host;
  const s = new Supervisor(dir, journal, 'test', (_c, sessionDir) => { const file = join(sessionDir, 's.jsonl'); writeFileSync(file, '{"type":"session","id":"s"}\n'); host = new Host(sessionDir, 's', file); return host; }, jail);
  try {
    const c = await s.create({ command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' }); assert.equal(c.state, 'delivered');
    journal.failed = true;
    host!.emit('event', { type: 'host_identity', sessionId: 'changed-behind-supervisor', sessionFile: '/bad' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(killed, 1, 'storage failure must not suppress the cgroup kill');
    assert.equal(s.get(c.worker_id!).status, 'cleanup_pending', 'no durable proof means no lease release');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('fallback names weaker process-group semantics', () => {
  assert.match(new ProcessGroupContainment().profile, /WEAKER.*escaped descendants unproven/);
});

const root = process.env.A0_TEST_CGROUP_DIR;
for (const cut of ['stop', 'restart'] as const) test(`real cgroup ${cut} kills setsid/nohup grandchild and retires the pre-exec join target`, { skip: !root }, async () => {
  const jail = new CgroupContainment(root!); const unit = jail.reserve(randomUUID());
  const dir = mkdtempSync(join(tmpdir(), 'a0s5-detached-')); const marker = join(dir, 'escaped');
  try {
    const child = jail.spawn(unit, '/bin/sh', ['-c', `setsid nohup /bin/sh -c 'sleep 2; echo ESCAPED > "$1"' detached '${marker}' >/dev/null 2>&1 & echo READY; wait`], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout!, 'data');
    assert.throws(() => jail.spawn(unit, '/bin/true', [], {}), /already exists/);
    if (cut === 'restart') {
      // Lose the process handle, recover solely from the journal-safe identity.
      const reopened = new CgroupContainment(root!); assert.equal(await reopened.clean(JSON.parse(JSON.stringify(unit)) as CleanupUnit), true);
    } else assert.equal(await jail.clean(unit), true);
    assert.equal(existsSync(join(root!, unit.name)), false);
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(existsSync(marker), false);
  } finally { await jail.clean(unit); rmSync(dir, { recursive: true, force: true }); }
});
