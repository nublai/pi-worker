#!/usr/bin/env node
// THROWAWAY. Authored slice-2 driver; only /tmp/a0s2 on the authorized existing VM.
// Never log grants, model response bodies, raw headers, or credential-bearing configuration.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Journal, parseJournal } from '../dist/journal.js';
import { Supervisor } from '../dist/supervisor.js';
import { RpcHost } from '../dist/host.js';
import { killGroup } from '../dist/process.js';
import { router, listenPrivate } from '../dist/server.js';
import { Client, ClientFailure, ResyncRequired } from '../dist/client.js';
process.umask(0o077);
mkdirSync('/tmp/a0s2', { recursive: true, mode: 0o700 });
const root = mkdtempSync('/tmp/a0s2/live-');
const version = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(); assert.equal(version, '1.5.2');
const provider = 'exe-dev-anthropic', model = 'claude-sonnet-4-6@llm';
const evidence = { prototype: true, root, pi_version: version, node: process.version, cases: [] };
const note = (name, details) => { const row = { name, result: 'pass', ...details }; evidence.cases.push(row); console.log(JSON.stringify(row)); };
const bind = (w, command_id) => ({ command_id, session_id: w.session_id, worker_epoch: w.worker_epoch, binding_revision: w.binding_revision });
function deadline(promise, label, ms = 120000) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline: ' + label)), ms); })]).finally(() => clearTimeout(timer)); }
const state = join(root, 'state'); mkdirSync(state, { mode: 0o700 });
let journal = new Journal(join(state, 'journal'));
const hosts = new Map();
let supervisor = new Supervisor(state, journal, version, (c, dir) => { const h = new RpcHost('pi', c.cwd, dir, c.provider, c.model, c.thinking); hosts.set(basename(dir), h); return h; });
let server = router(supervisor); const socket = join(state, 'worker.sock');
await listenPrivate(server, socket); let client = new Client(socket);
function projection(id, predicate) {
  let subscription, completed = false;
  return deadline(new Promise((resolve) => {
    const check = () => { const w = supervisor.get(id); if (predicate(w)) { completed = true; subscription?.close(); resolve(w); } };
    subscription = supervisor.events.subscribe(() => supervisor.list(), null, () => { check(); }, { workerIds: [id] });
    if (completed) subscription.close();
  }), 'projection ' + id).finally(() => subscription?.close());
}
async function create(name) {
  const cwd = join(root, name); mkdirSync(cwd, { mode: 0o700 });
  const receipt = await client.call('workers.create', { body: { command_id: 'create-' + name, cwd, provider, model, thinking: 'off' } });
  assert.equal(receipt.state, 'delivered'); return client.call('workers.get', { id: receipt.worker_id });
}
async function turn(w, command, message) {
  const settled = projection(w.worker_id, next => next.execution?.command_id === command && next.execution.state === 'settled');
  const receipt = await client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, command), message } });
  assert.equal(receipt.state, 'delivered'); await settled; return receipt;
}
async function closeEmbedded() {
  for (const w of supervisor.list()) await supervisor.stop(w.worker_id, bind(w, 'final-stop-' + supervisor.epoch + '-' + w.worker_id));
  await supervisor.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); journal.close();
}
try {
  const first = await create('binding'); const pid = hosts.get(first.worker_id).pid;
  const catalog = await hosts.get(first.worker_id).request({ type: 'get_available_models' });
  assert.ok(catalog.data.models.some(m => m.provider === provider && m.id === model));
  await turn(first, 'binding-seed', 'Do not delegate or use tools. Reply exactly A0S2_BINDING_READY.');
  const old = await client.call('workers.get', { id: first.worker_id });
  const initialHistory = await client.call('history.page', { id: first.worker_id });
  const userEntry = initialHistory.entries.find(e => e.type === 'message' && e.message?.role === 'user'); assert.ok(userEntry);
  await client.call('sessions.rebind', { id: first.worker_id, body: { ...bind(old, 'new'), action: 'new' } });
  let current = await client.call('workers.get', { id: first.worker_id }); assert.equal(current.binding_revision, 2); assert.notEqual(current.session_id, old.session_id);
  await assert.rejects(client.call('sessions.prompt', { id: first.worker_id, body: { ...bind(old, 'delayed'), message: 'THIS_MUST_NOT_BE_SENT' } }), e => e instanceof ClientFailure && e.effect === 'no_effect' && e.details.received_binding_revision === 1);
  await client.call('sessions.rebind', { id: first.worker_id, body: { ...bind(current, 'resume'), action: 'resume', target_session_id: old.session_id } });
  current = await client.call('workers.get', { id: first.worker_id }); assert.equal(current.session_id, old.session_id); assert.equal(current.binding_revision, 3);
  await client.call('sessions.rebind', { id: first.worker_id, body: { ...bind(current, 'fork'), action: 'fork', source_leaf_id: current.leaf_id, entry_id: userEntry.id } });
  current = await client.call('workers.get', { id: first.worker_id }); assert.equal(current.binding_revision, 4); assert.equal(hosts.get(first.worker_id).pid, pid);
  await assert.rejects(client.call('sessions.rebind', { id: first.worker_id, body: { ...bind(current, 'navigate'), action: 'navigate', entry_id: userEntry.id } }), e => e instanceof ClientFailure && e.effect === 'no_effect' && /tree_navigation_unavailable/.test(e.message));
  const second = await create('duplicate');
  await assert.rejects(client.call('sessions.rebind', { id: second.worker_id, body: { ...bind(second, 'duplicate-open'), action: 'resume', target_session_id: current.session_id } }), e => e instanceof ClientFailure && e.effect === 'no_effect' && e.details.holder_worker_id === first.worker_id);
  note('binding_and_duplicate', { revisions: [1,2,3,4], same_native_pid: true, delayed_effect: 'no_effect', holder_worker_id: first.worker_id, navigation: 'not_covered: direct Pi 1.5.2 RPC unsupported' });

  let overflowCursor; const frames = [];
  await assert.rejects(client.watch(null, frame => {
    frames.push(frame.type); if (frame.type === 'overflow') overflowCursor = frame.cursor;
    if (frame.type === 'snapshot') for (let i = 0; i < 300; i++) supervisor.events.publish('synthetic_transport_burst', { text: 'x'.repeat(15000) }, null, 'supervisor', false, first.worker_id);
    return true;
  }), e => e instanceof ResyncRequired && e.reason === 'overflow');
  assert.equal(client.resyncRequired, true);
  await client.watch(null, frame => { assert.equal(frame.type, 'snapshot'); assert.equal(frame.resync_reason, 'overflow'); return false; }, overflowCursor, { overflowResync: true });
  assert.equal(client.resyncRequired, false);
  note('overflow_resync', { overflow_received: frames.includes('overflow'), fresh_snapshot: true, synthetic_events: true, worker_cancelled: false });

  const grantFile = supervisor.grants.register('live-controller', { worker_ids: [first.worker_id], cwd_roots: [] }, ['sessions.follow_up','workers.get']);
  const scoped = new Client(socket, grantFile);
  await assert.rejects(scoped.call('workers.get', { id: second.worker_id }), e => e instanceof ClientFailure && e.effect === 'no_effect' && /grant_scope_denied/.test(e.message));
  const busyCommand = 'revocation-run';
  const settled = projection(first.worker_id, w => w.execution?.command_id === busyCommand && w.execution.state === 'settled');
  await client.call('sessions.prompt', { id: first.worker_id, body: { ...bind(current, busyCommand), message: 'Do not delegate. Use bash to run this exact harmless command and wait: node -e "console.log(\'A0S2_BUSY\');setTimeout(()=>console.log(\'A0S2_DONE\'),5000)". Use a 20 second tool timeout. Then reply A0S2_DONE.' } });
  const running = await client.call('workers.get', { id: first.worker_id }); assert.equal(running.foreground, 'running');
  const dropped = projection(first.worker_id, w => w.queued?.some(q => q.command_id === 'revoked-follow' && q.state === 'dropped'));
  const queued = await scoped.call('sessions.follow_up', { id: first.worker_id, body: { ...bind(running, 'revoked-follow'), execution_id: running.execution.execution_id, message: 'A0S2_REVOKED_MUST_NOT_ENTER_PI' } }); assert.equal(queued.state, 'queued');
  const grantId = JSON.parse(readFileSync(grantFile, 'utf8')).grant_id; supervisor.grants.revoke(grantId);
  await settled; await dropped;
  const revoked = await client.call('receipts.get', { id: 'revoked-follow' }); assert.equal(revoked.effect, 'no_effect'); assert.match(revoked.error, /grant_revoked/);
  const history = await client.call('history.page', { id: first.worker_id }); assert.ok(!JSON.stringify(history.entries).includes('A0S2_REVOKED_MUST_NOT_ENTER_PI'));
  note('grant_revocation', { mode: (statSync(grantFile).mode & 0o777).toString(8), cross_scope: 'no_effect', queued: true, dispatch: 'blocked_no_effect', native_history_contains_revoked_input: false, same_user_can_read_grant_file: true });

  const resolvedWorkers = [];
  for (const disposition of ['keep','abandon','observed']) {
    const w = await create('fence-' + disposition), command = 'uncertain-' + disposition;
    const fenced = projection(w.worker_id, next => next.fence?.command_id === command);
    const receipt = await client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, command), message: 'Do not delegate or use tools. Explain your answer in detail, at least 1000 words, starting with A0S2_UNCERTAIN.' } });
    assert.equal(receipt.state, 'delivered'); assert.notEqual(supervisor.get(w.worker_id).execution.state, 'settled');
    const host = hosts.get(w.worker_id); assert.equal(await killGroup(host.pid, host.token), true);
    const state = await fenced; const generation = state.fence.fence_generation;
    await assert.rejects(client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, 'denied-' + disposition), message: 'must not run' } }), e => e instanceof ClientFailure && e.effect === 'no_effect' && e.details.uncertain_command_id === command);
    await assert.rejects(client.call('sessions.resolve_unknown', { id: w.worker_id, body: { ...bind(w, 'wrong-' + disposition), uncertain_command_id: command, fence_generation: generation + 1, disposition } }), e => e instanceof ClientFailure && e.effect === 'no_effect');
    await client.call('sessions.resolve_unknown', { id: w.worker_id, body: { ...bind(w, 'resolve-' + disposition), uncertain_command_id: command, fence_generation: generation, disposition } });
    assert.equal((await client.call('workers.get', { id: w.worker_id })).fence, null);
    assert.deepEqual(await client.call('receipts.get', { id: command }), receipt);
    await client.call('workers.stop', { id: w.worker_id, body: bind(w, 'stop-' + disposition) });
    assert.equal(supervisor.get(w.worker_id).fence, null);
    resolvedWorkers.push(w.worker_id);
    note('resolve_' + disposition, { fence_generation: generation, wrong_generation: 'no_effect', fenced_prompt: 'no_effect_names_cause', final_fence: null, admission_receipt_unchanged: true, observed_evidence: disposition === 'observed' ? 'exact_execution_in_fsynced_delivered_receipt' : null, external_effects_undone: false });
  }
  const epochs = [supervisor.epoch], oldCursor = { worker_epoch: supervisor.epoch, seq: 0 };
  await closeEmbedded();
  for (let restart = 0; restart < 2; restart++) {
    journal = new Journal(join(state, 'journal')); supervisor = new Supervisor(state, journal, version, () => { throw new Error('no automatic native host launch'); }); await supervisor.recover();
    server = router(supervisor); await listenPrivate(server, socket); client = new Client(socket);
    epochs.push(supervisor.epoch);
    for (const id of resolvedWorkers) assert.equal((await client.call('workers.get', { id })).fence, null);
    await client.watch(null, frame => { assert.equal(frame.type, 'snapshot'); assert.equal(frame.resync_reason, 'epoch'); return false; }, oldCursor);
    if (restart === 0) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); journal.close(); }
  }
  assert.equal(new Set(epochs).size, 3); note('two_restarts', { distinct_transport_epochs: 3, resolved_fences_stay_clear: true, no_native_adoption: true });
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); journal.close();

  // Separate real main-process fsync cuts. Both begin with a real initialized Pi child.
  async function startMain(dir, cut) {
    const child = spawn(process.execPath, ['dist/main.js'], { cwd: process.cwd(), env: { ...process.env, A0_STATE_DIR: dir, A0_CRASH_AT: cut ?? '', A0_CRASH_INDEX: '', A0_TRACE_FSYNC: '1' }, stdio: ['ignore','ignore','pipe'] });
    let pending = ''; const labels = [];
    const ready = new Promise(resolve => child.stderr.on('data', b => {
      pending += b.toString();
      for (;;) { const i = pending.indexOf('\n'); if (i < 0) break; const line = pending.slice(0,i); pending = pending.slice(i+1); try { const r = JSON.parse(line); if (r.fsync) labels.push(r.fsync.label); if (r.socket) resolve(r); } catch {} }
    }));
    const fail = new Promise((_, reject) => child.once('exit', (code, signal) => reject(new Error('main exited before ready: ' + code + '/' + signal))));
    await deadline(Promise.race([ready, fail]), 'main ready', 30000); return { child, labels };
  }
  for (const [point, bucket, effect] of [['receipt.sessions.prompt.intent','intent_recovered','no_effect'],['receipt.sessions.prompt.accepted','outcome_unknown','unknown']]) {
    const dir = join(root, 'cut-' + bucket); mkdirSync(dir, { mode: 0o700 });
    let main = await startMain(dir, point); const c = new Client(join(dir, 'worker.sock'));
    const cwd = join(dir, 'cwd'); mkdirSync(cwd);
    const created = await c.call('workers.create', { body: { command_id: 'create', cwd, provider, model, thinking: 'off' } });
    const w = await c.call('workers.get', { id: created.worker_id });
    const body = { ...bind(w, 'cut-prompt'), message: 'A0S2_FSYNC_CUT_NO_REPLAY' };
    const exited = once(main.child, 'close');
    await assert.rejects(c.call('sessions.prompt', { id: w.worker_id, body }), e => e instanceof ClientFailure && e.effect === 'unknown');
    const [,signal] = await exited; assert.equal(signal, 'SIGKILL'); assert.ok(main.labels.includes(point));
    main = await startMain(dir);
    const r = await c.call('receipts.get', { id: 'cut-prompt' }); assert.equal(r.state, bucket); assert.equal(r.effect, effect);
    assert.deepEqual(await c.call('sessions.prompt', { id: w.worker_id, body }), r);
    const page = await c.call('history.page', { id: w.worker_id }); assert.ok(!JSON.stringify(page.entries).includes(body.message));
    const recovered = await c.call('workers.get', { id: w.worker_id });
    if (bucket === 'intent_recovered') assert.equal(recovered.fence, null); else assert.equal(recovered.fence.command_id, 'cut-prompt');
    await c.call('sessions.resolve_unknown', { id: w.worker_id, body: { ...bind(recovered, 'resolve-cut'), uncertain_command_id: 'cut-prompt', fence_generation: recovered.fence?.fence_generation ?? recovered.fence_generation ?? 0, disposition: 'abandon' } });
    await c.call('workers.stop', { id: w.worker_id, body: bind(recovered, 'stop-cut') });
    const stopped = once(main.child, 'exit'); main.child.kill('SIGTERM'); await deadline(stopped, 'main stop', 30000);
    const records = parseJournal(readFileSync(join(dir, 'journal.jsonl'))).records;
    assert.ok(records.some(x => x.kind === 'receipt' && x.value.command_id === 'cut-prompt'));
    note('real_fsync_' + bucket, { point, signal, recovered_bucket: bucket, effect, native_prompt_entries: 0, automatic_replay: false, cleanup: recovered.cleanup, state: dir });
  }
  writeFileSync(join(root, 'summary.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ complete: true, summary: join(root, 'summary.json') }));
} catch (error) {
  writeFileSync(join(root, 'incomplete.json'), JSON.stringify({ ...evidence, failure: error instanceof Error ? error.message : 'unknown' }, null, 2) + '\n');
  try { await closeEmbedded(); } catch {}
  throw error;
}
