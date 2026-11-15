import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { readConfined, sandboxRoot, sandboxSessionDir } from '../sandbox.js';
import { SessionIndex } from '../session.js';
import { Journal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { openContainment } from '../containment.js';
import { bind, fixture } from './helpers.js';
import type { Create } from '../types.js';

test('files.read pins roots, refuses hidden/traversal/symlink paths, non-UTF8, sockets, and oversize files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s5-files-')); mkdirSync(join(root, 'allowed')); mkdirSync(join(root, 'elsewhere'));
  try {
    writeFileSync(join(root, 'allowed', 'ok'), 'ALLOWED\n'); writeFileSync(join(root, 'elsewhere', 'out'), 'OUTSIDE\n');
    symlinkSync(join(root, 'elsewhere'), join(root, 'allowed', 'escape'));
    symlinkSync(join(root, 'allowed', 'ok'), join(root, 'allowed', 'link'));
    writeFileSync(join(root, 'allowed', '.secret'), 'hidden'); writeFileSync(join(root, 'allowed', 'invalid'), Buffer.from([0xff]));
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
    try { assert.throws(() => readConfined(root, 'allowed/socket', roots), /unavailable|not_regular/); }
    finally { await new Promise<void>(resolve => socket.close(() => resolve())); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sandbox history and session directory provisioning cannot follow outside symlinks', () => {
  const base = mkdtempSync(join(tmpdir(), 'a0s5-history-')), root = join(base, 'root'); mkdirSync(root);
  try {
    const outside = join(base, 'outside.jsonl');
    writeFileSync(outside, '{"type":"session","id":"native"}\n' + JSON.stringify({ type: 'message', id: 'outside', parentId: null, message: { role: 'user', content: 'OUTSIDE_TEST_SENTINEL' } }) + '\n');
    const linked = join(root, 'linked.jsonl'); symlinkSync(outside, linked);
    const index = new SessionIndex(linked, undefined, root);
    const page = index.page(null, 10); assert.ok('entries' in page); assert.deepEqual(page.entries, []);
    const direct = new SessionIndex(outside, undefined, root); assert.deepEqual(direct.page(null, 10), page);
    const session = sandboxSessionDir(root, 'worker');
    const own = join(session, 'own.jsonl'); writeFileSync(own, '{"type":"session","id":"own"}\n');
    const allowed = new SessionIndex(own, undefined, root); allowed.refresh(); assert.equal(allowed.headerId, 'own');
    rmSync(join(root, '.a0-worker'), { recursive: true });
    const target = join(base, 'outside-dir'); mkdirSync(target); symlinkSync(target, join(root, '.a0-worker'));
    assert.throws(() => sandboxSessionDir(root, 'worker'));
    assert.equal(existsSync(join(target, 'sessions')), false, 'no supervisor directory creation through a worktree symlink');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('sandbox launch refuses mismatched roots, parent state exposure, non-child and external resources', () => {
  const f = fixture();
  try {
    const root = join(f.dir, 'worktree'); mkdirSync(root);
    const c: Create = { command_id: 'x', cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', parent: { worker_id: 'p', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'gen' }, launch_spec: { environment: { id: 'x', revision: 1, allowed_methods: ['children.report'], filesystem: 'bwrap', root }, role: 'child', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' } };
    const state = join(f.dir, 'state-only'); mkdirSync(state);
    assert.equal(sandboxRoot(c, state), root);
    assert.throws(() => sandboxRoot(c, f.dir), /overlaps_supervisor_state/);
    assert.throws(() => sandboxRoot({ ...c, parent: undefined }, state), /requires_linux/);
    assert.throws(() => sandboxRoot({ ...c, host: 'rpc' }, state), /requires_linux/);
    const wrong = structuredClone(c); wrong.launch_spec!.environment.root = state;
    assert.throws(() => sandboxRoot(wrong, state), /must_equal_cwd/);
    const external = join(f.dir, 'external.mjs'); writeFileSync(external, 'export default () => {}');
    const widened = structuredClone(c); widened.launch_spec!.resources.extensions = [external];
    assert.throws(() => sandboxRoot(widened, state), /resource_outside_root/);
  } finally { f.cleanup(); }
});

// Real subprocess, real SDK and real bubblewrap; no model request. Explicit opt-in
// because many developer hosts disable user namespaces. Mandatory on a0-worker.
test('bwrap SDK child cannot read outside sentinel/socket/grants; inherited FD delivers its report', { skip: process.env.A0_TEST_BWRAP !== '1' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s5-sandbox-')), state = join(root, 'state'), cwd = join(root, 'child'), parentCwd = join(root, 'parent');
  mkdirSync(state); mkdirSync(cwd); mkdirSync(parentCwd);
  const outside = join(root, 'sentinel'); writeFileSync(outside, 'NEVER_VISIBLE');
  writeFileSync(join(state, 'worker.sock'), 'not-the-real-socket');
  const extension = join(cwd, 'probe.mjs');
  writeFileSync(extension, `import {readFileSync,writeSync} from 'node:fs'; export default function(pi) { pi.on('input',()=>{ for(const p of ${JSON.stringify([outside, join(state, 'worker.sock'), join(state, 'grants', 'owner.json')])}) { try { readFileSync(p); throw new Error('EXPOSED:'+p); } catch(e) { if(String(e).includes('EXPOSED:')) throw e; } } writeSync(3, JSON.stringify({report_id:'sandbox',kind:'result',message:'FD_ONLY_FS_CONFIRMED'})+'\\n'); return {action:'handled'}; }); }`);
  const journal = new Journal(join(state, 'journal')); const jail = openContainment(state);
  const supervisor = new Supervisor(state, journal, '1.5.2', Supervisor.rpcFactory('pi'), jail);
  const spec: NonNullable<Create['launch_spec']> = { environment: { id: 'test', revision: 1, allowed_methods: ['children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [extension], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
  try {
    const p = await supervisor.create({ command_id: 'parent', cwd: parentCwd, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: spec }); assert.equal(p.state, 'delivered', JSON.stringify(p));
    // A native run is not required to test launch/FD authority; parent execution
    // is an explicit fixture execution in this no-provider-call subprocess test.
    const parent = supervisor.require(p.worker_id!); parent.worker.execution = { execution_id: 'test-run', command_id: 'test-run', state: 'settled' };
    const w = supervisor.get(p.worker_id!);
    const c = await supervisor.create({ command_id: 'child', cwd, host: 'sdk', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', parent: { ...bind(w, 'unused'), worker_id: w.worker_id, execution_id: 'test-run', task_id: 'task', generation_id: 'gen' }, launch_spec: { ...spec, role: 'child', environment: { ...spec.environment, filesystem: 'bwrap', root: cwd } } });
    assert.equal(c.state, 'delivered', JSON.stringify(c));
    const child = supervisor.get(c.worker_id!);
    const reported = new Promise<void>(resolve => { supervisor.require(child.worker_id).host!.on('report', report => { if (report.message === 'FD_ONLY_FS_CONFIRMED') setImmediate(resolve); }); });
    const receipt = await supervisor.prompt(child.worker_id, { ...bind(child, 'probe'), message: 'probe' }); assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
    await Promise.race([reported, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('missing FD report')), 10000); t.unref(); })]);
    assert.equal(supervisor.get(child.worker_id).child_reports?.length, 1);
    writeFileSync(join(cwd, 'ok'), 'OK'); assert.equal(supervisor.readFile(child.worker_id, { path: 'ok', roots: [cwd] }).content, 'OK');
    assert.throws(() => supervisor.readFile(child.worker_id, { path: outside, roots: [root] }), /outside/);
  } finally { await supervisor.shutdown(); journal.close(); rmSync(root, { recursive: true, force: true }); }
});
