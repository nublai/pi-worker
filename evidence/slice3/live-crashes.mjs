// Real supervisor SIGKILL cuts with real pi resolvers, using only this run's PIDs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../dist/client.js';
const root = mkdtempSync('/tmp/a0s3/crashes-'); const rows = [];
const wait = async (f, label) => { const end = Date.now() + 60000; for (;;) { try { const x = await f(); if (x) return x; } catch {} if (Date.now() > end) throw new Error('timeout ' + label); await delay(20); } };
const bind = (w, command_id) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision });
function launch(state, cut = '') {
  const child = spawn(process.execPath, [resolve('dist/main.js')], { env: { ...process.env, A0_STATE_DIR: state, A0_PI: 'pi', A0_CRASH_AT: cut, A0_CRASH_INDEX: '', A0_CRASH_EFFECT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => { child.once('error', reject); child.stderr.on('data', b => { if (b.toString().includes('supervisor_epoch')) resolve(); }); child.once('exit', () => reject(new Error('supervisor exited before ready'))); });
  const exited = once(child, 'exit'); child.stdout.resume(); child.stderr.resume(); return { child, ready, exited };
}
for (const host of ['rpc', 'sdk', 'acp']) for (const stage of ['intent', 'accepted', 'delivered']) {
  const name = host + '-' + stage, dir = join(root, name), state = join(dir, 'state'), cwd = join(dir, 'cwd'); mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true }); copyFileSync(resolve('evidence/slice3/dialog-extension.ts'), join(cwd, '.pi', 'extensions', 'dialog.ts'));
  let processHost = launch(state, 'receipt.interactions.answer_if_current.' + stage); let recovery;
  try {
    await processHost.ready; const c = new Client(join(state, 'worker.sock'));
    const created = await c.call('workers.create', { body: { command_id: name + '-create', cwd, host, project_trusted: true, provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off' } }); assert.equal(created.state, 'delivered');
    const w = await c.call('workers.get', { id: created.worker_id });
    const prompting = c.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, name + '-prompt'), message: 'a0:dialog:input:crash' } }).catch(error => ({ disconnected: true, effect: error.effect }));
    const i = await wait(async () => (await c.call('interactions.list', { id: w.worker_id }))[0], name + ' dialog');
    const answer = { ...bind(w, name + '-answer'), answer_id: name + '-answer', interaction_id: i.interaction_id, revision: i.revision, kind: i.kind, outcome: 'answer', value: 'SYNTHETIC_CRASH_VALUE' };
    await c.call('interactions.answer_if_current', { id: w.worker_id, body: answer }).catch(() => {});
    const [, signal] = await processHost.exited; assert.equal(signal, 'SIGKILL'); await prompting;
    const nativeBefore = existsSync(join(cwd, '.a0-dialog-results')) ? readFileSync(join(cwd, '.a0-dialog-results'), 'utf8') : '';
    assert.equal(nativeBefore.includes('SYNTHETIC_CRASH_VALUE'), stage === 'delivered');
    recovery = launch(state); await recovery.ready;
    const recovered = await c.call('workers.get', { id: w.worker_id }); const receipt = await c.call('receipts.get', { id: answer.command_id });
    assert.equal(receipt.state, stage === 'intent' ? 'intent_recovered' : stage === 'accepted' ? 'outcome_unknown' : 'delivered');
    assert.equal((await c.call('interactions.list', { id: w.worker_id })).length, 0);
    assert.deepEqual(await c.call('interactions.answer_if_current', { id: w.worker_id, body: { ...answer, value: false } }), receipt);
    await assert.rejects(c.call('interactions.answer_if_current', { id: w.worker_id, body: { ...answer, command_id: name + '-stale', answer_id: name + '-stale' } }), /session_fenced|worker_not_ready|interaction_not_pending/);
    const nativeAfter = existsSync(join(cwd, '.a0-dialog-results')) ? readFileSync(join(cwd, '.a0-dialog-results'), 'utf8') : '';
    assert.equal(nativeAfter, nativeBefore, 'restart and duplicate lookup must not invoke the native resolver');
    const bytes = readFileSync(join(state, 'journal.jsonl'), 'utf8'); assert.equal(bytes.includes('SYNTHETIC_CRASH_VALUE'), false);
    const row = { host, cut: stage, receipt: receipt.state, answer_stage: receipt.answer_stage, resolver_effect_count: nativeAfter.split('SYNTHETIC_CRASH_VALUE').length - 1, fence: Boolean(recovered.fence), old_process_cleanup: recovered.cleanup, stale_answer_refused: true, duplicate_unchanged: true }; rows.push(row); console.log(JSON.stringify(row));
  } finally {
    if (recovery) { recovery.child.kill('SIGTERM'); await recovery.exited; }
    if (processHost.child.exitCode === null && processHost.child.signalCode === null) { processHost.child.kill('SIGTERM'); await processHost.exited; }
  }
}
writeFileSync(join(root, 'summary.json'), JSON.stringify({ root, rows }, null, 2) + '\n'); console.log(JSON.stringify({ complete: true, summary: join(root, 'summary.json') }));
