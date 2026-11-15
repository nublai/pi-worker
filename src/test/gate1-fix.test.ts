/** Gate 1 rerun fix round (D1 profile staging size, D2 post-dispatch staging
 * failures, D3 failed child rows). Portable unless marked kernel. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, existsSync, realpathSync, statSync, fstatSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { ReceiptStore } from '../receipts.js';
import { Host, bind } from './helpers.js';
import { sandboxLaunch } from '../sandbox.js';
import * as types from '../types.js';
import { Refusal, type Create, type Worker } from '../types.js';
import type { HostContext } from '../host.js';

const call = (socket: string, path: string, body?: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
  const q = request({ socketPath: socket, path: '/v0' + path, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, agent: false }, r => {
    let t = ''; r.on('data', x => t += x); r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(t) }));
  });
  q.on('error', reject); q.end(body ? JSON.stringify(body) : undefined);
});
/** Shape of a real staged Pi profile: a few config files plus a large
 * npm/node_modules tree (the real one has 18,801 entries; this one > 20,000). */
function realisticProfile(profile: string, packages = 2300): number {
  mkdirSync(join(profile, 'extensions', 'provider'), { recursive: true });
  writeFileSync(join(profile, 'extensions', 'provider', 'index.ts'), 'export default () => {};\n');
  writeFileSync(join(profile, 'settings.json'), '{"packages":[]}\n');
  writeFileSync(join(profile, 'models-store.json'), '{}');
  writeFileSync(join(profile, 'npm-package.json'), '{}');
  const modules = join(profile, 'npm', 'node_modules'); mkdirSync(join(modules, '.bin'), { recursive: true });
  for (let i = 0; i < packages; i++) {
    const pkg = join(modules, 'pkg-' + i); mkdirSync(join(pkg, 'lib'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), `{"name":"pkg-${i}","version":"1.0.0"}`);
    for (const name of ['index.js', 'README.md', 'LICENSE']) writeFileSync(join(pkg, name), 'x');
    for (const name of ['a.js', 'b.js', 'c.js']) writeFileSync(join(pkg, 'lib', name), 'y');
    if (i % 50 === 0) symlinkSync('../pkg-' + i + '/index.js', join(modules, '.bin', 'pkg-' + i));
  }
  return count(profile) + 1;
}
function count(dir: string): number { return existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0; }
type DependencyBind = { fd: number; dest: string[] };
/** A bwrap SDK parent on fake hosts with its REAL channel; each host factory
 * call records what the sandbox would bind, while descriptors are still open. */
async function channelFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0g1f-')));
  const state = join(base, 's'), root = join(base, 'parent');
  mkdirSync(state, { mode: 0o700 }); mkdirSync(join(root, '.a0-agent'), { recursive: true }); mkdirSync(join(root, '.a0-worktrees'));
  const journal = new Journal(join(state, 'journal')); const hosts: Host[] = [];
  const launches: { cwd: string; args: string[]; dependencies: { dest: string[]; ino: number; dev: number }[] }[] = [];
  const s = new Supervisor(state, journal, '1.5.2', (c: Create, _dir: string, context?: HostContext) => {
    if (c.parent && context?.sandbox) {
      const deps = ((context.sandbox as Record<string, unknown>).dependencies ?? []) as DependencyBind[];
      const launch = sandboxLaunch(c.cwd, '/bin/true', [], c.parent, 'child', undefined, context.sandbox); launch.close();
      launches.push({ cwd: c.cwd, args: launch.args, dependencies: deps.map(d => ({ dest: d.dest, ino: fstatSync(d.fd).ino, dev: fstatSync(d.fd).dev })) });
    }
    const sid = `session-${hosts.length}`, file = join(state, sid + '.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
    const h = new Host(state, sid, file); hosts.push(h); return h;
  });
  const spec: NonNullable<Create['launch_spec']> = { environment: { id: root, revision: 1, filesystem: 'bwrap', root, allowed_methods: ['workers.create', 'children.report'] }, role: 'parent', tools: ['read'], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
  const p = await s.create({ command_id: 'parent', cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', launch_spec: spec });
  assert.equal(p.state, 'delivered', JSON.stringify(p));
  const live = s.require(p.worker_id!); live.worker.execution = { execution_id: 'run', command_id: 'run', state: 'settled' };
  const w = s.get(p.worker_id!), socket = live.channel!.socket;
  const child = (command_id: string, cwd: string) => ({ command_id, cwd, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', parent: { worker_id: w.worker_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision, execution_id: 'run', task_id: 'task-' + command_id, generation_id: 'gen' }, launch_spec: { ...spec, role: 'child', grant_methods: ['children.report'], environment: { id: cwd, revision: 1, allowed_methods: ['children.report'] } } });
  const worktree = (name: string) => { const cwd = join(root, '.a0-worktrees', name); mkdirSync(cwd); return cwd; };
  const cleanup = async () => { await s.shutdown(); journal.close(); rmSync(base, { recursive: true, force: true }); };
  return { base, state, root, s, hosts, w, socket, child, worktree, launches, cleanup };
}
const children = (s: Supervisor, parent: string): Worker[] => s.list().filter(x => x.parent_worker_id === parent);
const failure = (w: Worker) => (w as Worker & { failure?: { command_id: string; reason: string } }).failure;

test('D1: a real-size profile (20k+ entries, node_modules shape) stages small and binds its dependency tree read-only by descriptor', { timeout: 120000 }, async () => {
  const f = await channelFixture();
  try {
    const profile = join(f.root, '.a0-agent'), total = realisticProfile(profile);
    assert.ok(total > 20000, `fixture must exceed the real profile (${total})`);
    const cwd = f.worktree('big');
    const launched = await call(f.socket, '/workers', f.child('big', cwd));
    assert.equal(launched.body.state, 'delivered', JSON.stringify(launched.body));
    const staged = join(cwd, '.a0-agent');
    // Only mutable/config files are copied; the dependency tree is a mount point.
    assert.ok(count(staged) < 50, `staged copy must stay small (${count(staged)} entries)`);
    assert.equal(statSync(join(staged, 'npm', 'node_modules')).isDirectory(), true);
    assert.deepEqual(readdirSync(join(staged, 'npm', 'node_modules')), [], 'dependency mount point holds no copied entries');
    assert.equal(readFileSync(join(staged, 'settings.json'), 'utf8'), '{"packages":[]}\n');
    // The sandbox binds the PARENT's dependency directory itself, read-only.
    const launch = f.launches.find(l => l.cwd === cwd)!;
    assert.ok(launch, 'child host launched');
    const source = statSync(join(profile, 'npm', 'node_modules'));
    assert.deepEqual(launch.dependencies.map(d => ({ dest: d.dest, ino: d.ino, dev: d.dev })), [{ dest: ['npm', 'node_modules'], ino: source.ino, dev: source.dev }]);
    const at = launch.args.findIndex((a, i) => a === '--ro-bind-fd' && launch.args[i + 2] === join(staged, 'npm', 'node_modules'));
    assert.ok(at >= 0, 'dependency tree is mounted with --ro-bind-fd at the staged mount point');
    assert.equal(launch.args.some((a, i) => a === '--bind-fd' && launch.args[i + 2]?.includes('node_modules')), false, 'never a writable dependency bind');
  } finally { await f.cleanup(); }
});

test('D1: the copied part keeps its entry budget; a refusal after dispatch leaves nothing staged', { timeout: 120000 }, async () => {
  const f = await channelFixture();
  try {
    const big = join(f.root, '.a0-agent', 'extensions', 'big'); mkdirSync(big, { recursive: true });
    for (let i = 0; i < 10050; i++) writeFileSync(join(big, 'f' + i), 'x');
    const cwd = f.worktree('over');
    const r = await call(f.socket, '/workers', f.child('over', cwd));
    assert.equal(r.body.error, 'profile_copy_too_many_entries', JSON.stringify(r.body));
    assert.equal(r.body.effect, 'no_effect', JSON.stringify(r.body));
    assert.equal(existsSync(join(cwd, '.a0-agent')), false, 'every staged entry was removed before replying no_effect');
    assert.equal(f.s.get(f.w.worker_id).fence, null);
  } finally { await f.cleanup(); }
});

test('D2+D3: a staging failure after dispatch is cleaned, verified and reported no_effect; the child row ends failed and frees its root', async () => {
  const f = await channelFixture();
  try {
    const profile = join(f.root, '.a0-agent');
    for (let i = 0; i < 50; i++) writeFileSync(join(profile, 'f' + i), 'benign');
    execFileSync('mkfifo', [join(profile, 'special')]);
    const cwd = f.worktree('fifo');
    const r = await call(f.socket, '/workers', f.child('fifo', cwd));
    assert.equal(r.body.error, 'profile_copy_special_file', JSON.stringify(r.body));
    const receipt = f.s.receipts.all.get('fifo')!;
    assert.equal(receipt.state, 'rejected'); assert.equal(receipt.effect, 'no_effect');
    assert.equal(existsSync(join(cwd, '.a0-agent')), false, 'no partial profile is left behind a no_effect reply');
    assert.deepEqual(readdirSync(cwd), [], 'child root is exactly as before');
    assert.equal(f.s.get(f.w.worker_id).fence, null, 'a proven no-effect failure does not fence');
    assert.equal(f.hosts.length, 1, 'no child process was started');
    const [row] = children(f.s, f.w.worker_id);
    assert.ok(row, 'the dispatched child row is retained');
    assert.equal(row.status, 'failed', JSON.stringify(row));
    assert.deepEqual(failure(row), { command_id: 'fifo', reason: 'profile_copy_special_file' });
    // A failed row is not live: the same root can be launched again.
    rmSync(join(profile, 'special'));
    const again = await call(f.socket, '/workers', f.child('fifo-again', cwd));
    assert.equal(again.body.state, 'delivered', JSON.stringify(again.body));
    // Stopping the parent leaves no child row in a live state.
    const p = f.s.get(f.w.worker_id);
    assert.equal((await f.s.stop(p.worker_id, bind(p, 'stop-parent'))).state, 'delivered');
    const rows = children(f.s, f.w.worker_id);
    assert.deepEqual(rows.filter(x => ['starting', 'cleanup_pending'].includes(x.status)), [], JSON.stringify(rows.map(x => x.status)));
  } finally { await f.cleanup(); }
});

test('D2: an unverified staging cleanup is outcome_unknown and fences the parent', async () => {
  const f = await channelFixture();
  try {
    const profile = join(f.root, '.a0-agent');
    for (let i = 0; i < 50; i++) writeFileSync(join(profile, 'f' + i), 'benign');
    execFileSync('mkfifo', [join(profile, 'special')]);
    // Seam: a cleanup that removes nothing. The descriptor check must notice.
    (f.s as unknown as { stagingCleanup: (rootFd: number) => void }).stagingCleanup = () => {};
    const cwd = f.worktree('leftover');
    const r = await call(f.socket, '/workers', f.child('leftover', cwd));
    const receipt = f.s.receipts.all.get('leftover')!;
    assert.equal(receipt.state, 'outcome_unknown', JSON.stringify(r.body));
    assert.equal(receipt.effect, 'unknown');
    assert.equal(existsSync(join(cwd, '.a0-agent')), true, 'fixture: entries were left behind');
    const parent = f.s.get(f.w.worker_id);
    assert.deepEqual(parent.fence?.uncertain_command_ids, ['leftover'], 'parent fenced on the uncertain launch');
    const [row] = children(f.s, f.w.worker_id);
    assert.equal(row?.status, 'failed', JSON.stringify(row));
    assert.equal(failure(row!)?.reason, 'profile_copy_special_file');
  } finally { await f.cleanup(); }
});

test('D2: after the dispatch record a plain Refusal is outcome_unknown; only ProvenNoEffect is rejected/no_effect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0g1f-receipts-'));
  const journal = new Journal(join(dir, 'journal'));
  try {
    const store = new ReceiptStore(journal);
    const before = await store.run('before', 'workers.create', { x: 1 }, async () => { throw new Refusal('pre_dispatch'); });
    assert.equal(before.state, 'rejected');
    const after = await store.run('after', 'workers.create', { x: 2 }, async () => { store.dispatch('after'); throw new Refusal('post_dispatch'); });
    assert.equal(after.state, 'outcome_unknown', 'a default Refusal after dispatch is not proof of no effect');
    assert.equal(after.effect, 'unknown');
    const Proven = (types as Record<string, unknown>).ProvenNoEffect as (new (message: string, evidence: string) => Error) | undefined;
    assert.equal(typeof Proven, 'function', 'ProvenNoEffect exists');
    const proven = await store.run('proven', 'workers.create', { x: 3 }, async () => { store.dispatch('proven'); throw new Proven!('post_dispatch_cleaned', 'verified'); });
    assert.equal(proven.state, 'rejected'); assert.equal(proven.effect, 'no_effect');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---- kernel (real bwrap, real Pi SDK processes, no model) ----
const kernel = { skip: process.env.A0_TEST_BWRAP !== '1' };
test('kernel D1: a sandboxed parent launches a channel child with a 20k+ entry profile; the child loads code from the read-only dependency bind', { ...kernel, timeout: 180000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0g1f-live-'))), state = join(base, 'state'), agent = join(base, 'agent'), root = join(base, 'workspace');
  mkdirSync(state, { mode: 0o700 }); mkdirSync(agent); mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'A0 owner'); git(root, 'config', 'user.email', 'a0@example.invalid');
  writeFileSync(join(root, 'README.md'), 'base\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.a0-agent/\n.a0-worker/\n.a0-worktrees/\n');
  const profile = join(root, '.a0-agent'); mkdirSync(join(root, '.a0-worktrees'));
  const total = realisticProfile(profile);
  writeFileSync(join(profile, 'auth.json'), '{}');
  const modules = join(profile, 'npm', 'node_modules'), probe = join(modules, 'probe-ext');
  mkdirSync(join(probe, 'data', 'deep'), { recursive: true });
  writeFileSync(join(probe, 'data', 'deep', 'marker.txt'), 'FROM_PARENT_DEPENDENCY_TREE');
  writeFileSync(join(probe, 'package.json'), '{"name":"probe-ext","type":"module"}');
  writeFileSync(join(probe, 'index.mjs'), `import {readFileSync,writeFileSync,readdirSync} from 'node:fs'; import {dirname,join} from 'node:path'; import {fileURLToPath} from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
export default pi => pi.on('input', async e => {
  if (e.text !== 'probe') return;
  const out = { marker: readFileSync(join(here,'data','deep','marker.txt'),'utf8'), packages: readdirSync(dirname(here)).length, here };
  try { writeFileSync(join(here,'planted'),'x'); out.writable = true; } catch (error) { out.writable = false; out.code = error.code; }
  try { writeFileSync(join(dirname(here),'pkg-1','index.js'),'planted'); out.sibling_writable = true; } catch { out.sibling_writable = false; }
  writeFileSync(process.cwd()+'/.a0-worker/probe.json', JSON.stringify(out)); return {action:'handled'};
});`);
  assert.ok(total > 20000, `fixture must exceed the real profile (${total})`);
  const ext = join(profile, 'extensions'); mkdirSync(ext, { recursive: true });
  const id = 'c0ffee00-0000-4000-8000-0000000000d1';
  writeFileSync(join(ext, 'parent.mjs'), `import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; import {request} from 'node:http';
const call=(path,body)=>new Promise((resolve,reject)=>{const q=request({socketPath:process.env.PI_WORKER_SOCKET,path,method:body?'POST':'GET',headers:{'Content-Type':'application/json'},agent:false},r=>{let t='';r.on('data',x=>t+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(t)}));});q.on('error',reject);q.end(body?JSON.stringify(body):undefined);});
const git=(...a)=>execFileSync('git',['-c','user.name=A0 parent','-c','user.email=a0@example.invalid',...a],{encoding:'utf8',cwd:process.cwd()}).trim();
export default pi => pi.on('input', async e => {
  if (e.text !== 'go') return;
  const wt = process.cwd() + '/.a0-worktrees/${id}';
  git('worktree','add','--lock','-b','task-d1/work',wt,'HEAD');
  const me=(await call('/v0/workers/'+process.env.PI_WORKER_ID)).body;
  const r=await call('/v0/workers',{command_id:'d1-child',cwd:wt,host:'sdk',provider:'anthropic',model:'claude-sonnet-4-5',thinking:'off',parent:{worker_id:me.worker_id,worker_epoch:me.worker_epoch,session_id:me.session_id,binding_revision:me.binding_revision,execution_id:me.execution.execution_id,task_id:'d1-task',generation_id:'d1-gen'},launch_spec:{...me.launch_spec,role:'child',grant_methods:['children.report'],environment:{id:wt,revision:1,allowed_methods:['children.report']}}});
  writeFileSync(process.cwd()+'/go.json',JSON.stringify({status:r.status,body:r.body}));return {action:'handled'};
});`);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  const journal = new Journal(join(state, 'journal'));
  const s = new Supervisor(state, journal, '1.5.2', Supervisor.rpcFactory(join(process.cwd(), 'node_modules/.bin/pi')));
  try {
    const spec: NonNullable<Create['launch_spec']> = { environment: { id: root, revision: 1, filesystem: 'bwrap', root, allowed_methods: ['workers.create', 'children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [join(ext, 'parent.mjs'), join(probe, 'index.mjs')], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
    const created = await s.create({ command_id: 'd1-parent', cwd: root, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: spec });
    assert.equal(created.state, 'delivered', JSON.stringify(created));
    const p = s.get(created.worker_id!);
    assert.equal((await s.prompt(p.worker_id, { ...bind(p, 'go'), message: 'go' })).state, 'delivered');
    const go = JSON.parse(readFileSync(join(root, 'go.json'), 'utf8'));
    assert.equal(go.body.state, 'delivered', JSON.stringify(go));
    const child = s.get(go.body.worker_id), wt = join(root, '.a0-worktrees', id);
    assert.equal(child.status, 'ready');
    assert.ok(count(join(wt, '.a0-agent')) < 60, `staged copy stays small (${count(join(wt, '.a0-agent'))})`);
    assert.equal((await s.prompt(child.worker_id, { ...bind(child, 'probe'), message: 'probe' })).state, 'delivered');
    const out = JSON.parse(readFileSync(join(wt, '.a0-worker', 'probe.json'), 'utf8'));
    assert.equal(out.marker, 'FROM_PARENT_DEPENDENCY_TREE', 'child loaded and read its extension from the dependency bind');
    assert.equal(out.here, join(wt, '.a0-agent', 'npm', 'node_modules', 'probe-ext'), 'child sees the dependency tree at its own profile path');
    assert.ok(out.packages > 2000, 'the whole dependency tree is visible');
    assert.equal(out.writable, false, 'dependency bind is read-only in the child'); assert.equal(out.code, 'EROFS');
    assert.equal(out.sibling_writable, false);
    assert.equal(existsSync(join(probe, 'planted')), false); assert.equal(readFileSync(join(modules, 'pkg-1', 'index.js'), 'utf8'), 'x');
    assert.equal(lstatSync(join(wt, '.a0-agent', 'npm', 'node_modules')).isDirectory(), true);
    assert.deepEqual(readdirSync(join(wt, '.a0-agent', 'npm', 'node_modules')), [], 'host mount point stays empty');
  } finally {
    await s.shutdown(); journal.close();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    rmSync(base, { recursive: true, force: true });
  }
});
