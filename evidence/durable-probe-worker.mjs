/** Authored library-only probes; all writes below supplied /tmp/a0d path. */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc, defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
const [mode, dir, backend] = process.argv.slice(2);
if (!dir.startsWith('/tmp/a0d/')) throw new Error('scratch only');
const registry = createRegistry(), models = createModels();
const faux = fauxProvider({ provider: 'probe', models: [{ id: 'm' }] }); models.setProvider(faux.provider);
const Approval = defineDoc({ kind: 'probe.approval', scope: 'session', version: 1,
  initial: () => ({ status: 'pending', task: 0, visits: 0, artifact: 'fixture-v1', policy: 1 }), checkpointWhen: () => true });
let h;
if (mode === 'approval') {
  registry.install(defineExtension({ name: 'approval-fixture', tools: [defineTool({ name: 'effect', description: 'One isolated test effect', parameters: { type: 'object', properties: {} },
    execute: async () => { appendFileSync(dir + '/effect', 'ONCE\n'); return { output: 'EFFECT_DONE' }; } })],
    hooks: [hook(ToolTask, { beforeTool: async (_call, api, context) => {
      await h.commit(async tx => { const d = await tx.doc(Approval); if (d.task && d.task !== api.taskId) throw new Error('wrong approval binding'); d.task = api.taskId; d.visits++; }, context);
      const d = await h.snapshot(Approval, context); console.log(JSON.stringify({ event: 'approval_wait', document: d, pid: process.pid }));
      const watch = await h.watchDoc(Approval, context);
      if (watch.value.status === 'approved') { await watch.stop(); return; }
      await new Promise((resolve, reject) => {
        watch.start(async call => { if (call.kind === 'value' && call.value.status === 'approved') resolve(); });
        watch.closed.then(() => reject(new Error('approval wait ended')));
      });
      await watch.stop();
      const approved = await h.snapshot(Approval, context);
      if (approved.artifact !== 'fixture-v1' || approved.policy !== 1) return { block: 'stale approval' };
    } })] }));
  faux.setResponses([fauxAssistantMessage(fauxToolCall('effect', {}, { id: 'effect-call' }), { stopReason: 'toolUse' }), fauxAssistantMessage('APPROVAL_DONE')]);
}
const storage = backend === 'sqlite' ? await openNodeSqliteStorage(dir + '/db.sqlite') : await openNodeJsonlStorage(dir + '/jsonl', ctx, { fsync: true });
h = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false } } }, ctx);
const root = await h.root(ctx, { agent: { model: { provider: 'probe', modelId: 'm' } } });
console.log(JSON.stringify({ event: 'opened', mode, backend, root: root.id, pid: process.pid }));
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void (async () => {
  if (line === 'close') { await h.close(ctx); process.exit(0); }
  if (line === 'approve') await h.commit(async tx => { (await tx.doc(Approval)).status = 'approved'; }, ctx);
})().catch(error => { console.error(error); process.exit(1); }); });
if (mode === 'approval') {
  const existing = await h.snapshot(Approval, ctx);
  if (existing) {
    // Reopened generation is already after the tool-calling response.
    faux.setResponses([fauxAssistantMessage('APPROVAL_DONE')]);
    console.log(JSON.stringify({ event: 'recovered_document', document: existing }));
  }
  const submission = await root.submit({ type: 'input', requestId: 'approval-input', content: 'Run effect once after approval' }, ctx);
  h.resume();
  const settled = await submission.wait(ctx); await root.waitForIdle(ctx);
  console.log(JSON.stringify({ event: 'settled', settled, document: await h.snapshot(Approval, ctx) }));
}
