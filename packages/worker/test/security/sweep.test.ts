/**
 * The startup sweep (P2-2), ported from A0 `src/test/containment.test.ts` (its three sweep cases). Before recovery the
 * supervisor kills and removes every cleanup domain of its own installation (`w-<installation>-…` in its delegation)
 * that no journal record accounts for; a recorded domain is recovery's (a failure there leaves its worker
 * `cleanup_pending`), an unrecorded one not proven gone fails startup. Another installation's domains and any other
 * cgroup are never touched. The `sweep:` cases run anywhere; the `kernel:` cases need a real delegated cgroup v2
 * subtree and run only in the kernel tier (`harness/ci/kernel.sh -- sweep`); elsewhere they skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CgroupContainment, checkDelegation, keeperUnit, openContainment, RecordedDomainRefused, SweepUnproven, type Domain } from '../../src/containment/containment.js';
import { bootId, procInfo } from '../../src/host/process.js';
import { parseJournal } from '../../src/journal/journal.js';
import { openState } from '../../src/journal/state.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import type { Worker } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { privateTmp, testInstallation } from '../helpers.js';
import { TestDomains } from '../domains.js';
import { fixture, Host, retire } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT in a delegated user service (harness/ci/kernel.sh)';
const root = process.env.PIW_CGROUP_ROOT ?? '';
const workerRows = (file: string): Worker[] => parseJournal(readFileSync(file)).records.filter(r => r.kind === 'worker').map(r => r.value.worker as Worker);

test('sweep: startup sweeps only the unknown domains of its own installation in its own delegation', async () => {
  const tmp = privateTmp();
  try {
    const own = join(tmp.dir, 'own');
    const elsewhere = join(tmp.dir, 'elsewhere');
    mkdirSync(own);
    mkdirSync(elsewhere);
    const installation = testInstallation(tmp.dir);
    const ours = (n: string) => `w-${installation}-${n}`;
    const otherInstallation = `w-${'0'.repeat(20)}-orphan`;
    for (const dir of [ours('known'), ours('orphan'), ours('known-elsewhere'), 'not-a-worker', 'w-operator', otherInstallation]) mkdirSync(join(own, dir));
    mkdirSync(join(elsewhere, ours('orphan')));
    writeFileSync(join(own, ours('file')), '');
    // Real directory enumeration; only the kernel removal is substituted (the kernel: cases below remove real domains).
    const jail = new CgroupContainment(own, installation, 200);
    const cleaned: string[] = [];
    jail.clean = async domain => {
      cleaned.push(domain.name);
      assert.equal(domain.root, own);
      rmSync(join(domain.root, domain.name), { recursive: true });
      return true;
    };
    const known: Domain[] = [{ root: own, name: ours('known'), boot: bootId() }];
    // A recorded domain of this boot that clean would refuse (another delegation, another installation's name) fails
    // the sweep before anything is swept: recovery could never kill it, so the daemon must not listen with it running.
    for (const refused of [
      { root: elsewhere, name: ours('known-elsewhere'), boot: bootId() },
      { root: own, name: otherInstallation, boot: bootId() },
    ]) {
      await assert.rejects(jail.sweep([...known, refused]), (error: unknown) => {
        assert.ok(error instanceof RecordedDomainRefused);
        assert.equal(error.code, 'recorded_domain_not_cleanable');
        assert.deepEqual(error.domains, [join(refused.root, refused.name)]);
        return true;
      });
      assert.deepEqual(cleaned, [], 'nothing was swept');
    }
    // One of a previous boot is gone with that boot's cgroupfs: it refuses nothing. A record in another delegation
    // never accounts for a same-named domain in this one.
    await jail.sweep([...known, { root: elsewhere, name: ours('known-elsewhere'), boot: 'a-previous-boot' }]);
    assert.deepEqual(cleaned.sort(), [ours('known-elsewhere'), ours('orphan')], "only this installation's unrecorded domains are swept");
    assert.deepEqual(
      readdirSync(own).sort(),
      [ours('file'), ours('known'), 'not-a-worker', otherInstallation, 'w-operator'].sort(),
      "a recorded domain, another installation's, an operator's and a cgroup that is not a worker domain survive",
    );
    assert.ok(existsSync(join(elsewhere, ours('orphan'))), 'another delegation is never swept');
    // A domain not proven gone fails the sweep, naming it; the others are still swept.
    mkdirSync(join(own, ours('stuck')));
    mkdirSync(join(own, ours('later')));
    const fallible = jail.clean;
    jail.clean = async domain => (domain.name === ours('stuck') ? false : fallible(domain));
    await assert.rejects(jail.sweep(known), (error: unknown) => {
      assert.ok(error instanceof SweepUnproven);
      assert.equal(error.code, 'orphan_cleanup_unproven');
      assert.deepEqual(error.domains, [ours('stuck')]);
      return true;
    });
    assert.equal(existsSync(join(own, ours('later'))), false, 'the sweep goes on past an unproven domain');
  } finally {
    tmp.cleanup();
  }
});

test('sweep: recovery awaits the startup sweep; a sweep failure fails it before anything is recovered or recorded', async () => {
  const domains = new TestDomains();
  const f = fixture({ domains });
  try {
    const w = await f.create();
    // An inventory probe whose cleanup is unproven stays recorded: recovery cleans it, so the sweep must skip it.
    f.supervisor.features.inventory = domains.track(() => new Host(f.dir, 'none', join(f.dir, 'none.jsonl')));
    const cwd = join(f.dir, 'probe');
    mkdirSync(cwd);
    domains.confirm = false;
    await assert.rejects(f.supervisor.features.models({ cwd }), /inventory_cleanup_unproven/);
    domains.confirm = true;
    const recorded = [f.supervisor.state.require(w.worker_id).domain!, ...f.supervisor.features.pendingDomains()];
    assert.equal(recorded.length, 2);
    const rows = workerRows(f.journalFile).length;
    const cleans = domains.cleaned.length;
    domains.sweepError = new SweepUnproven(['w-orphan']);
    await assert.rejects(f.restart(), /orphan_cleanup_unproven/, 'a sweep failure fails recovery, so the daemon never listens');
    assert.deepEqual(domains.sweeps, [recorded], 'the sweep skips exactly the domains the journal still accounts for');
    assert.equal(domains.cleaned.length, cleans, 'nothing was cleaned before the sweep finished');
    assert.equal(workerRows(f.journalFile).length, rows, 'nothing was recovered or recorded before the sweep finished');
    assert.equal(f.supervisor.get(w.worker_id).status, 'ready');
    // The next start sweeps first, then recovers: the worker's and the probe's domains are cleaned by recovery.
    delete domains.sweepError;
    domains.confirmUnknown = true;
    const recovered = await f.restart();
    assert.deepEqual(domains.sweeps.at(-1), recorded);
    assert.deepEqual(domains.cleaned.slice(cleans).map(d => d.name).sort(), recorded.map(d => d.name).sort());
    assert.equal(recovered.get(w.worker_id).status, 'stopped');
    assert.deepEqual(recovered.features.pendingProbes(), []);
    // Confirmed cleanups account for nothing any more: a later sweep may remove whatever carries their names.
    await f.restart();
    assert.deepEqual(domains.sweeps.at(-1), []);
  } finally {
    f.cleanup();
  }
});

test('sweep: a recorded domain recovery cannot prove gone leaves its worker cleanup_pending and startup proceeds; an unrecorded one fails startup', async () => {
  const tmp = privateTmp();
  const delegation = join(tmp.dir, 'delegation');
  mkdirSync(delegation);
  // A plain directory stands in for the delegation: no domain in it is ever observed gone (no cgroup.events).
  let state = openState(tmp.dir);
  const jail = () => new CgroupContainment(delegation, state.installation, 100);
  const open = () =>
    new Supervisor({
      journal: state.journal,
      receipts: new ReceiptStore(state.journal),
      supervisorEpoch: state.supervisorEpoch,
      stateDir: tmp.dir,
      containment: jail(),
      factory: launch => {
        const file = join(launch.sessionDir, 's.jsonl');
        writeFileSync(file, '{"type":"session","id":"s"}\n');
        return new Host(launch.sessionDir, 's', file);
      },
    });
  let s = open();
  try {
    const cwd = join(tmp.dir, 'cwd');
    mkdirSync(cwd);
    const made = await s.create({ command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' });
    assert.equal(made.state, 'delivered');
    const recorded = s.state.require(made.worker_id!).domain!;
    assert.ok(existsSync(join(delegation, recorded.name)));
    const orphan = `w-${state.installation}-orphan`;
    mkdirSync(join(delegation, orphan));
    const restart = async () => {
      retire(s);
      state.close();
      state = openState(tmp.dir);
      s = open();
      await s.recover();
    };
    await assert.rejects(restart(), (error: unknown) => {
      assert.ok(error instanceof SweepUnproven);
      assert.deepEqual(error.domains, [orphan], 'the sweep names only the unrecorded domain, never the recorded one');
      return true;
    });
    assert.equal(workerRows(state.journal.file).at(-1)!.status, 'ready', 'nothing was recovered');
    // The operator removes it (the sweep's kill left its cgroup.kill write in the plain directory).
    rmSync(join(delegation, orphan), { recursive: true });
    await restart();
    assert.deepEqual([s.get(made.worker_id!).status, s.get(made.worker_id!).cleanup], ['cleanup_pending', 'unresolved'], 'recovery holds the worker');
    assert.ok(existsSync(join(delegation, recorded.name)), 'the recorded domain is left to recovery');
  } finally {
    retire(s);
    state.close();
    tmp.cleanup();
  }
});

/** Runs `script` inside a domain through its join prefix. */
const inDomain = (prefix: readonly string[], script: string, args: string[]): ChildProcess =>
  spawn(prefix[0]!, [...prefix.slice(1), '/bin/sh', '-c', script, 'payload', ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

/** A double fork with setsid and nohup: the grandchild leaves the leader's process group and session. */
const DETACHED = `(setsid nohup /bin/sh -c 'echo $$ > "$1"; sleep 2; echo ESCAPED > "$2"' detached "$1" "$2" >/dev/null 2>&1 &); echo READY; exec sleep 300`;

const gone = (pid: number) => !procInfo(pid) || procInfo(pid)?.state === 'Z';
const populated = (dir: string) => /^populated 1$/m.test(readFileSync(join(dir, 'cgroup.events'), 'utf8'));

/** A populated domain with a detached grandchild, started like a worker's (enter, then the join prefix). */
async function detachedIn(jail: CgroupContainment, dir: string): Promise<{ domain: Domain; grandchild: number; marker: string }> {
  const domain = jail.reserve(randomUUID());
  const pidFile = join(dir, `${domain.name}.pid`);
  const marker = join(dir, `${domain.name}.escaped`);
  const leader = inDomain(jail.enter(domain), DETACHED, [pidFile, marker]);
  await once(leader.stdout!, 'data');
  for (let n = 0; n < 300 && !(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()); n++) await delay(10);
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  assert.match(readFileSync(join(domain.root, domain.name, 'cgroup.procs'), 'utf8'), new RegExp(`^${grandchild}$`, 'm'), 'the grandchild is in the domain');
  return { domain, grandchild, marker };
}

/** A cgroup that is not a worker domain, with a process in it (an operator's). */
async function operatorCgroup(path: string): Promise<ChildProcess> {
  mkdirSync(path);
  const child = spawn('/bin/sh', ['-c', 'echo 0 > "$1/cgroup.procs" || exit 125; echo READY; exec sleep 300', 'operator', path], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  await once(child.stdout!, 'data');
  return child;
}

/** Kills and removes a test-owned cgroup (not a domain of the installation under test). */
async function removeCgroup(path: string): Promise<void> {
  if (!existsSync(path)) return;
  try {
    writeFileSync(join(path, 'cgroup.kill'), '1\n');
  } catch {}
  for (let i = 0; i < 250 && populated(path); i++) await delay(20);
  rmdirSync(path);
}

test('kernel: real startup sweeps orphaned domains, with a setsid grandchild, but never another installation service', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const env = { ...process.env };
  delete env.PIW_CGROUP_ROOT;
  const a = join(tmp.dir, 'a');
  const b = join(tmp.dir, 'b');
  mkdirSync(a, { mode: 0o700 });
  mkdirSync(b, { mode: 0o700 });
  const state = openState(a);
  const installations = [state.installation, testInstallation(b)] as const;
  const units = installations.map(keeperUnit);
  const owned: { jail: CgroupContainment; domain: Domain }[] = [];
  try {
    const jailA = openContainment(installations[0], env);
    const jailB = openContainment(installations[1], env);
    assert.notEqual(jailA.root, jailB.root, 'each installation keeps its own delegated service');
    const orphan = await detachedIn(jailA, tmp.dir);
    owned.push({ jail: jailA, domain: orphan.domain });
    const other = await detachedIn(jailB, tmp.dir);
    owned.push({ jail: jailB, domain: other.domain });
    const s = new Supervisor({
      journal: state.journal,
      receipts: new ReceiptStore(state.journal),
      supervisorEpoch: state.supervisorEpoch,
      stateDir: a,
      containment: jailA,
      factory: () => {
        throw new Error('no worker in this test');
      },
    });
    await s.recover();
    assert.equal(existsSync(join(orphan.domain.root, orphan.domain.name)), false, 'the orphan is removed');
    assert.ok(gone(orphan.grandchild), "the orphan's detached grandchild is dead");
    assert.ok(existsSync(join(other.domain.root, other.domain.name)), "another installation's domain survives");
    assert.equal(populated(join(other.domain.root, other.domain.name)), true, 'and keeps running');
    assert.equal(gone(other.grandchild), false);
    await delay(2200);
    assert.equal(existsSync(orphan.marker), false, 'the orphan never wrote after the sweep');
  } finally {
    for (const { jail, domain } of owned) await jail.clean(domain);
    state.close();
    for (const unit of units) spawn('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
    for (const unit of units) {
      for (let n = 0; n < 500; n++) {
        const active = spawn('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' });
        const [code] = await once(active, 'exit');
        if (code !== 0) break;
        await delay(10);
      }
    }
    tmp.cleanup();
  }
});

const daemonMain = fileURLToPath(new URL('../../src/main.js', import.meta.url));

/**
 * Starts the production daemon on `stateDir` in the kernel tier's delegation; resolves when it listens or exits. Its
 * installation lock is in `dir` (its XDG_RUNTIME_DIR).
 */
async function startDaemon(dir: string, stateDir: string): Promise<{ child: ChildProcess; outcome: number | null | 'listening' | 'timeout'; stderr: () => string; socket: string }> {
  const socket = join(dir, 'run', 'b2.sock');
  const child = spawn(process.execPath, [daemonMain], {
    env: { PATH: process.env.PATH, HOME: dir, XDG_RUNTIME_DIR: dir, PIW_SOCKET: socket, PIW_STATE_DIR: stateDir, PIW_CGROUP_ROOT: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  const listening = new Promise<'listening'>(resolve =>
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.includes('"listening"')) resolve('listening');
    }),
  );
  const outcome = await Promise.race([
    once(child, 'exit').then(([code]) => code as number | null),
    listening,
    delay(30_000).then(() => 'timeout' as const),
  ]);
  return { child, outcome, stderr: () => stderr, socket };
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test("kernel: in an operator-shared delegation the daemon sweeps its own installation's orphan, with a setsid grandchild, before it listens; another installation's domain and the operator's cgroups are untouched", { skip, timeout: 90_000 }, async () => {
  const tmp = privateTmp();
  const stateA = join(tmp.dir, 'state-a');
  const stateB = join(tmp.dir, 'state-b');
  mkdirSync(stateA, { mode: 0o700 });
  mkdirSync(stateB, { mode: 0o700 });
  const env = { ...process.env, PIW_CGROUP_ROOT: root };
  // The daemon's installation: the one its state records (a first start creates it).
  const opened = openState(stateA);
  const installation = opened.installation;
  opened.close();
  const jailA = openContainment(installation, env);
  const jailB = openContainment(testInstallation(stateB), env);
  assert.equal(jailA.root, jailB.root, 'both installations share the operator delegation');
  const operator = [join(jailA.root, `op-sweep-${process.pid}`), join(jailA.root, `w-operator-${process.pid}`)];
  const owned: { jail: CgroupContainment; domain: Domain }[] = [];
  const children: ChildProcess[] = [];
  let daemon: ChildProcess | undefined;
  try {
    const orphan = await detachedIn(jailA, tmp.dir);
    owned.push({ jail: jailA, domain: orphan.domain });
    const other = await detachedIn(jailB, tmp.dir);
    owned.push({ jail: jailB, domain: other.domain });
    for (const path of operator) children.push(await operatorCgroup(path));
    const started = await startDaemon(tmp.dir, stateA);
    daemon = started.child;
    assert.equal(started.outcome, 'listening', `the daemon starts: ${started.stderr()}`);
    // By the time it listens the orphan is gone: the sweep ran before any request could be accepted.
    assert.equal(existsSync(join(orphan.domain.root, orphan.domain.name)), false, "this installation's orphan is removed");
    assert.ok(gone(orphan.grandchild), "the orphan's detached grandchild is dead");
    assert.equal(populated(join(other.domain.root, other.domain.name)), true, "another installation's domain keeps running");
    assert.equal(gone(other.grandchild), false);
    for (const path of operator) assert.equal(populated(path), true, `the operator's cgroup ${path} keeps running`);
    await delay(2200);
    assert.equal(existsSync(orphan.marker), false, 'the orphan never wrote after the sweep');
  } finally {
    if (daemon) await stopDaemon(daemon);
    for (const { jail, domain } of owned) await jail.clean(domain);
    for (const path of operator) await removeCgroup(path);
    tmp.cleanup();
  }
});

test('kernel: a sweep that cannot prove an unrecorded domain gone fails startup: the daemon exits refused orphan_cleanup_unproven and never listens', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const stateDir = join(tmp.dir, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  const opened = openState(stateDir);
  const installation = opened.installation;
  opened.close();
  const stuck = join(checkDelegation(root), `w-${installation}-stuck`);
  let daemon: ChildProcess | undefined;
  try {
    // An empty domain whose nested cgroup cannot be removed (its parent is not writable): never observed gone.
    mkdirSync(join(stuck, 'nested'), { recursive: true });
    chmodSync(stuck, 0o555);
    const started = await startDaemon(tmp.dir, stateDir);
    daemon = started.child;
    assert.equal(started.outcome, 1, `the daemon must exit 1: ${started.stderr()}`);
    const refused = started.stderr().split('\n').filter(Boolean).map(l => JSON.parse(l) as { event: string; reason?: string; domains?: string[] }).find(e => e.event === 'refused');
    assert.deepEqual([refused?.reason, refused?.domains], ['orphan_cleanup_unproven', [`w-${installation}-stuck`]]);
    assert.equal(started.stderr().includes('"listening"'), false);
    assert.equal(existsSync(started.socket), false, 'no socket');
    assert.ok(existsSync(stuck), 'the unproven domain is left in place, not reported gone');
  } finally {
    if (daemon) await stopDaemon(daemon);
    if (existsSync(stuck)) {
      chmodSync(stuck, 0o755);
      rmdirSync(join(stuck, 'nested'));
      rmdirSync(stuck);
    }
    tmp.cleanup();
  }
});
