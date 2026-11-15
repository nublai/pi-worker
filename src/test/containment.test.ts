import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { CgroupContainment, ProcessGroupContainment, openContainment, type Containment, type CleanupUnit } from '../containment.js';
import { Journal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { Host, bind } from './helpers.js';
import { processToken } from '../process.js';

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

test('startup sweeps only unknown worker domains in its own installation service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0s5-sweep-')), own = join(dir, 'own'), other = join(dir, 'other'); mkdirSync(own); mkdirSync(other);
  for (const path of [join(own, 'w-known'), join(own, 'w-orphan'), join(own, 'not-a-worker'), join(other, 'w-other')]) mkdirSync(path);
  try {
    // Real directory enumeration; substitute only kernel removal for this
    // portable regression. Kernel population/removal has its own opt-in test.
    const jail = Object.assign(Object.create(CgroupContainment.prototype) as CgroupContainment, { root: own, installationOwned: true });
    const cleaned: string[] = [];
    jail.clean = async unit => { cleaned.push(unit.name); rmSync(join(unit.root, unit.name), { recursive: true }); return true; };
    await jail.sweepUnknown!([{ root: own, name: 'w-known', boot: 'test' }]);
    assert.deepEqual(cleaned, ['w-orphan']); assert.ok(existsSync(join(own, 'w-known'))); assert.ok(existsSync(join(other, 'w-other'))); assert.ok(existsSync(join(own, 'not-a-worker')));
    mkdirSync(join(own, 'w-operator'));
    const external = Object.assign(Object.create(CgroupContainment.prototype) as CgroupContainment, { root: own, installationOwned: false, clean: jail.clean });
    await external.sweepUnknown!([]); assert.ok(existsSync(join(own, 'w-operator')), 'shared operator delegation is never swept');
    mkdirSync(join(own, 'w-failed')); jail.clean = async () => false;
    await assert.rejects(jail.sweepUnknown!([]), /orphan_cleanup_unproven/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recover awaits orphan sweep before permitting worker operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0s5-startup-')), journal = new Journal(join(dir, 'journal'));
  let swept = false;
  const jail: Containment = { profile: 'test', reserve: () => undefined, spawn: () => { throw new Error('unused'); }, clean: async () => false, sweepUnknown: async known => { assert.deepEqual(known, []); swept = true; throw new Error('orphan_cleanup_unproven'); } };
  try {
    const s = new Supervisor(dir, journal, 'test', () => { throw new Error('unused'); }, jail);
    await assert.rejects(s.recover(), /orphan_cleanup_unproven/); assert.equal(swept, true);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

const root = process.env.A0_TEST_CGROUP_DIR;
test('real startup sweeps orphaned domains but never another installation service', { skip: !root }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0s5-orphan-')), a = join(dir, 'a'), b = join(dir, 'b'); mkdirSync(a); mkdirSync(b);
  const journal = new Journal(join(a, 'journal')); const owned: { jail: Containment; unit: CleanupUnit }[] = [];
  try {
    for (const state of [a, b]) {
      const jail = openContainment(state), unit = jail.reserve(randomUUID())!; owned.push({ jail, unit });
      const child = jail.spawn(unit, '/bin/sh', ['-c', 'echo READY; exec sleep infinity'], { stdio: ['ignore', 'pipe', 'pipe'] }); await once(child.stdout!, 'data');
    }
    const s = new Supervisor(a, journal, 'test', () => { throw new Error('unused'); }, owned[0]!.jail); await s.recover();
    assert.equal(existsSync(join(owned[0]!.unit.root, owned[0]!.unit.name)), false);
    assert.equal(existsSync(join(owned[1]!.unit.root, owned[1]!.unit.name)), true);
    assert.match(readFileSync(join(owned[1]!.unit.root, owned[1]!.unit.name, 'cgroup.events'), 'utf8'), /^populated 1$/m);
  } finally {
    for (const { jail, unit } of owned) await jail.clean(unit);
    journal.close();
    if (!process.env.A0_CGROUP_DIR) for (const state of [a, b]) execFileSync('systemctl', ['--user', 'stop', `a0-${createHash('sha256').update(state).digest('hex').slice(0, 20)}.service`], { timeout: 15000 });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real leader crash kills a detached grandchild without stop or restart', { skip: !root }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0s5-exit-')), journal = new Journal(join(dir, 'journal')), jail = new CgroupContainment(root!);
  const marker = join(dir, 'escaped'), pidFile = join(dir, 'grandchild.pid');
  let leader: ReturnType<CgroupContainment['spawn']> | undefined;
  const s = new Supervisor(dir, journal, 'test', (_c, sessionDir, context) => {
    const file = join(sessionDir, 's.jsonl'); writeFileSync(file, '{"type":"session","id":"s"}\n');
    leader = jail.spawn(context!.unit!, '/bin/sh', ['-c', `setsid nohup /bin/sh -c 'echo $$ > "$1"; sleep 2; echo ESCAPED > "$2"' detached '${pidFile}' '${marker}' >/dev/null 2>&1 & echo READY; read line`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const h = new Host(sessionDir, 's', file); h.pid = leader.pid; h.token = processToken(leader.pid!) as typeof h.token;
    leader.once('exit', () => h.emit('exit')); return h;
  }, jail);
  try {
    const made = await s.create({ command_id: 'create', cwd: dir, provider: 'p', model: 'm', thinking: 'off' }); assert.equal(made.state, 'delivered');
    for (let n = 0; n < 200 && !existsSync(pidFile); n++) await new Promise(r => setTimeout(r, 10));
    const grandchild = Number(readFileSync(pidFile, 'utf8')); process.kill(grandchild, 0);
    const unit = s.require(made.worker_id!).unit!;
    const exited = once(leader!, 'exit'); process.kill(leader!.pid!, 'SIGKILL'); await exited;
    for (let n = 0; n < 600 && s.get(made.worker_id!).status === 'cleanup_pending'; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(s.get(made.worker_id!).cleanup, 'cgroup_empty_removed');
    assert.equal(existsSync(join(root!, unit.name)), false);
    await new Promise(r => setTimeout(r, 2200)); assert.equal(existsSync(marker), false);
  } finally { await s.shutdown(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

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
