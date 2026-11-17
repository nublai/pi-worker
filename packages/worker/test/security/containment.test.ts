/**
 * Cleanup domains (P2-1), ported from A0 `src/test/containment.test.ts` except the sweep cases (P2-2) and the
 * process-group fallback case (dropped: plan decision D3). The supervisor cases run anywhere on the test domains
 * (../domains.ts); the `kernel:` cases need a real delegated cgroup v2 subtree and run only in the kernel tier
 * (`harness/ci/kernel.sh -- containment`, which sets PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT); elsewhere they skip. The
 * portable `containment:` cases drive `CgroupContainment` over a plain directory, so a removed guard fails by
 * assertion in the ordinary tier too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/b2/app.js';
import { createMemoryTransport } from '../../src/b2/memory.js';
import { CgroupContainment, checkDelegation, keeperUnit, openContainment, type Domain } from '../../src/containment/containment.js';
import { bootId, procInfo, processToken } from '../../src/host/process.js';
import { sdkChildEntry } from '../../src/host/host.js';
import { productionHosts } from '../../src/daemon.js';
import type { InventoryFactory } from '../../src/supervisor/features.js';
import { parseJournal, type JournalRecord } from '../../src/journal/journal.js';
import { DEFAULT_RETENTION, goalFor, planCompaction } from '../../src/journal/retention.js';
import { openState } from '../../src/journal/state.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import type { Worker } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { ownerGrant, privateTmp } from '../helpers.js';
import { TestDomains } from '../domains.js';
import { bind, fixture, Host, tick } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT in a delegated user service (harness/ci/kernel.sh)';
const root = process.env.PIW_CGROUP_ROOT ?? '';
const latestWorker = (file: string): Worker => parseJournal(readFileSync(file)).records.filter(r => r.kind === 'worker').at(-1)!.value.worker as Worker;
type ProbeRecord = { inventory_id: string; state: string; domain: Domain };
/** Every inventory probe record, in journal order. */
const probeRecords = (file: string): ProbeRecord[] => parseJournal(readFileSync(file)).records.filter(r => r.kind === 'inventory').map(r => r.value as ProbeRecord);
/** Each probe's latest state. */
const probeStates = (file: string): Record<string, string> => Object.fromEntries(probeRecords(file).map(r => [r.inventory_id, r.state]));

test('cleanup_pending is fsynced before kill; failed empty proof blocks resume and replacement', async () => {
  let confirmed = false;
  let cleanCalls = 0;
  // The status of the worker's latest durable row each time its domain is cleaned (A0 asserted inside clean, where a
  // thrown assertion is swallowed as an unproven cleanup; recording it keeps the assertion effective).
  const atKill: string[] = [];
  const domains = new TestDomains();
  const f = fixture({ domains });
  domains.clean = async () => {
    cleanCalls++;
    atKill.push(latestWorker(f.journalFile).status);
    return confirmed;
  };
  try {
    const w = await f.create();
    const stopped = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(stopped.state, 'outcome_unknown');
    assert.equal(f.supervisor.get(w.worker_id).status, 'cleanup_pending');
    await assert.rejects(f.supervisor.rebind(w.worker_id, { ...bind(w, 'resume'), action: 'resume', target_session_id: w.session_id! }), /cleanup_pending_or_worker_not_ready/);
    await assert.rejects(f.supervisor.create({ command_id: 'replacement', cwd: w.cwd, provider: 'p', model: 'm', thinking: 'off' }), /exclusive_environment/);
    const recovered = await f.restart();
    assert.equal(recovered.get(w.worker_id).status, 'cleanup_pending');
    assert.equal(cleanCalls, 2);
    confirmed = true;
    const again = await f.restart();
    assert.equal(again.get(w.worker_id).cleanup, 'cgroup_empty_removed');
    assert.equal(again.get(w.worker_id).status, 'stopped');
    assert.deepEqual(atKill, ['cleanup_pending', 'cleanup_pending', 'cleanup_pending'], 'cleanup_pending is durable before every kill');
    const owner = ownerGrant(f.dir);
    const hello = await createMemoryTransport(createApp({ supervisor: again, grants: owner.grants, cleanupProfile: domains.profile }).handle, owner.headers).request('GET', '/b2/hello');
    assert.match(JSON.stringify((hello.body as { named_limits: string[] }).named_limits), /test_domains/);
  } finally {
    f.cleanup();
  }
});

test('a failed journal still permits fault termination but never records cleanup as confirmed', async () => {
  let killed = 0;
  const domains = new TestDomains();
  const clean = domains.clean.bind(domains);
  domains.clean = async domain => {
    killed++;
    return clean(domain);
  };
  const f = fixture({ domains });
  try {
    const c = await f.create();
    f.state.journal.failed = true;
    f.hosts[0]!.emit('event', { type: 'host_identity', sessionId: 'changed-behind-supervisor', sessionFile: '/bad' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(killed, 1, 'storage failure must not suppress the cgroup kill');
    assert.equal(f.supervisor.get(c.worker_id).status, 'cleanup_pending', 'no durable proof means no lease release');
  } finally {
    f.cleanup();
  }
});

test('containment: an inventory probe runs in its own domain, recorded before it is spawned; only the domain removal, recorded, ends it', async () => {
  const f = fixture();
  try {
    const probe = new Host(f.dir, 'none', join(f.dir, 'none.jsonl'));
    let atSpawn: { name: string; domain: Domain; prefix: readonly string[]; records: ProbeRecord[] } | undefined;
    f.supervisor.features.inventory = f.domains.track(launch => {
      atSpawn = { name: launch.domain.name, domain: launch.domain, prefix: launch.prefix, records: probeRecords(f.journalFile) };
      return probe;
    });
    const cwd = join(f.dir, 'probe');
    mkdirSync(cwd);
    assert.equal((await f.supervisor.features.models({ cwd })).evidence, 'pi_inventory_process');
    assert.match(atSpawn!.name, /^w-inventory-/);
    assert.deepEqual(
      atSpawn!.records.map(r => [r.state, r.domain]),
      [['started', atSpawn!.domain]],
      'the probe domain is durable before the probe is spawned',
    );
    assert.deepEqual(f.domains.cleaned.map(d => d.name), [atSpawn!.name], 'the probe ends by cleaning its domain');
    assert.equal(probe.stops, 1, 'cleaning the domain is what stopped the probe');
    assert.deepEqual(probeRecords(f.journalFile).map(r => r.state), ['started', 'cleaned'], 'its removal is recorded');
    assert.deepEqual(f.supervisor.features.pendingProbes(), []);
    // A probe that fails to answer is cleaned the same way before the failure is returned.
    probe.features = {};
    f.supervisor.features.inventory = f.domains.track(() => {
      const failing = new Host(f.dir, 'none', join(f.dir, 'none.jsonl'));
      failing.request = async () => ({ type: 'response', id: 'x', success: false, error: 'boom' });
      return failing;
    });
    await assert.rejects(f.supervisor.features.commands({ cwd }), /pi_features_unavailable/);
    assert.equal(f.domains.cleaned.length, 2);
    assert.deepEqual(Object.values(probeStates(f.journalFile)), ['cleaned', 'cleaned']);
  } finally {
    f.cleanup();
  }
});

test('containment: an inventory probe whose cleanup is unproven, or cut by a supervisor crash, stays recorded; recovery cleans it before listening', async () => {
  const domains = new TestDomains();
  const f = fixture({ domains });
  try {
    const probes: Host[] = [];
    const install = (answer: boolean) => {
      f.supervisor.features.inventory = domains.track(() => {
        const h = new Host(f.dir, 'none', join(f.dir, 'none.jsonl'));
        if (!answer) h.request = () => new Promise(() => {});
        probes.push(h);
        return h;
      });
    };
    const cwd = join(f.dir, 'probe');
    mkdirSync(cwd);
    // The domain removal is not observed: the call is refused and the probe stays recorded.
    install(true);
    domains.confirm = false;
    await assert.rejects(f.supervisor.features.models({ cwd }), /inventory_cleanup_unproven/);
    const [unproven] = f.supervisor.features.pendingProbes();
    assert.ok(unproven, 'an unproven probe stays recorded');
    assert.deepEqual(probeStates(f.journalFile), { [unproven]: 'started' }, 'no confirmation without an observed removal');
    // The supervisor crashes mid-probe: the probe never answers and nothing in this instance cleans it.
    domains.confirm = true;
    install(false);
    void f.supervisor.features.models({ cwd }).catch(() => {});
    await tick();
    const crashed = f.supervisor.features.pendingProbes().find(id => id !== unproven);
    assert.ok(crashed, 'the probe was recorded before it started');
    const before = domains.cleaned.length;
    const recovered = await f.restart();
    assert.deepEqual(recovered.features.pendingProbes(), [], 'recovery cleaned every recorded probe');
    assert.deepEqual(probeStates(f.journalFile), { [unproven]: 'cleaned', [crashed]: 'cleaned' });
    assert.deepEqual(
      domains.cleaned.slice(before).map(d => d.name).sort(),
      probeRecords(f.journalFile).filter(r => r.state === 'started').map(r => r.domain.name).sort(),
      'recovery cleaned each recorded probe domain',
    );
    assert.ok(probes[1]!.stops >= 1, 'the crashed probe was stopped by its domain cleanup');
  } finally {
    f.cleanup();
  }
});

test('containment: compaction keeps every inventory probe record whose cleanup is not confirmed, and drops confirmed ones', () => {
  const domain = (n: string): Domain => ({ root: '/test-domains', name: `w-inventory-${n}`, boot: 'test' });
  const records: JournalRecord[] = [
    { seq: 1, kind: 'supervisor', value: { supervisor_id: 's', supervisor_epoch: 'e', state_version: 2 } },
    { seq: 2, kind: 'inventory', value: { inventory_id: 'pending', state: 'started', domain: domain('pending') } },
    { seq: 3, kind: 'inventory', value: { inventory_id: 'done', state: 'started', domain: domain('done') } },
    { seq: 4, kind: 'inventory', value: { inventory_id: 'done', state: 'cleaned', domain: domain('done') } },
  ];
  const limits = { ...DEFAULT_RETENTION };
  const plan = planCompaction(records, { limits, goal: goalFor(limits), now: Date.now(), inFlight: new Set() });
  assert.deepEqual(
    plan.entries.filter(e => e.kind === 'inventory').map(e => e.value),
    [{ inventory_id: 'pending', state: 'started', domain: domain('pending') }],
    'recovery can still clean an unconfirmed probe from the compacted journal alone',
  );
});

test('containment: every pi process the production daemon starts, a worker or an inventory probe, runs through its domain join prefix', { timeout: 30_000 }, async () => {
  const tmp = privateTmp();
  try {
    const hosts = productionHosts({ PATH: process.env.PATH, HOME: tmp.dir, PI_CODING_AGENT_DIR: join(tmp.dir, 'agent') });
    const domain: Domain = { root: '/test-domains', name: 'w-prefix', boot: 'test' };
    // A join stand-in that records what it would run inside the domain, then exits without running it.
    const prefix = (marker: string) => ['/bin/sh', '-c', 'printf "%s\\n" "$@" > "$0.tmp" && mv "$0.tmp" "$0"', marker];
    const worker = join(tmp.dir, 'worker.argv');
    const probe = join(tmp.dir, 'probe.argv');
    const started = [
      hosts.factory({ workerId: 'w', create: { command_id: 'c', cwd: tmp.dir, provider: 'p', model: 'm', thinking: 'off' }, cwd: tmp.dir, sessionDir: tmp.dir, domain, prefix: prefix(worker) }),
      hosts.inventory({ cwd: tmp.dir, projectTrusted: false, domain, prefix: prefix(probe) }),
    ];
    try {
      for (const marker of [worker, probe]) {
        for (let n = 0; n < 500 && !existsSync(marker); n++) await delay(10);
        assert.ok(existsSync(marker), `${marker}: pi was started through the domain join prefix`);
        assert.ok(readFileSync(marker, 'utf8').split('\n').includes(sdkChildEntry), `${marker}: the prefix runs pi's SDK child`);
      }
      assert.match(readFileSync(probe, 'utf8'), /"inventory":true/);
    } finally {
      for (const h of started) await h.stop();
    }
  } finally {
    tmp.cleanup();
  }
});

/** A plain directory standing in for a delegation: enough for identity, join and removal checks without a kernel. */
function plainRoot(): { dir: string; root: string; jail: CgroupContainment; cleanup: () => void } {
  const tmp = privateTmp();
  const rootDir = join(tmp.dir, 'delegation');
  mkdirSync(rootDir);
  return { dir: tmp.dir, root: rootDir, jail: new CgroupContainment(rootDir, 200), cleanup: tmp.cleanup };
}

test('containment: a domain is never reused, and a join that cannot enter its domain runs nothing (exit 125)', () => {
  const p = plainRoot();
  try {
    const domain = p.jail.reserve(randomUUID());
    assert.deepEqual([domain.root, domain.boot], [p.root, bootId()]);
    const prefix = p.jail.enter(domain);
    assert.ok(existsSync(join(p.root, domain.name)), 'enter creates the domain');
    assert.throws(() => p.jail.enter(domain), /already exists/, 'an existing domain is never entered again');
    assert.throws(() => p.jail.enter({ ...domain, boot: 'another-boot' }), /stale cleanup boot/);
    // The domain was cleaned (removed) before a delayed wrapper got to run: it must not run its payload anywhere.
    rmdirSync(join(p.root, domain.name));
    const marker = join(p.dir, 'ran');
    const late = spawnSync(prefix[0]!, [...prefix.slice(1), '/bin/sh', '-c', 'echo RAN > "$0"', marker], { encoding: 'utf8' });
    assert.equal(late.status, 125, `the join refuses: ${late.stderr}`);
    assert.equal(existsSync(marker), false, 'no payload ran outside its domain');
  } finally {
    p.cleanup();
  }
});

test('containment: clean confirms only a removed domain of its own delegation', async () => {
  const p = plainRoot();
  try {
    const name = (n: string) => `w-${n}`;
    const at = (n: string) => join(p.root, name(n));
    const domain = (n: string, over: Partial<Domain> = {}): Domain => ({ root: p.root, name: name(n), boot: bootId(), ...over });
    // Absent, or of a prior boot: nothing can still run in it.
    assert.equal(await p.jail.clean(domain('absent')), true);
    assert.equal(await p.jail.clean(domain('old-boot', { boot: 'another-boot' })), true);
    // Another delegation's domain, or a name that is not a worker domain's, is never touched or confirmed.
    const foreign = join(p.dir, 'other');
    mkdirSync(join(foreign, 'w-x'), { recursive: true });
    assert.equal(await p.jail.clean({ root: foreign, name: 'w-x', boot: bootId() }), false);
    assert.ok(existsSync(join(foreign, 'w-x')), 'a foreign domain survives');
    assert.equal(existsSync(join(foreign, 'w-x', 'cgroup.kill')), false, 'a foreign domain is never killed');
    mkdirSync(join(p.root, 'not-a-worker'));
    assert.equal(await p.jail.clean({ root: p.root, name: 'not-a-worker', boot: bootId() }), false);
    assert.ok(existsSync(join(p.root, 'not-a-worker')));
    assert.equal(existsSync(join(p.root, 'not-a-worker', 'cgroup.kill')), false, 'a cgroup that is not a worker domain is never killed');
    // Still populated: killed, never confirmed.
    mkdirSync(at('busy'));
    writeFileSync(join(at('busy'), 'cgroup.events'), 'populated 1\nfrozen 0\n');
    assert.equal(await p.jail.clean(domain('busy')), false);
    assert.equal(readFileSync(join(at('busy'), 'cgroup.kill'), 'utf8'), '1\n', 'cgroup.kill was written');
    assert.ok(existsSync(at('busy')));
    // Empty but its removal fails: an error is never confirmation.
    mkdirSync(at('stuck'));
    writeFileSync(join(at('stuck'), 'cgroup.events'), 'populated 0\nfrozen 0\n');
    assert.equal(await p.jail.clean(domain('stuck')), false);
    assert.ok(existsSync(at('stuck')));
    // Removal of an empty domain with nested cgroups is a kernel case (the kernel: tests below).
  } finally {
    p.cleanup();
  }
});

const daemonMain = fileURLToPath(new URL('../../src/main.js', import.meta.url));

test('containment: the daemon refuses to start without a cgroup delegation and never listens', { timeout: 30_000 }, async () => {
  const tmp = privateTmp();
  const socket = join(tmp.dir, 'run', 'b2.sock');
  const notCgroup = join(tmp.dir, 'not-a-cgroup');
  mkdirSync(notCgroup);
  assert.throws(() => checkDelegation(notCgroup), /cgroup v2 mount/);
  assert.throws(() => checkDelegation(join(tmp.dir, 'missing')), /does not exist/);
  const child = spawn(process.execPath, [daemonMain], {
    env: { PATH: process.env.PATH, PIW_SOCKET: socket, PIW_STATE_DIR: join(tmp.dir, 'state'), PIW_CGROUP_ROOT: notCgroup },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => (stderr += chunk));
    const outcome = await Promise.race([
      once(child, 'exit').then(([code]) => ({ code: code as number | null | 'listening' | 'timeout' })),
      new Promise<{ code: 'listening' }>(resolve => child.stderr!.on('data', () => stderr.includes('"listening"') && resolve({ code: 'listening' }))),
      delay(20_000).then(() => ({ code: 'timeout' as const })),
    ]);
    assert.equal(outcome.code, 1, `the daemon must exit 1: ${stderr}`);
    assert.match(stderr, /"refused"/);
    assert.match(stderr, /no_cgroup_delegation/);
    assert.equal(stderr.includes('"listening"'), false);
    assert.equal(existsSync(socket), false, 'no socket');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    tmp.cleanup();
  }
});

/** Runs `script` inside `domain` through the containment's join prefix. */
const inDomain = (prefix: readonly string[], script: string, args: string[], stdin: 'ignore' | 'pipe' = 'ignore'): ChildProcess =>
  spawn(prefix[0]!, [...prefix.slice(1), '/bin/sh', '-c', script, 'payload', ...args], { stdio: [stdin, 'pipe', 'pipe'], detached: true });

/** A double fork with setsid and nohup: the grandchild leaves the leader's process group and session. */
const DETACHED = `(setsid nohup /bin/sh -c 'echo $$ > "$1"; sleep 2; echo ESCAPED > "$2"' detached "$1" "$2" >/dev/null 2>&1 &); echo READY`;

const gone = (pid: number) => !procInfo(pid) || procInfo(pid)?.state === 'Z';

test('kernel: real leader crash kills a detached grandchild without stop or restart', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const dir = tmp.dir;
  const state = openState(dir);
  const jail = new CgroupContainment(checkDelegation(root));
  const marker = join(dir, 'escaped');
  const pidFile = join(dir, 'grandchild.pid');
  let leader: ChildProcess | undefined;
  const s = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir: dir,
    containment: jail,
    factory: launch => {
      const file = join(launch.sessionDir, 's.jsonl');
      writeFileSync(file, '{"type":"session","id":"s"}\n');
      leader = inDomain(launch.prefix, `${DETACHED}; read line`, [pidFile, marker], 'pipe');
      const h = new Host(launch.sessionDir, 's', file);
      h.pid = leader.pid;
      h.token = processToken(leader.pid!);
      leader.once('exit', () => h.emit('exit'));
      return h;
    },
  });
  try {
    const made = await s.create({ command_id: 'create', cwd: dir, provider: 'p', model: 'm', thinking: 'off' });
    assert.equal(made.state, 'delivered');
    for (let n = 0; n < 200 && !existsSync(pidFile); n++) await delay(10);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    process.kill(grandchild, 0);
    const domain = s.state.require(made.worker_id!).domain!;
    assert.match(readFileSync(join(root, domain.name, 'cgroup.procs'), 'utf8'), new RegExp(`^${grandchild}$`, 'm'), 'the detached grandchild is in the domain');
    const exited = once(leader!, 'exit');
    process.kill(leader!.pid!, 'SIGKILL');
    await exited;
    for (let n = 0; n < 600 && s.get(made.worker_id!).status === 'cleanup_pending'; n++) await delay(10);
    assert.equal(s.get(made.worker_id!).cleanup, 'cgroup_empty_removed');
    assert.equal(existsSync(join(root, domain.name)), false);
    assert.ok(gone(grandchild), 'the grandchild is dead');
    await delay(2200);
    assert.equal(existsSync(marker), false);
  } finally {
    await s.shutdown();
    state.close();
    tmp.cleanup();
  }
});

for (const cut of ['stop', 'restart'] as const) {
  test(`kernel: real cgroup ${cut} kills setsid/nohup grandchild and retires the pre-exec join target`, { skip, timeout: 60_000 }, async () => {
    const jail = new CgroupContainment(checkDelegation(root));
    const unit = jail.reserve(randomUUID());
    const tmp = privateTmp();
    const marker = join(tmp.dir, 'escaped');
    const pidFile = join(tmp.dir, 'grandchild.pid');
    try {
      const prefix = jail.enter(unit);
      const child = inDomain(prefix, `${DETACHED}; wait`, [pidFile, marker]);
      await once(child.stdout!, 'data');
      for (let n = 0; n < 200 && !existsSync(pidFile); n++) await delay(10);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => jail.enter(unit), /already exists/);
      if (cut === 'restart') {
        // Lose the process handle, recover solely from the journal-safe identity.
        const reopened = new CgroupContainment(checkDelegation(root));
        assert.equal(await reopened.clean(JSON.parse(JSON.stringify(unit)) as Domain), true);
      } else assert.equal(await jail.clean(unit), true);
      assert.equal(existsSync(join(root, unit.name)), false);
      assert.ok(gone(grandchild), 'the grandchild is dead');
      // A wrapper that had not joined yet can never join the retired domain: it runs nothing.
      const late = spawnSync(prefix[0]!, [...prefix.slice(1), '/bin/sh', '-c', 'echo RAN > "$0"', marker], { encoding: 'utf8' });
      assert.equal(late.status, 125);
      await delay(2200);
      assert.equal(existsSync(marker), false);
    } finally {
      await jail.clean(unit);
      tmp.cleanup();
    }
  });
}

test('kernel: a supervisor stop kills the worker domain with its detached grandchild; the domain is removed and recorded', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const state = openState(tmp.dir);
  const jail = new CgroupContainment(checkDelegation(root));
  const marker = join(tmp.dir, 'escaped');
  const pidFile = join(tmp.dir, 'grandchild.pid');
  const s = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir: tmp.dir,
    containment: jail,
    factory: launch => {
      const file = join(launch.sessionDir, 's.jsonl');
      writeFileSync(file, '{"type":"session","id":"s"}\n');
      const leader = inDomain(launch.prefix, `${DETACHED}; read line`, [pidFile, marker], 'pipe');
      const h = new Host(launch.sessionDir, 's', file);
      h.pid = leader.pid;
      h.token = processToken(leader.pid!);
      // A host's own stop is never the proof: the domain is.
      h.stopOk = false;
      leader.once('exit', () => h.emit('exit'));
      return h;
    },
  });
  try {
    const made = await s.create({ command_id: 'create', cwd: tmp.dir, provider: 'p', model: 'm', thinking: 'off' });
    const w = s.get(made.worker_id!);
    for (let n = 0; n < 200 && !existsSync(pidFile); n++) await delay(10);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    const domain = s.state.require(w.worker_id).domain!;
    const stopped = await s.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(stopped.result?.termination, 'observed_stopped');
    assert.deepEqual([s.get(w.worker_id).status, s.get(w.worker_id).cleanup], ['stopped', 'cgroup_empty_removed']);
    assert.equal(latestWorker(state.journal.file).cleanup, 'cgroup_empty_removed', 'durable');
    assert.equal(existsSync(join(root, domain.name)), false);
    assert.ok(gone(grandchild));
    await delay(2200);
    assert.equal(existsSync(marker), false);
  } finally {
    await s.shutdown();
    state.close();
    tmp.cleanup();
  }
});

/**
 * An inventory probe in a real domain whose leader double-forks a setsid grandchild before it answers (or, for a crash,
 * never answers). Its own stop is never the proof. `seen` records the grandchild and its domain membership.
 */
function detachingProbe(dir: string, answer: boolean) {
  const pidFile = join(dir, 'grandchild.pid');
  const marker = join(dir, 'escaped');
  const seen: { grandchild?: number; member?: boolean; domain?: Domain } = {};
  const factory: InventoryFactory = launch => {
    const leader = inDomain(launch.prefix, `${DETACHED}; read line`, [pidFile, marker], 'pipe');
    const h = new Host(dir, 'none', join(dir, 'none.jsonl'));
    h.pid = leader.pid;
    h.token = processToken(leader.pid!);
    h.stopOk = false;
    leader.once('exit', () => h.emit('exit'));
    const native = h.request.bind(h);
    h.request = async c => {
      for (let n = 0; n < 300 && !(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()); n++) await delay(10);
      seen.grandchild = Number(readFileSync(pidFile, 'utf8'));
      seen.member = new RegExp(`^${seen.grandchild}$`, 'm').test(readFileSync(join(launch.domain.root, launch.domain.name, 'cgroup.procs'), 'utf8'));
      seen.domain = launch.domain;
      return answer ? native(c) : new Promise<never>(() => {});
    };
    return h;
  };
  return { factory, seen, marker };
}

const noWorker = () => {
  throw new Error('no worker in this test');
};

test('kernel: an inventory probe runs in a real domain; its setsid grandchild dies when the probe ends', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const state = openState(tmp.dir);
  const probe = detachingProbe(tmp.dir, true);
  const s = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir: tmp.dir,
    containment: new CgroupContainment(checkDelegation(root)),
    factory: noWorker,
    inventory: probe.factory,
  });
  try {
    assert.equal((await s.features.models({ cwd: tmp.dir })).evidence, 'pi_inventory_process');
    assert.equal(probe.seen.member, true, 'the detached grandchild was in the probe domain');
    assert.ok(gone(probe.seen.grandchild!), 'the grandchild is dead');
    assert.equal(existsSync(join(root, probe.seen.domain!.name)), false, 'the domain is removed');
    assert.deepEqual(probeRecords(state.journal.file).map(r => r.state), ['started', 'cleaned']);
    await delay(2200);
    assert.equal(existsSync(probe.marker), false);
  } finally {
    await s.shutdown();
    state.close();
    tmp.cleanup();
  }
});

test('kernel: a supervisor crash mid-probe leaves the probe recorded; recovery kills its setsid grandchild and removes the domain', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const probe = detachingProbe(tmp.dir, false);
  let state = openState(tmp.dir);
  const options = (opened: typeof state) => ({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: tmp.dir,
    containment: new CgroupContainment(checkDelegation(root)),
    factory: noWorker,
  });
  const first = new Supervisor({ ...options(state), inventory: probe.factory });
  let second: Supervisor | undefined;
  try {
    void first.features.models({ cwd: tmp.dir }).catch(() => {});
    for (let n = 0; n < 500 && probe.seen.member === undefined; n++) await delay(10);
    assert.equal(probe.seen.member, true, 'the detached grandchild is in the probe domain');
    assert.equal(gone(probe.seen.grandchild!), false, 'it runs while the probe runs');
    // The supervisor dies: nothing of it cleans anything; its journal is closed and a new one recovers.
    state.close();
    state = openState(tmp.dir);
    assert.deepEqual(probeRecords(state.journal.file).map(r => [r.state, r.domain.name]), [['started', probe.seen.domain!.name]], 'the probe was recorded before it ran');
    second = new Supervisor(options(state));
    await second.recover();
    assert.ok(gone(probe.seen.grandchild!), 'recovery killed the grandchild');
    assert.equal(existsSync(join(root, probe.seen.domain!.name)), false, 'the domain is removed');
    assert.deepEqual(probeRecords(state.journal.file).map(r => r.state), ['started', 'cleaned']);
    assert.deepEqual(second.features.pendingProbes(), []);
    await delay(2200);
    assert.equal(existsSync(probe.marker), false);
  } finally {
    if (probe.seen.domain) await new CgroupContainment(checkDelegation(root)).clean(probe.seen.domain);
    await second?.shutdown();
    state.close();
    tmp.cleanup();
  }
});

test('kernel: without PIW_CGROUP_ROOT the daemon keeps an installation-scoped delegated user service', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const unit = keeperUnit(tmp.dir);
  const env = { ...process.env };
  delete env.PIW_CGROUP_ROOT;
  try {
    const jail = openContainment(tmp.dir, env);
    const group = execFileSync('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value'], { encoding: 'utf8' }).trim();
    assert.equal(jail.root, join('/sys/fs/cgroup', group));
    assert.equal(openContainment(tmp.dir, env).root, jail.root, 'the same installation reuses its service');
    const domain = jail.reserve(randomUUID());
    const child = inDomain(jail.enter(domain), 'echo READY; exec sleep 300', []);
    await once(child.stdout!, 'data');
    assert.match(readFileSync(join(jail.root, domain.name, 'cgroup.procs'), 'utf8'), new RegExp(`^${child.pid}$`, 'm'));
    assert.equal(await jail.clean(domain), true);
    assert.equal(existsSync(join(jail.root, domain.name)), false);
  } finally {
    spawnSync('systemctl', ['--user', 'stop', unit]);
    rmSync(tmp.dir, { recursive: true, force: true });
  }
});

