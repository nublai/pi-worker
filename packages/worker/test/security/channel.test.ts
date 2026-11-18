/**
 * P2-8: the parent channel and sandboxed child launch. Ports A0's `gate1-parent` tests, `gate1-fix` `kernel D1` and the
 * remaining `security-fix` cases (B1, m1, live topology), adapted to topology B (root, 2026-11-18): a sandboxed parent's
 * root is an owner-prepared linked worktree of the owner's repository; its children run in owner-prepared slots,
 * linked worktrees of the same repository at `PARENT/.piw-slots/<name>`; the parent never writes Git administrative
 * state. Portable cases run fake hosts behind the real channel sockets; kernel cases run real bwrap and real pi SDK
 * processes (no model request) under `harness/ci/kernel.sh -- channel`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parentChannels } from '../../src/b2/channel.js';
import { CgroupContainment, checkDelegation, type Domain } from '../../src/containment/containment.js';
import { productionHosts } from '../../src/daemon.js';
import { createApp } from '../../src/b2/app.js';
import { createB2Server, listenPrivate } from '../../src/b2/server.js';
import { GrantStore } from '../../src/grants/store.js';
import type { SdkHost } from '../../src/host/host.js';
import { openState } from '../../src/journal/state.js';
import { gitForEachRef, gitLog, gitRevParse, gitStatus, readGitPin, type OwnerGit } from '../../src/owner-git/git-safe.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import { CHANNEL_MOUNT, CHANNEL_SOCKET, locateBwrap, sandboxLaunch } from '../../src/sandbox/sandbox.js';
import type { Create, HostLaunch, Worker } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { ownerGrant, privateTmp, socketCall } from '../helpers.js';
import { bind, fixture, Host } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT in a delegated user service with bwrap (harness/ci/kernel.sh)';

type Spec = NonNullable<Create['launch_spec']>;
/** The complete environment inside a recorded sandbox launch: synthetic, never process.env. */
const SANDBOX_ENV: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/tmp/piw-home', LANG: 'C' };
/** Git with no global or system configuration and a synthetic environment. */
function gitIn(home: string) {
  const env = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  return (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
type GitFn = ReturnType<typeof gitIn>;
/** An ordinary owner repository with one commit, and the in-root names excluded. */
function ownerRepo(git: GitFn, repo: string, file = 'note'): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'A0 owner');
  git(repo, 'config', 'user.email', 'a0@example.invalid');
  writeFileSync(join(repo, file), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.piw-agent/\n.piw-worker/\n.piw-slots/\n');
}
const tree = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);
const count = (dir: string): number => (existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0);

/**
 * A fixture supervisor serving parent channels, and beside its state a sandboxed parent on a fake host, with its REAL
 * per-generation channel socket and a running execution. With `git`, the parent root is a linked worktree (branch
 * `job/parent`) of the owner repository `base/repo`, and `slot(name)` is an owner-made linked worktree of it;
 * otherwise slots are plain directories. Every sandboxed launch runs `sandboxLaunch` (so the spawn's pin, staging and
 * channel checks run) before its fake host exists; `before` runs first.
 */
async function channelFixture(options: { git?: boolean; resources?: (root: string) => string[]; before?: (launch: HostLaunch) => void } = {}) {
  const hosts: { workerId: string; host: Host }[] = [];
  const launches: HostLaunch[] = [];
  const f = fixture({
    launch: launch => {
      if (!launch.sandbox) return undefined;
      options.before?.(launch);
      sandboxLaunch(launch.sandbox, '/bin/true', [], { env: SANDBOX_ENV, ...(launch.gitPin !== undefined ? { gitPin: launch.gitPin } : {}), ...(launch.dependencies ? { dependencies: launch.dependencies } : {}), ...(launch.channel ? { channel: launch.channel } : {}) }).close();
      launches.push(launch);
      const sid = `sandboxed-${launch.workerId}-${launches.length}`;
      const file = join(launch.sessionDir, `${sid}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid })}\n`);
      const host = new Host(launch.sessionDir, sid, file);
      hosts.push({ workerId: launch.workerId, host });
      return host;
    },
  });
  const grants = new GrantStore(f.dir);
  f.supervisor.serveParentChannels(parentChannels({ supervisor: f.supervisor, grants }));
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const root = join(base, 'parent');
  const outside = join(base, 'outside');
  const repo = join(base, 'repo');
  const git = gitIn(base);
  if (options.git) {
    ownerRepo(git, repo);
    git(repo, 'worktree', 'add', '-qb', 'job/parent', root, 'HEAD');
  }
  mkdirSync(join(root, '.piw-agent'), { recursive: true });
  mkdirSync(join(root, '.piw-slots'));
  mkdirSync(outside);
  writeFileSync(join(outside, 'host-file'), 'HOST_ONLY');
  const resources = options.resources?.(root) ?? [];
  const methods = ['workers.create', 'children.report', 'sessions.resolve_unknown'];
  const spec: Spec = { environment: { id: 'parent', revision: 1, filesystem: 'bwrap', root, allowed_methods: methods }, role: 'parent', tools: ['read'], denied_tools: [], resources: { extensions: resources, skills: [] }, grant_methods: methods, seed_mode: 'standalone' };
  const made = await f.supervisor.create({ command_id: 'parent', cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', launch_spec: spec });
  assert.equal(made.state, 'delivered', JSON.stringify(made));
  const p = f.supervisor.get(made.worker_id!);
  assert.equal((await f.supervisor.prompt(p.worker_id, { ...bind(p, 'parent-run'), message: 'run' })).state, 'delivered');
  const w = f.supervisor.get(p.worker_id);
  const live = f.supervisor.state.require(w.worker_id);
  const socket = join(live.channel!.dir, 'sock');
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await socketCall(socket, body === undefined ? 'GET' : 'POST', `/b2${path}`, body, headers);
    return r as { status: number; body: Record<string, unknown> & Worker[] };
  };
  const child = (command_id: string, cwd: string, extra: Partial<Spec> = {}): Create => ({
    command_id,
    cwd,
    host: 'sdk',
    provider: 'p',
    model: 'm',
    thinking: 'off',
    parent: { worker_id: w.worker_id, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision, execution_id: w.execution!.execution_id, task_id: `task-${command_id}`, generation_id: 'gen' },
    launch_spec: { ...spec, role: 'child', grant_methods: ['children.report'], environment: { id: cwd, revision: 1, allowed_methods: ['children.report'] }, ...extra },
  });
  /** An owner-prepared slot: a linked worktree of the owner repository (with `git`), else a directory. */
  const slot = (name: string): string => {
    const path = join(root, '.piw-slots', name);
    if (options.git) git(repo, 'worktree', 'add', '-qb', `task-${name}/work`, path, 'HEAD');
    else mkdirSync(path);
    return path;
  };
  const childLaunches = () => launches.filter(l => l.workerId !== w.worker_id);
  const cleanup = async () => {
    await f.supervisor.shutdown();
    f.cleanup();
    tmp.cleanup();
  };
  return { f, s: f.supervisor, grants, base, root, outside, repo, git, w, live, socket, call, child, slot, spec, hosts, launches, childLaunches, cleanup };
}

// ---- ported from A0 security-fix.test.ts (B1, m1) ----

test('B1: a symlinked .piw-slots (or slot entry) cannot hand a child an arbitrary host root', async () => {
  const x = await channelFixture();
  try {
    const before = tree(x.outside);
    // The sandboxed parent replaces its own slot directory with a link to a host directory.
    rmSync(join(x.root, '.piw-slots'), { recursive: true });
    symlinkSync(x.outside, join(x.root, '.piw-slots'));
    mkdirSync(join(x.outside, 'x'));
    const viaBase = await x.call('/workers', x.child('via-base', join(x.root, '.piw-slots', 'x')));
    assert.equal(viaBase.status, 409, JSON.stringify(viaBase.body));
    // Pins the DIRECTORY check (O_NOFOLLOW walk from the parent root), not just the channel grant scope behind it.
    assert.equal(viaBase.body.error, 'parent_channel_child_root_not_real_directory');
    assert.equal(viaBase.body.effect, 'no_effect');
    rmSync(join(x.root, '.piw-slots'));
    mkdirSync(join(x.root, '.piw-slots'));
    symlinkSync(join(x.outside, 'x'), join(x.root, '.piw-slots', 'y'));
    const viaEntry = await x.call('/workers', x.child('via-entry', join(x.root, '.piw-slots', 'y')));
    assert.equal(viaEntry.body.error, 'parent_channel_child_root_not_real_directory', JSON.stringify(viaEntry.body));
    const nested = await x.call('/workers', x.child('nested', join(x.root, '.piw-slots', 'a', 'b')));
    assert.equal(nested.body.error, 'parent_channel_child_root_not_slot', JSON.stringify(nested.body));
    assert.deepEqual(tree(x.outside), [...before, 'x'].sort(), 'broker wrote nothing into the host directory');
    assert.equal(x.childLaunches().length, 0, 'no child process was started');
  } finally {
    await x.cleanup();
  }
});

test('B1: the channel acts with its own root-scoped grant, never the owner grant; worker-less receipts stay hidden', async () => {
  const x = await channelFixture();
  try {
    const grant = x.grants.read(`channel-${x.w.worker_epoch}`);
    assert.deepEqual(grant.scope, { worker_ids: [x.w.worker_id], cwd_roots: [x.root] });
    assert.equal(grant.methods.includes('*'), false);
    assert.equal(grant.methods.includes('interactions.answer_if_current'), false);
    const launched = await x.call('/workers', x.child('ok', x.slot('ok')));
    assert.equal(launched.body.state, 'delivered', JSON.stringify(launched.body));
    assert.equal(x.s.get(String(launched.body.worker_id)).grant_source_id, `channel-${x.w.worker_epoch}`);
    // A worker-less receipt (another caller's command) is not readable here.
    x.s.receipts.put({ command_id: 'owner-only', operation: 'workers.create', request_hash: 'h', state: 'rejected', stage: 'refused', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: new Date().toISOString() }, 'receipt.result');
    const receipt = await x.call('/receipts/owner-only');
    assert.equal(receipt.status, 409, JSON.stringify(receipt.body));
  } finally {
    await x.cleanup();
  }
});

test("B1 (topology B): a channel child's Git dirs are the parent's own pinned repository; another repository, or one the parent made in its root, refuses", async () => {
  const x = await channelFixture({ git: true });
  try {
    const parentPin = x.live.gitPin;
    assert.equal(parentPin?.common_dir, join(x.repo, '.git'), 'the parent root is a linked worktree of the owner repository');
    const ok = await x.call('/workers', x.child('inside', x.slot('inside')));
    assert.equal(ok.body.state, 'delivered', JSON.stringify(ok.body));
    const pin = x.s.state.require(String(ok.body.worker_id)).gitPin;
    assert.equal(pin?.kind, 'linked');
    assert.equal(pin?.common_dir, join(x.repo, '.git'));
    assert.equal(pin?.head, 'ref: refs/heads/task-inside/work\n');
    // A linked worktree of another repository placed in a slot refuses.
    const other = join(x.base, 'other');
    ownerRepo(x.git, other);
    x.git(other, 'worktree', 'add', '-qb', 'task-b/work', join(x.root, '.piw-slots', 'outside'), 'HEAD');
    const out = await x.call('/workers', x.child('outside', join(x.root, '.piw-slots', 'outside')));
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, 'parent_channel_child_git_not_parent_repository');
    // A repository the parent made inside its own root (it can write all of it) and a worktree of it in a slot refuse:
    // that common dir is outside the child root, so only the parent-repository rule stops it.
    const made = join(x.root, 'made');
    ownerRepo(x.git, made);
    x.git(made, 'worktree', 'add', '-qb', 'task-c/work', join(x.root, '.piw-slots', 'made'), 'HEAD');
    const mine = await x.call('/workers', x.child('made', join(x.root, '.piw-slots', 'made')));
    assert.equal(mine.body.error, 'parent_channel_child_git_not_parent_repository', JSON.stringify(mine.body));
    // A plain directory slot has no Git dirs at all.
    const plain = await x.call('/workers', x.child('plain', join(mkdirSync(join(x.root, '.piw-slots', 'plain'), { recursive: true })!)));
    assert.equal(plain.body.state, 'delivered', JSON.stringify(plain.body));
    assert.equal(x.s.state.require(String(plain.body.worker_id)).gitPin, null);
    assert.equal(x.childLaunches().length, 2, 'only the accepted children ran');
  } finally {
    await x.cleanup();
  }
});

test("B1 (topology B): a parent cannot redirect a slot's gitfile (in its writable root) to another slot or repository", async () => {
  let race: ((launch: HostLaunch) => void) | undefined;
  const x = await channelFixture({ git: true, before: launch => race?.(launch) });
  const owner: OwnerGit = { stateDir: x.f.dir, env: { PATH: '/usr/bin:/bin' } };
  try {
    const a = x.slot('a');
    const b = x.slot('b');
    const gitfile = readFileSync(join(a, '.git'), 'utf8');
    const admin = (name: string) => join(x.repo, '.git', 'worktrees', name);
    const refused = async (name: string, target: string, code: string) => {
      writeFileSync(join(a, '.git'), `gitdir: ${target}\n`);
      const r = await x.call('/workers', x.child(name, a));
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error, code, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.effect, 'no_effect');
    };
    // Another slot's admin dir names that slot back, not this one.
    await refused('to-sibling', admin('b'), 'sandbox_git_not_linked_worktree');
    // The parent's own admin dir names the parent root.
    await refused('to-parent', admin('parent'), 'sandbox_git_not_linked_worktree');
    // A worktree admin dir of another repository.
    const other = join(x.base, 'other');
    ownerRepo(x.git, other);
    x.git(other, 'worktree', 'add', '-qb', 'task-x/work', join(x.base, 'other-wt'), 'HEAD');
    await refused('to-other-repository', join(other, '.git', 'worktrees', 'other-wt'), 'sandbox_git_not_linked_worktree');
    // A fake admin dir the parent wrote in its root, naming this slot back, over its own fake common dir.
    const fake = join(x.root, 'fake');
    mkdirSync(join(fake, 'worktrees', 'a'), { recursive: true });
    for (const name of ['objects', 'refs']) mkdirSync(join(fake, name));
    writeFileSync(join(fake, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    writeFileSync(join(fake, 'worktrees', 'a', 'gitdir'), `${join(a, '.git')}\n`);
    writeFileSync(join(fake, 'worktrees', 'a', 'commondir'), '../..\n');
    writeFileSync(join(fake, 'worktrees', 'a', 'HEAD'), 'ref: refs/heads/task-a/work\n');
    await refused('to-fake-admin', join(fake, 'worktrees', 'a'), 'parent_channel_child_git_not_parent_repository');
    // A gitfile redirected after the launch's validation, before its spawn, refuses at the spawn; no child runs.
    writeFileSync(join(a, '.git'), gitfile);
    race = launch => {
      if (launch.cwd === a) writeFileSync(join(a, '.git'), `gitdir: ${admin('b')}\n`);
    };
    const raced = await x.call('/workers', x.child('raced', a));
    race = undefined;
    // The spawn reads the metadata again: the redirected gitfile is refused (it names another worktree's admin dir).
    assert.equal(raced.body.state, 'outcome_unknown', JSON.stringify(raced.body));
    assert.match(String(raced.body.error), /^(sandbox_git_not_linked_worktree|git_metadata_changed_since_launch)$/);
    assert.equal(x.childLaunches().length, 0, 'the raced child never ran');
    // A launched child's gitfile the parent rewrites later: owner Git, holding the launch pin, refuses to follow it.
    const fresh = await x.s.resolveUnknown(x.w.worker_id, { ...bind(x.s.get(x.w.worker_id), 'resolve'), uncertain_command_id: 'raced', fence_generation: x.s.get(x.w.worker_id).fence!.fence_generation, disposition: 'abandon' });
    assert.equal(fresh.state, 'delivered', JSON.stringify(fresh));
    const w = x.s.get(x.w.worker_id);
    const launched = await x.call('/workers', { ...x.child('b', b), parent: { ...x.child('b', b).parent!, binding_revision: w.binding_revision } });
    assert.equal(launched.body.state, 'delivered', JSON.stringify(launched.body));
    const pin = x.s.state.require(String(launched.body.worker_id)).gitPin!;
    assert.equal(gitRevParse({ owner, root: b, pin }, 'HEAD'), x.git(x.repo, 'rev-parse', 'HEAD'));
    writeFileSync(join(b, '.git'), `gitdir: ${admin('a')}\n`);
    assert.throws(() => gitRevParse({ owner, root: b, pin }, 'HEAD'), /git_metadata_changed_since_launch/);
  } finally {
    await x.cleanup();
  }
});

test('m1: an exact channel launch retry returns the stored receipt; a refused retry refuses again (never unknown)', async () => {
  const x = await channelFixture();
  try {
    const body = x.child('retry', x.slot('r'));
    const first = await x.call('/workers', body);
    const second = await x.call('/workers', body);
    assert.equal(first.body.state, 'delivered', JSON.stringify(first.body));
    assert.deepEqual(second, first);
    const missing = await x.call('/workers', x.child('missing', join(x.root, '.piw-slots', 'missing')));
    assert.equal(missing.status, 409, JSON.stringify(missing.body));
    assert.equal(missing.body.effect, 'no_effect');
    const again = await x.call('/workers', x.child('missing', join(x.root, '.piw-slots', 'missing')));
    assert.deepEqual(again, missing);
  } finally {
    await x.cleanup();
  }
});

// ---- ported from A0 gate1-parent.test.ts ----

test('parent channel staging never dereferences profile symlinks into supervisor secrets', async () => {
  const x = await channelFixture();
  try {
    const profile = join(x.root, '.piw-agent');
    // A file the parent cannot read: the channel's own grant record in the supervisor's state.
    const privateFile = join(x.f.dir, 'grants', `channel-${x.w.worker_epoch}.json`);
    assert.equal(existsSync(privateFile), true);
    symlinkSync(privateFile, join(profile, 'outside-link'));
    writeFileSync(join(profile, 'settings.json'), '{}');
    symlinkSync('settings.json', join(profile, 'local-link'));
    const refused = x.slot('refused');
    const no = await x.call('/workers', x.child('refused', refused, { tools: ['notgranted'] }));
    assert.equal(no.body.error, 'child_authority_not_subset', JSON.stringify(no.body));
    assert.equal(existsSync(join(refused, '.piw-agent')), false, 'a refused launch must not stage any file');
    const child = x.slot('copy');
    const accepted = await x.call('/workers', x.child('copy', child));
    assert.equal(accepted.body.state, 'delivered', JSON.stringify(accepted.body));
    assert.equal(lstatSync(join(child, '.piw-agent', 'outside-link')).isSymbolicLink(), true, 'broker must not turn an inaccessible link into a readable copied credential');
    assert.equal(readlinkSync(join(child, '.piw-agent', 'outside-link')), privateFile);
    assert.equal(readlinkSync(join(child, '.piw-agent', 'local-link')), 'settings.json', 'internal relative links must stay relative after staging');
  } finally {
    await x.cleanup();
  }
});

// ---- new in P2-8 ----

test('channel: only the whitelist is served; the Authorization header is ignored (the owner bearer gains nothing); only the parent and its children are visible', async () => {
  const x = await channelFixture();
  try {
    const owner = ownerGrant(x.f.dir, 'test-owner');
    const unrelated = await x.f.create();
    // An owner-made worker inside the parent's root that is not its child.
    const inRoot = join(x.root, '.piw-slots', 'owner-made');
    mkdirSync(inRoot);
    const stranger = await x.s.create({ command_id: 'stranger', cwd: inRoot, provider: 'p', model: 'm', thinking: 'off' });
    assert.equal(stranger.state, 'delivered', JSON.stringify(stranger));
    for (const headers of [{}, owner.headers]) {
      assert.equal((await x.call('/hello', undefined, headers)).status, 200);
      const list = await x.call('/workers', undefined, headers);
      assert.deepEqual(
        list.body.map(w => w.worker_id),
        [x.w.worker_id],
      );
      assert.equal((await x.call(`/workers/${x.w.worker_id}`, undefined, headers)).status, 200);
      for (const id of [unrelated.worker_id, stranger.worker_id!]) {
        const r = await x.call(`/workers/${id}`, undefined, headers);
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.error, 'grant_scope_denied');
      }
      for (const path of [`/workers/${x.w.worker_id}/resolve_unknown`, `/workers/${x.w.worker_id}/relaunch`, `/workers/${x.w.worker_id}/interactions/answer`, `/workers/${x.w.worker_id}/compact`]) {
        const r = await x.call(path, { command_id: 'x' }, headers);
        assert.equal(r.status, 409, `${path}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.error, 'parent_channel_method_denied', path);
        assert.equal(r.body.effect, 'no_effect');
      }
    }
  } finally {
    await x.cleanup();
  }
});

test("channel: a create must be the parent's own typed child; its resources must lie in the parent's profile", async () => {
  const x = await channelFixture();
  try {
    const unrelated = await x.f.create();
    const a = x.slot('a');
    const notMine = x.child('not-mine', a);
    const other = await x.call('/workers', { ...notMine, parent: { ...notMine.parent!, worker_id: unrelated.worker_id } });
    assert.equal(other.body.error, 'parent_channel_requires_own_child', JSON.stringify(other.body));
    const { parent: _parent, ...orphan } = notMine;
    void _parent;
    const root = await x.call('/workers', orphan);
    assert.equal(root.body.error, 'parent_channel_requires_own_child', JSON.stringify(root.body));
    const outside = await x.call('/workers', x.child('outside', a, { resources: { extensions: ['/etc/hostname'], skills: [] } }));
    assert.equal(outside.body.error, 'parent_channel_resource_outside_profile', JSON.stringify(outside.body));
    const traversal = await x.call('/workers', x.child('traversal', a, { resources: { extensions: [`${join(x.root, '.piw-agent')}/../x.mjs`], skills: [] } }));
    assert.equal(traversal.body.error, 'parent_channel_resource_outside_profile', JSON.stringify(traversal.body));
    assert.equal(x.childLaunches().length, 0);
  } finally {
    await x.cleanup();
  }
});

test("channel: a child's resources in the parent's profile are named in its staged copy; it is an SDK worker sandboxed in its slot", async () => {
  const x = await channelFixture({
    resources: root => {
      mkdirSync(join(root, '.piw-agent', 'extensions'), { recursive: true });
      writeFileSync(join(root, '.piw-agent', 'extensions', 'e.mjs'), 'export default () => {};\n');
      return [join(root, '.piw-agent', 'extensions', 'e.mjs')];
    },
  });
  try {
    const a = x.slot('a');
    const asked = x.child('ext', a);
    const { host: _host, ...rest } = asked;
    void _host;
    // The parent names its own profile path and no filesystem; the channel makes it a bwrap SDK child of its slot.
    const r = await x.call('/workers', { ...rest, launch_spec: { ...asked.launch_spec!, environment: { id: a, revision: 1, allowed_methods: ['children.report'] } } });
    assert.equal(r.body.state, 'delivered', JSON.stringify(r.body));
    const row = x.s.get(String(r.body.worker_id));
    assert.deepEqual(row.launch_spec?.resources.extensions, [join(a, '.piw-agent', 'extensions', 'e.mjs')]);
    assert.equal(row.launch_spec?.environment.filesystem, 'bwrap');
    assert.equal(row.launch_spec?.environment.root, a);
    assert.equal(row.host, 'sdk');
    assert.equal(readFileSync(join(a, '.piw-agent', 'extensions', 'e.mjs'), 'utf8'), 'export default () => {};\n', 'the staged copy holds the extension');
  } finally {
    await x.cleanup();
  }
});

test('channel: one generation: a stopped parent’s socket is gone, a retired generation and a revoked grant (the channel’s or the parent’s creating one) are refused', async () => {
  const x = await channelFixture();
  try {
    const handle = parentChannels({ supervisor: x.s, grants: x.grants });
    const hello = { method: 'GET', url: '/b2/hello', headers: {} };
    const identity = { workerId: x.w.worker_id, epoch: x.w.worker_epoch, grantId: `channel-${x.w.worker_epoch}`, root: x.root };
    assert.equal((await handle(identity)(hello)).status, 200);
    const stale = await handle({ ...identity, epoch: 'an-older-generation' })(hello);
    assert.equal(stale.status, 409);
    assert.equal((stale.body as { error: string }).error, 'parent_channel_retired');
    // The grant that created the parent, revoked: the channel stops too.
    const creator = x.grants.register({ caller: 'creator', scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods: ['*'], grant_id: 'creator' });
    void creator;
    x.live.worker.grant_source_id = 'creator';
    assert.equal((await x.call('/hello')).status, 200);
    x.grants.revoke('creator');
    const cut = await x.call('/hello');
    assert.equal(cut.status, 409, JSON.stringify(cut.body));
    assert.equal(cut.body.error, 'grant_revoked');
    delete x.live.worker.grant_source_id;
    assert.equal((await x.call('/hello')).status, 200);
    x.grants.revoke(identity.grantId);
    assert.equal((await x.call('/hello')).body.error, 'grant_revoked');
    // The generation ends: its socket and directory are gone.
    const dir = x.live.channel!.dir;
    assert.equal((await x.s.stop(x.w.worker_id, bind(x.s.get(x.w.worker_id), 'stop'))).state, 'delivered');
    assert.equal(x.live.channel, undefined);
    for (let n = 0; n < 100 && existsSync(dir); n++) await delay(10);
    assert.equal(existsSync(dir), false, 'the channel directory is removed');
    const connected = await new Promise<boolean>(resolve => {
      const c = createConnection(x.socket);
      c.once('connect', () => {
        c.destroy();
        resolve(true);
      });
      c.once('error', () => resolve(false));
    });
    assert.equal(connected, false, 'nothing answers on a retired channel socket');
    assert.equal((await handle(identity)(hello)).status, 409);
  } finally {
    await x.cleanup();
  }
});

test('channel: a relaunched sandboxed parent gets a new channel (directory, socket and grant); its root is validated again', async () => {
  const x = await channelFixture({ git: true });
  try {
    const old = x.live.channel!.dir;
    // The parent's run settles, so its stop is certain.
    x.hosts.find(h => h.workerId === x.w.worker_id)!.host.emit('event', { type: 'agent_settled' });
    assert.equal((await x.s.stop(x.w.worker_id, bind(x.s.get(x.w.worker_id), 'stop'))).state, 'delivered');
    for (let n = 0; n < 100 && existsSync(old); n++) await delay(10);
    const stopped = x.s.get(x.w.worker_id);
    // A relaunch revalidates the root: a retargeted HEAD refuses before any record.
    const head = join(x.repo, '.git', 'worktrees', 'parent', 'HEAD');
    writeFileSync(head, 'ref: refs/heads/main\n');
    await assert.rejects(x.s.relaunch(x.w.worker_id, bind(stopped, 'relaunch-bad')), /sandbox_git_branch_requires_private_namespace/);
    writeFileSync(head, 'ref: refs/heads/job/parent\n');
    const r = await x.s.relaunch(x.w.worker_id, bind(stopped, 'relaunch'));
    assert.equal(r.state, 'delivered', JSON.stringify(r));
    const now = x.s.get(x.w.worker_id);
    assert.notEqual(now.worker_epoch, x.w.worker_epoch);
    const channel = x.live.channel!;
    assert.notEqual(channel.dir, old);
    assert.equal(existsSync(old), false);
    assert.equal(channel.grantId, `channel-${now.worker_epoch}`);
    assert.equal(x.launches.at(-1)?.channel, channel.dir, 'the new generation binds its own channel');
    assert.equal(x.live.gitPin?.head, 'ref: refs/heads/job/parent\n');
    const hello = await socketCall(join(channel.dir, 'sock'), 'GET', '/b2/hello');
    assert.equal(hello.status, 200);
  } finally {
    await x.cleanup();
  }
});

test('channel: a supervisor without parent channels refuses a sandboxed root worker before any record; a restart removes stale channel directories', async () => {
  const f = fixture();
  const tmp = privateTmp();
  try {
    const root = realpathSync(tmp.dir);
    const spec: Spec = { environment: { id: 'p', revision: 1, filesystem: 'bwrap', root, allowed_methods: [] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' };
    const before = readFileSync(f.journalFile);
    await assert.rejects(f.supervisor.create({ command_id: 'p', cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', launch_spec: spec }), /sandboxed_parent_requires_parent_channel/);
    assert.deepEqual(readFileSync(f.journalFile), before);
    mkdirSync(join(f.dir, 'ch', 'stale'), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.dir, 'ch', 'stale', 'sock'), '');
    await f.restart();
    assert.equal(existsSync(join(f.dir, 'ch')), false);
  } finally {
    f.cleanup();
    tmp.cleanup();
  }
});

/** A stand-in bwrap that records its argv and its descriptors in `out`, then exits. */
function fakeBwrap(dir: string, out: string): string {
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'bwrap');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}.argv'\nls /proc/self/fd > '${out}.fds'\nmv '${out}.argv' '${out}.argv.done'\n`);
  chmodSync(path, 0o755);
  return path;
}

test('channel: the production host runs a sandboxed parent in bwrap with its channel directory bound read-only by descriptor and an allowlisted environment', async () => {
  const tmp = privateTmp();
  const dir = realpathSync(tmp.dir);
  try {
    const root = join(dir, 'root');
    const channel = join(dir, 'channel');
    mkdirSync(root);
    mkdirSync(channel, { mode: 0o700 });
    const out = join(dir, 'capture');
    // Synthetic: a model key passes, the supervisor's own configuration and a code-loading variable do not.
    const env = { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C', SYNTHETIC_API_KEY: 'synthetic-value', NODE_OPTIONS: '--require /x', PIW_STATE_DIR: '/state', UNLISTED_SETTING: 'x' };
    const hosts = productionHosts(fakeBwrap(dir, out), env);
    const domain: Domain = { root: '/test-domains', name: 'w-parent', boot: 'test' };
    const create: Create = { command_id: 'c', cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', launch_spec: { environment: { id: 'root', revision: 1, allowed_methods: [], filesystem: 'bwrap', root }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' } };
    const host = hosts.factory({ workerId: 'parent-id', commandId: 'c', create, cwd: root, sessionDir: join(root, '.piw-worker'), domain, prefix: [], sandbox: root, channel }) as SdkHost;
    await once(host, 'exit');
    for (let n = 0; n < 500 && !existsSync(`${out}.argv.done`); n++) await delay(20);
    const args = readFileSync(`${out}.argv.done`, 'utf8').trim().split('\n');
    const at = args.indexOf(CHANNEL_MOUNT);
    assert.ok(at > 0, 'the channel directory is mounted');
    assert.equal(args[at - 2], '--ro-bind-fd', 'read-only, by descriptor');
    assert.ok(readFileSync(`${out}.fds`, 'utf8').trim().split('\n').map(Number).includes(Number(args[at - 1])), 'bwrap holds the channel descriptor');
    assert.equal(args.includes(channel), false, 'the channel is never bound by path');
    const set = new Map<string, string>();
    for (let i = 0; i < args.length; i++) if (args[i] === '--setenv') set.set(args[i + 1]!, args[i + 2]!);
    assert.ok(set.get('PI_WORKER_SOCKET') === CHANNEL_SOCKET, 'PI_WORKER_SOCKET names the channel socket inside');
    assert.ok(set.get('PI_WORKER_ID') === 'parent-id', 'PI_WORKER_ID names the parent');
    assert.ok(set.has('SYNTHETIC_API_KEY'), 'a model key passes the allowlist');
    for (const name of ['NODE_OPTIONS', 'PIW_STATE_DIR', 'UNLISTED_SETTING', 'PI_WORKER_GRANT_FILE', 'PI_WORKER_REPORT_FD']) assert.equal(set.has(name), false, `${name} is not set inside`);
    assert.equal(args.includes('--clearenv'), true);
  } finally {
    tmp.cleanup();
  }
});

// ---- kernel: real bwrap, real pi SDK processes, no model ----

/** A supervisor on real cgroup domains and the production hosts (synthetic environment), serving the B2 socket and parent channels. */
async function realSupervisor(base: string) {
  const stateDir = join(base, 'state');
  const agent = join(base, 'agent');
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(agent);
  writeFileSync(join(agent, 'auth.json'), '{}');
  const state = openState(stateDir);
  const containment = new CgroupContainment(checkDelegation(process.env.PIW_CGROUP_ROOT ?? ''), state.installation);
  const grants = new GrantStore(stateDir);
  const s = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir,
    containment,
    grants,
    ...productionHosts(locateBwrap(), { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent }),
    sandboxControls: [stateDir],
  });
  s.serveParentChannels(parentChannels({ supervisor: s, grants }));
  const owner = ownerGrant(stateDir, 'owner');
  const server = createB2Server(createApp({ supervisor: s, grants }).handle);
  const socket = join(stateDir, 'worker.sock');
  await listenPrivate(server, socket);
  const close = async () => {
    await s.shutdown();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    state.close();
  };
  return { s, stateDir, agent, socket, owner, close };
}

const CALL = `const call=(path,body)=>new Promise((resolve,reject)=>{const q=request({socketPath:process.env.PI_WORKER_SOCKET,path,method:body?'POST':'GET',headers:{'Content-Type':'application/json'},agent:false},r=>{let t='';r.on('data',x=>t+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(t)}));});q.on('error',reject);q.end(body?JSON.stringify(body):undefined);});`;
const CHILD = (cwd: string, command: string, task: string) =>
  `{command_id:'${command}',cwd:${cwd},host:'sdk',provider:'anthropic',model:'claude-sonnet-4-5',thinking:'off',parent:{worker_id:me.worker_id,worker_epoch:me.worker_epoch,session_id:me.session_id,binding_revision:me.binding_revision,execution_id:me.execution.execution_id,task_id:'${task}',generation_id:'gen'},launch_spec:{...me.launch_spec,role:'child',grant_methods:['children.report'],environment:{id:${cwd},revision:1,allowed_methods:['children.report']}}}`;

// Literal Gate 1 test 11: the SAME project extension connects to the real B2 socket as this UID outside bwrap, then
// cannot connect inside a parent sandbox, where it can use its own channel only (PROBE A included).
test('project extension reaches B2 unsandboxed; bwrap parent cannot read grants/state or reach B2, but can use its own channel', { skip, timeout: 120_000 }, async () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const r = await realSupervisor(base);
  try {
    // A separate, same-UID worker stays invisible behind the parent's narrowly scoped channel.
    const unrelatedCwd = join(base, 'unrelated');
    mkdirSync(unrelatedCwd);
    const unrelated = await r.s.create({ command_id: 'unrelated', cwd: unrelatedCwd, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: { environment: { id: 'other', revision: 1, allowed_methods: [] }, role: 'other', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' } });
    assert.equal(unrelated.state, 'delivered', JSON.stringify(unrelated));
    // A host directory the parent cannot see (security fix round, PROBE A).
    const outsideHost = join(base, 'outside-host');
    mkdirSync(join(outsideHost, 'x'), { recursive: true });
    for (const sandboxed of [false, true]) {
      const root = join(base, sandboxed ? 'sandboxed' : 'unsandboxed');
      mkdirSync(join(root, '.piw-agent'), { recursive: true });
      mkdirSync(join(root, '.piw-slots'));
      writeFileSync(join(root, '.piw-agent', 'auth.json'), '{}');
      const project = join(root, '.pi', 'extensions');
      mkdirSync(project, { recursive: true });
      const extension = join(project, 'socket-probe.mjs');
      writeFileSync(
        extension,
        `import {readFileSync,writeFileSync,mkdirSync,symlinkSync,renameSync} from 'node:fs'; import {createConnection} from 'node:net'; import {request} from 'node:http';
const connect = path => new Promise(resolve=>{const c=createConnection(path); c.once('connect',()=>{c.destroy();resolve(true)});c.once('error',()=>resolve(false));});
${CALL}
export default pi => pi.on('input',async e=>{if(e.text!=='probe') return;
  const read = path => {try{readFileSync(path);return true}catch{return false}};
  const data={socket_connected:await connect(${JSON.stringify(r.socket)}),grant_readable:read(${JSON.stringify(join(r.stateDir, 'grants', 'owner.json'))}),state_readable:read(${JSON.stringify(join(r.stateDir, 'journal'))})};
  if(process.env.PI_WORKER_SOCKET===${JSON.stringify(CHANNEL_SOCKET)}) {
    data.channel_hello=(await call('/b2/hello')).status;
    data.channel_own=(await call('/b2/workers/'+process.env.PI_WORKER_ID)).status;
    data.channel_other=(await call('/b2/workers/${unrelated.worker_id}')).status;
    data.channel_inventory=(await call('/b2/workers')).body.map(w=>w.worker_id);
    data.no_bearer=process.env.PI_WORKER_GRANT_FILE===undefined;
    data.credential_readable=read(process.cwd()+'/.piw-agent/auth.json');
    try{writeFileSync(process.cwd()+'/.piw-agent/auth.json','{}');data.credential_writable=true}catch{data.credential_writable=false}
    const me=(await call('/b2/workers/'+process.env.PI_WORKER_ID)).body,child=process.cwd()+'/.piw-slots/probe-child';mkdirSync(child);
    symlinkSync(${JSON.stringify(join(r.stateDir, 'grants', 'owner.json'))},process.cwd()+'/.piw-agent/broker-link');
    const launched=await call('/b2/workers',${CHILD('child', 'broker-child', 'broker-task')});
    data.broker_child_state=launched.body.state;data.broker_secret_readable=read(child+'/.piw-agent/broker-link');
    const wt=process.cwd()+'/.piw-slots';renameSync(wt,wt+'-old');symlinkSync(${JSON.stringify(outsideHost)},wt);
    const escaped=await call('/b2/workers',${CHILD("wt+'/x'", 'escape-child', 'escape-task')});
    data.escape_status=escaped.status;data.escape_error=escaped.body.error;
  }
  writeFileSync(process.cwd()+'/probe.json',JSON.stringify(data));return {action:'handled'};
});`,
      );
      const spec: Spec = { environment: { id: root, revision: 1, allowed_methods: ['workers.create', 'children.report'], ...(sandboxed ? { filesystem: 'bwrap' as const, root } : {}) }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [extension], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
      const created = await r.s.create({ command_id: `parent-${sandboxed}`, cwd: root, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', project_trusted: true, launch_spec: spec });
      assert.equal(created.state, 'delivered', 'sandboxed parent must start');
      const w = r.s.get(created.worker_id!);
      const p = await r.s.prompt(w.worker_id, { ...bind(w, `probe-${sandboxed}`), message: 'probe' });
      assert.equal(p.state, 'delivered', JSON.stringify(p));
      const data = JSON.parse(readFileSync(join(root, 'probe.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(data.socket_connected, !sandboxed);
      assert.equal(data.grant_readable, !sandboxed);
      assert.equal(data.state_readable, !sandboxed);
      if (sandboxed) {
        assert.equal(data.channel_hello, 200);
        assert.equal(data.channel_own, 200);
        assert.equal(data.channel_other, 409);
        assert.deepEqual(data.channel_inventory, [w.worker_id]);
        assert.equal(data.no_bearer, true, 'no bearer exists in the sandbox');
        assert.equal(data.credential_readable, true);
        assert.equal(data.credential_writable, false);
        assert.equal(data.broker_child_state, 'delivered');
        assert.equal(data.broker_secret_readable, false, 'sandboxed parent must not obtain a grant indirectly through profile staging');
        assert.equal(data.escape_status, 409);
        assert.equal(data.escape_error, 'parent_channel_child_root_not_real_directory');
        assert.equal(existsSync(join(outsideHost, 'x', '.piw-agent')), false, 'broker must not write into a host directory reached through a parent link');
        assert.equal(existsSync(join(outsideHost, 'x', '.piw-worker')), false);
      }
    }
  } finally {
    await r.close();
    tmp.cleanup();
  }
});

/** A real staged pi profile's shape: config files and a 20,000+ entry node_modules tree. */
function realisticProfile(profile: string, packages = 2300): number {
  mkdirSync(join(profile, 'extensions', 'provider'), { recursive: true });
  writeFileSync(join(profile, 'extensions', 'provider', 'index.ts'), 'export default () => {};\n');
  writeFileSync(join(profile, 'settings.json'), '{"packages":[]}\n');
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

/**
 * Topology B, as the owner prepares it: the owner repository `base/repo`, the parent root a linked worktree of it on
 * `job/live` and one slot, a locked linked worktree on `task-<slot>/work` at `PARENT/.piw-slots/<slot>`.
 */
function ownerTopology(base: string, slotName: string, slotBranch: string) {
  const git = gitIn(base);
  const repo = join(base, 'repo');
  const root = join(base, 'parent');
  ownerRepo(git, repo, 'README.md');
  git(repo, 'worktree', 'add', '-qb', 'job/live', root, 'HEAD');
  const slot = join(root, '.piw-slots', slotName);
  git(repo, 'worktree', 'add', '--lock', '-qb', slotBranch, slot, 'HEAD');
  return { git, repo, root, slot };
}

test('kernel D1: a sandboxed parent launches a channel child with a 20k+ entry profile; the child loads code from the read-only dependency bind', { skip, timeout: 300_000 }, async () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const id = 'c0ffee00-0000-4000-8000-0000000000d1';
  const t = ownerTopology(base, id, 'task-d1/work');
  const profile = join(t.root, '.piw-agent');
  const total = realisticProfile(profile);
  writeFileSync(join(profile, 'auth.json'), '{}');
  const modules = join(profile, 'npm', 'node_modules');
  const probe = join(modules, 'probe-ext');
  mkdirSync(join(probe, 'data', 'deep'), { recursive: true });
  writeFileSync(join(probe, 'data', 'deep', 'marker.txt'), 'FROM_PARENT_DEPENDENCY_TREE');
  writeFileSync(join(probe, 'package.json'), '{"name":"probe-ext","type":"module"}');
  writeFileSync(
    join(probe, 'index.mjs'),
    `import {readFileSync,writeFileSync,readdirSync} from 'node:fs'; import {dirname,join} from 'node:path'; import {fileURLToPath} from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
export default pi => pi.on('input', async e => {
  if (e.text !== 'probe') return;
  const out = { marker: readFileSync(join(here,'data','deep','marker.txt'),'utf8'), packages: readdirSync(dirname(here)).length, here };
  try { writeFileSync(join(here,'planted'),'x'); out.writable = true; } catch (error) { out.writable = false; out.code = error.code; }
  try { writeFileSync(join(dirname(here),'pkg-1','index.js'),'planted'); out.sibling_writable = true; } catch { out.sibling_writable = false; }
  writeFileSync(process.cwd()+'/.piw-worker/probe.json', JSON.stringify(out)); return {action:'handled'};
});`,
  );
  assert.ok(total > 20000, `fixture must exceed the real profile (${total})`);
  const ext = join(profile, 'extensions');
  // The owner prepared the slot; the parent only names it (no Git administrative write).
  writeFileSync(
    join(ext, 'parent.mjs'),
    `import {writeFileSync} from 'node:fs'; import {request} from 'node:http';
${CALL}
export default pi => pi.on('input', async e => {
  if (e.text !== 'go') return;
  const wt = process.cwd() + '/.piw-slots/${id}';
  const me=(await call('/b2/workers/'+process.env.PI_WORKER_ID)).body;
  const r=await call('/b2/workers',${CHILD('wt', 'd1-child', 'd1-task')});
  writeFileSync(process.cwd()+'/go.json',JSON.stringify({status:r.status,body:r.body}));return {action:'handled'};
});`,
  );
  const r = await realSupervisor(base);
  try {
    const spec: Spec = { environment: { id: t.root, revision: 1, filesystem: 'bwrap', root: t.root, allowed_methods: ['workers.create', 'children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [join(ext, 'parent.mjs'), join(probe, 'index.mjs')], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
    const created = await r.s.create({ command_id: 'd1-parent', cwd: t.root, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: spec });
    assert.equal(created.state, 'delivered', JSON.stringify(created));
    const p = r.s.get(created.worker_id!);
    assert.equal((await r.s.prompt(p.worker_id, { ...bind(p, 'go'), message: 'go' })).state, 'delivered');
    const go = JSON.parse(readFileSync(join(t.root, 'go.json'), 'utf8')) as { body: Record<string, unknown> };
    assert.equal(go.body.state, 'delivered', JSON.stringify(go));
    const child = r.s.get(String(go.body.worker_id));
    const wt = t.slot;
    assert.equal(child.status, 'ready');
    assert.ok(count(join(wt, '.piw-agent')) < 60, `staged copy stays small (${count(join(wt, '.piw-agent'))})`);
    assert.equal((await r.s.prompt(child.worker_id, { ...bind(child, 'probe'), message: 'probe' })).state, 'delivered');
    const out = JSON.parse(readFileSync(join(wt, '.piw-worker', 'probe.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(out.marker, 'FROM_PARENT_DEPENDENCY_TREE', 'child loaded and read its extension from the dependency bind');
    assert.equal(out.here, join(wt, '.piw-agent', 'npm', 'node_modules', 'probe-ext'), 'child sees the dependency tree at its own profile path');
    assert.ok(Number(out.packages) > 2000, 'the whole dependency tree is visible');
    assert.equal(out.writable, false, 'dependency bind is read-only in the child');
    assert.equal(out.code, 'EROFS');
    assert.equal(out.sibling_writable, false);
    assert.equal(existsSync(join(probe, 'planted')), false);
    assert.equal(readFileSync(join(modules, 'pkg-1', 'index.js'), 'utf8'), 'x');
    assert.equal(lstatSync(join(wt, '.piw-agent', 'npm', 'node_modules')).isDirectory(), true);
    assert.deepEqual(readdirSync(join(wt, '.piw-agent', 'npm', 'node_modules')), [], 'host mount point stays empty');
  } finally {
    await r.close();
    tmp.cleanup();
  }
});

// The live job's topology with no model call, adapted to topology B: the owner prepares the parent worktree and the
// child slot, the sandboxed parent launches a child there through its channel, the child commits in its namespace
// inside bwrap, the parent cherry-picks in its own worktree, and the owner verifies through owner Git's typed API.
test('kernel: live topology — owner-prepared parent and slot, channel child commit, parent cherry-pick, owner pinned check', { skip, timeout: 120_000 }, async () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const id = 'c0ffee00-0000-4000-8000-000000000001';
  const t = ownerTopology(base, id, 'task-live/work');
  const ext = join(t.root, '.piw-agent', 'extensions');
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(t.root, '.piw-agent', 'auth.json'), '{}');
  const ownerPin = readGitPin(t.root);
  const childPin0 = readGitPin(t.slot);
  const baseRefs = t.git(t.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  writeFileSync(
    join(ext, 'parent.mjs'),
    `import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; import {request} from 'node:http';
${CALL}
const git=(...a)=>execFileSync('git',['-c','user.name=A0 parent','-c','user.email=a0@example.invalid',...a],{encoding:'utf8',cwd:process.cwd()}).trim();
export default pi => pi.on('input', async e => {
  if (e.text === 'go') {
    const wt = process.cwd() + '/.piw-slots/${id}';
    const me=(await call('/b2/workers/'+process.env.PI_WORKER_ID)).body;
    const r=await call('/b2/workers',${CHILD('wt', 'live-child', 'live-task')});
    writeFileSync(process.cwd()+'/go.json',JSON.stringify({status:r.status,body:r.body}));return {action:'handled'};
  }
  if (e.text.startsWith('pick ')) { let out; try { git('cherry-pick',e.text.slice(5)); out={ok:true,head:git('rev-parse','HEAD')}; } catch (error) { out={ok:false,error:String(error).slice(0,400)}; } writeFileSync(process.cwd()+'/pick.json',JSON.stringify(out)); return {action:'handled'}; }
});`,
  );
  writeFileSync(
    join(ext, 'child.mjs'),
    `import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs';
export default pi => pi.on('input', async e => {
  if (e.text !== 'commit') return;
  const git=(...a)=>execFileSync('git',['-c','user.name=A0 child','-c','user.email=a0@example.invalid',...a],{encoding:'utf8',cwd:process.cwd()}).trim();
  let out; try { writeFileSync(process.cwd()+'/README.md','base\\nchild line\\n'); git('add','README.md'); git('commit','-qm','child'); out={ok:true,head:git('rev-parse','HEAD'),status:git('status','--porcelain')}; } catch (error) { out={ok:false,error:String(error).slice(0,400)}; }
  writeFileSync(process.cwd()+'/.piw-worker/commit.json',JSON.stringify(out)); return {action:'handled'};
});`,
  );
  const r = await realSupervisor(base);
  const owner: OwnerGit = { stateDir: r.stateDir, env: { PATH: '/usr/bin:/bin' } };
  try {
    const spec: Spec = { environment: { id: t.root, revision: 1, filesystem: 'bwrap', root: t.root, allowed_methods: ['workers.create', 'children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [join(ext, 'parent.mjs'), join(ext, 'child.mjs')], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
    const created = await r.s.create({ command_id: 'live-parent', cwd: t.root, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: spec });
    assert.equal(created.state, 'delivered', JSON.stringify(created));
    const p = r.s.get(created.worker_id!);
    assert.deepEqual(r.s.state.require(p.worker_id).gitPin, ownerPin, 'supervisor launch pin equals the owner setup pin');
    assert.equal((await r.s.prompt(p.worker_id, { ...bind(p, 'go'), message: 'go' })).state, 'delivered');
    const go = JSON.parse(readFileSync(join(t.root, 'go.json'), 'utf8')) as { body: Record<string, unknown> };
    assert.equal(go.body.state, 'delivered', JSON.stringify(go));
    const child = r.s.get(String(go.body.worker_id));
    const childPin = r.s.state.require(child.worker_id).gitPin!;
    assert.equal(childPin.kind, 'linked');
    assert.equal(childPin.head, 'ref: refs/heads/task-live/work\n');
    assert.equal(childPin.common_dir, ownerPin.common_dir, "the child's Git dirs are the parent's own repository");
    assert.deepEqual(childPin, childPin0, 'the child launch pin equals the owner setup pin of the slot');
    assert.equal((await r.s.prompt(child.worker_id, { ...bind(child, 'commit'), message: 'commit' })).state, 'delivered');
    const commit = JSON.parse(readFileSync(join(t.slot, '.piw-worker', 'commit.json'), 'utf8')) as { ok: boolean; head: string; status: string };
    assert.equal(commit.ok, true, JSON.stringify(commit));
    assert.equal(commit.status, '');
    const p2 = r.s.get(p.worker_id);
    assert.equal((await r.s.prompt(p2.worker_id, { ...bind(p2, 'pick'), message: `pick ${commit.head}` })).state, 'delivered');
    const pick = JSON.parse(readFileSync(join(t.root, 'pick.json'), 'utf8')) as { ok: boolean; head: string };
    assert.equal(pick.ok, true, JSON.stringify(pick));
    // Owner verification: only through the launch-time pins and owner Git's typed API.
    const childAt = { owner, root: t.slot, pin: childPin };
    const parentAt = { owner, root: t.root, pin: ownerPin };
    assert.equal(gitRevParse(childAt, 'HEAD'), commit.head);
    assert.equal(gitRevParse(parentAt, 'HEAD'), pick.head);
    assert.deepEqual(
      gitLog(parentAt, 'HEAD', 3).map(e => e.subject),
      ['child', 'base'],
    );
    assert.equal(
      gitStatus(parentAt)
        .split('\n')
        .filter(l => l && !/go\.json|pick\.json/.test(l))
        .join(''),
      '',
    );
    const before = new Map(baseRefs.split('\n').map(x => x.split(' ') as [string, string]));
    const after = new Map(gitForEachRef(parentAt, 'refs/').map(ref => [ref.ref, ref.object] as [string, string]));
    const moved = [...after].filter(([ref, sha]) => before.get(ref) !== sha).map(([ref]) => ref).sort();
    assert.deepEqual(moved, ['refs/heads/job/live', 'refs/heads/task-live/work']);
  } finally {
    await r.close();
    tmp.cleanup();
  }
});

