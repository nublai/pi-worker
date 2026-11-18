/**
 * Profile staging for sandboxed children (P2-7), ported from A0 `src/test/gate1-fix.test.ts` (every case except
 * `kernel D1`, a channel child, which is in channel.test.ts since P2-8) and the `security-fix.test.ts` B2 staging
 * case, plus new cases: links and limits in the copy, a cleanup that never follows a link, the validation refusals, the
 * dependency mount point and descriptors, and a kernel case (real bwrap and pi) reading the dependency tree read-only.
 *
 * A0 launched its children through a sandboxed parent's channel (channel.test.ts since P2-8); here a sandboxed child's
 * parent is an unsandboxed typed worker and the child is created through `workers.create` (the supervisor's `create`), so A0's
 * channel reply body (`error`, `effect`, `state`) is read from the create's receipt, which carries the same fields.
 * A0's `.a0-agent` is `.piw-agent`. Cases named `kernel` run real bwrap and pi: `harness/ci/kernel.sh -- staging`
 * (PIW_TEST_KERNEL=1, PIW_CGROUP_ROOT); elsewhere they skip.
 *
 * Every sandbox and child environment here is synthetic (never process.env), so no credential can reach an argv or a
 * message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProvenNoEffect, Refusal } from '../../src/b2/errors.js';
import { CgroupContainment, checkDelegation, type Domain } from '../../src/containment/containment.js';
import { productionHosts } from '../../src/daemon.js';
import { GrantStore } from '../../src/grants/store.js';
import type { SdkHost } from '../../src/host/host.js';
import { openState } from '../../src/journal/state.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import { openPinned } from '../../src/sandbox/pinned-fs.js';
import { inside, locateBwrap, sandboxLaunch } from '../../src/sandbox/sandbox.js';
import { PROFILE_LIMITS, removeTreeAt, stageProfileAt, type DependencyBind } from '../../src/sandbox/staging.js';
import type { Create, Worker } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { privateTmp } from '../helpers.js';
import { bind, fixture, Host } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT in a delegated user service with bwrap (harness/ci/kernel.sh)';

type Spec = NonNullable<Create['launch_spec']>;
/** The complete environment inside a recorded sandbox launch: synthetic, never process.env. */
const SANDBOX_ENV: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/tmp/piw-home', LANG: 'C' };

/**
 * Shape of a real staged pi profile: a few config files plus a large npm/node_modules tree (the real one has 18,801
 * entries; this one more than 20,000).
 */
function realisticProfile(profile: string, packages = 2300): number {
  mkdirSync(join(profile, 'extensions', 'provider'), { recursive: true });
  writeFileSync(join(profile, 'extensions', 'provider', 'index.ts'), 'export default () => {};\n');
  writeFileSync(join(profile, 'settings.json'), '{"packages":[]}\n');
  writeFileSync(join(profile, 'models-store.json'), '{}');
  writeFileSync(join(profile, 'npm-package.json'), '{}');
  const modules = join(profile, 'npm', 'node_modules');
  mkdirSync(join(modules, '.bin'), { recursive: true });
  for (let i = 0; i < packages; i++) {
    const pkg = join(modules, `pkg-${i}`);
    mkdirSync(join(pkg, 'lib'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), `{"name":"pkg-${i}","version":"1.0.0"}`);
    for (const name of ['index.js', 'README.md', 'LICENSE']) writeFileSync(join(pkg, name), 'x');
    for (const name of ['a.js', 'b.js', 'c.js']) writeFileSync(join(pkg, 'lib', name), 'y');
    if (i % 50 === 0) symlinkSync(`../pkg-${i}/index.js`, join(modules, '.bin', `pkg-${i}`));
  }
  return count(profile) + 1;
}
const count = (dir: string): number => (existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0);
const tree = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

interface Recorded {
  readonly cwd: string;
  readonly args: string[];
  readonly dependencies: { dest: string[]; ino: number; dev: number }[];
}

/**
 * A fixture supervisor and, in a tree beside its state, an unsandboxed typed parent (cwd `tree/parent`, profile
 * `tree/parent/.piw-agent`) with a running execution. Each sandboxed child launch records what its sandbox would bind,
 * while the dependency descriptors are still open, then gets a fake host. `child(name)` is a sandboxed child's create
 * with root and cwd `tree/<name>`.
 */
async function stagingFixture(config: { unconfirmedIdentity?: boolean } = {}) {
  const launches: Recorded[] = [];
  const f = fixture({
    ...config,
    launch: launch => {
      if (!launch.sandbox) return undefined;
      const deps = launch.dependencies ?? [];
      const box = sandboxLaunch(launch.sandbox, '/bin/true', [], { env: SANDBOX_ENV, ...(launch.gitPin !== undefined ? { gitPin: launch.gitPin } : {}), dependencies: deps });
      box.close();
      launches.push({ cwd: launch.cwd, args: box.args, dependencies: deps.map(d => ({ dest: [...d.dest], ino: fstatSync(d.fd).ino, dev: fstatSync(d.fd).dev })) });
      const sid = `sandboxed-${launch.workerId}`;
      const file = join(launch.sessionDir, `${sid}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid })}\n`);
      return new Host(launch.sessionDir, sid, file);
    },
  });
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const parentCwd = join(root, 'parent');
  const profile = join(parentCwd, '.piw-agent');
  mkdirSync(profile, { recursive: true });
  const spec: Spec = { environment: { id: 'family', revision: 1, root, allowed_methods: ['children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
  const made = await f.supervisor.create({ command_id: 'parent', cwd: parentCwd, provider: 'p', model: 'm', thinking: 'off', launch_spec: spec });
  assert.equal(made.state, 'delivered', JSON.stringify(made));
  const p = f.supervisor.get(made.worker_id!);
  assert.equal((await f.supervisor.prompt(p.worker_id, { ...bind(p, 'parent-run'), message: 'run' })).state, 'delivered');
  const w = f.supervisor.get(p.worker_id);
  const child = (command_id: string, cwd: string, extra: Partial<Spec> = {}): Create => ({
    command_id,
    cwd,
    provider: 'p',
    model: 'm',
    thinking: 'off',
    parent: { worker_id: w.worker_id, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision, execution_id: w.execution!.execution_id, task_id: `task-${command_id}`, generation_id: 'gen' },
    launch_spec: { ...spec, role: 'child', environment: { id: cwd, revision: 1, allowed_methods: ['children.report'], filesystem: 'bwrap', root: cwd }, ...extra },
  });
  const worktree = (name: string) => {
    const cwd = join(root, name);
    mkdirSync(cwd);
    return cwd;
  };
  const cleanup = () => {
    f.cleanup();
    tmp.cleanup();
  };
  return { f, s: f.supervisor, root, parentCwd, profile, w, child, worktree, launches, cleanup };
}
const children = (s: Supervisor, parent: string): Worker[] => s.list().filter(x => x.parent_worker_id === parent);
const failure = (w: Worker) => w.failure;
/** The lifecycle's staging cleanup seam (A0 `Supervisor.stagingCleanup`). */
const seam = (s: Supervisor) => s.lifecycle as unknown as { stagingCleanup: (rootFd: number) => void };

// ---- ported from A0 gate1-fix.test.ts ----

test('D1: a real-size profile (20k+ entries, node_modules shape) stages small and binds its dependency tree read-only by descriptor', { timeout: 120_000 }, async () => {
  const x = await stagingFixture();
  try {
    const total = realisticProfile(x.profile);
    assert.ok(total > 20000, `fixture must exceed the real profile (${total})`);
    const cwd = x.worktree('big');
    const launched = await x.s.create(x.child('big', cwd));
    assert.equal(launched.state, 'delivered', JSON.stringify(launched));
    const staged = join(cwd, '.piw-agent');
    // Only mutable/config files are copied; the dependency tree is a mount point.
    assert.ok(count(staged) < 50, `staged copy must stay small (${count(staged)} entries)`);
    assert.equal(statSync(join(staged, 'npm', 'node_modules')).isDirectory(), true);
    assert.deepEqual(readdirSync(join(staged, 'npm', 'node_modules')), [], 'dependency mount point holds no copied entries');
    assert.equal(readFileSync(join(staged, 'settings.json'), 'utf8'), '{"packages":[]}\n');
    // The sandbox binds the PARENT's dependency directory itself, read-only.
    const launch = x.launches.find(l => l.cwd === cwd)!;
    assert.ok(launch, 'child host launched');
    const source = statSync(join(x.profile, 'npm', 'node_modules'));
    assert.deepEqual(
      launch.dependencies.map(d => ({ dest: d.dest, ino: d.ino, dev: d.dev })),
      [{ dest: ['npm', 'node_modules'], ino: source.ino, dev: source.dev }],
    );
    const at = launch.args.findIndex((a, i) => a === '--ro-bind-fd' && launch.args[i + 2] === join(staged, 'npm', 'node_modules'));
    assert.ok(at >= 0, 'dependency tree is mounted with --ro-bind-fd at the staged mount point');
    assert.equal(
      launch.args.some((a, i) => a === '--bind-fd' && launch.args[i + 2]?.includes('node_modules')),
      false,
      'never a writable dependency bind',
    );
    // P2-7: once the factory returned, the supervisor holds no descriptor of the dependency tree.
    const held = readdirSync('/proc/self/fd').flatMap(fd => {
      try {
        return [readlinkSync(`/proc/self/fd/${fd}`)];
      } catch {
        return [];
      }
    });
    assert.deepEqual(held.filter(target => inside(x.profile, target)), [], 'the supervisor keeps no dependency descriptor open');
  } finally {
    x.cleanup();
  }
});

test('D1: the copied part keeps its entry budget; a refusal after dispatch removes the partial copy and is outcome_unknown', { timeout: 120_000 }, async () => {
  const x = await stagingFixture();
  try {
    const big = join(x.profile, 'extensions', 'big');
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 10050; i++) writeFileSync(join(big, `f${i}`), 'x');
    const cwd = x.worktree('over');
    const r = await x.s.create(x.child('over', cwd));
    assert.equal(r.error, 'profile_copy_too_many_entries', JSON.stringify(r));
    // Staging created files; an absent name is not proof the inode is gone.
    assert.equal(r.effect, 'unknown', JSON.stringify(r));
    assert.equal(existsSync(join(cwd, '.piw-agent')), false, 'every staged entry was removed (best effort) before replying');
    assert.deepEqual(x.s.get(x.w.worker_id).fence?.uncertain_command_ids, ['over'], 'parent fenced on the uncertain launch');
  } finally {
    x.cleanup();
  }
});

test('D2+D3: a staging failure after dispatch is cleaned and reported outcome_unknown (parent fenced); the child row ends failed and frees its root', async () => {
  const x = await stagingFixture();
  try {
    for (let i = 0; i < 50; i++) writeFileSync(join(x.profile, `f${i}`), 'benign');
    execFileSync('mkfifo', [join(x.profile, 'special')], { env: { PATH: '/usr/bin:/bin' } });
    const cwd = x.worktree('fifo');
    const r = await x.s.create(x.child('fifo', cwd));
    assert.equal(r.error, 'profile_copy_special_file', JSON.stringify(r));
    const receipt = x.s.receipts.all.get('fifo')!;
    assert.equal(receipt.state, 'outcome_unknown');
    assert.equal(receipt.effect, 'unknown');
    assert.equal(existsSync(join(cwd, '.piw-agent')), false, 'the partial profile was removed (best effort)');
    assert.deepEqual(readdirSync(cwd), [], 'child root is exactly as before');
    const fenced = x.s.get(x.w.worker_id);
    assert.deepEqual(fenced.fence?.uncertain_command_ids, ['fifo'], 'a staging failure after creating files fences the parent');
    assert.equal(x.launches.length, 0, 'no child process was started');
    const [row] = children(x.s, x.w.worker_id);
    assert.ok(row, 'the dispatched child row is retained');
    assert.equal(row.status, 'failed', JSON.stringify(row));
    assert.deepEqual(failure(row), { command_id: 'fifo', reason: 'profile_copy_special_file' });
    // A failed row is not live: once the owner resolves the fence, the same root can be launched again.
    const resolved = await x.s.resolveUnknown(fenced.worker_id, { ...bind(fenced, 'resolve-fifo'), uncertain_command_id: 'fifo', fence_generation: fenced.fence!.fence_generation, disposition: 'abandon' });
    assert.equal(resolved.state, 'delivered', JSON.stringify(resolved));
    rmSync(join(x.profile, 'special'));
    const again = await x.s.create(x.child('fifo-again', cwd));
    assert.equal(again.state, 'delivered', JSON.stringify(again));
    // Stopping the parent leaves no child row in a live state.
    const p = x.s.get(x.w.worker_id);
    assert.equal((await x.s.stop(p.worker_id, bind(p, 'stop-parent'))).state, 'delivered');
    const rows = children(x.s, x.w.worker_id);
    assert.deepEqual(rows.filter(r => ['starting', 'cleanup_pending'].includes(r.status)), [], JSON.stringify(rows.map(r => r.status)));
  } finally {
    x.cleanup();
  }
});

test('D2: an unverified staging cleanup is outcome_unknown and fences the parent', async () => {
  const x = await stagingFixture();
  try {
    for (let i = 0; i < 50; i++) writeFileSync(join(x.profile, `f${i}`), 'benign');
    execFileSync('mkfifo', [join(x.profile, 'special')], { env: { PATH: '/usr/bin:/bin' } });
    // Seam: a cleanup that removes nothing. The outcome must still be unknown.
    seam(x.s).stagingCleanup = () => {};
    const cwd = x.worktree('leftover');
    const r = await x.s.create(x.child('leftover', cwd));
    const receipt = x.s.receipts.all.get('leftover')!;
    assert.equal(receipt.state, 'outcome_unknown', JSON.stringify(r));
    assert.equal(receipt.effect, 'unknown');
    assert.equal(existsSync(join(cwd, '.piw-agent')), true, 'fixture: entries were left behind');
    const parent = x.s.get(x.w.worker_id);
    assert.deepEqual(parent.fence?.uncertain_command_ids, ['leftover'], 'parent fenced on the uncertain launch');
    const [row] = children(x.s, x.w.worker_id);
    assert.equal(row?.status, 'failed', JSON.stringify(row));
    assert.equal(failure(row!)?.reason, 'profile_copy_special_file');
  } finally {
    x.cleanup();
  }
});

test('D2: a parent that renames the partial .a0-agent aside before cleanup cannot get rejected/no_effect', async () => {
  const x = await stagingFixture();
  try {
    writeFileSync(join(x.profile, 'auth.json'), '{"fixture":"copied-credential-store"}');
    for (let i = 0; i < 50; i++) writeFileSync(join(x.profile, `f${i}`), 'benign');
    execFileSync('mkfifo', [join(x.profile, 'special')], { env: { PATH: '/usr/bin:/bin' } });
    const cwd = x.worktree('aside');
    const kept = join(cwd, '.kept');
    // The parent wins the race: it renames the staged directory (its tree holds the child root) just before the real
    // cleanup opens the name.
    const real = seam(x.s).stagingCleanup;
    seam(x.s).stagingCleanup = rootFd => {
      renameSync(join(cwd, '.piw-agent'), kept);
      real(rootFd);
    };
    const r = await x.s.create(x.child('aside', cwd));
    assert.equal(r.error, 'profile_copy_special_file', JSON.stringify(r));
    assert.equal(existsSync(join(cwd, '.piw-agent')), false, 'fixture: the name is gone');
    // The directory this launch created (and whatever was copied into it before the fifo, in readdir order) is still
    // linked under another name.
    assert.equal(statSync(kept).isDirectory(), true, 'fixture: the staged inode remains under another name');
    const receipt = x.s.receipts.all.get('aside')!;
    assert.equal(receipt.state, 'outcome_unknown', JSON.stringify(receipt));
    assert.equal(receipt.effect, 'unknown');
    assert.deepEqual(x.s.get(x.w.worker_id).fence?.uncertain_command_ids, ['aside'], 'parent fenced on the uncertain launch');
    const [row] = children(x.s, x.w.worker_id);
    assert.equal(row?.status, 'failed', JSON.stringify(row));
  } finally {
    x.cleanup();
  }
});

test('D2: after the dispatch record a plain Refusal is outcome_unknown; only ProvenNoEffect is rejected/no_effect', async () => {
  const tmp = privateTmp();
  const state = openState(tmp.dir);
  try {
    const store = new ReceiptStore(state.journal);
    const before = await store.run('before', 'workers.create', { x: 1 }, async () => {
      throw new Refusal('pre_dispatch');
    });
    assert.equal(before.state, 'rejected');
    const after = await store.run('after', 'workers.create', { x: 2 }, async () => {
      store.dispatch('after');
      throw new Refusal('post_dispatch');
    });
    assert.equal(after.state, 'outcome_unknown', 'a default Refusal after dispatch is not proof of no effect');
    assert.equal(after.effect, 'unknown');
    assert.equal(typeof ProvenNoEffect, 'function', 'ProvenNoEffect exists');
    const proven = await store.run('proven', 'workers.create', { x: 3 }, async () => {
      store.dispatch('proven');
      throw new ProvenNoEffect('post_dispatch_cleaned', 'verified');
    });
    assert.equal(proven.state, 'rejected');
    assert.equal(proven.effect, 'no_effect');
  } finally {
    state.close();
    tmp.cleanup();
  }
});

// ---- ported from A0 security-fix.test.ts (B2 staging) ----

test('B2: refused launches stage nothing; accepted staging never copies a raced link target', { timeout: 120_000 }, async () => {
  const x = await stagingFixture();
  const outside = privateTmp();
  const secret = join(outside.dir, 'secret');
  writeFileSync(secret, 'SECRET-MARKER');
  const scratch = join(outside.dir, 'scratch');
  mkdirSync(scratch);
  for (let i = 0; i < 64; i++) writeFileSync(join(x.profile, `f${i}`), 'benign');
  // Separate process: atomically alternate every profile file between a regular file and a link to a file the child
  // must never get. Synthetic environment.
  const racer = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('fs');const p=${JSON.stringify(x.profile)},t=${JSON.stringify(scratch)},s=${JSON.stringify(secret)};
    for(;;)for(let i=0;i<64;i++){try{fs.rmSync(t+'/l'+i,{force:true});fs.symlinkSync(s,t+'/l'+i);fs.renameSync(t+'/l'+i,p+'/f'+i);fs.writeFileSync(t+'/r'+i,'benign');fs.renameSync(t+'/r'+i,p+'/f'+i)}catch{}}`,
    ],
    { stdio: 'ignore', env: {} },
  );
  try {
    await delay(300);
    for (let i = 0; i < 20; i++) {
      const cwd = x.worktree(`refused${i}`);
      await assert.rejects(x.s.create(x.child(`refused${i}`, cwd, { tools: ['notgranted'] })), (e: unknown) => e instanceof Refusal && e.message === 'child_authority_not_subset');
      assert.deepEqual(tree(cwd), [], 'a refused launch performs no copy');
    }
    let staged = 0;
    const failed: string[] = [];
    for (let i = 0; i < 40; i++) {
      const cwd = x.worktree(`ok${i}`);
      const launched = await x.s.create(x.child(`ok${i}`, cwd));
      // Leak check first, whatever the receipt says: a path-following copy can both fail and steal under this race.
      for (const name of existsSync(join(cwd, '.piw-agent')) ? readdirSync(join(cwd, '.piw-agent')) : []) {
        const path = join(cwd, '.piw-agent', name);
        if (lstatSync(path).isFile()) {
          staged++;
          assert.notEqual(readFileSync(path, 'utf8'), 'SECRET-MARKER', `staging copied a link target (${name}, attempt ${i})`);
        }
      }
      if (launched.state !== 'delivered') {
        failed.push(String(launched.error ?? launched.state));
        // Fixture plumbing only: lift the parent fence so later attempts still race.
        const w = x.s.get(x.w.worker_id);
        if (w.fence) await x.s.resolveUnknown(w.worker_id, { ...bind(w, `resolve-${i}`), uncertain_command_id: w.fence.uncertain_command_ids![0]!, fence_generation: w.fence.fence_generation, disposition: 'abandon' });
      }
    }
    assert.ok(staged > 0);
    assert.deepEqual(failed, [], 'descriptor staging tolerates a racing swap without failing the launch');
  } finally {
    racer.kill('SIGKILL');
    await once(racer, 'exit').catch(() => {});
    x.cleanup();
    outside.cleanup();
  }
});

// ---- new in P2-7 ----

test('staging: a link in the profile is recreated verbatim, never followed; a linked node_modules is a link, never a bind', async () => {
  const x = await stagingFixture();
  const outside = privateTmp();
  try {
    writeFileSync(join(outside.dir, 'secret'), 'SECRET-MARKER');
    mkdirSync(join(outside.dir, 'deps'));
    writeFileSync(join(outside.dir, 'deps', 'secret.js'), 'SECRET-MARKER');
    symlinkSync(join(outside.dir, 'secret'), join(x.profile, 'auth-link.json'));
    mkdirSync(join(x.profile, 'npm'));
    symlinkSync(join(outside.dir, 'deps'), join(x.profile, 'npm', 'node_modules'));
    writeFileSync(join(x.profile, 'settings.json'), '{}');
    const cwd = x.worktree('links');
    const r = await x.s.create(x.child('links', cwd));
    assert.equal(r.state, 'delivered', JSON.stringify(r));
    const staged = join(cwd, '.piw-agent');
    assert.equal(lstatSync(join(staged, 'auth-link.json')).isSymbolicLink(), true, 'a link is copied as a link');
    assert.equal(readlinkSync(join(staged, 'auth-link.json')), join(outside.dir, 'secret'));
    assert.equal(lstatSync(join(staged, 'npm', 'node_modules')).isSymbolicLink(), true, 'a linked node_modules is copied as a link');
    assert.deepEqual(x.launches.find(l => l.cwd === cwd)!.dependencies, [], 'a linked node_modules is never bound');
    assert.equal(readFileSync(join(staged, 'settings.json'), 'utf8'), '{}');
  } finally {
    x.cleanup();
    outside.cleanup();
  }
});

test('staging: the copy refuses past its depth, byte and dependency-bind limits and on a FIFO; the production limits are A0’s', () => {
  assert.deepEqual(PROFILE_LIMITS, { entries: 10_000, bytes: 256 * 1024 * 1024, depth: 32, dependencyBinds: 64 });
  const tmp = privateTmp();
  try {
    const stage = (name: string, build: (src: string) => void, limits = PROFILE_LIMITS): DependencyBind[] => {
      const src = join(tmp.dir, `${name}-src`);
      const dest = join(tmp.dir, `${name}-dest`);
      mkdirSync(src);
      mkdirSync(dest);
      build(src);
      const s = openPinned(realpathSync(src), 'dir');
      const d = openPinned(realpathSync(dest), 'dir');
      try {
        return stageProfileAt(s, d, limits);
      } finally {
        closeSync(s);
        closeSync(d);
      }
    };
    const refused = (fn: () => unknown, reason: string) => assert.throws(fn, (e: unknown) => e instanceof Refusal && e.message === reason, reason);
    const small = { entries: 100, bytes: 1024, depth: 3, dependencyBinds: 2 };
    // Depth: three nested directories copy, a fourth refuses.
    const nest = (src: string, n: number) => mkdirSync(join(src, ...Array.from({ length: n }, (_, i) => `d${i}`)), { recursive: true });
    assert.deepEqual(stage('depth-ok', src => nest(src, 3), small), []);
    refused(() => stage('depth', src => nest(src, 4), small), 'profile_copy_too_deep');
    // Bytes: the budget counts every copied byte.
    assert.deepEqual(stage('bytes-ok', src => writeFileSync(join(src, 'a'), Buffer.alloc(1024)), small), []);
    refused(() => stage('bytes', src => writeFileSync(join(src, 'a'), Buffer.alloc(1025)), small), 'profile_copy_too_large');
    // Entries.
    refused(() => stage('entries', src => Array.from({ length: 101 }, (_, i) => writeFileSync(join(src, `f${i}`), '')), small), 'profile_copy_too_many_entries');
    // Dependency binds: two node_modules trees bind, a third refuses (and the two opened are closed).
    const deps = stage('deps-ok', src => ['a', 'b'].forEach(n => mkdirSync(join(src, n, 'node_modules'), { recursive: true })), small);
    assert.deepEqual(deps.map(d => d.dest).sort(), [['a', 'node_modules'], ['b', 'node_modules']]);
    for (const d of deps) closeSync(d.fd);
    refused(() => stage('deps', src => ['a', 'b', 'c'].forEach(n => mkdirSync(join(src, n, 'node_modules'), { recursive: true })), small), 'profile_dependency_binds_too_many');
    // A FIFO refuses (never opened for reading: no blocking).
    refused(() => stage('fifo', src => execFileSync('mkfifo', [join(src, 'pipe')], { env: { PATH: '/usr/bin:/bin' } })), 'profile_copy_special_file');
  } finally {
    tmp.cleanup();
  }
});

test('staging: the cleanup removes the staged tree and unlinks a link in it without following it', () => {
  const tmp = privateTmp();
  try {
    const root = realpathSync(tmp.dir);
    const target = join(root, 'outside');
    mkdirSync(join(target, 'deep'), { recursive: true });
    writeFileSync(join(target, 'keep-me'), 'KEEP');
    writeFileSync(join(target, 'deep', 'keep-me-too'), 'KEEP');
    const staged = join(root, 'child', '.piw-agent');
    mkdirSync(join(staged, 'a', 'b'), { recursive: true });
    writeFileSync(join(staged, 'a', 'b', 'f'), 'x');
    symlinkSync(target, join(staged, 'dir-link'));
    symlinkSync(join(target, 'keep-me'), join(staged, 'a', 'file-link'));
    // Whatever the cleanup throws (it is best effort in production), nothing behind a link may be removed.
    const clean = (): unknown => {
      const fd = openPinned(join(root, 'child'), 'dir');
      try {
        removeTreeAt(fd, '.piw-agent');
        return null;
      } catch (error) {
        return error;
      } finally {
        closeSync(fd);
      }
    };
    const first = clean();
    assert.deepEqual(tree(target), ['deep', 'deep/keep-me-too', 'keep-me'], 'nothing behind a link was removed');
    assert.equal(first, null, 'the cleanup completes');
    assert.equal(existsSync(staged), false, 'the staged tree is gone');
    // A staged name that is itself a link is unlinked, its target kept.
    symlinkSync(target, staged);
    const second = clean();
    assert.deepEqual(tree(target), ['deep', 'deep/keep-me-too', 'keep-me']);
    assert.equal(second, null);
    assert.equal(existsSync(staged), false);
  } finally {
    tmp.cleanup();
  }
});

test('staging: a create refuses before any record when the child root already holds .piw-agent, overlaps the parent profile, or the profile is a link; with no parent profile nothing is staged', async () => {
  const x = await stagingFixture();
  try {
    writeFileSync(join(x.profile, 'settings.json'), '{}');
    const rows = () => children(x.s, x.w.worker_id).length;
    const refusedBefore = async (c: Create, reason: string) => {
      await assert.rejects(x.s.create(c), (e: unknown) => e instanceof Refusal && e.message === reason && e.effect === 'no_effect', reason);
      assert.equal(x.s.receipts.all.get(c.command_id)?.state ?? 'none', 'none', `${reason}: no receipt record`);
    };
    // A child root holding .piw-agent (a directory, a file or a link): staging creates its own.
    for (const [name, plant] of [
      ['held-dir', (cwd: string) => mkdirSync(join(cwd, '.piw-agent'))],
      ['held-file', (cwd: string) => writeFileSync(join(cwd, '.piw-agent'), '')],
      ['held-link', (cwd: string) => symlinkSync(x.profile, join(cwd, '.piw-agent'))],
    ] as const) {
      const cwd = x.worktree(name);
      plant(cwd);
      await refusedBefore(x.child(name, cwd), 'child_profile_exists');
    }
    // A child root inside the parent profile.
    const within = join(x.profile, 'inner');
    mkdirSync(within);
    await refusedBefore(x.child('inner', within), 'child_root_overlaps_parent_profile');
    // A parent profile that is a link (never followed).
    renameSync(x.profile, `${x.profile}-real`);
    symlinkSync(`${x.profile}-real`, x.profile);
    await refusedBefore(x.child('linked', x.worktree('linked')), 'parent_profile_not_directory');
    assert.equal(rows(), 0, 'no child row');
    assert.equal(x.launches.length, 0, 'no child launched');
    // No parent profile: nothing is staged, and an owner-staged .piw-agent in the child root stays as it was.
    rmSync(x.profile);
    const cwd = x.worktree('plain');
    mkdirSync(join(cwd, '.piw-agent'));
    writeFileSync(join(cwd, '.piw-agent', 'models.json'), '{}');
    const r = await x.s.create(x.child('plain', cwd));
    assert.equal(r.state, 'delivered', JSON.stringify(r));
    assert.deepEqual(tree(join(cwd, '.piw-agent')), ['models.json']);
    assert.deepEqual(x.launches.find(l => l.cwd === cwd)!.dependencies, []);
  } finally {
    x.cleanup();
  }
});

/** Runs `change` on the profile between a child create's validation and its staging (right after its starting row). */
function afterStartingRow(x: Awaited<ReturnType<typeof stagingFixture>>, cwd: string, change: () => void): void {
  const persist = x.s.state.persist.bind(x.s.state);
  x.s.state.persist = (live, label) => {
    const appended = persist(live, label);
    if (label === 'worker.create' && live.worker.cwd === cwd) change();
    return appended;
  };
}

test('staging: a profile that vanished or became a link after validation stages nothing and is rejected no_effect after dispatch; the row ends failed', async () => {
  for (const swap of ['vanished', 'linked'] as const) {
    const x = await stagingFixture();
    const outside = privateTmp();
    try {
      writeFileSync(join(x.profile, 'settings.json'), '{}');
      writeFileSync(join(outside.dir, 'settings.json'), 'OUTSIDE');
      const cwd = x.worktree(swap);
      afterStartingRow(x, cwd, () => {
        rmSync(x.profile, { recursive: true });
        if (swap === 'linked') symlinkSync(outside.dir, x.profile);
      });
      const r = await x.s.create(x.child(swap, cwd));
      assert.deepEqual(readdirSync(cwd), [], `${swap}: nothing was staged (a link is never followed)`);
      assert.equal(r.state, 'rejected', JSON.stringify(r));
      assert.equal(r.effect, 'no_effect');
      // O_NOFOLLOW with O_DIRECTORY on a link: ENOTDIR.
      assert.equal(r.error, swap === 'vanished' ? 'profile_staging_failed:ENOENT' : 'profile_staging_failed:ENOTDIR');
      assert.equal(x.s.get(x.w.worker_id).fence ?? null, null, 'a proven no_effect never fences the parent');
      const [row] = children(x.s, x.w.worker_id);
      assert.equal(row?.status, 'failed', JSON.stringify(row));
    } finally {
      x.cleanup();
      outside.cleanup();
    }
  }
});

test('staging: nothing staged is still outcome_unknown (parent fenced) while the child’s domain is not observed removed', async () => {
  const x = await stagingFixture({ unconfirmedIdentity: true });
  try {
    writeFileSync(join(x.profile, 'settings.json'), '{}');
    const cwd = x.worktree('unconfirmed');
    afterStartingRow(x, cwd, () => rmSync(x.profile, { recursive: true }));
    const r = await x.s.create(x.child('unconfirmed', cwd));
    assert.deepEqual(readdirSync(cwd), [], 'nothing was staged');
    assert.equal(r.state, 'outcome_unknown', JSON.stringify(r));
    assert.equal(r.effect, 'unknown');
    assert.deepEqual(x.s.get(x.w.worker_id).fence?.uncertain_command_ids, ['unconfirmed'], 'parent fenced on the uncertain launch');
    const [row] = children(x.s, x.w.worker_id);
    assert.equal(row?.status, 'cleanup_pending', JSON.stringify(row));
  } finally {
    x.cleanup();
  }
});

test('staging: the sandbox binds each dependency read-only at its real mount point, and refuses a mount point that is a link', () => {
  const tmp = privateTmp();
  try {
    const base = realpathSync(tmp.dir);
    const root = join(base, 'root');
    const source = join(base, 'source');
    mkdirSync(join(root, '.piw-agent', 'npm', 'node_modules'), { recursive: true });
    mkdirSync(source);
    const fd = openPinned(source, 'dir');
    try {
      const deps = [{ fd, dest: ['npm', 'node_modules'] }];
      const launch = sandboxLaunch(root, '/bin/true', [], { env: SANDBOX_ENV, dependencies: deps });
      launch.close();
      const at = launch.args.indexOf(join(root, '.piw-agent', 'npm', 'node_modules'));
      assert.equal(launch.args[at - 2], '--ro-bind-fd', 'read-only, by descriptor');
      assert.equal(launch.fds[Number(launch.args[at - 1]) - 4], fd, 'the bound descriptor is the dependency source');
      assert.ok(at > launch.args.indexOf('--bind-fd'), 'after the root bind it overlays');
      fstatSync(fd); // the caller's descriptor stays open
      // The mount point replaced by a link (to anywhere) refuses rather than letting bwrap resolve it.
      rmSync(join(root, '.piw-agent', 'npm', 'node_modules'), { recursive: true });
      symlinkSync(source, join(root, '.piw-agent', 'npm', 'node_modules'));
      assert.throws(() => sandboxLaunch(root, '/bin/true', [], { env: SANDBOX_ENV, dependencies: deps }), (e: unknown) => e instanceof Refusal && e.message === 'sandbox_dependency_mount_point_invalid');
    } finally {
      closeSync(fd);
    }
  } finally {
    tmp.cleanup();
  }
});

/** A stand-in bwrap that records its argv and its descriptors, then exits. */
function fakeBwrap(dir: string, out: string): string {
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'bwrap');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}.argv'\nls /proc/self/fd > '${out}.fds'\nmv '${out}.argv' '${out}.argv.done'\n`);
  chmodSync(path, 0o755);
  return path;
}

test('staging: the production host hands bwrap each dependency descriptor for its read-only bind', async () => {
  const tmp = privateTmp();
  const dir = realpathSync(tmp.dir);
  try {
    const root = join(dir, 'root');
    const source = join(dir, 'source');
    mkdirSync(join(root, '.piw-agent', 'npm', 'node_modules'), { recursive: true });
    mkdirSync(source);
    const out = join(dir, 'capture');
    const hosts = productionHosts(fakeBwrap(dir, out), { PATH: '/usr/bin:/bin', HOME: dir });
    const domain: Domain = { root: '/test-domains', name: 'w-staging', boot: 'test' };
    const create: Create = {
      command_id: 'c',
      cwd: root,
      host: 'sdk',
      provider: 'p',
      model: 'm',
      thinking: 'off',
      parent: { worker_id: 'p', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'gen' },
      launch_spec: { environment: { id: 'root', revision: 1, allowed_methods: [], filesystem: 'bwrap', root }, role: 'child', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' },
    };
    const fd = openPinned(source, 'dir');
    let host: SdkHost;
    try {
      host = hosts.factory({ workerId: 'w', commandId: 'c', create, cwd: root, sessionDir: join(root, '.piw-worker'), domain, prefix: [], sandbox: root, dependencies: [{ fd, dest: ['npm', 'node_modules'] }] }) as SdkHost;
    } finally {
      closeSync(fd);
    }
    await once(host, 'exit');
    for (let n = 0; n < 500 && !existsSync(`${out}.argv.done`); n++) await delay(20);
    const args = readFileSync(`${out}.argv.done`, 'utf8').trim().split('\n');
    const at = args.indexOf(join(root, '.piw-agent', 'npm', 'node_modules'));
    assert.ok(at > 0, 'the dependency mount point is in the profile');
    assert.equal(args[at - 2], '--ro-bind-fd', 'read-only, by descriptor');
    const slot = Number(args[at - 1]);
    assert.ok(readFileSync(`${out}.fds`, 'utf8').trim().split('\n').map(Number).includes(slot), `bwrap holds descriptor ${slot}`);
  } finally {
    tmp.cleanup();
  }
});

// ---- kernel: real bwrap, real pi SDK child, no model ----

const PROBE = `import { readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi) {
  pi.on('input', async () => {
    const agent = process.env.PI_CODING_AGENT_DIR;
    const modules = join(agent, 'npm', 'node_modules');
    const out = { agent };
    out.loaded = (await import(join(modules, 'probe-ext', 'index.mjs'))).PROBE;
    out.marker = readFileSync(join(modules, 'probe-ext', 'data', 'marker.txt'), 'utf8');
    out.packages = readdirSync(modules).length;
    out.settings = readFileSync(join(agent, 'settings.json'), 'utf8');
    try { writeFileSync(join(modules, 'probe-ext', 'planted'), 'x'); out.writable = true; } catch (error) { out.writable = false; out.code = error.code; }
    try { writeFileSync(join(modules, 'pkg-1', 'index.js'), 'planted'); out.sibling_writable = true; } catch { out.sibling_writable = false; }
    try { writeFileSync(join(agent, 'auth.json'), 'planted'); out.auth_writable = true; } catch { out.auth_writable = false; }
    writeFileSync(join(process.cwd(), 'probe.json'), JSON.stringify(out));
    writeSync(3, JSON.stringify({ report_id: 'staging', kind: 'result', message: 'STAGED_PROFILE_PROBED' }) + '\\n');
    return { action: 'handled' };
  });
}
`;

test('kernel: a sandboxed child reads its parent’s staged profile; the dependency tree loads read-only at its own profile path and the host mount point stays empty', { skip, timeout: 180_000 }, async () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const stateDir = join(base, 'state');
  const workspace = join(base, 'workspace');
  const parentCwd = join(workspace, 'parent');
  const cwd = join(workspace, 'child');
  const agent = join(base, 'agent');
  for (const d of [stateDir, parentCwd, cwd, agent]) mkdirSync(d, { recursive: true });
  const profile = join(parentCwd, '.piw-agent');
  const modules = join(profile, 'npm', 'node_modules');
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(profile, 'settings.json'), '{"packages":[]}\n');
  writeFileSync(join(profile, 'auth.json'), '{}');
  for (let i = 0; i < 300; i++) {
    mkdirSync(join(modules, `pkg-${i}`));
    writeFileSync(join(modules, `pkg-${i}`, 'index.js'), 'x');
  }
  const probe = join(modules, 'probe-ext');
  mkdirSync(join(probe, 'data'), { recursive: true });
  writeFileSync(join(probe, 'data', 'marker.txt'), 'FROM_PARENT_DEPENDENCY_TREE');
  writeFileSync(join(probe, 'package.json'), '{"name":"probe-ext","type":"module"}');
  writeFileSync(join(probe, 'index.mjs'), "export const PROBE = 'LOADED_FROM_DEPENDENCY_BIND';\n");
  const extension = join(cwd, 'probe.mjs');
  writeFileSync(extension, PROBE);
  const state = openState(stateDir);
  const containment = new CgroupContainment(checkDelegation(process.env.PIW_CGROUP_ROOT ?? ''), state.installation);
  const supervisor = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir,
    containment,
    grants: new GrantStore(stateDir),
    ...productionHosts(locateBwrap(), { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent }),
  });
  const spec: Spec = { environment: { id: 'test', revision: 1, root: workspace, allowed_methods: ['children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [extension], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
  try {
    const p = await supervisor.create({ command_id: 'parent', cwd: parentCwd, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: spec });
    assert.equal(p.state, 'delivered', JSON.stringify(p));
    // A fixture execution: a child launches only under a running parent execution (no model call in this test).
    supervisor.state.require(p.worker_id!).worker.execution = { execution_id: 'test-run', command_id: 'test-run', state: 'started' };
    const w = supervisor.get(p.worker_id!);
    const c = await supervisor.create({ command_id: 'child', cwd, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', parent: { ...bind(w, 'unused'), worker_id: w.worker_id, execution_id: 'test-run', task_id: 'task', generation_id: 'gen' }, launch_spec: { ...spec, role: 'child', environment: { ...spec.environment, filesystem: 'bwrap', root: cwd } } });
    assert.equal(c.state, 'delivered', JSON.stringify(c));
    const child = supervisor.get(c.worker_id!);
    assert.ok(count(join(cwd, '.piw-agent')) < 10, `staged copy stays small (${count(join(cwd, '.piw-agent'))})`);
    assert.equal((await supervisor.prompt(child.worker_id, { ...bind(child, 'probe'), message: 'probe' })).state, 'delivered');
    const deadline = Date.now() + 10_000;
    while (!(supervisor.get(child.worker_id).child_reports?.length ?? 0) && Date.now() < deadline) await delay(50);
    assert.equal(supervisor.get(child.worker_id).child_reports?.[0]?.message, 'STAGED_PROFILE_PROBED', 'missing FD report');
    const out = JSON.parse(readFileSync(join(cwd, 'probe.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(out.agent, join(cwd, '.piw-agent'), 'pi’s agent directory is the staged profile in its own root');
    assert.equal(out.loaded, 'LOADED_FROM_DEPENDENCY_BIND', 'the child loaded code from the dependency bind');
    assert.equal(out.marker, 'FROM_PARENT_DEPENDENCY_TREE');
    assert.equal(out.packages, 301, 'the whole dependency tree is visible');
    assert.equal(out.settings, '{"packages":[]}\n', 'the copied settings are the parent’s');
    assert.equal(out.writable, false, 'dependency bind is read-only in the child');
    assert.equal(out.code, 'EROFS');
    assert.equal(out.sibling_writable, false);
    assert.equal(out.auth_writable, false, 'the staged credential store is read-only in the child');
    assert.equal(existsSync(join(probe, 'planted')), false);
    assert.equal(readFileSync(join(modules, 'pkg-1', 'index.js'), 'utf8'), 'x');
    assert.equal(readFileSync(join(cwd, '.piw-agent', 'auth.json'), 'utf8'), '{}');
    assert.equal(lstatSync(join(cwd, '.piw-agent', 'npm', 'node_modules')).isDirectory(), true);
    assert.deepEqual(readdirSync(join(cwd, '.piw-agent', 'npm', 'node_modules')), [], 'host mount point stays empty');
  } finally {
    await supervisor.shutdown();
    state.close();
    tmp.cleanup();
  }
});
