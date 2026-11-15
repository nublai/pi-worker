/** Task-owned VM probe. No source-supplied driver is executed. Private profiles stay on VM. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../../dist/client.js';
import { GrantStore } from '../../dist/grants.js';
const repo = fileURLToPath(new URL('../..', import.meta.url));
assert.equal(hostname(), 'a0-worker', 'authorized VM only');
process.umask(0o077);
const root = mkdtempSync('/tmp/a0s5/live-'), state = join(root, 'state'), profile = join(root, 'parent-agent'), parentCwd = join(root, 'parent');
mkdirSync(state); mkdirSync(profile); mkdirSync(parentCwd);
const bind = (w, command_id) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision });
const summary = { root, host: 'sdk', provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off', direct_native_requests: [], failures: [] };
function profileAt(path) {
  mkdirSync(path, { recursive: true });
  for (const name of ['auth.json', 'models-store.json', 'exe-dev-llm-integration.json']) {
    const source = join('/home/exedev/.pi/agent', name);
    if (existsSync(source)) { copyFileSync(source, join(path, name)); chmodSync(join(path, name), 0o600); }
  }
  writeFileSync(join(path, 'settings.json'), JSON.stringify({ packages: [] }));
}
profileAt(profile);
const base = join(root, 'git-base'), childCwd = join(root, 'child'); mkdirSync(base);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A0 probe', GIT_AUTHOR_EMAIL: 'a0@example.invalid', GIT_COMMITTER_NAME: 'A0 probe', GIT_COMMITTER_EMAIL: 'a0@example.invalid' } }).trim();
git('init', base); writeFileSync(join(base, 'allowed.txt'), 'SANDBOX_ALLOWED\n'); git('-C', base, 'add', 'allowed.txt'); git('-C', base, 'commit', '-m', 'probe base');
const baseSha = git('-C', base, 'rev-parse', 'HEAD'); git('-C', base, 'worktree', 'add', '--detach', '--lock', '--reason', 'A0 slice5 retained evidence', childCwd, baseSha);
const childProfile = join(childCwd, '.a0-agent'); profileAt(childProfile);
const providerDir = join(childProfile, 'extensions', 'exe-dev'); cpSync('/home/exedev/.pi/agent/extensions/exe-dev', providerDir, { recursive: true });
const provider = join(providerDir, 'index.ts');
// The VM integration normally checks /exe.dev. That host directory is NOT
// mounted. Only this private probe copy removes its existence check; network,
// provider registration and preference checks remain unchanged.
const source = readFileSync(provider, 'utf8'); assert.equal(source.split('if (!existsSync("/exe.dev")) return;').length, 2);
writeFileSync(provider, source.replace('if (!existsSync("/exe.dev")) return;', '// private A0 probe: already verified VM identity by the driver'));
const sentinel = join(root, 'outside-sentinel'); writeFileSync(sentinel, 'NEVER_VISIBLE_IN_CHILD');
const reportExtension = join(childCwd, 'report.mjs');
const denied = [sentinel, state, join(state, 'worker.sock'), join(state, 'grants', 'owner.json')];
writeFileSync(reportExtension, `import {existsSync,writeFileSync,writeSync} from 'node:fs'; export default function(pi) { let sent=false; pi.on('session_start',()=>{ if(!process.env.PI_WORKER_REPORT_FD)return; for(const p of ${JSON.stringify(denied)}) if(existsSync(p))throw new Error('FS_EXPOSED'); writeFileSync(${JSON.stringify(join(childCwd, 'startup-confined'))},'CONFINED\\n'); }); pi.on('agent_end',()=>{if(!process.env.PI_WORKER_REPORT_FD||sent)return;sent=true;writeSync(Number(process.env.PI_WORKER_REPORT_FD),JSON.stringify({report_id:'final',kind:'result',message:'SANDBOX_FD_RESULT'})+'\\n');}); }`);
const spec = { environment: { id: 'a0-slice5', revision: 1, allowed_methods: ['children.report'] }, role: 'probe parent', tools: ['bash', 'read'], denied_tools: [], resources: { extensions: [provider, reportExtension], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
const config = { cwd: parentCwd, host: 'sdk', provider: summary.provider, model: summary.model, thinking: summary.thinking, launch_spec: spec };
let processHandle, client; const owned = [], units = [];
function deadline(promise, label, ms = 120000) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout:' + label)), ms); })]).finally(() => clearTimeout(timer));
}
async function start(cut) {
  const log = openSync(join(root, 'supervisor.log'), 'a');
  processHandle = spawn(process.execPath, [join(repo, 'dist/main.js')], { cwd: repo, env: { ...process.env, A0_STATE_DIR: state, A0_PI: '/home/exedev/.local/bin/pi', PI_CODING_AGENT_DIR: profile, A0_CRASH_AT: cut ?? '', A0_CRASH_INDEX: '', A0_CRASH_EFFECT: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  owned.push(processHandle.pid);
  await deadline(new Promise((resolve, reject) => {
    let buffer = '';
    const exit = () => reject(new Error('supervisor exited before readiness; inspect private log'));
    processHandle.once('exit', exit);
    processHandle.stderr.on('data', chunk => { writeFileSync(log, chunk); buffer += chunk.toString(); if (buffer.includes('"socket":')) { processHandle.off('exit', exit); resolve(); } });
  }), 'supervisor ready', 30000).finally(() => { processHandle.stderr.once('end', () => closeSync(log)); });
  const grants = new GrantStore(state), grantPath = join(grants.dir, 'orchestrator.json');
  if (!existsSync(grantPath)) grants.register('slice5-probe', { worker_ids: [], cwd_roots: [root] }, ['hello', 'workers.create', 'workers.get', 'workers.list', 'workers.stop', 'workers.relaunch', 'sessions.prompt', 'sessions.resolve_unknown', 'sessions.rebind', 'events.subscribe', 'history.page', 'receipts.get', 'files.read', 'children.report'], 'orchestrator');
  client = new Client(join(state, 'worker.sock'), grantPath);
  summary.cleanup_profile = (await client.call('hello')).cleanup_profile;
  assert.match(summary.cleanup_profile, /cgroup_v2_user_delegation/);
}
async function end(signal = 'SIGTERM') {
  const h = processHandle; if (!h || h.exitCode !== null || h.signalCode !== null) return;
  const exited = once(h, 'exit'); h.kill(signal); await deadline(exited, 'own supervisor exit', 15000);
}
const get = id => client.call('workers.get', { id });
const call = (op, id, body) => client.call(op, { id, body });
function until(id, predicate, label, ms = 120000) {
  let seen;
  return deadline(client.watch(id, frame => {
    const w = frame.type === 'snapshot' ? frame.worker : frame.type === 'worker_changed' ? frame.data.worker : undefined;
    if (w && predicate(w)) { seen = w; return false; }
    return true;
  }), label, ms).then(() => seen);
}
async function turn(id, command_id, message) {
  const w = await get(id);
  const done = until(id, x => x.execution?.command_id === command_id && x.execution.state === 'settled', command_id); done.catch(() => {});
  const receipt = await call('sessions.prompt', id, { ...bind(w, command_id), message });
  assert.equal(receipt.state, 'delivered', JSON.stringify(receipt)); await done; return receipt;
}
function unitFor(id) {
  try {
    const records = readFileSync(join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).record);
    const record = records.findLast(r => r.kind === 'worker' && r.value.worker.worker_id === id); assert.ok(record.value.unit);
    const unit = record.value.unit; units.push(unit); return unit;
  } catch (cause) { throw new Error('invalid or missing private worker domain record', { cause }); }
}
const proc = pid => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[0]; } catch { return null; } };
async function detach(id, kind) {
  const pidFile = join(parentCwd, `${kind}.pid`), marker = join(parentCwd, `${kind}.escaped`);
  const seconds = kind === 'stop' ? 20 : 6;
  const shell = `setsid nohup sh -c 'echo $$ > "${pidFile}"; sleep ${seconds}; printf ESCAPED > "${marker}"' >/dev/null 2>&1 </dev/null & printf DETACHED_STARTED`;
  await turn(id, 'detach-' + kind, 'Use bash exactly once to run this exact shell command, then reply DONE. Do not wait for or inspect the background task.\n' + shell);
  assert.ok(existsSync(pidFile), 'independent tool effect, never prompt echo');
  const pid = Number(readFileSync(pidFile, 'utf8').trim()), unit = unitFor(id);
  assert.ok(proc(pid) && proc(pid) !== 'Z', 'detached grandchild is alive');
  assert.ok(readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(unit.name), 'detached process stayed in exact worker domain');
  return { pid, marker, unit, started: Date.now(), waitMs: seconds * 1000 + 600 };
}
async function verifyKilled(probe) {
  assert.equal(existsSync(join(probe.unit.root, probe.unit.name)), false);
  assert.ok(proc(probe.pid) === null || proc(probe.pid) === 'Z');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, probe.waitMs - (Date.now() - probe.started))));
  assert.equal(existsSync(probe.marker), false, 'past real detached write deadline');
  return { pid: probe.pid, final_state: proc(probe.pid), marker_absent_after_deadline: true, unit_removed: true };
}
try {
  await start();
  const created = await client.call('workers.create', { body: { ...config, command_id: 'create-parent' } }); assert.equal(created.state, 'delivered', JSON.stringify(created));
  const id = created.worker_id;
  await turn(id, 'warmup', 'Reply READY, no tools.');
  const stopProbe = await detach(id, 'stop');
  const killFile = join(stopProbe.unit.root, stopProbe.unit.name, 'cgroup.kill'), killMode = statSync(killFile).mode & 0o777;
  try {
    chmodSync(killFile, 0o000); // only this test-owned unit: force failed cleanup proof
    const uncertainStop = await call('workers.stop', id, bind(await get(id), 'blocked-stop'));
    assert.equal(uncertainStop.state, 'outcome_unknown');
    assert.equal((await get(id)).status, 'cleanup_pending');
    assert.match(readFileSync(join(stopProbe.unit.root, stopProbe.unit.name, 'cgroup.events'), 'utf8'), /populated 1/);
    await assert.rejects(call('workers.relaunch', id, bind(await get(id), 'pending-relaunch')), /cleanup_pending/);
    await assert.rejects(call('sessions.rebind', id, { ...bind(await get(id), 'pending-resume'), action: 'resume', target_session_id: (await get(id)).session_id }), /cleanup_pending_or_worker_not_ready/);
    await end('SIGKILL'); await start(); // blocked cleanup survives an actual restart
    assert.equal((await get(id)).status, 'cleanup_pending');
    await assert.rejects(call('workers.relaunch', id, bind(await get(id), 'pending-after-restart')), /cleanup_pending/);
    summary.cleanup_pending = { actual_populated_unit: true, kill_permission_withheld_only_on_own_unit: true, stop_unknown: true, actual_restart_retained_pending: true, resume_and_relaunch_refused_no_effect: true };
  } finally { if (existsSync(killFile)) chmodSync(killFile, killMode); }
  const stop = await call('workers.stop', id, bind(await get(id), 'stop-parent')); assert.equal(stop.state, 'delivered');
  summary.stop = await verifyKilled(stopProbe);
  let w = await get(id);
  const relaunched = await call('workers.relaunch', id, bind(w, 'relaunch-after-stop')); assert.equal(relaunched.state, 'delivered', JSON.stringify(relaunched));
  assert.notEqual((await get(id)).worker_epoch, w.worker_epoch);
  const crashProbe = await detach(id, 'restart');
  await end('SIGKILL'); assert.ok(proc(crashProbe.pid) && proc(crashProbe.pid) !== 'Z', 'grandchild survives supervisor kill BEFORE cleanup');
  summary.detached_alive_after_supervisor_kill = true;
  await start();
  assert.equal((await get(id)).cleanup, 'cgroup_empty_removed');
  summary.restart = await verifyKilled(crashProbe);
  // A real before-dispatch fsync cut, on a fresh real SDK process opened on
  // existing history. No request payload is stored by the worker itself.
  w = await get(id);
  if (w.fence) { await call('sessions.resolve_unknown', id, { ...bind(w, 'resolve-crash'), uncertain_command_id: w.fence.command_id, fence_generation: w.fence.fence_generation, disposition: 'keep' }); }
  await end(); await start('receipt.sessions.prompt.intent');
  w = await get(id);
  assert.equal((await call('workers.relaunch', id, bind(w, 'relaunch-for-intent-cut'))).state, 'delivered');
  const before = await get(id), p = { ...bind(before, 'recovered-once'), message: 'Use bash exactly once to run: printf "ONCE\\n" >> recovered-effect.txt . Then reply RECOVERED. Do not run any other tool.' };
  // Clarify the period is prose, not an extra printf argument.
  p.message = 'Use bash exactly once with this command: printf "ONCE\\n" >> recovered-effect.txt\nThen reply RECOVERED. Do not run any other tool.';
  const died = once(processHandle, 'exit');
  await assert.rejects(call('sessions.prompt', id, p)); await deadline(died, 'intent cut process exit', 10000);
  assert.equal(processHandle.signalCode, 'SIGKILL');
  await start();
  let pending = await client.call('receipts.get', { id: p.command_id }); assert.equal(pending.state, 'intent_recovered'); assert.equal(pending.effect, 'no_effect');
  assert.equal(existsSync(join(parentCwd, 'recovered-effect.txt')), false);
  const beforeResolution = await get(id);
  assert.equal((await call('sessions.resolve_unknown', id, { ...bind(beforeResolution, 'owner-keep-intent'), uncertain_command_id: p.command_id, fence_generation: beforeResolution.fence_generation ?? 0, disposition: 'keep' })).state, 'delivered');
  assert.equal((await call('workers.relaunch', id, bind(await get(id), 'fresh-after-intent'))).state, 'delivered');
  const afterRelaunch = await get(id); assert.notEqual(afterRelaunch.worker_epoch, p.worker_epoch);
  const settled = until(id, x => x.execution?.command_id === p.command_id && x.execution.state === 'settled', 'recovered once settled'); settled.catch(() => {});
  const first = await call('sessions.prompt', id, p); assert.equal(first.state, 'delivered', JSON.stringify(first));
  assert.deepEqual(await call('sessions.prompt', id, p), first); await settled;
  assert.equal(readFileSync(join(parentCwd, 'recovered-effect.txt'), 'utf8'), 'ONCE\n');
  const parentUnit = unitFor(id);
  const rows = readFileSync(join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).record);
  const parentFile = rows.findLast(r => r.kind === 'worker' && r.value.worker.worker_id === id).value.sessionFile;
  const native = readFileSync(parentFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(native.filter(r => r.type === 'message' && r.message?.role === 'user' && JSON.stringify(r.message.content).includes('recovered-effect.txt')).length, 1);
  summary.owner_resolved_intent = { actual_SIGKILL_before_dispatch: true, recovered_no_effect: true, fresh_epoch: afterRelaunch.worker_epoch !== p.worker_epoch, native_user_entries: 1, external_append_count: 1, duplicate_receipt_identical: true, relaunch_prompted: false };
  // Real sandboxed SDK child, actual Git worktree, actual supervisor socket.
  w = await get(id);
  const parent = { worker_id: id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision, execution_id: w.execution.execution_id, task_id: 'sandbox-child', generation_id: 'one' };
  const child = await client.call('workers.create', { body: { ...config, command_id: 'create-sandbox', cwd: childCwd, parent, launch_spec: { ...spec, role: 'sandbox child', environment: { ...spec.environment, filesystem: 'bwrap', root: childCwd, base_sha: baseSha } } } });
  assert.equal(child.state, 'delivered', JSON.stringify(child));
  assert.equal(readFileSync(join(childCwd, 'startup-confined'), 'utf8'), 'CONFINED\n');
  const command = `node -e 'const f=require("fs"); for(const p of ${JSON.stringify(denied)})if(f.existsSync(p))throw Error("OUTSIDE_VISIBLE"); if(f.readFileSync("allowed.txt","utf8")!=="SANDBOX_ALLOWED\\n")throw Error("BAD_ALLOWED"); f.writeFileSync("sandbox-proof.txt","SANDBOX_TOOL_OK\\n"); console.log("SANDBOX_TOOL_OK")'`;
  await turn(child.worker_id, 'sandbox-tool', 'Use bash exactly once with this exact command, then reply SANDBOX_DONE:\n' + command);
  const childState = await get(child.worker_id);
  assert.equal(childState.child_reports.length, 1); assert.equal(childState.child_reports[0].message, 'SANDBOX_FD_RESULT');
  const file = await call('files.read', child.worker_id, { path: 'sandbox-proof.txt', roots: [childCwd] }); assert.equal(file.content, 'SANDBOX_TOOL_OK\n');
  await assert.rejects(call('files.read', child.worker_id, { path: sentinel, roots: [root] }), /outside/);
  await assert.rejects(call('files.read', child.worker_id, { path: '.a0-agent/auth.json', roots: [childCwd] }), /hidden/);
  const stanza = git('-C', base, 'worktree', 'list', '--porcelain').split('\n\n').find(s => s.includes('worktree ' + childCwd)); assert.match(stanza, /^locked/m);
  summary.sandbox = { actual_socket_hidden: true, parent_state_and_grants_hidden: true, outside_sentinel_hidden: true, real_bash_tool_proof: file.content.trim(), inherited_fd_report_count: childState.child_reports.length, files_read_allowed: true, files_read_outside_and_hidden_refused: true, worktree_retained: true, worktree_locked: true, base: baseSha, network: 'shared; not a network sandbox', provider_probe_copy: 'VM marker existence check removed only in private copied provider extension; /exe.dev never mounted' };
  assert.equal((await call('workers.stop', child.worker_id, bind(childState, 'stop-child'))).state, 'delivered');
  assert.equal(existsSync(join(parentUnit.root, parentUnit.name)), true, 'stopping child preserves parent');
  assert.equal((await get(id)).status, 'ready');
  await call('workers.stop', id, bind(await get(id), 'final-stop-parent'));
  await end();
  summary.supervisor_pids = owned.map(pid => ({ pid, absent: !existsSync('/proc/' + pid) }));
  assert.ok(summary.supervisor_pids.every(p => p.absent));
  summary.pass = true;
} catch (error) {
  summary.pass = false; summary.failures.push(String(error));
  try { await end(); } catch { /* private logs retained */ }
  throw error;
} finally {
  try {
    const rows = readFileSync(join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).record).filter(r => r.kind === 'worker');
    for (const r of rows) if (r.value.unit) units.push(r.value.unit);
    summary.pi_leaders = [...new Set(rows.map(r => r.value.pid).filter(Boolean))].map(pid => ({ pid, state: proc(pid) }));
    if (summary.pass) assert.ok(summary.pi_leaders.every(p => p.state === null || p.state === 'Z'));
  } catch (error) { summary.pass = false; summary.failures.push(String(error)); }
  summary.units = [...new Map(units.map(u => [u.name, { name: u.name, removed: !existsSync(join(u.root, u.name)) }])).values()];
  if (summary.pass) assert.ok(summary.units.every(u => u.removed));
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ root, pass: summary.pass, summary: join(root, 'summary.json') }));
}
