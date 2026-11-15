/** Authored live process probes, not upstream example execution. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
const root = mkdtempSync('/tmp/a0d/probes-'), children = [];
function start(mode, dir, backend = 'jsonl') {
  const child = spawn(process.execPath, ['evidence/durable-probe-worker.mjs', mode, dir, backend], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  const events = [], bus = new EventEmitter(); let pending = '', stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  child.stdout.on('data', b => { pending += b; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) { const e = JSON.parse(line); events.push(e); bus.emit(e.event, e); } });
  const wait = async name => events.find(e => e.event === name) ?? await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${name}: ${stderr}`)), 15000);
    bus.once(name, e => { clearTimeout(timer); resolve(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${stderr}`)); });
  });
  const close = async signal => { if (child.exitCode !== null || child.signalCode) return; const done = once(child, 'exit'); if (signal) child.kill(signal); else child.stdin.write('close\n'); await done; };
  return { child, wait, close, events };
}
const results = {};
try {
  for (const backend of ['jsonl', 'sqlite']) {
    const dir = root + '/' + backend; mkdirSync(dir);
    const a = start('writer', dir, backend); const first = await a.wait('opened');
    const b = start('writer', dir, backend); const second = await b.wait('opened');
    assert.notEqual(first.pid, second.pid); assert.equal(first.root, second.root);
    results[backend] = { first, second, bothWritableOpensSucceeded: true, concurrentWritesNotTested: true };
    await b.close(); await a.close();
  }
  const dir = root + '/approval'; mkdirSync(dir);
  const a = start('approval', dir); const before = await a.wait('approval_wait');
  assert.equal(before.document.status, 'pending'); assert(!existsSync(dir + '/effect'));
  await a.close('SIGKILL');
  const b = start('approval', dir); const recovered = await b.wait('recovered_document'), again = await b.wait('approval_wait');
  assert.equal(again.document.task, before.document.task); assert.equal(again.document.visits, 2); assert(!existsSync(dir + '/effect'));
  b.child.stdin.write('approve\n'); const settled = await b.wait('settled');
  assert.equal(settled.settled.status, 'done'); assert.equal(readFileSync(dir + '/effect', 'utf8'), 'ONCE\n');
  results.approval = { before, recovered, again, settled, effects: 1, noTypedSignals: true };
  await b.close();
} finally {
  await Promise.all(children.map(async child => { if (child.exitCode === null && !child.signalCode) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; } }));
  results.cleanup = { root, allChildrenStopped: children.every(c => c.exitCode !== null || c.signalCode) };
  writeFileSync(root + '/results.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));
}
