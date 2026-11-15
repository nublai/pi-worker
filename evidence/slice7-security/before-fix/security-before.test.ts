/** Cross-version probe: security-fix channel regressions compiled against the PRE-FIX runtime 1f38036. */
/** Security fix round regressions (A0 slice 7). Portable unless marked kernel. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { Host, bind } from './helpers.js';
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

