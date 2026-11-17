/**
 * The bwrap profile for typed children (P2-4), ported from A0 `src/test/sandbox.test.ts` and the `security-fix.test.ts`
 * bwrap cases (the profile, kernel B1 bind, `--die-with-parent`), plus new cases: the daemon's bwrap refusal, the
 * production host's composition (join prefix outermost, mount descriptors at 4, no descriptor kept), the supervisor's
 * sandboxed launch, root-pinned history, `files.read` over B2 and the confinement of session moves. Cases named
 * `kernel:` run real bwrap (and real pi) inside a delegated user service: `harness/ci/kernel.sh -- sandbox`, which sets
 * PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT; elsewhere they skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/b2/app.js';
import { createB2Server, listenPrivate } from '../../src/b2/server.js';
import { CgroupContainment, checkDelegation, type Domain } from '../../src/containment/containment.js';
import { productionHosts } from '../../src/daemon.js';
import { GrantStore } from '../../src/grants/store.js';
import { SessionIndex } from '../../src/history/session-index.js';
import { childEnv, sdkChildEntry, SdkHost } from '../../src/host/host.js';
import { openState } from '../../src/journal/state.js';
import type { JournalRecord } from '../../src/journal/journal.js';
import { DEFAULT_RETENTION, goalFor, planCompaction } from '../../src/journal/retention.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import { inside, locateBwrap, readConfined, sandboxEnv, sandboxLaunch, sandboxRoot, sandboxSessionDir, type SandboxLaunch } from '../../src/sandbox/sandbox.js';
import type { Create, HostLaunch } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { ownerGrant, privateTmp, repoRoot, socketCall } from '../helpers.js';
import { bind, fixture, Host } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT in a delegated user service with bwrap (harness/ci/kernel.sh)';
const daemonMain = fileURLToPath(new URL('../fixtures/daemon.js', import.meta.url));

type Spec = NonNullable<Create['launch_spec']>;
const parentBinding = { worker_id: 'p', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'gen' };
/** A sandboxed child's create for `root` (A0's literal shape, SDK host). */
const childCreate = (root: string, extra: Partial<Spec> = {}): Create => ({
  command_id: 'root',
  cwd: root,
  host: 'sdk',
  provider: 'p',
  model: 'm',
  thinking: 'off',
  parent: parentBinding,
  launch_spec: { environment: { id: 'root', revision: 1, allowed_methods: [], filesystem: 'bwrap', root }, role: 'child', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone', ...extra },
});
/** The environment a sandboxed child gets inside its root. */
const profileEnv = (root: string, env: NodeJS.ProcessEnv = process.env) => sandboxEnv(childEnv(env, 'task'), root);
const launchIn = (root: string, command: string, args: string[], bwrap?: string): SandboxLaunch => sandboxLaunch(root, command, args, { env: profileEnv(root), ...(bwrap ? { bwrap } : {}) });

// ---- ported from A0 sandbox.test.ts ----

test('files.read pins roots, refuses hidden/traversal/symlink paths, non-UTF8, sockets, and oversize files', async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  mkdirSync(join(root, 'allowed'));
  mkdirSync(join(root, 'elsewhere'));
  try {
    writeFileSync(join(root, 'allowed', 'ok'), 'ALLOWED\n');
    writeFileSync(join(root, 'elsewhere', 'out'), 'OUTSIDE\n');
    symlinkSync(join(root, 'elsewhere'), join(root, 'allowed', 'escape'));
    symlinkSync(join(root, 'allowed', 'ok'), join(root, 'allowed', 'link'));
    writeFileSync(join(root, 'allowed', '.secret'), 'hidden');
    writeFileSync(join(root, 'allowed', 'invalid'), Buffer.from([0xff]));
    writeFileSync(join(root, 'allowed', 'huge'), Buffer.alloc(1024 * 1024 + 1));
    const roots = [join(root, 'allowed')];
    assert.equal(readConfined(root, 'allowed/ok', roots).content, 'ALLOWED\n');
    for (const path of ['elsewhere/out', '/etc/passwd']) assert.throws(() => readConfined(root, path, roots), /outside/);
    for (const path of ['allowed/.secret', 'allowed/../elsewhere/out']) assert.throws(() => readConfined(root, path, roots), /hidden_or_traversal/);
    for (const path of ['allowed/escape/out', 'allowed/link']) assert.throws(() => readConfined(root, path, roots), /symlink/);
    assert.throws(() => readConfined(root, 'allowed/invalid', roots), /not_utf8/);
    assert.throws(() => readConfined(root, 'allowed/huge', roots), /over_1MiB/);
    assert.throws(() => readConfined(root, 'allowed', roots), /not_regular/);
    assert.throws(() => readConfined(root, 'allowed/ok', []), /explicit_roots/);
    assert.throws(() => readConfined(root, 'allowed/ok', ['/']), /outside/);
    assert.throws(() => readConfined(root, 'allowed/ok', [...roots, '/']), /outside/);
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(join(root, 'allowed', 'socket'), resolve));
    try {
      assert.throws(() => readConfined(root, 'allowed/socket', roots), /unavailable|not_regular/);
    } finally {
      await new Promise<void>(resolve => socket.close(() => resolve()));
    }
    // P2-4: the wire form is an absolute path; its hidden components are judged below the root, never above it.
    assert.equal(readConfined(root, join(root, 'allowed', 'ok'), roots).content, 'ALLOWED\n');
    assert.throws(() => readConfined(root, join(root, 'allowed', '.secret'), roots), /hidden_or_traversal/);
  } finally {
    tmp.cleanup();
  }
});

test('sandbox history and session directory provisioning cannot follow outside symlinks', () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const root = join(base, 'root');
  mkdirSync(root);
  try {
    const outside = join(base, 'outside.jsonl');
    writeFileSync(outside, '{"type":"session","id":"native"}\n' + JSON.stringify({ type: 'message', id: 'outside', parentId: null, message: { role: 'user', content: 'OUTSIDE_TEST_SENTINEL' } }) + '\n');
    const linked = join(root, 'linked.jsonl');
    symlinkSync(outside, linked);
    const index = new SessionIndex(linked, undefined, root);
    const page = index.page(null, 10);
    assert.ok('entries' in page);
    assert.deepEqual(page.entries, []);
    const direct = new SessionIndex(outside, undefined, root);
    assert.deepEqual(direct.page(null, 10), page);
    const session = sandboxSessionDir(root, 'worker');
    const own = join(session, 'own.jsonl');
    writeFileSync(own, '{"type":"session","id":"own"}\n');
    const allowed = new SessionIndex(own, undefined, root);
    allowed.refresh();
    assert.equal(allowed.headerId, 'own');
    rmSync(join(root, '.piw-worker'), { recursive: true });
    const target = join(base, 'outside-dir');
    mkdirSync(target);
    symlinkSync(target, join(root, '.piw-worker'));
    assert.throws(() => sandboxSessionDir(root, 'worker'));
    assert.equal(existsSync(join(target, 'sessions')), false, 'no supervisor directory creation through a worktree symlink');
    // P2-4: a link in a directory below the root is refused as well, not only at the session file.
    rmSync(join(root, '.piw-worker'));
    mkdirSync(join(root, '.piw-worker'));
    symlinkSync(target, join(root, '.piw-worker', 'sessions'));
    writeFileSync(join(target, 'planted.jsonl'), '{"type":"session","id":"planted"}\n');
    const planted = new SessionIndex(join(root, '.piw-worker', 'sessions', 'planted.jsonl'), undefined, root);
    planted.refresh();
    assert.equal(planted.headerId, null, 'never read through a linked directory below the root');
  } finally {
    tmp.cleanup();
  }
});

test('sandbox launch refuses mismatched roots, parent state exposure, non-child and external resources', () => {
  const f = fixture();
  try {
    const root = join(f.dir, 'worktree');
    mkdirSync(root);
    const c: Create = { command_id: 'x', cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', parent: parentBinding, launch_spec: { environment: { id: 'x', revision: 1, allowed_methods: ['children.report'], filesystem: 'bwrap', root }, role: 'child', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' } };
    const state = join(f.dir, 'state-only');
    mkdirSync(state);
    const controls = (paths: string[] = []) => ({ stateDir: state, paths });
    assert.equal(sandboxRoot(c, controls()), root);
    const rooted = (path: string): Create => ({ ...c, cwd: path, launch_spec: { ...c.launch_spec!, environment: { ...c.launch_spec!.environment, root: path } } });
    assert.throws(() => sandboxRoot(rooted('/'), controls()), /sandbox_root_is_host_root/);
    assert.equal(inside('/', state), true);
    assert.throws(() => sandboxRoot(rooted(f.dir), controls()), /overlaps_supervisor_state/);
    assert.throws(() => sandboxRoot(rooted(state), controls()), /overlaps_supervisor_state/);
    const socketDir = join(f.dir, 'socket-dir');
    mkdirSync(socketDir);
    const grantDir = join(f.dir, 'grant-dir');
    mkdirSync(grantDir);
    const grantFile = join(grantDir, 'grant.json');
    writeFileSync(grantFile, '{}');
    // A0 named its socket and grant file in the environment; the daemon names its control paths (the socket's
    // directory) to the supervisor instead.
    for (const path of [socketDir, grantDir, '/sys', '/sys/fs', '/sys/fs/cgroup']) assert.throws(() => sandboxRoot(rooted(path), controls([socketDir, grantFile])), /overlaps_protected_control_path/);
    assert.throws(() => sandboxRoot(c, { stateDir: f.dir, paths: [] }), /overlaps_supervisor_state/);
    assert.equal(sandboxRoot({ ...c, parent: undefined }, controls()), root, 'SDK parents now use the same confinement policy');
    assert.throws(() => sandboxRoot({ ...c, host: 'rpc' as never }, controls()), /requires_linux/);
    const wrong = structuredClone(c);
    wrong.launch_spec!.environment.root = state;
    assert.throws(() => sandboxRoot(wrong, controls()), /must_equal_cwd/);
    const external = join(f.dir, 'external.mjs');
    writeFileSync(external, 'export default () => {}');
    const widened = structuredClone(c);
    widened.launch_spec!.resources.extensions = [external];
    assert.throws(() => sandboxRoot(widened, controls()), /resource_outside_root/);
    // P2-4: the worker's own runtime (its code and dependencies, bound read-only) is never inside a sandbox root.
    assert.throws(() => sandboxRoot(rooted(realpathSync(repoRoot)), controls()), /runtime_overlaps/);
  } finally {
    f.cleanup();
  }
});

for (const relation of ['equal', 'ancestor', 'descendant', 'bus', 'bus-ancestor', 'symlink'] as const) {
  test(`sandbox refuses user runtime control paths (${relation})`, () => {
    const f = fixture();
    const state = join(f.dir, 'state');
    const control = join(f.dir, 'control');
    const runtime = join(control, 'runtime');
    mkdirSync(state);
    mkdirSync(control);
    mkdirSync(runtime);
    mkdirSync(join(runtime, 'nested'));
    const busDir = join(f.dir, 'bus-dir');
    mkdirSync(busDir);
    const bus = join(busDir, 'bus');
    writeFileSync(bus, 'test bus path, not a live manager');
    symlinkSync(bus, join(runtime, 'bus')); // Protect a bus socket's canonical target too.
    const alias = join(f.dir, 'runtime-alias');
    symlinkSync(runtime, alias);
    const saved = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.XDG_RUNTIME_DIR = relation === 'symlink' ? alias : runtime;
      const root = relation === 'ancestor' ? control : relation === 'descendant' ? join(runtime, 'nested') : relation === 'bus' ? bus : relation === 'bus-ancestor' ? busDir : runtime;
      assert.throws(() => sandboxRoot(childCreate(root), { stateDir: state, paths: [] }), /overlaps_protected_control_path/);
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
      f.cleanup();
    }
  });
}

test('sandbox refuses default user runtime, private kernel mounts and nested cgroup/socket roots', () => {
  const f = fixture();
  const state = join(f.dir, 'state');
  const sockets = join(f.dir, 'sockets');
  mkdirSync(state);
  mkdirSync(sockets);
  mkdirSync(join(sockets, 'nested'));
  const savedRuntime = process.env.XDG_RUNTIME_DIR;
  try {
    // The fixed UID path must remain protected without XDG_RUNTIME_DIR.
    delete process.env.XDG_RUNTIME_DIR;
    const userRuntime = `/run/user/${process.getuid!()}`;
    const cgroup = join('/sys/fs/cgroup', readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1]!);
    for (const root of [...[userRuntime, join(userRuntime, 'bus'), cgroup].filter(existsSync), '/run', '/proc', '/proc/self', '/dev', '/dev/shm', join(sockets, 'nested')]) {
      assert.throws(() => sandboxRoot(childCreate(root), { stateDir: state, paths: [sockets] }), /overlaps_protected_control_path/, `root ${root} must not expose host controls`);
    }
  } finally {
    if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedRuntime;
    f.cleanup();
  }
});

/** A stand-in bwrap that records its argv, its environment's names and its descriptors in `out`, then exits. */
function fakeBwrap(dir: string, out: string): string {
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'bwrap');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}.argv'\nenv | cut -d= -f1 | sort > '${out}.env'\nls /proc/self/fd > '${out}.fds'\nmv '${out}.argv' '${out}.argv.done'\n`);
  chmodSync(path, 0o755);
  return path;
}

async function waitFor(path: string, ms = 10_000): Promise<void> {
  for (let n = 0; n < ms / 20 && !existsSync(path); n++) await delay(20);
  assert.ok(existsSync(path), `${path} was written`);
}

test('sandbox host uses environment allowlist and a private PID namespace', async () => {
  const tmp = privateTmp();
  const dir = realpathSync(tmp.dir);
  const saved = process.env.PIW_TEST_PRIVATE_SENTINEL;
  process.env.PIW_TEST_PRIVATE_SENTINEL = 'NOT_A_CREDENTIAL';
  try {
    const spec: Spec = { environment: { id: 'test', revision: 1, filesystem: 'bwrap', root: dir, allowed_methods: [] }, role: 'child', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' };
    const profile = launchIn(dir, 'node', []);
    profile.close();
    assert.ok(profile.args.includes('--unshare-pid'));
    // A0 captured the containment's spawn; the production host spawns bwrap itself, so a stand-in bwrap records it.
    const out = join(dir, 'capture');
    const bwrap = fakeBwrap(dir, out);
    const host = new SdkHost({ cwd: dir, sessionDir: dir, provider: 'p', model: 'm', thinking: 'off', projectTrusted: false, launchSpec: spec, taskId: 'task' }, { sandbox: { root: dir, bwrap } });
    await once(host, 'exit');
    await waitFor(`${out}.argv.done`);
    const args = readFileSync(`${out}.argv.done`, 'utf8').trim().split('\n');
    assert.ok(args.includes('--unshare-pid'));
    const names = readFileSync(`${out}.env`, 'utf8').trim().split('\n');
    // The shell itself adds PWD, SHLVL and `_`; every other name is the profile's.
    assert.deepEqual(names.filter(n => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n)).sort(), Object.keys(profile.env).sort(), 'host must replace rather than merge the parent environment; compare names only, never print inherited values');
    assert.equal(names.includes('PIW_TEST_PRIVATE_SENTINEL'), false);
  } finally {
    if (saved === undefined) delete process.env.PIW_TEST_PRIVATE_SENTINEL;
    else process.env.PIW_TEST_PRIVATE_SENTINEL = saved;
    tmp.cleanup();
  }
});

/** A typed root parent outside the fixture's state directory, with a running execution, and a sandboxed child spec. */
async function sandboxedFamily(f: ReturnType<typeof fixture>, tree: string, childSpec: (root: string) => Partial<Spec>, name = 'parent') {
  const parentCwd = join(tree, name);
  mkdirSync(parentCwd, { recursive: true });
  const spec: Spec = { environment: { id: 'family', revision: 1, root: tree, allowed_methods: ['children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
  const made = await f.supervisor.create({ command_id: name, cwd: parentCwd, provider: 'p', model: 'm', thinking: 'off', launch_spec: spec });
  assert.equal(made.state, 'delivered', JSON.stringify(made));
  const parent = f.supervisor.get(made.worker_id!);
  assert.equal((await f.supervisor.prompt(parent.worker_id, { ...bind(parent, `${name}-run`), message: 'run' })).state, 'delivered');
  const running = f.supervisor.get(parent.worker_id);
  const child = (name: string, extra: Partial<Create> = {}): Create => {
    const cwd = join(tree, name);
    mkdirSync(cwd, { recursive: true });
    return {
      command_id: name,
      cwd,
      provider: 'p',
      model: 'm',
      thinking: 'off',
      parent: { worker_id: parent.worker_id, worker_epoch: parent.worker_epoch, session_id: parent.session_id!, binding_revision: parent.binding_revision, execution_id: running.execution!.execution_id, task_id: `task-${name}`, generation_id: 'gen' },
      launch_spec: { ...spec, role: 'child', ...childSpec(cwd) },
      ...extra,
    };
  };
  return { parent, spec, child };
}

test('sandboxed parent cannot create an unconfined child', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const live = f.supervisor.state.require(w.worker_id);
    const spec: Spec = { environment: { id: 'parent', revision: 1, filesystem: 'bwrap', root: w.cwd, allowed_methods: [] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' };
    live.worker.launch_spec = spec;
    // A0's fixture execution was `settled`; P1-11 launches a child only under a running execution.
    live.worker.execution = { execution_id: 'run', command_id: 'run', state: 'started' };
    const cwd = join(w.cwd, 'child');
    mkdirSync(cwd);
    await assert.rejects(f.supervisor.create({ command_id: 'widen', cwd, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', parent: { ...bind(w, 'unused'), worker_id: w.worker_id, execution_id: 'run', task_id: 'task', generation_id: 'gen' }, launch_spec: { ...spec, role: 'child', environment: { id: 'child', revision: 1, allowed_methods: [] } } }), /child_filesystem_cannot_widen/);
    assert.equal(f.hosts.length, 1);
  } finally {
    f.cleanup();
  }
});

// ---- new in P2-4 ----

test('sandbox: a sandboxed child launches in its root (factory told, session dir inside it, history pinned there); files.read reads it', async () => {
  const launches: HostLaunch[] = [];
  const hosts: Host[] = [];
  const f = fixture({
    launch: launch => {
      launches.push(launch);
      if (!launch.sandbox) return undefined;
      // pi in the sandbox writes its session below its root; `outside` reports one outside it instead.
      const sid = `sandboxed-${hosts.length}`;
      const file = launch.create.command_id === 'outside' ? join(dirname(launch.sandbox), `${sid}.jsonl`) : join(launch.sessionDir, `${sid}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid })}\n${JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: 'SANDBOX_HISTORY' } })}\n`);
      const host = new Host(launch.sessionDir, sid, file);
      hosts.push(host);
      return host;
    },
  });
  const tree = privateTmp();
  try {
    const family = await sandboxedFamily(f, realpathSync(tree.dir), cwd => ({ environment: { id: 'child', revision: 1, allowed_methods: ['children.report'], filesystem: 'bwrap', root: cwd } }));
    const made = await f.supervisor.create(family.child('inside'));
    assert.equal(made.state, 'delivered', JSON.stringify(made));
    const child = f.supervisor.get(made.worker_id!);
    const launch = launches.find(l => l.workerId === child.worker_id)!;
    assert.equal(launch.sandbox, child.cwd, 'the factory is told the sandbox root: never an unsandboxed launch');
    assert.equal(launch.sessionDir, join(child.cwd, '.piw-worker', 'sessions', child.worker_id), 'its sessions live inside its root');
    assert.equal(launches.find(l => l.workerId === family.parent.worker_id)!.sandbox, undefined, 'an unsandboxed worker gets no sandbox');
    // pi selects the entry it wrote.
    hosts.find(h => h.file === f.supervisor.state.require(child.worker_id).sessionFile)!.emit('event', { type: 'host_leaf', leafId: 'entry' });
    const page = f.supervisor.history(child.worker_id, {});
    assert.deepEqual(page.entries.map(e => e.id), ['entry'], 'history reads the session file pinned below the root');
    // A session file pi reports outside the root is never read.
    const outside = await f.supervisor.create(family.child('outside'));
    assert.equal(outside.state, 'delivered', JSON.stringify(outside));
    hosts.find(h => h.file === f.supervisor.state.require(outside.worker_id!).sessionFile)!.emit('event', { type: 'host_leaf', leafId: 'entry' });
    assert.deepEqual(f.supervisor.history(outside.worker_id!, {}).entries, [], 'a session file outside the root is never read');
    assert.equal(f.supervisor.get(outside.worker_id!).history.last_entry_id, null);
    assert.throws(() => f.supervisor.features.history(f.supervisor.get(outside.worker_id!).session_id!, {}), /session_file_not_regular/, 'sessions.history never reads it either');
    assert.throws(() => f.supervisor.features.blob(f.supervisor.get(outside.worker_id!).session_id!, 'entry', 0), /unknown_entry/, 'blobs.read never reads it either');
    // files.read over B2: a sandboxed worker's root only, inside explicit roots; the response validates.
    writeFileSync(join(child.cwd, 'README.md'), '# readme\n');
    const owner = ownerGrant(f.dir);
    const server = createB2Server(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle);
    const socket = join(f.dir, 'b2.sock');
    await listenPrivate(server, socket);
    try {
      const read = (id: string, body: unknown) => socketCall(socket, 'POST', `/b2/workers/${id}/files/read`, body, owner.headers);
      assert.deepEqual(await read(child.worker_id, { path: join(child.cwd, 'README.md'), roots: [child.cwd] }), { status: 200, body: { path: join(child.cwd, 'README.md'), content: '# readme\n', bytes: 9, evidence: 'pinned_file_read' } });
      assert.deepEqual(await read(child.worker_id, { path: join(f.dir, 'journal.jsonl'), roots: [child.cwd] }), { status: 409, body: { error: 'file_outside_explicit_roots', effect: 'no_effect' } });
      assert.deepEqual(await read(family.parent.worker_id, { path: join(child.cwd, 'README.md'), roots: [child.cwd] }), { status: 409, body: { error: 'files_read_requires_sandbox_environment', effect: 'no_effect' } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }
  } finally {
    f.cleanup();
    tree.cleanup();
  }
});

test('sandbox: a sandboxed root worker waits for the parent channel; a child root overlapping the state is refused; sessions never cross a confinement', async () => {
  const f = fixture({
    launch: launch => {
      if (!launch.sandbox) return undefined;
      const sid = `sandboxed-${launch.workerId}`;
      const file = join(launch.sessionDir, `${sid}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid })}\n`);
      return new Host(launch.sessionDir, sid, file);
    },
  });
  const tree = privateTmp();
  try {
    const root = realpathSync(tree.dir);
    const lone = join(root, 'lone');
    mkdirSync(lone);
    const sandboxedRoot: Spec = { environment: { id: 'lone', revision: 1, allowed_methods: [], filesystem: 'bwrap', root: lone }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' };
    await assert.rejects(f.supervisor.create({ command_id: 'lone', cwd: lone, provider: 'p', model: 'm', thinking: 'off', launch_spec: sandboxedRoot }), /sandboxed_parent_requires_parent_channel/);
    const family = await sandboxedFamily(f, root, cwd => ({ environment: { id: 'child', revision: 1, allowed_methods: ['children.report'], filesystem: 'bwrap', root: cwd } }));
    const made = await f.supervisor.create(family.child('confined'));
    assert.equal(made.state, 'delivered', JSON.stringify(made));
    const child = f.supervisor.get(made.worker_id!);
    // The child stops (cleanup confirmed); its session is then known, free and unfenced, but sandbox-written.
    assert.equal((await f.supervisor.stop(child.worker_id, bind(child, 'stop-child'))).state, 'delivered');
    const parent = f.supervisor.get(family.parent.worker_id);
    f.hosts.find(h => h.file === f.supervisor.state.require(parent.worker_id).sessionFile)!.emit('event', { type: 'agent_settled' });
    const idle = f.supervisor.get(parent.worker_id);
    await assert.rejects(f.supervisor.rebind(parent.worker_id, { ...bind(idle, 'resume-child-session'), action: 'resume', target_session_id: child.session_id! }), /session_confinement_mismatch/, 'an unsandboxed pi never opens a session a sandbox wrote');
    const hostsBefore = f.hosts.length;
    // A sandboxed child whose root would contain the supervisor's state (the fixture's state is the test directory).
    const staged = await sandboxedFamily(f, join(f.dir, 'tree'), cwd => ({ environment: { id: 'inner', revision: 1, allowed_methods: ['children.report'], filesystem: 'bwrap', root: cwd } }), 'second-parent');
    const inner = staged.child('inner');
    await assert.rejects(f.supervisor.create({ ...inner, cwd: f.dir, launch_spec: { ...inner.launch_spec!, environment: { ...inner.launch_spec!.environment, root: f.dir } } }), /child_environment_outside_parent|overlaps_supervisor_state/);
    await assert.rejects(f.supervisor.create(inner), /overlaps_supervisor_state/);
    assert.equal(f.hosts.length, hostsBefore + 1, 'only the second parent was spawned; no refused child ran');
  } finally {
    f.cleanup();
    tree.cleanup();
  }
});

test('sandbox: the production host runs bwrap inside the join prefix, hands it the mount descriptors from FD 4 and keeps none open', async () => {
  const tmp = privateTmp();
  const dir = realpathSync(tmp.dir);
  try {
    const root = join(dir, 'root');
    mkdirSync(join(root, '.piw-agent'), { recursive: true });
    writeFileSync(join(root, '.piw-agent', 'auth.json'), '{}');
    const out = join(dir, 'capture');
    const bwrap = fakeBwrap(dir, out);
    const joined = join(dir, 'joined');
    const hosts = productionHosts(bwrap, { PATH: process.env.PATH, HOME: dir, PIW_TEST_PRIVATE_SENTINEL: 'x' });
    const domain: Domain = { root: '/test-domains', name: 'w-sandbox', boot: 'test' };
    const create = childCreate(root);
    const host = hosts.factory({ workerId: 'w', commandId: 'c', create, cwd: root, sessionDir: join(root, '.piw-worker'), domain, prefix: ['/bin/sh', '-c', 'printf "%s\\n" "$@" > "$0"; exec "$@"', joined], sandbox: root });
    await once(host as SdkHost, 'exit');
    await waitFor(`${out}.argv.done`);
    const ran = readFileSync(joined, 'utf8').trim().split('\n');
    assert.equal(ran[0], bwrap, 'the join prefix is the outermost wrapper: it runs bwrap, inside the domain');
    const args = readFileSync(`${out}.argv.done`, 'utf8').trim().split('\n');
    const at = args.indexOf('--');
    assert.deepEqual(args.slice(at + 1, at + 3), [process.execPath, sdkChildEntry], 'bwrap runs pi’s SDK child');
    for (const flag of ['--die-with-parent', '--clearenv', '--unshare-user', '--unshare-pid', '--new-session']) assert.ok(args.slice(0, at).includes(flag), flag);
    const bindAt = args.indexOf('--bind-fd');
    assert.deepEqual(args.slice(bindAt, bindAt + 3), ['--bind-fd', '4', root], 'the root is bound from descriptor 4');
    const roAt = args.indexOf('--ro-bind-fd');
    assert.deepEqual(args.slice(roAt, roAt + 3), ['--ro-bind-fd', '5', join(root, '.piw-agent', 'auth.json')]);
    assert.ok(!args.some((a, i) => (a === '--bind' || a === '--ro-bind') && inside(root, args[i + 1]!)), 'no path-based bind into the sandbox-writable tree');
    const fds = readFileSync(`${out}.fds`, 'utf8').trim().split('\n').map(Number);
    for (const fd of [3, 4, 5]) assert.ok(fds.includes(fd), `bwrap gets descriptor ${fd} (report slot, root, credential)`);
    assert.equal(readFileSync(`${out}.env`, 'utf8').includes('PIW_TEST_PRIVATE_SENTINEL'), false);
    await host.stop();
    // The supervisor's own copies of the mount sources are closed once bwrap has them.
    const held = readdirSync('/proc/self/fd').flatMap(fd => {
      try {
        return [readlinkSync(`/proc/self/fd/${fd}`)];
      } catch {
        return [];
      }
    });
    assert.deepEqual(held.filter(target => inside(root, target)), [], 'the supervisor keeps no mount descriptor open');
  } finally {
    tmp.cleanup();
  }
});

test('sandbox: compaction keeps a sandboxed session’s root in the resume catalog, so its reads stay pinned', () => {
  const records: JournalRecord[] = [
    { seq: 1, kind: 'supervisor', value: { supervisor_id: 's', supervisor_epoch: 'e', state_version: 3 } },
    { seq: 2, kind: 'worker', value: { worker: { worker_id: 'boxed', session_id: 'boxed-s', cwd: '/tree/child', status: 'stopped', launch_spec: { environment: { id: 'e', revision: 1, allowed_methods: [], filesystem: 'bwrap', root: '/tree/child' } } }, sessionFile: '/tree/child/.piw-worker/sessions/boxed/s.jsonl', pid: null, token: null } },
    { seq: 3, kind: 'worker', value: { worker: { worker_id: 'plain', session_id: 'plain-s', cwd: '/plain', status: 'stopped' }, sessionFile: '/state/sessions/plain/s.jsonl', pid: null, token: null } },
  ];
  const limits = { ...DEFAULT_RETENTION };
  const plan = planCompaction(records, { limits, goal: goalFor(limits), now: Date.now(), inFlight: new Set() });
  assert.deepEqual(
    plan.entries.filter(e => e.kind === 'session_catalog').map(e => e.value),
    [
      { session_id: 'boxed-s', file: '/tree/child/.piw-worker/sessions/boxed/s.jsonl', worker_id: 'boxed', root: '/tree/child' },
      { session_id: 'plain-s', file: '/state/sessions/plain/s.jsonl', worker_id: 'plain' },
    ],
  );
});

test('sandbox: the daemon refuses to start without a bwrap that runs, and never listens', { timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  try {
    const bins = { none: join(tmp.dir, 'none'), broken: join(tmp.dir, 'broken'), working: join(tmp.dir, 'working') };
    for (const [name, dir] of Object.entries(bins)) {
      mkdirSync(dir);
      if (name !== 'none') {
        writeFileSync(join(dir, 'bwrap'), `#!/bin/sh\nexit ${name === 'working' ? 0 : 1}\n`);
        chmodSync(join(dir, 'bwrap'), 0o755);
      }
    }
    const start = async (name: keyof typeof bins) => {
      const socket = join(tmp.dir, name, 'run', 'b2.sock');
      const child = spawn(process.execPath, [daemonMain], {
        env: { PATH: bins[name], PIW_SOCKET: socket, PIW_STATE_DIR: join(tmp.dir, name, 'state'), PIW_TEST_LOCATE_BWRAP: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => (stderr += chunk));
      try {
        const outcome = await Promise.race([
          once(child, 'exit').then(([code]) => code as number | null),
          new Promise<'listening'>(resolve => child.stderr!.on('data', () => stderr.includes('"listening"') && resolve('listening'))),
          delay(20_000).then(() => 'timeout' as const),
        ]);
        return { outcome, stderr, socket: existsSync(socket) };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    };
    for (const name of ['none', 'broken'] as const) {
      const r = await start(name);
      assert.equal(r.outcome, 1, `${name}: the daemon must exit 1: ${r.stderr}`);
      assert.match(r.stderr, /"refused"/);
      assert.match(r.stderr, /bwrap_unavailable/);
      assert.equal(r.stderr.includes('"listening"'), false);
      assert.equal(r.socket, false, `${name}: no socket`);
    }
    const ok = await start('working');
    assert.equal(ok.outcome, 'listening', `a bwrap that runs lets the daemon start: ${ok.stderr}`);
  } finally {
    tmp.cleanup();
  }
});

// ---- ported from A0 security-fix.test.ts (bwrap profile, kernel B1 bind, --die-with-parent) ----

test('bwrap profile: --die-with-parent, --clearenv allowlist, credential links refuse', () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  try {
    mkdirSync(join(root, '.piw-agent'));
    writeFileSync(join(root, '.piw-agent', 'models.json'), '{}');
    const launch = launchIn(root, '/bin/true', []);
    launch.close();
    assert.ok(launch.args.includes('--die-with-parent'));
    assert.ok(launch.args.includes('--clearenv'));
    const set = launch.args.flatMap((a, i) => (a === '--setenv' ? [launch.args[i + 1]!] : []));
    assert.deepEqual(set.sort(), Object.keys(launch.env).sort());
    assert.ok(launch.args.includes('--ro-bind-fd'));
    rmSync(join(root, '.piw-agent', 'models.json'));
    writeFileSync(join(root, 'elsewhere'), '{}');
    symlinkSync(join(root, 'elsewhere'), join(root, '.piw-agent', 'models.json'));
    assert.throws(() => launchIn(root, '/bin/true', []), /sandbox_credential_not_regular_file/);
  } finally {
    tmp.cleanup();
  }
});

const spawnLaunch = (launch: SandboxLaunch, extra: ('pipe' | 'ignore')[] = ['ignore']) =>
  new Promise<{ status: number | null; out: string; err: string }>(resolve => {
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['ignore', 'pipe', 'pipe', ...extra, ...launch.fds] });
    launch.close();
    let out = '';
    let err = '';
    child.stdout!.on('data', d => (out += d));
    child.stderr!.on('data', d => (err += d));
    child.on('close', status => resolve({ status, out, err }));
  });

test('kernel B1: bwrap binds the exact opened root even if the path is swapped before spawn; no mount fd reaches the sandbox', { skip }, async () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'marker'), 'ORIGINAL');
  writeFileSync(join(outside, 'marker'), 'OUTSIDE');
  try {
    const launch = launchIn(root, '/bin/sh', ['-c', 'cat marker; echo; ls /proc/self/fd | tr "\\n" " "'], locateBwrap());
    renameSync(root, join(base, 'moved'));
    symlinkSync(outside, root);
    const result = await spawnLaunch(launch);
    assert.equal(result.status, 0, result.err);
    const [content, fds] = result.out.split('\n');
    assert.equal(content, 'ORIGINAL');
    // 0-2 stdio, 3 report slot, plus the descriptor ls itself opens.
    assert.ok(fds!.trim().split(' ').map(Number).filter(n => n > 3).length <= 1, `mount descriptors leaked: ${fds}`);
  } finally {
    tmp.cleanup();
  }
});

test('kernel: --die-with-parent kills the sandbox when its spawning process dies', { skip }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  try {
    const launch = launchIn(root, '/bin/sh', ['-c', 'echo started > started; exec sleep 30'], locateBwrap());
    // The intermediate inherits the mount descriptors at the same numbers and
    // hands them to bwrap; then it is SIGKILLed like a crashed supervisor.
    const slots = launch.fds.map((_, i) => 4 + i);
    const mid = spawn(process.execPath, ['-e', `const c=require('child_process').spawn(${JSON.stringify(launch.command)},${JSON.stringify(launch.args)},{stdio:['ignore','ignore','ignore','ignore',...${JSON.stringify(slots)}],env:${JSON.stringify(launch.env)}});console.log(c.pid);setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'ignore', 'ignore', ...launch.fds] });
    launch.close();
    const pid = Number(await new Promise<string>(r => mid.stdout!.once('data', d => r(String(d)))));
    for (let i = 0; i < 100 && !existsSync(join(root, 'started')); i++) await delay(50);
    assert.equal(existsSync(join(root, 'started')), true, 'sandbox must have started (non-vacuous)');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true);
    mid.kill('SIGKILL');
    for (let i = 0; i < 40 && alive; i++) {
      await delay(50);
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'bwrap outlived its parent');
  } finally {
    tmp.cleanup();
  }
});

// ---- ported from A0 sandbox.test.ts: real subprocess, real SDK and real bubblewrap; no model request ----

const PROBE = (paths: string[]) => `import { readFileSync, readdirSync, readlinkSync, writeFileSync, writeSync } from 'node:fs';
export default function (pi) {
  pi.on('input', () => {
    for (const p of ${JSON.stringify(paths)}) {
      try { readFileSync(p); throw new Error('EXPOSED:' + p); } catch (e) { if (String(e).includes('EXPOSED:')) throw e; }
    }
    const fds = {};
    for (const fd of readdirSync('/proc/self/fd')) { try { fds[fd] = readlinkSync('/proc/self/fd/' + fd); } catch {} }
    writeFileSync(process.cwd() + '/fds.json', JSON.stringify(fds));
    writeSync(3, JSON.stringify({ report_id: 'sandbox', kind: 'result', message: 'FD_ONLY_FS_CONFIRMED' }) + '\\n');
    return { action: 'handled' };
  });
}
`;

test('kernel: bwrap SDK child cannot read outside sentinel/socket/grants; inherited FD delivers its report', { skip, timeout: 120_000 }, async () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const stateDir = join(base, 'state');
  const tree = join(base, 'tree');
  const cwd = join(tree, 'child');
  const parentCwd = join(tree, 'parent');
  const agent = join(base, 'agent');
  for (const d of [stateDir, cwd, parentCwd, agent]) mkdirSync(d, { recursive: true });
  const outside = join(tree, 'sentinel');
  writeFileSync(outside, 'NEVER_VISIBLE');
  writeFileSync(join(stateDir, 'worker.sock'), 'not-the-real-socket');
  writeFileSync(join(agent, 'auth.json'), '{}');
  const extension = join(cwd, 'probe.mjs');
  writeFileSync(extension, PROBE([outside, join(stateDir, 'worker.sock'), join(stateDir, 'grants', 'owner.json'), join(agent, 'auth.json')]));
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
  const spec: Spec = { environment: { id: 'test', revision: 1, root: tree, allowed_methods: ['children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [extension], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
  try {
    const p = await supervisor.create({ command_id: 'parent', cwd: parentCwd, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: spec });
    assert.equal(p.state, 'delivered', JSON.stringify(p));
    // A native run is not required to test launch/FD authority; the parent execution is an explicit fixture execution
    // in this no-provider-call subprocess test (running: P1-11 launches a child only under a running execution).
    const parent = supervisor.state.require(p.worker_id!);
    parent.worker.execution = { execution_id: 'test-run', command_id: 'test-run', state: 'started' };
    const w = supervisor.get(p.worker_id!);
    const c = await supervisor.create({ command_id: 'child', cwd, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', parent: { ...bind(w, 'unused'), worker_id: w.worker_id, execution_id: 'test-run', task_id: 'task', generation_id: 'gen' }, launch_spec: { ...spec, role: 'child', environment: { ...spec.environment, filesystem: 'bwrap', root: cwd } } });
    assert.equal(c.state, 'delivered', JSON.stringify(c));
    const child = supervisor.get(c.worker_id!);
    // The sandbox runs inside the child's cleanup domain: the join prefix is the outermost wrapper.
    const live = supervisor.state.require(child.worker_id);
    assert.match(readFileSync(`/proc/${live.pid}/cgroup`, 'utf8'), new RegExp(`/${live.domain!.name}\\n?$`), 'bwrap runs in the worker domain');
    const receipt = await supervisor.prompt(child.worker_id, { ...bind(child, 'probe'), message: 'probe' });
    assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
    const deadline = Date.now() + 10_000;
    while (!(supervisor.get(child.worker_id).child_reports?.length ?? 0) && Date.now() < deadline) await delay(50);
    assert.equal(supervisor.get(child.worker_id).child_reports?.length, 1, 'missing FD report');
    assert.equal(supervisor.get(child.worker_id).child_reports?.[0]?.message, 'FD_ONLY_FS_CONFIRMED');
    // bwrap closed every mount descriptor before pi ran: no descriptor of pi's names the root or anything below it.
    const fds = JSON.parse(readFileSync(join(cwd, 'fds.json'), 'utf8')) as Record<string, string>;
    // Node's 'pipe' stdio is a socket pair.
    assert.match(fds['3'] ?? '', /^(pipe|socket):/, `FD 3 is the report channel: ${JSON.stringify(fds)}`);
    // A mount source is a directory or file path (the root, a credential store); pi's own descriptors are pipes,
    // sockets, anonymous inodes and the directory it is listing.
    const leaked = Object.entries(fds).filter(([fd, target]) => Number(fd) > 3 && target.startsWith('/') && !/^\/proc\/\d+\/fd$/.test(target) && !target.startsWith('/dev/'));
    assert.deepEqual(leaked, [], `pi holds no mount descriptor: ${JSON.stringify(fds)}`);
    writeFileSync(join(cwd, 'ok'), 'OK');
    assert.equal(supervisor.readFile(child.worker_id, { path: 'ok', roots: [cwd] }).content, 'OK');
    assert.throws(() => supervisor.readFile(child.worker_id, { path: outside, roots: [tree] }), /outside/);
  } finally {
    await supervisor.shutdown();
    state.close();
    tmp.cleanup();
  }
});

