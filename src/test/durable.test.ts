/** THROWAWAY regression coverage for comparison seam, not contract conformance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, type ConversationId } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { DurableHost, Control } from '../durable-host.js';
import { router, listenPrivate } from '../server.js';
import { Client } from '../client.js';
import type { Binding, Snapshot } from '../types.js';
async function fixture() {
  mkdirSync('/tmp/a0d', { recursive: true });
  const dir = mkdtempSync('/tmp/a0d/unit-');
  const models = createModels(), faux = fauxProvider({ provider: 'test', models: [{ id: 'm' }] }); models.setProvider(faux.provider);
  const h = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { compaction: { enabled: false } } }, ctx);
  const host = new DurableHost(h, models); await host.recover();
  return { dir, h, host, faux, cleanup: async () => { await host.shutdown(); rmSync(dir, { recursive: true }); } };
}
test('Durable B2: atomic receipt/submission, concurrent duplicate, conflicts, snapshot, pinned history and stop', async () => {
  const f = await fixture(), server = router(f.host);
  try {
    const socket = join(f.dir, 'worker.sock'); await listenPrivate(server, socket); const client = new Client(socket);
    const create = await client.call('workers.create', { body: { command_id: 'c', cwd: f.dir, provider: 'test', model: 'm', thinking: 'off' } });
    const id = create.worker_id!, worker = f.host.get(id);
    const binding: Binding = { command_id: 'p', worker_epoch: worker.worker_epoch, session_id: worker.session_id!, binding_revision: 1 };
    f.faux.setResponses([fauxAssistantMessage('ONE'), fauxAssistantMessage('TWO')]);
    const body = { ...binding, message: 'hello' };
    const [one, two] = await Promise.all([client.call('sessions.prompt', { id, body }), client.call('sessions.prompt', { id, body })]);
    assert.deepEqual(one, two);
    await f.h.waitForIdle(ctx); assert.equal(f.faux.state.callCount, 1);
    await assert.rejects(client.call('sessions.prompt', { id, body: { ...body, message: 'conflict' } }), /command_id_conflict/);
    await assert.rejects(client.call('sessions.prompt', { id, body: { ...body, command_id: 'stale', binding_revision: 2 } }), /stale_binding/);
    const submission = await f.h.submission(Number(one.execution_id) as Parameters<typeof f.h.submission>[0], ctx);
    assert.equal((await submission!.status(ctx)).status, 'done');
    const control = await f.h.snapshot(Control, ctx); assert(control?.receipts.p);
    const firstPage = await client.call('history.page', { id, query: { limit: '1' } }); assert(firstPage.next);
    await client.call('sessions.prompt', { id, body: { ...body, command_id: 'p2', message: 'later' } }); await f.h.waitForIdle(ctx);
    const rest = await client.call('history.page', { id, query: { watermark: firstPage.next.watermark, after: firstPage.next.after! } });
    assert.equal(rest.watermark, firstPage.watermark); assert(!JSON.stringify(rest).includes('later'));
    const frames: Snapshot[] = []; await client.watch(id, frame => { frames.push(frame as Snapshot); return false; });
    assert.equal(frames[0]?.type, 'snapshot'); assert.equal(frames[0]?.history.evidence, 'durable_storage');
    const stop = await client.call('workers.stop', { id, body: { ...binding, command_id: 'stop' } });
    assert.equal(stop.result?.termination, 'durable_tasks_idle');
    await assert.rejects(client.call('sessions.prompt', { id, body: { ...body, command_id: 'stopped' } }), /worker_not_ready/);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
});
test('native requestId deduplicates even different content; host must retain conflict comparison', async () => {
  const f = await fixture(); try {
    const root = await f.h.root(ctx, { agent: { model: { provider: 'test', modelId: 'm' } } });
    f.faux.setResponses([fauxAssistantMessage('one')]);
    const a = await root.submit({ type: 'input', content: 'first', requestId: 'same' }, ctx);
    const b = await root.submit({ type: 'input', content: 'different', requestId: 'same' }, ctx);
    assert.equal(a.id, b.id); await a.wait(ctx); await root.waitForIdle(ctx);
    assert.equal(f.faux.state.callCount, 1);
    const history = await root.entries({}, 100, undefined, ctx); assert.equal(history.items.filter(e => e.kind === 'pi.user').length, 1);
  } finally { await f.cleanup(); }
});
test('submit(tx) rollback stores neither submission nor control record', async () => {
  const f = await fixture(); try {
    const root = await f.h.root(ctx, { agent: { model: { provider: 'test', modelId: 'm' } } });
    await assert.rejects(f.h.commit(async tx => {
      await root.submit(tx, { type: 'input', content: 'not admitted', requestId: 'rollback' });
      (await tx.doc(Control)).receipts.rollback = 'provisional'; throw new Error('ROLLBACK');
    }, ctx), /ROLLBACK/);
    assert.equal((await f.h.snapshot(Control, ctx))?.receipts.rollback, undefined);
    const absent = await f.h.commit(tx => tx.submissionByRequest(root.id as ConversationId, 'rollback'), ctx);
    assert.equal(absent, undefined); assert.equal(f.faux.state.callCount, 0);
  } finally { await f.cleanup(); }
});
