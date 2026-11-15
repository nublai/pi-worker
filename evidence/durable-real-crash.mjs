/** Real exe.dev request SIGKILL probe. No fake response and no tool execution. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension, hook, GenerationTask } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { spikeModels } from '../dist/durable-models.js';
const [mode, path] = process.argv.slice(2);
if (mode === 'worker') {
  if (!path.startsWith('/tmp/a0d/')) throw new Error('scratch only');
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'count-requests', hooks: [hook(GenerationTask, { beforeRequest: async () => { appendFileSync(path + '/requests.jsonl', JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n'); } })] }));
  const h = await Harness.open(await openNodeJsonlStorage(path + '/storage', ctx, { fsync: true }), { registry, models: spikeModels(path, true), settings: { retry: { maxRetries: 2, baseDelayMs: 100 }, compaction: { enabled: false } } }, ctx);
  try {
    const root = await h.root(ctx, { agent: { model: { provider: 'exe-dev-anthropic', modelId: 'claude-sonnet-4-6@llm' }, thinkingLevel: 'off' } });
    const watch = await root.watch(ctx); let announced = false;
    watch.start(async call => {
      const message = call.kind === 'value' ? call.value.docs['pi.live']?.generation?.message : undefined;
      const chars = message?.content?.filter(x => x.type === 'text').reduce((n, x) => n + x.text.length, 0) ?? 0;
      if (chars && !announced) { announced = true; console.log(JSON.stringify({ event: 'real_partial', pid: process.pid, chars })); }
    });
    const submission = await root.submit({ type: 'input', requestId: 'real-model-cut', content: 'Write 200 numbered lines, each containing the number and five different common English words. Include every line. Do not use tools. End with A0D_REAL_RECOVERY_DONE.' }, ctx);
    h.resume(); const outcome = await submission.wait(ctx); await root.waitForIdle(ctx);
    const history = await root.entries({}, 100, undefined, ctx);
    const assistants = history.items.filter(e => e.kind === 'pi.assistant').map(e => ({ id: e.id, stopReason: e.model?.[0]?.stopReason, chars: JSON.stringify(e.model?.[0]?.content).length, finalMarker: JSON.stringify(e.model?.[0]?.content).includes('A0D_REAL_RECOVERY_DONE') }));
    console.log(JSON.stringify({ event: 'settled', pid: process.pid, outcome, userEntries: history.items.filter(e => e.kind === 'pi.user').length, assistants }));
    await watch.stop();
  } finally { await h.close(ctx); }
} else {
  const root = mkdtempSync('/tmp/a0d/real-crash-'), children = [];
  const run = () => {
    const child = spawn(process.execPath, ['evidence/durable-real-crash.mjs', 'worker', root], { stdio: ['ignore','pipe','pipe'] }); children.push(child);
    let text = '', stderr = ''; const events = [], listeners = new Map();
    child.stderr.on('data', b => { stderr += b; });
    child.stdout.on('data', b => { text += b; const lines = text.split('\n'); text = lines.pop(); for (const line of lines) { const e = JSON.parse(line); events.push(e); listeners.get(e.event)?.(e); } });
    return { child, events, wait: name => events.find(e => e.event === name) ?? new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout ' + name + ': ' + stderr)), 90000); listeners.set(name, e => { clearTimeout(timer); resolve(e); }); child.once('exit', code => { clearTimeout(timer); reject(new Error('exit ' + code + ': ' + stderr)); }); }) };
  };
  try {
    const first = run(); const partial = await first.wait('real_partial'); const killed = once(first.child, 'exit'); first.child.kill('SIGKILL'); await killed;
    const second = run(); const settled = await second.wait('settled'); await once(second.child, 'exit');
    const requests = readFileSync(root + '/requests.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.length, 2); assert.notEqual(requests[0].pid, requests[1].pid);
    assert.equal(settled.outcome.status, 'done'); assert.equal(settled.userEntries, 1); assert(settled.assistants.some(x => x.finalMarker && x.stopReason === 'stop'));
    console.log(JSON.stringify({ root, partial, requests, settled, allChildrenStopped: children.every(c => c.exitCode !== null || c.signalCode) }, null, 2));
  } finally { await Promise.all(children.map(async child => { if (child.exitCode === null && !child.signalCode) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } })); }
}
