/**
 * Installation identity for the startup sweep (P2-2, PR #23 GPT 1 and Grok 1, 2). The installation id that names every
 * cleanup domain is random, made when a state is created and recorded in its start records: a moved state keeps its
 * domains, and a new state at the same path is another installation, so it can never sweep the domains of a
 * supervisor still running on the state that was there. One daemon holds an installation at a time, so a daemon on a
 * copy of a state is refused before its sweep: it binds the installation's abstract Unix socket, which no file operation
 * can remove or replace (PR #23 Grok delta 2) and which the holder's death releases. A recorded domain this daemon's cleanup would not accept fails startup
 * instead of running on while the daemon listens.
 *
 * These cases read the id from the journal's start records, as an operator would. The `kernel:` case needs a real
 * delegated cgroup v2 subtree (`harness/ci/kernel.sh -- sweep`); elsewhere it skips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CgroupContainment, holdInstallation, InstallationRefused, installationName, openContainment, type Domain } from '../../src/containment/containment.js';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath, openState } from '../../src/journal/state.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import type { Worker } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { privateTmp } from '../helpers.js';
import { Host, retire } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT in a delegated user service (harness/ci/kernel.sh)';
const root = process.env.PIW_CGROUP_ROOT ?? '';
const ID = /^[0-9a-f]{20}$/;

/** The installation id of every start record of the state at `dir`, in order. */
const installations = (dir: string): unknown[] =>
  parseJournal(readFileSync(journalPath(dir)))
    .records.filter(r => r.kind === 'supervisor')
    .map(r => r.value.installation_id);
const workerRows = (dir: string): Worker[] =>
  parseJournal(readFileSync(journalPath(dir)))
    .records.filter(r => r.kind === 'worker')
    .map(r => r.value.worker as Worker);

/** A supervisor on `stateDir` whose domains are plain directories under `delegation` (no removal is ever confirmed). */
function supervisorOn(state: ReturnType<typeof openState>, stateDir: string, delegation: string, installation: string): Supervisor {
  return new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir,
    containment: new CgroupContainment(delegation, installation, 50),
    factory: launch => {
      const file = join(launch.sessionDir, 's.jsonl');
      writeFileSync(file, '{"type":"session","id":"s"}\n');
      return new Host(launch.sessionDir, 's', file);
    },
  });
}

test('installation: a new state records a random installation id in every start record; a moved state keeps it, and a new state at the same path is another installation whose sweep never selects the live one', async () => {
  const tmp = privateTmp();
  const path = join(tmp.dir, 'state');
  const moved = join(tmp.dir, 'moved');
  mkdirSync(path, { mode: 0o700 });
  try {
    openState(path).close();
    openState(path).close();
    const [id, again] = installations(path);
    assert.match(String(id), ID, 'the start record carries the installation id');
    assert.equal(again, id, 'a restart keeps it');
    // A supervisor still runs on the state while its directory is moved, and a new state is made at the old path.
    const live = openState(path);
    renameSync(path, moved);
    mkdirSync(path, { mode: 0o700 });
    const replacement = openState(path);
    try {
      const [other] = installations(path);
      assert.match(String(other), ID);
      assert.notEqual(other, id, 'a new state at the same path is another installation');
      // Its sweep selects only its own installation's domains, never the live supervisor's.
      const delegation = join(tmp.dir, 'delegation');
      mkdirSync(delegation);
      mkdirSync(join(delegation, `w-${String(id)}-live`));
      mkdirSync(join(delegation, `w-${String(other)}-orphan`));
      const jail = new CgroupContainment(delegation, String(other), 50);
      const cleaned: string[] = [];
      jail.clean = async domain => {
        cleaned.push(domain.name);
        rmSync(join(domain.root, domain.name), { recursive: true });
        return true;
      };
      await jail.sweep([]);
      assert.deepEqual(cleaned, [`w-${String(other)}-orphan`]);
      assert.ok(existsSync(join(delegation, `w-${String(id)}-live`)), "the live supervisor's domain is never swept");
    } finally {
      replacement.close();
      live.close();
    }
    openState(moved).close();
    assert.deepEqual(installations(moved), [id, id, id, id], 'the moved state keeps its installation');
  } finally {
    tmp.cleanup();
  }
});

test('installation: after its state directory moves, recovery still kills the domain the journal records', async () => {
  const tmp = privateTmp();
  const path = join(tmp.dir, 'state');
  const moved = join(tmp.dir, 'moved');
  const delegation = join(tmp.dir, 'delegation');
  mkdirSync(path, { mode: 0o700 });
  mkdirSync(delegation);
  let state = openState(path);
  const [id] = installations(path);
  let s: Supervisor | undefined;
  try {
    assert.match(String(id), ID, 'the start record carries the installation id');
    s = supervisorOn(state, path, delegation, String(id));
    const cwd = join(tmp.dir, 'cwd');
    mkdirSync(cwd);
    const made = await s.create({ command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' });
    assert.equal(made.state, 'delivered');
    const domain = s.state.require(made.worker_id!).domain!;
    retire(s);
    state.close();
    renameSync(path, moved);
    state = openState(moved);
    const after = installations(moved).at(-1);
    assert.equal(after, id, 'the moved state is the same installation');
    s = supervisorOn(state, moved, delegation, String(after));
    await s.recover();
    assert.ok(existsSync(join(delegation, domain.name, 'cgroup.kill')), 'recovery killed the recorded domain');
    assert.equal(s.get(made.worker_id!).status, 'cleanup_pending', 'and holds the worker until its removal is observed');
  } finally {
    if (s) retire(s);
    state.close();
    tmp.cleanup();
  }
});

test('installation: a recorded domain this cleanup would not accept fails startup before anything is swept or recorded; one of a previous boot does not', async () => {
  const tmp = privateTmp();
  const stateDir = join(tmp.dir, 'state');
  const before = join(tmp.dir, 'delegation-before');
  const after = join(tmp.dir, 'delegation-after');
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(before);
  mkdirSync(after);
  let state = openState(stateDir);
  const [id] = installations(stateDir);
  let s: Supervisor | undefined;
  try {
    assert.match(String(id), ID, 'the start record carries the installation id');
    s = supervisorOn(state, stateDir, before, String(id));
    const cwd = join(tmp.dir, 'cwd');
    mkdirSync(cwd);
    const made = await s.create({ command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' });
    assert.equal(made.state, 'delivered');
    const domain = s.state.require(made.worker_id!).domain!;
    // The delegation changed (another PIW_CGROUP_ROOT): the recorded domain is outside it, so it could never be killed.
    const orphan = join(after, `w-${String(id)}-orphan`);
    mkdirSync(orphan);
    const restart = (delegation: string): Supervisor => {
      retire(s!);
      state.close();
      state = openState(stateDir);
      return (s = supervisorOn(state, stateDir, delegation, String(id)));
    };
    const rows = workerRows(stateDir).length;
    await assert.rejects(restart(after).recover(), (error: unknown) => {
      const refused = error as { code?: string; domains?: string[] };
      assert.equal(refused.code, 'recorded_domain_not_cleanable');
      assert.deepEqual(refused.domains, [join(before, domain.name)]);
      return true;
    }, 'startup fails rather than listening with the recorded domain running');
    assert.equal(workerRows(stateDir).length, rows, 'nothing was recovered or recorded');
    assert.equal(workerRows(stateDir).at(-1)!.status, 'ready');
    assert.equal(existsSync(join(before, domain.name, 'cgroup.kill')), false);
    assert.ok(existsSync(orphan), 'nothing was swept');
    // A domain of a previous boot is gone with that boot's cgroupfs: it refuses nothing.
    rmSync(orphan, { recursive: true });
    const next = restart(after);
    next.state.require(made.worker_id!).domain!.boot = 'a-previous-boot';
    await next.recover();
    assert.equal(next.get(made.worker_id!).status, 'stopped');
  } finally {
    if (s) retire(s);
    state.close();
    tmp.cleanup();
  }
});

const testDaemon = fileURLToPath(new URL('../fixtures/daemon.js', import.meta.url));
const productionDaemon = fileURLToPath(new URL('../../src/main.js', import.meta.url));
const gcHook = new URL('../fixtures/gc.js', import.meta.url).href;

type Started = { child: ChildProcess; outcome: number | null | 'listening' | 'timeout'; stderr: () => string; socket: string };

/**
 * Starts a daemon on `stateDir` with its socket in `run` and XDG_RUNTIME_DIR `runtime`. With `gc` it runs under
 * `--expose-gc` with fixtures/gc.js preloaded, so `collect` can force collections in it.
 */
async function start(main: string, run: string, stateDir: string, runtime: string, opts: { env?: NodeJS.ProcessEnv; gc?: boolean } = {}): Promise<Started> {
  const socket = join(run, 'b2.sock');
  const args = opts.gc ? ['--expose-gc', '--import', gcHook, main] : [main];
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, HOME: runtime, XDG_RUNTIME_DIR: runtime, PIW_SOCKET: socket, PIW_STATE_DIR: stateDir, ...opts.env },
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
  const outcome = await Promise.race([once(child, 'exit').then(([code]) => code as number | null), listening, delay(30_000).then(() => 'timeout' as const)]);
  return { child, outcome, stderr: () => stderr, socket };
}

/** Forces full garbage collections in a daemon started with `gc` and waits until they have run. */
async function collect(daemon: Started): Promise<void> {
  const done = () => daemon.stderr().split('"collected"').length - 1;
  const before = done();
  daemon.child.kill('SIGUSR2');
  for (let n = 0; n < 1000 && done() === before; n++) await delay(10);
  assert.equal(done(), before + 1, `the daemon ran its collections: ${daemon.stderr()}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function kill(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await Promise.race([exited, delay(10_000)]);
  assert.equal(child.signalCode, 'SIGKILL', 'the holder was SIGKILLed');
}

/**
 * The lock-file attack (PR #23 Grok delta 2): removes every regular file under `dirs` (a socket is left), and the file
 * lock b36ca70 kept for `installation` in `/run/user/<euid>/pi-worker-installations`, while its daemon runs.
 */
function unlinkLocks(installation: string, dirs: string[]): void {
  const old = `/run/user/${process.geteuid!()}/pi-worker-installations`;
  for (const file of [`${installation}.lock`, `${installation}.lock-journal`]) rmSync(join(old, file), { force: true });
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.isFile()) unlinkSync(join(dir, entry.name));
    }
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir);
}

const refusal = (stderr: string) => stderr.split('\n').filter(Boolean).map(l => JSON.parse(l) as { event: string; reason?: string }).find(e => e.event === 'refused');

const refusedWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof InstallationRefused, String(error));
  assert.equal(error.code, code);
  return true;
};

/** A fresh installation id: tests of one id may run beside each other on one host and network namespace. */
const freshId = () => randomBytes(10).toString('hex');

test('installation: the installation lock is the abstract Unix socket \\0pi-worker-installation/<id>, named from the id whatever XDG_RUNTIME_DIR says; a second hold of the id is refused installation_in_use, another id is not; any other bind error refuses installation_lock_unavailable', async () => {
  const saved = process.env.XDG_RUNTIME_DIR;
  const id = freshId();
  const held: { release(): void }[] = [];
  try {
    process.env.XDG_RUNTIME_DIR = '/run/piw-test-runtime-a';
    const first = await holdInstallation(id);
    held.push(first);
    assert.equal(first.name, `\0pi-worker-installation/${id}`);
    assert.match(readFileSync('/proc/net/unix', 'utf8'), new RegExp(` @pi-worker-installation/${id}$`, 'm'), 'an abstract name: no file');
    for (const value of ['/run/piw-test-runtime-b', undefined]) {
      if (value === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = value;
      assert.equal(installationName(id), `\0pi-worker-installation/${id}`, `XDG_RUNTIME_DIR=${value ?? '(unset)'} does not move the name`);
      await assert.rejects(holdInstallation(id), refusedWith('installation_in_use'), `XDG_RUNTIME_DIR=${value ?? '(unset)'}: the id is held`);
    }
    // Another installation is another name; the test prefix is another name too.
    held.push(await holdInstallation(freshId()));
    held.push(await holdInstallation(id, 'pi-worker-test/'));
    // A bind that fails for another reason (a name too long for sun_path) refuses startup, typed.
    await assert.rejects(holdInstallation(id, 'x'.repeat(200)), refusedWith('installation_lock_unavailable'));
    // Released, it can be held again.
    first.release();
    held.push(await holdInstallation(id));
  } finally {
    for (const h of held) h.release();
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  }
});

test("installation: a daemon on a copy of a running daemon's state is refused installation_in_use and never listens, after the running daemon garbage-collects, with another XDG_RUNTIME_DIR and socket directory, and after every file in the running daemon's directories is unlinked; it starts once the other is SIGKILLed or stops", { timeout: 90_000 }, async () => {
  const tmp = privateTmp();
  const runtimeA = join(tmp.dir, 'runtime-a');
  const runtimeB = join(tmp.dir, 'runtime-b');
  const a = join(tmp.dir, 'a');
  const b = join(tmp.dir, 'b');
  for (const dir of [runtimeA, runtimeB, a, b]) mkdirSync(dir, { mode: 0o700 });
  const children: ChildProcess[] = [];
  try {
    const created = await start(testDaemon, join(tmp.dir, 'run-a'), a, runtimeA);
    children.push(created.child);
    assert.equal(created.outcome, 'listening', created.stderr());
    await stop(created.child);
    copyFileSync(journalPath(a), journalPath(b));
    const [id] = installations(a);
    assert.match(String(id), ID, 'the start record carries the installation id');
    const first = await start(testDaemon, join(tmp.dir, 'run-a'), a, runtimeA, { gc: true });
    children.push(first.child);
    assert.equal(first.outcome, 'listening', first.stderr());
    // An ordinary collection in the running daemon must not release its installation (PR #23 GPT delta 3, Grok delta 1).
    await collect(first);
    // Nothing on the filesystem holds the installation (PR #23 Grok delta 2).
    unlinkLocks(String(id), [runtimeA, join(tmp.dir, 'run-a')]);
    const second = await start(testDaemon, join(tmp.dir, 'run-b'), b, runtimeB);
    children.push(second.child);
    assert.equal(second.outcome, 1, `the daemon on the copy must exit 1: ${second.stderr()}`);
    assert.equal(refusal(second.stderr())?.reason, 'installation_in_use');
    assert.equal(second.stderr().includes('"listening"'), false);
    assert.equal(existsSync(second.socket), false, 'no socket');
    assert.equal(first.child.exitCode, null, 'the running daemon still runs');
    // The holder's death releases it.
    await kill(first.child);
    const third = await start(testDaemon, join(tmp.dir, 'run-b'), b, runtimeB);
    children.push(third.child);
    assert.equal(third.outcome, 'listening', `a SIGKILLed holder releases the installation: ${third.stderr()}`);
    // So does an orderly shutdown.
    await stop(third.child);
    const fourth = await start(testDaemon, join(tmp.dir, 'run-c'), a, runtimeA);
    children.push(fourth.child);
    assert.equal(fourth.outcome, 'listening', `a stopped holder releases the installation: ${fourth.stderr()}`);
  } finally {
    for (const child of children) await stop(child);
    tmp.cleanup();
  }
});

const populated = (dir: string) => /^populated 1$/m.test(readFileSync(join(dir, 'cgroup.events'), 'utf8'));

test("kernel: a daemon on a copy of a running daemon's state is refused before its sweep, after the running daemon garbage-collects, with another XDG_RUNTIME_DIR, and after the lock files are unlinked: the running daemon's domain keeps running until the holder is SIGKILLed", { skip, timeout: 120_000 }, async () => {
  const tmp = privateTmp();
  const runtimeA = join(tmp.dir, 'runtime-a');
  const runtimeB = join(tmp.dir, 'runtime-b');
  const a = join(tmp.dir, 'a');
  const b = join(tmp.dir, 'b');
  for (const dir of [runtimeA, runtimeB, a, b]) mkdirSync(dir, { mode: 0o700 });
  openState(a).close();
  copyFileSync(journalPath(a), journalPath(b));
  const [id] = installations(a);
  const env = { PIW_CGROUP_ROOT: root };
  const children: ChildProcess[] = [];
  let owned: { jail: CgroupContainment; domain: Domain } | undefined;
  try {
    assert.match(String(id), ID, 'the start record carries the installation id');
    const first = await start(productionDaemon, join(tmp.dir, 'run-a'), a, runtimeA, { env, gc: true });
    children.push(first.child);
    assert.equal(first.outcome, 'listening', first.stderr());
    // A domain of the running installation that the copy's journal does not record (one the running daemon started
    // after the copy was taken): a sweep on the copy would remove it.
    const jail = openContainment(String(id), { ...process.env, ...env });
    const domain = jail.reserve(`live-${process.pid}`);
    owned = { jail, domain };
    const prefix = jail.enter(domain);
    const leader = spawn(prefix[0]!, [...prefix.slice(1), '/bin/sh', '-c', 'echo READY; exec sleep 300'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    children.push(leader);
    await once(leader.stdout!, 'data');
    const dir = join(domain.root, domain.name);
    assert.equal(populated(dir), true);
    // The running daemon garbage-collects (its hold must survive it), and the copy's daemon is started with another
    // runtime directory (it must not lock somewhere else).
    await collect(first);
    const second = await start(productionDaemon, join(tmp.dir, 'run-b'), b, runtimeB, { env });
    children.push(second.child);
    assert.equal(second.outcome, 1, `the daemon on the copy must exit 1: ${second.stderr()}`);
    assert.equal(refusal(second.stderr())?.reason, 'installation_in_use');
    assert.equal(existsSync(second.socket), false, 'no socket');
    // Grok's probe: the lock files are unlinked while the daemon runs, then the copy's daemon starts again.
    unlinkLocks(String(id), [runtimeA, join(tmp.dir, 'run-a')]);
    const third = await start(productionDaemon, join(tmp.dir, 'run-b'), b, runtimeB, { env });
    children.push(third.child);
    assert.equal(third.outcome, 1, `the daemon on the copy must exit 1 after the lock files are unlinked: ${third.stderr()}`);
    assert.equal(refusal(third.stderr())?.reason, 'installation_in_use');
    assert.equal(existsSync(third.socket), false, 'no socket');
    assert.equal(populated(dir), true, "the running daemon's domain keeps running: the copy never swept");
    assert.equal(leader.exitCode, null);
    assert.equal(first.child.exitCode, null, 'the running daemon still runs');
    // The holder's death releases the installation: the copy's daemon now starts, and sweeps the domain its journal
    // does not record.
    await kill(first.child);
    const fourth = await start(productionDaemon, join(tmp.dir, 'run-b'), b, runtimeB, { env });
    children.push(fourth.child);
    assert.equal(fourth.outcome, 'listening', `a SIGKILLed holder releases the installation: ${fourth.stderr()}`);
    assert.equal(existsSync(dir), false, 'the copy swept the domain it does not record');
  } finally {
    for (const child of children) await stop(child);
    if (owned) await owned.jail.clean(owned.domain);
    tmp.cleanup();
  }
});
