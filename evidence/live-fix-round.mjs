// THROWAWAY, authored live driver. Only run on the authorized a0-worker VM.
// Uses fresh /tmp/a0 state; never reads model credentials or changes Pi config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../dist/client.js';
import { parseJournal } from '../dist/journal.js';
const root = mkdtempSync('/tmp/a0/fix-live-'), state = join(root, 'state'); mkdirSync(state, { mode: 0o700 });
const client = new Client(join(state, 'worker.sock'));
const summary = { root, receipts: [], restarts: [], watchers: [], effects: {} };
let supervisor;
const bounded = async (promise, label, ms = 90000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
};
async function start() {
  const child = spawn(process.execPath, ['dist/main.js'], { env: { ...process.env, A0_STATE_DIR: state }, stdio: ['ignore', 'ignore', 'pipe'] });
  supervisor = child;
  await bounded(new Promise((resolve, reject) => {
    let pending = '';
    child.once('error', reject); child.once('exit', code => reject(new Error('supervisor startup exit ' + code)));
    child.stderr.on('data', b => {
      pending += b.toString();
      const end = pending.indexOf('\n');
      if (end >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { const record = JSON.parse(line); if (record.socket) resolve(record); } catch { /* Non-JSON startup failure surfaces as exit. */ }
      }
    });
  }), 'supervisor ready', 30000);
  return client.call('hello');
}
async function stopSupervisor(signal) {
  const child = supervisor; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal); await bounded(exited, 'supervisor exit', 15000);
}
const binding = (w, command_id) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision });
async function create(label) {
  const cwd = join(root, label); mkdirSync(cwd);
  const r = await client.call('workers.create', { body: { command_id: 'create-' + label, cwd, provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off' } });
  assert.equal(r.state, 'delivered'); return client.call('workers.get', { id: r.worker_id });
}
function watcher(w, label) {
  const frames = [], waiters = []; let ready;
  const snapshot = new Promise(r => { ready = r; });
  const stream = client.watch(w.worker_id, frame => {
    // Whitelist projections and the controlled marker, never arbitrary tool data.
    const projection = frame.type === 'snapshot' ? { type: frame.type, cursor: frame.cursor, worker: frame.worker } : frame.type === 'worker_changed' ? { type: frame.type, cursor: frame.cursor, producer: frame.producer, evidence: frame.evidence, worker: frame.data.worker } : { type: frame.type, cursor: frame.cursor, execution_id: frame.execution_id };
    frames.push(projection);
    if (frame.type === 'snapshot') ready(frame);
    for (const waiter of [...waiters]) if (waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame); }
    return !(frame.type === 'worker_changed' && frame.data.worker.status === 'stopped');
  }).catch(error => ({ disconnected: true, error: error.message }));
  return { frames, snapshot, stream, until(predicate) { return bounded(new Promise(resolve => waiters.push({ predicate, resolve })), label); }, save() { writeFileSync(join(root, label + '.json'), JSON.stringify(frames, null, 2) + '\n'); } };
}
function blockPrompt(w, command_id, marker) {
  const startFile = join(w.cwd, 'started.txt'), endFile = join(w.cwd, 'finished.txt');
  const code = `require("fs").appendFileSync(${JSON.stringify(startFile)},"ONCE\\n");console.log(${JSON.stringify(marker)});setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(endFile)},"DONE\\n"),30000)`;
  const message = `Do not delegate, inspect configuration, or do anything else. Use bash to execute exactly this command and wait for it: node -e '${code}'. Set the tool timeout to 60 seconds. After it finishes, reply FIX_TURN_DONE.`;
  return { body: { ...binding(w, command_id), message }, startFile, endFile, marker };
}
const started = p => frame => frame.type === 'tool_execution_update' && Array.isArray(frame.data.partialResult?.content) && frame.data.partialResult.content.some(x => x.type === 'text' && x.text.trim() === p.marker);
function verifyStarted(p) { assert.equal(readFileSync(p.startFile, 'utf8'), 'ONCE\n'); }
try {
  const hello = await start(); console.log('INITIAL', JSON.stringify({ supervisor_epoch: hello.supervisor_epoch, root }));
  const w = await create('crash-main'), watch = watcher(w, 'supervisor-crash-watch'); await watch.snapshot;
  const p = blockPrompt(w, 'fix-crash', 'FIX_CRASH_BLOCK_STARTED');
  const marker = watch.until(started(p));
  const delivered = await client.call('sessions.prompt', { id: w.worker_id, body: p.body });
  assert.equal(delivered.state, 'delivered'); writeFileSync(join(root, 'receipt-before.json'), JSON.stringify(delivered, null, 2) + '\n');
  await marker; verifyStarted(p); const began = Date.now();
  await stopSupervisor('SIGKILL'); await watch.stream; watch.save();
  console.log('SUPERVISOR_SIGKILL_AFTER_ACTUAL_PARTIAL_OUTPUT_AND_ONCE_FILE');
  let fence;
  for (let restart = 0; restart < 3; restart++) {
    const nextHello = await start();
    const after = await client.call('receipts.get', { id: p.body.command_id });
    assert.deepEqual(after, delivered);
    assert.deepEqual(await client.call('sessions.prompt', { id: w.worker_id, body: p.body }), delivered);
    const current = await client.call('workers.get', { id: w.worker_id });
    assert.equal(current.execution.state, 'outcome_unknown');
    assert.equal(current.fence.command_id, 'fix-crash'); assert.equal(current.fence.fence_generation, 1);
    if (fence) assert.deepEqual(current.fence, fence); else fence = current.fence;
    let snap;
    await client.watch(w.worker_id, frame => { snap = frame; return false; });
    summary.restarts.push({ restart, supervisor_epoch: nextHello.supervisor_epoch, fence: current.fence, cursor: snap.cursor, receipt_identical: true });
    summary.receipts.push(after);
    if (restart < 2) await stopSupervisor('SIGKILL');
  }
  assert.equal(new Set(summary.restarts.map(r => r.cursor.worker_epoch)).size, 3);
  await assert.rejects(client.call('sessions.prompt', { id: w.worker_id, body: { ...p.body, command_id: 'fenced-new', message: 'Must not run' } }), /session_fenced/);
  const recoveredWatch = watcher(w, 'recovered-stop-watch'); await recoveredWatch.snapshot;
  await client.call('workers.stop', { id: w.worker_id, body: binding(w, 'stop-recovered') }); await recoveredWatch.stream; recoveredWatch.save();
  assert.ok(recoveredWatch.frames.some(x => x.type === 'worker_changed' && x.worker.status === 'stopped'));
  // A separate live Pi exit proves a fence TRANSITION reaches an already attached
  // watcher, rather than relabeling the recovery snapshot as a live event.
  const live = await create('pi-exit'), liveWatch = watcher(live, 'connected-fence-stop-watch'); await liveWatch.snapshot;
  const livePrompt = blockPrompt(live, 'fix-pi-exit', 'FIX_EXIT_BLOCK_STARTED');
  const liveMarker = liveWatch.until(started(livePrompt));
  const liveReceipt = await client.call('sessions.prompt', { id: live.worker_id, body: livePrompt.body }); assert.equal(liveReceipt.state, 'delivered');
  await liveMarker; verifyStarted(livePrompt); const liveBegan = Date.now();
  const fenceEvent = liveWatch.until(x => x.type === 'worker_changed' && x.data.worker.fence?.command_id === 'fix-pi-exit');
  const records = parseJournal(readFileSync(join(state, 'journal.jsonl'))).records;
  const processRecord = records.filter(r => r.kind === 'worker' && r.value.worker.worker_id === live.worker_id).at(-1).value;
  assert.ok(processRecord.pid > 0); process.kill(-processRecord.pid, 'SIGKILL');
  await fenceEvent;
  assert.deepEqual(await client.call('receipts.get', { id: livePrompt.body.command_id }), liveReceipt);
  await client.call('workers.stop', { id: live.worker_id, body: binding(live, 'stop-live-exit') }); await liveWatch.stream; liveWatch.save();
  assert.ok(liveWatch.frames.some(x => x.type === 'worker_changed' && x.worker.fence?.command_id === 'fix-pi-exit'));
  assert.ok(liveWatch.frames.some(x => x.type === 'worker_changed' && x.worker.status === 'stopped'));
  summary.watchers = [{ label: 'connected-fence-stop-watch', fence_event: true, stop_event: true }, { label: 'recovered-stop-watch', stop_event: true }];
  await delay(Math.max(0, Math.max(began, liveBegan) + 32000 - Date.now()));
  verifyStarted(p); assert.equal(existsSync(p.endFile), false); verifyStarted(livePrompt); assert.equal(existsSync(livePrompt.endFile), false);
  const history = await client.call('history.page', { id: w.worker_id, query: { limit: '100' } });
  const prompts = history.entries.filter(e => e.type === 'message' && e.message?.role === 'user' && e.message.content?.some(x => x.type === 'text' && x.text === p.body.message));
  assert.equal(prompts.length, 1);
  summary.effects = { main_start_count: 1, main_prompt_in_history: prompts.length, main_finished_absent: true, live_start_count: 1, live_finished_absent: true };
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('LIVE_FIX_ROUND_PASS', JSON.stringify({ root, receipts_identical: true, fences: summary.restarts.map(x => x.fence), watchers: summary.watchers, effects: summary.effects }));
} finally {
  await stopSupervisor('SIGTERM');
  console.log('ALL_DRIVER_SUPERVISORS_STOPPED');
}
