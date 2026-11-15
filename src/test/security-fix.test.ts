/** Security fix round regressions (A0 slice 7). Portable unless marked kernel. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, readdirSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { Host, bind } from './helpers.js';
import { artifactSubject } from '../artifact.js';
import { readGitPin, safeGit, safeGitRun } from '../git-safe.js';
import { sandboxLaunch } from '../sandbox.js';
import type { Create } from '../types.js';

const call = (socket: string, path: string, body?: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
  const q = request({ socketPath: socket, path: '/v0' + path, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, agent: false }, r => {
    let t = ''; r.on('data', x => t += x); r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(t) }));
  });
  q.on('error', reject); q.end(body ? JSON.stringify(body) : undefined);
});
/** A bwrap SDK parent on fake hosts, with its REAL per-generation channel. */
async function channelFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0sf-')));
  const state = join(base, 's'), root = join(base, 'parent'), outside = join(base, 'outside');
  mkdirSync(state, { mode: 0o700 }); mkdirSync(join(root, '.a0-agent'), { recursive: true }); mkdirSync(join(root, '.a0-worktrees')); mkdirSync(outside);
  writeFileSync(join(outside, 'host-file'), 'HOST_ONLY');
  const journal = new Journal(join(state, 'journal')); const hosts: Host[] = [];
  const s = new Supervisor(state, journal, '1.5.2', () => {
    const sid = `session-${hosts.length}`, file = join(state, sid + '.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
    const h = new Host(state, sid, file); hosts.push(h); return h;
  });
  const spec: NonNullable<Create['launch_spec']> = { environment: { id: root, revision: 1, filesystem: 'bwrap', root, allowed_methods: ['workers.create', 'children.report'] }, role: 'parent', tools: ['read'], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
  const p = await s.create({ command_id: 'parent', cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', launch_spec: spec });
  assert.equal(p.state, 'delivered', JSON.stringify(p));
  const live = s.require(p.worker_id!); live.worker.execution = { execution_id: 'run', command_id: 'run', state: 'settled' };
  const w = s.get(p.worker_id!), socket = live.channel!.socket;
  const child = (command_id: string, cwd: string, extra: Partial<NonNullable<Create['launch_spec']>> = {}) => ({ command_id, cwd, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', parent: { worker_id: w.worker_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision, execution_id: 'run', task_id: 'task-' + command_id, generation_id: 'gen' }, launch_spec: { ...spec, role: 'child', grant_methods: ['children.report'], environment: { id: cwd, revision: 1, allowed_methods: ['children.report'] }, ...extra } });
  const cleanup = async () => { await s.shutdown(); journal.close(); rmSync(base, { recursive: true, force: true }); };
  return { base, state, root, outside, s, hosts, w, socket, child, cleanup };
}
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

test('B1: a symlinked .a0-worktrees (or child entry) cannot hand a child an arbitrary host root', async () => {
  const f = await channelFixture();
  try {
    const before = tree(f.outside);
    // Sandboxed parent replaces its own worktree base with a link to a host dir.
    rmSync(join(f.root, '.a0-worktrees'), { recursive: true }); symlinkSync(f.outside, join(f.root, '.a0-worktrees'));
    mkdirSync(join(f.outside, 'x'));
    const viaBase = await call(f.socket, '/workers', f.child('via-base', join(f.root, '.a0-worktrees', 'x')));
    assert.equal(viaBase.status, 409, JSON.stringify(viaBase.body));
    // Pins the DIRECTORY check (O_NOFOLLOW walk from the parent root), not just
    // the channel grant scope behind it.
    assert.equal(viaBase.body.error, 'parent_channel_child_root_not_real_directory');
    assert.equal(viaBase.body.effect, 'no_effect');
    rmSync(join(f.root, '.a0-worktrees')); mkdirSync(join(f.root, '.a0-worktrees'));
    symlinkSync(join(f.outside, 'x'), join(f.root, '.a0-worktrees', 'y'));
    const viaEntry = await call(f.socket, '/workers', f.child('via-entry', join(f.root, '.a0-worktrees', 'y')));
    assert.equal(viaEntry.body.error, 'parent_channel_child_root_not_real_directory', JSON.stringify(viaEntry.body));
    const nested = await call(f.socket, '/workers', f.child('nested', join(f.root, '.a0-worktrees', 'a', 'b')));
    assert.equal(nested.body.error, 'parent_channel_child_root_not_direct_worktree', JSON.stringify(nested.body));
    assert.deepEqual(tree(f.outside), [...before, 'x'].sort(), 'broker wrote nothing into the host directory');
    assert.equal(f.hosts.length, 1, 'no child process was started');
  } finally { await f.cleanup(); }
});

test('B1: the channel acts with its own root-scoped grant, never the owner grant; worker-less receipts stay hidden', async () => {
  const f = await channelFixture();
  try {
    const grant = f.s.grants.active('channel-' + f.w.worker_id);
    assert.deepEqual(grant.scope, { worker_ids: [f.w.worker_id], cwd_roots: [f.root] });
    assert.equal(grant.methods.includes('*'), false);
    assert.equal(grant.methods.includes('interactions.answer_if_current'), false);
    mkdirSync(join(f.root, '.a0-worktrees', 'ok'));
    const launched = await call(f.socket, '/workers', f.child('ok', join(f.root, '.a0-worktrees', 'ok')));
    assert.equal(launched.body.state, 'delivered', JSON.stringify(launched.body));
    assert.equal(f.s.get(String(launched.body.worker_id)).grant_source_id, 'channel-' + f.w.worker_id);
    // A worker-less receipt (another caller's command) is not readable here.
    f.s.receipts.put({ command_id: 'owner-only', operation: 'workers.create', request_hash: 'h', state: 'rejected', stage: 'refused', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: new Date().toISOString() });
    const receipt = await call(f.socket, '/receipts/owner-only');
    assert.equal(receipt.status, 409, JSON.stringify(receipt.body));
  } finally { await f.cleanup(); }
});

test('B2: refused launches stage nothing; accepted staging never copies a raced link target', { timeout: 60000 }, async () => {
  const f = await channelFixture();
  const secret = join(f.base, 'secret'); writeFileSync(secret, 'SECRET-MARKER');
  const profile = join(f.root, '.a0-agent'), scratch = join(f.base, 'scratch'); mkdirSync(scratch);
  for (let i = 0; i < 64; i++) writeFileSync(join(profile, 'f' + i), 'benign');
  // Separate process: atomically alternate every profile file between a
  // regular file and a link to a file the sandboxed parent cannot read.
  const racer = spawn(process.execPath, ['-e', `const fs=require('fs');const p=${JSON.stringify(profile)},t=${JSON.stringify(scratch)},s=${JSON.stringify(secret)};
    for(;;)for(let i=0;i<64;i++){try{fs.rmSync(t+'/l'+i,{force:true});fs.symlinkSync(s,t+'/l'+i);fs.renameSync(t+'/l'+i,p+'/f'+i);fs.writeFileSync(t+'/r'+i,'benign');fs.renameSync(t+'/r'+i,p+'/f'+i)}catch{}}`], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 20; i++) {
      const cwd = join(f.root, '.a0-worktrees', 'refused' + i); mkdirSync(cwd);
      const refused = await call(f.socket, '/workers', f.child('refused' + i, cwd, { tools: ['notgranted'] }));
      assert.equal(refused.body.error, 'child_authority_not_subset', JSON.stringify(refused.body));
      assert.deepEqual(tree(cwd), [], 'a refused launch performs no copy');
    }
    let staged = 0; const failed: string[] = [];
    for (let i = 0; i < 40; i++) {
      const cwd = join(f.root, '.a0-worktrees', 'ok' + i); mkdirSync(cwd);
      const launched = await call(f.socket, '/workers', f.child('ok' + i, cwd));
      // Leak check first, whatever the receipt says: a path-following copy can
      // both fail and steal under this race.
      for (const name of existsSync(join(cwd, '.a0-agent')) ? readdirSync(join(cwd, '.a0-agent')) : []) {
        const path = join(cwd, '.a0-agent', name);
        if (lstatSync(path).isFile()) { staged++; assert.notEqual(readFileSync(path, 'utf8'), 'SECRET-MARKER', `staging copied a link target (${name}, attempt ${i})`); }
      }
      if (launched.body.state !== 'delivered') {
        failed.push(String(launched.body.error ?? launched.body.state));
        // Fixture plumbing only: lift the parent fence so later attempts still race.
        const w = f.s.get(f.w.worker_id);
        if (w.fence) await f.s.resolveUnknown(w.worker_id, { command_id: 'resolve-' + i, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision, uncertain_command_id: w.fence.command_id, fence_generation: w.fence.fence_generation, disposition: 'abandon' });
      }
    }
    assert.ok(staged > 0);
    assert.deepEqual(failed, [], 'descriptor staging tolerates a racing swap without failing the launch');
  } finally { racer.kill('SIGKILL'); await f.cleanup(); }
});

test('m1: an exact channel launch retry returns the stored receipt; a refused retry refuses again (never unknown)', async () => {
  const f = await channelFixture();
  try {
    mkdirSync(join(f.root, '.a0-worktrees', 'r'));
    const body = f.child('retry', join(f.root, '.a0-worktrees', 'r'));
    const first = await call(f.socket, '/workers', body), second = await call(f.socket, '/workers', body);
    assert.equal(first.body.state, 'delivered', JSON.stringify(first.body));
    assert.deepEqual(second, first);
    const missing = await call(f.socket, '/workers', f.child('missing', join(f.root, '.a0-worktrees', 'missing')));
    assert.equal(missing.status, 409, JSON.stringify(missing.body)); assert.equal(missing.body.effect, 'no_effect');
  } finally { await f.cleanup(); }
});

function linkedRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0sf-git-'))), repo = join(base, 'repo'), wt = join(base, 'wt'); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'A0 fixture'); git(repo, 'config', 'user.email', 'a0@example.invalid');
  writeFileSync(join(repo, 'note'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'worktree', 'add', '-qb', 'a0-child/task', wt, 'HEAD');
  const marker = join(base, 'fsmonitor-ran'), payload = join(base, 'payload.sh');
  writeFileSync(payload, `#!/bin/sh\necho RAN >> ${marker}\n`, { mode: 0o755 });
  return { base, repo, wt, git, marker, payload, admin: join(repo, '.git', 'worktrees', 'wt') };
}
/** A decoy common dir with a core.fsmonitor payload, as a sandboxed child could write. */
function decoy(r: ReturnType<typeof linkedRepo>, where: string): string {
  execFileSync('cp', ['-a', join(r.repo, '.git'), where]);
  execFileSync('git', ['--git-dir', where, 'config', 'core.fsmonitor', r.payload]);
  return where;
}

test('M1: a planted core.fsmonitor never runs from the owner checks (pin compare, then safe config)', () => {
  const r = linkedRepo();
  try {
    const pin = readGitPin(r.wt); // launch time
    const base = r.git(r.repo, 'rev-parse', 'HEAD');
    // Plant 1: rewrite the admin commondir to a decoy common dir.
    const original = readFileSync(join(r.admin, 'commondir'), 'utf8');
    writeFileSync(join(r.admin, 'commondir'), decoy(r, join(r.wt, 'decoy')) + '\n');
    assert.throws(() => artifactSubject(r.wt, 'HEAD', base, pin), /git_metadata_changed_since_launch/);
    assert.throws(() => safeGit(r.wt, pin, ['status', '--porcelain']), /git_metadata_changed_since_launch/);
    writeFileSync(join(r.admin, 'commondir'), original);
    // Plant 2: rewrite the worktree .git gitfile to point at a decoy gitdir.
    const gitfile = readFileSync(join(r.wt, '.git'), 'utf8');
    const fake = decoy(r, join(r.wt, 'decoy2')); writeFileSync(join(r.wt, '.git'), `gitdir: ${fake}\n`);
    assert.throws(() => safeGit(r.wt, pin, ['status', '--porcelain']), /git_metadata_changed_since_launch/);
    writeFileSync(join(r.wt, '.git'), gitfile);
    // A config the pin cannot catch (set before pinning) still never executes.
    r.git(r.repo, 'config', 'core.fsmonitor', r.payload);
    const repin = readGitPin(r.wt);
    safeGit(r.wt, repin, ['status', '--porcelain']); safeGitRun(r.repo, readGitPin(r.repo), ['fsck', '--full', '--strict']);
    artifactSubject(r.wt, 'HEAD', base, repin);
    assert.equal(existsSync(r.marker), false, 'fsmonitor payload ran from an owner-side Git command');
    // Missing pin refuses rather than trusting current bytes.
    assert.throws(() => safeGit(r.wt, undefined, ['status']), /git_launch_pin_required/);
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test('M1: ordinary checkouts refuse a planted commondir and config includes', () => {
  const r = linkedRepo();
  try {
    const pin = readGitPin(r.repo);
    writeFileSync(join(r.repo, '.git', 'commondir'), decoy(r, join(r.base, 'decoy')) + '\n');
    assert.throws(() => safeGit(r.repo, pin, ['status', '--porcelain']), /ordinary_checkout_redirected/);
    rmSync(join(r.repo, '.git', 'commondir'));
    r.git(r.repo, 'config', 'include.path', join(r.repo, 'evil.cfg'));
    assert.throws(() => readGitPin(r.repo), /include_refused/);
    assert.throws(() => sandboxLaunch(r.wt, '/bin/true', [], parent, 'child'), /include_refused/);
    assert.equal(existsSync(r.marker), false);
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

const parent = { worker_id: 'p', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'gen' };
const fdMounts = (args: string[]) => { const out: string[] = []; for (let i = 0; i < args.length; i++) if (args[i] === '--ro-bind-fd' || args[i] === '--bind-fd') out.push(`${args[i] === '--ro-bind-fd' ? 'ro' : 'rw'} ${args[i + 2]}`); return out; };

test('M1: sandbox mounts make Git pointers, HEAD, config, hooks and alternates read-only; sources are descriptors', () => {
  const r = linkedRepo();
  try {
    const launch = sandboxLaunch(r.wt, '/bin/true', [], parent, 'child');
    try {
      const mounts = fdMounts(launch.args), c = join(r.repo, '.git');
      for (const ro of [join(r.wt, '.git'), join(r.admin, 'gitdir'), join(r.admin, 'commondir'), join(r.admin, 'HEAD'), join(c, 'config'), join(c, 'refs'), join(c, 'objects', 'info')]) assert.ok(mounts.includes('ro ' + ro), ro);
      for (const rw of [r.wt, r.admin, join(c, 'objects'), join(c, 'refs', 'heads', 'a0-child')]) assert.ok(mounts.includes('rw ' + rw), rw);
      assert.ok(!launch.args.some((a, i) => (a === '--bind' || a === '--ro-bind') && launch.args[i + 1]!.startsWith(r.base)), 'no path-based bind into the sandbox-writable tree');
      assert.equal(launch.fds.length, mounts.length);
      assert.equal(launch.gitPin?.kind, 'linked');
    } finally { launch.close(); }
    const ordinary = sandboxLaunch(r.repo, '/bin/true', [], parent, 'child');
    try {
      const mounts = fdMounts(ordinary.args), g = join(r.repo, '.git');
      for (const ro of ['config', 'hooks', 'info', 'objects/info']) assert.ok(mounts.includes('ro ' + join(g, ro)), ro);
      assert.ok(mounts.includes('rw ' + g), '.git is pinned as a mount point');
    } finally { ordinary.close(); }
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test('m2: relaunch refuses a retargeted HEAD instead of mounting a sibling namespace', () => {
  const r = linkedRepo();
  try {
    const first = sandboxLaunch(r.wt, '/bin/true', [], parent, 'child'); first.close();
    r.git(r.repo, 'branch', 'a0-sibling/task');
    writeFileSync(join(r.admin, 'HEAD'), 'ref: refs/heads/a0-sibling/task\n');
    assert.throws(() => sandboxLaunch(r.wt, '/bin/true', [], parent, 'child', undefined, { gitPin: first.gitPin }), /git_metadata_changed_since_launch/);
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test('bwrap profile: --die-with-parent, --clearenv allowlist, credential links refuse', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a0sf-env-')));
  try {
    mkdirSync(join(root, '.a0-agent')); writeFileSync(join(root, '.a0-agent', 'models-store.json'), '{}');
    const launch = sandboxLaunch(root, '/bin/true', [], parent, 'child'); launch.close();
    assert.ok(launch.args.includes('--die-with-parent')); assert.ok(launch.args.includes('--clearenv'));
    const set = launch.args.flatMap((a, i) => a === '--setenv' ? [launch.args[i + 1]!] : []);
    assert.deepEqual(set.sort(), Object.keys(launch.env).sort());
    assert.ok(launch.args.includes('--ro-bind-fd'));
    rmSync(join(root, '.a0-agent', 'models-store.json')); writeFileSync(join(root, 'elsewhere'), '{}');
    symlinkSync(join(root, 'elsewhere'), join(root, '.a0-agent', 'models-store.json'));
    assert.throws(() => sandboxLaunch(root, '/bin/true', [], parent, 'child'), /sandbox_credential_not_regular_file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('m4: a native move that never completes reconciles from host state instead of refusing writes forever', async () => {
  const f = await channelFixture();
  try {
    const live = f.s.require(f.w.worker_id); live.worker.execution = null;
    f.s.nativeMoveTimeoutMs = 50;
    const before = f.s.get(f.w.worker_id);
    f.hosts[0]!.emit('event', { type: 'host_binding_changing' });
    await assert.rejects(f.s.prompt(f.w.worker_id, { ...bind(before, 'during'), message: 'x' }), /binding_change_in_progress/);
    await new Promise(r => setTimeout(r, 300));
    const after = f.s.get(f.w.worker_id);
    assert.equal(after.binding_revision, before.binding_revision + 1, 'reconciled as a binding change');
    await assert.rejects(f.s.prompt(f.w.worker_id, { ...bind(before, 'stale'), message: 'x' }), /stale_binding/);
    const ok = await f.s.prompt(f.w.worker_id, { ...bind(after, 'fresh'), message: 'x' });
    assert.equal(ok.state, 'delivered', JSON.stringify(ok));
  } finally { await f.cleanup(); }
});

test('m3: RPC refuses a stale-binding prompt while a native move is in progress', { timeout: 45000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0sf-rpcmove-'))), cwd = join(base, 'workspace'), state = join(base, 'state'), agent = join(base, 'agent');
  for (const dir of [cwd, state, agent]) mkdirSync(dir);
  const extension = join(cwd, 'slow.mjs');
  writeFileSync(extension, `import {writeFileSync,existsSync} from 'node:fs';
export default pi => {
  pi.on('input', e => e.text === 'noop' ? {action:'handled'} : undefined);
  pi.registerCommand('slow', {handler: async (_args, ctx) => {
    const cwd = ctx.cwd;
    await ctx.newSession({setup: async () => { writeFileSync(cwd+'/started','1'); while(!existsSync(cwd+'/release')) await new Promise(r=>setTimeout(r,20)); }});
  }});
};`);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  const journal = new Journal(join(state, 'journal'));
  const s = new Supervisor(state, journal, '1.5.2', Supervisor.rpcFactory(join(process.cwd(), 'node_modules/.bin/pi')));
  try {
    const receipt = await s.create({ command_id: 'create', cwd, host: 'rpc', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: { environment: { id: 'rpc-move', revision: 1, allowed_methods: [] }, role: 'test', tools: [], denied_tools: [], resources: { extensions: [extension], skills: [] }, grant_methods: [], seed_mode: 'standalone' } });
    assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
    const id = receipt.worker_id!, native = s.require(id).host!, before = s.get(id);
    const moving = native.request({ type: 'prompt', message: '/slow' });
    for (let i = 0; i < 200 && !existsSync(join(cwd, 'started')); i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(existsSync(join(cwd, 'started')), true);
    await new Promise(r => setTimeout(r, 200)); // let the stdout notification arrive
    await assert.rejects(s.prompt(id, { ...bind(before, 'stale-during'), message: 'noop' }), /binding_change_in_progress|stale_binding/);
    assert.equal(s.receipts.all.has('stale-during'), false, 'stale write was never dispatched to Pi');
    writeFileSync(join(cwd, 'release'), '1'); await moving; await native.request({ type: 'get_state' });
    const after = s.get(id);
    assert.equal(after.binding_revision, before.binding_revision + 1);
    const ok = await s.prompt(id, { ...bind(after, 'fresh'), message: 'noop' });
    assert.equal(ok.state, 'delivered', JSON.stringify(ok));
  } finally {
    await s.shutdown(); journal.close();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

// ---- kernel (real bwrap) ----
const kernel = { skip: process.env.A0_TEST_BWRAP !== '1' };
const spawnLaunch = (launch: ReturnType<typeof sandboxLaunch>, extra: ('pipe' | 'ignore')[] = ['ignore']) => new Promise<{ status: number | null; out: string; err: string }>(resolve => {
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['ignore', 'pipe', 'pipe', ...extra, ...launch.fds] });
  launch.close(); let out = '', err = '';
  child.stdout!.on('data', d => out += d); child.stderr!.on('data', d => err += d); child.on('close', status => resolve({ status, out, err }));
});

test('kernel B1: bwrap binds the exact opened root even if the path is swapped before spawn; no mount fd reaches the sandbox', kernel, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0sf-bfd-'))), root = join(base, 'root'), outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside); writeFileSync(join(root, 'marker'), 'ORIGINAL'); writeFileSync(join(outside, 'marker'), 'OUTSIDE');
  try {
    const launch = sandboxLaunch(root, '/bin/sh', ['-c', 'cat marker; echo; ls /proc/self/fd | tr "\\n" " "'], parent, 'child');
    renameSync(root, join(base, 'moved')); symlinkSync(outside, root);
    const result = await spawnLaunch(launch);
    assert.equal(result.status, 0, result.err);
    const [content, fds] = result.out.split('\n');
    assert.equal(content, 'ORIGINAL');
    // 0-2 stdio, 3 report slot, plus the descriptor ls itself opens.
    assert.ok(fds!.trim().split(' ').map(Number).filter(n => n > 3).length <= 1, `mount descriptors leaked: ${fds}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('kernel M1: child cannot rewrite .git, gitdir, commondir, HEAD or alternates; commit still works', kernel, async () => {
  const r = linkedRepo();
  try {
    const c = join(r.repo, '.git');
    const script = `set -u
      echo x > f && git add f && git -c user.name=A -c user.email=a@example.invalid commit -qm child || exit 70
      for t in .git ${r.admin}/gitdir ${r.admin}/commondir ${r.admin}/HEAD ${c}/objects/info/alternates ${c}/config; do
        if ( echo planted > "$t" ) 2>/dev/null; then echo "WROTE $t"; exit 71; fi
      done
      if rm -f .git 2>/dev/null || mv .git .g 2>/dev/null; then exit 72; fi
      echo OK`;
    const result = await spawnLaunch(sandboxLaunch(r.wt, '/bin/sh', ['-c', script], parent, 'child'));
    assert.equal(result.status, 0, result.out + result.err);
    assert.notEqual(r.git(r.wt, 'rev-parse', 'HEAD'), r.git(r.repo, 'rev-parse', 'HEAD'));
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test('kernel M1: an ordinary checkout root keeps config/hooks/info/alternates read-only and .git pinned; commits work', kernel, async () => {
  const r = linkedRepo();
  try {
    const g = join(r.repo, '.git');
    const script = `set -u
      echo y > g && git add g && git -c user.name=A -c user.email=a@example.invalid commit -qm parent || exit 70
      for t in ${g}/config ${g}/hooks/pre-commit ${g}/info/attributes ${g}/objects/info/alternates; do
        if ( echo planted > "$t" ) 2>/dev/null; then echo "WROTE $t"; exit 71; fi
      done
      if mv .git .g 2>/dev/null; then exit 72; fi
      echo OK`;
    const result = await spawnLaunch(sandboxLaunch(r.repo, '/bin/sh', ['-c', script], parent, 'child'));
    assert.equal(result.status, 0, result.out + result.err);
    assert.equal(r.git(r.repo, 'log', '-1', '--format=%s'), 'parent');
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test('kernel: --die-with-parent kills the sandbox when its spawning process dies', kernel, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a0sf-die-')));
  try {
    const launch = sandboxLaunch(root, '/bin/sh', ['-c', 'echo started > started; exec sleep 30'], parent, 'child');
    // The intermediate inherits the mount descriptors at the same numbers and
    // hands them to bwrap; then it is SIGKILLed like a crashed supervisor.
    const slots = launch.fds.map((_, i) => 4 + i);
    const mid = spawn(process.execPath, ['-e', `const c=require('child_process').spawn(${JSON.stringify(launch.command)},${JSON.stringify(launch.args)},{stdio:['ignore','ignore','ignore','ignore',...${JSON.stringify(slots)}],env:${JSON.stringify(launch.env)}});console.log(c.pid);setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'ignore', 'ignore', ...launch.fds] });
    launch.close();
    const pid = Number(await new Promise<string>(r => mid.stdout!.once('data', d => r(String(d)))));
    for (let i = 0; i < 100 && !existsSync(join(root, 'started')); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(existsSync(join(root, 'started')), true, 'sandbox must have started (non-vacuous)');
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, true);
    mid.kill('SIGKILL');
    for (let i = 0; i < 40 && alive; i++) { await new Promise(r => setTimeout(r, 50)); try { process.kill(pid, 0); } catch { alive = false; } }
    assert.equal(alive, false, 'bwrap outlived its parent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
