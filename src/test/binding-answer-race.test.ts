import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { fixture, bind, tick } from './helpers.js';
import type { Answer } from '../interactions.js';
import type { PiRecord } from '../host.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const approval = () => ({ gate_token: 'gate', digest: 'digest', policy_revision: 'p1', expiry: Date.now() + 30000, operation: 'bash', resource: 'fixture', environment: 'fixture', offered_scope: 'once' });
for (const kind of ['input', 'tool_approval'] as const) for (const consumed of [false, true]) test(`in-flight ${kind}, consumed=${consumed}: navigate cancels accepted resolver and refuses stale success`, async () => {
  const f = fixture();
  try {
    const w = await f.create(), h = f.hosts[0]!;
    const entered = deferred<void>(), release = deferred<void>();
    Object.assign(h, { kind: 'sdk', answerUI: async () => { entered.resolve(); await release.promise; return { stage: 3, consumed, outcome: 'answered' }; } });
    appendFileSync(h.file, JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: [] } }) + '\n');
    const gate = approval();
    h.emit('event', { type: 'extension_ui_request', method: kind, id: 'native', approval: gate });
    const i = f.supervisor.interactions.list(w.worker_id)[0]!;
    const a: Answer = { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind, outcome: 'answer', value: kind === 'input' ? 'synthetic' : true };
    const pending = f.supervisor.answer(w.worker_id, a); await entered.promise;
    const before = f.supervisor.get(w.worker_id);
    let cancelledBeforeMove = false;
    h.before = c => { if (c.type === 'navigate') cancelledBeforeMove = h.cancelled.includes('native'); };
    const nav = await f.supervisor.rebind(w.worker_id, { ...bind(before, 'nav'), action: 'navigate', entry_id: 'entry', source_leaf_id: before.leaf_id });
    release.resolve(); const receipt = await pending;
    assert.equal(nav.state, 'delivered'); assert.equal(f.supervisor.get(w.worker_id).binding_revision, 2);
    assert.equal(cancelledBeforeMove, true, 'cancelUI must include accepted interactions before navigate');
    assert.equal(receipt.state, consumed ? 'outcome_unknown' : 'rejected'); assert.equal(receipt.effect, consumed ? 'unknown' : 'no_effect');
    assert.ok((receipt.answer_stage ?? 0) < 3);
    assert.equal(Boolean(f.supervisor.get(w.worker_id).fence), consumed);
    assert.ok(!f.journal.records.some(r => r.kind === 'interaction' && r.value.interaction_id === i.interaction_id && Number(r.value.answer_stage) >= 3), 'no stale stage-3 journal record');
    assert.deepEqual(await f.supervisor.answer(w.worker_id, a), receipt, 'duplicate never replays');
    if (kind === 'tool_approval') {
      h.emit('event', { type: 'gate_check', ...gate }); await tick(); await tick();
      assert.equal(f.supervisor.get(w.worker_id).status, 'ready', 'late cancelled gate is not a worker fault');
      assert.equal(h.commands.some(c => c.type === 'gate_release'), false);
    }
  } finally { f.cleanup(); }
});
for (const change of ['epoch', 'fence', 'rebinding'] as const) test(`in-flight answer rechecks ${change} even without a revision move`, async () => {
  const f = fixture(); try {
    const w = await f.create(), h = f.hosts[0]!, entered = deferred<void>(), release = deferred<void>();
    Object.assign(h, { kind: 'sdk', answerUI: async () => { entered.resolve(); await release.promise; return { stage: 3, consumed: true }; } });
    h.emit('event', { type: 'extension_ui_request', method: 'input', id: 'native' });
    const i = f.supervisor.interactions.list(w.worker_id)[0]!;
    const pending = f.supervisor.answer(w.worker_id, { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind: 'input', outcome: 'answer', value: 'synthetic' });
    await entered.promise;
    const live = f.supervisor.require(w.worker_id);
    if (change === 'epoch') live.worker.worker_epoch = 'replacement';
    if (change === 'fence') { live.worker.fence_generation = 1; /* fence appeared and was resolved while awaiting */ }
    if (change === 'rebinding') live.rebinding = true;
    release.resolve(); const r = await pending;
    assert.equal(r.state, 'outcome_unknown'); assert.equal(r.effect, 'unknown'); assert.ok(live.worker.fence); assert.ok((r.answer_stage ?? 0) < 3);
  } finally { f.cleanup(); }
});
test('already-consumed approval is cancelled by navigate; late gate check does not fault or release', async () => {
  const f = fixture(); try {
    const w = await f.create(), h = f.hosts[0]!;
    Object.assign(h, { kind: 'sdk', answerUI: async () => ({ stage: 3, consumed: true }) });
    appendFileSync(h.file, JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: [] } }) + '\n');
    const gate = approval(); h.emit('event', { type: 'extension_ui_request', method: 'tool_approval', id: 'native', approval: gate });
    const i = f.supervisor.interactions.list(w.worker_id)[0]!;
    await f.supervisor.answer(w.worker_id, { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind: 'tool_approval', outcome: 'answer', value: true });
    const before = f.supervisor.get(w.worker_id);
    await f.supervisor.rebind(w.worker_id, { ...bind(before, 'nav'), action: 'navigate', entry_id: 'entry', source_leaf_id: before.leaf_id });
    h.emit('event', { type: 'gate_check', ...gate } as PiRecord); await tick(); await tick();
    assert.ok(h.cancelled.includes('native')); assert.equal(f.supervisor.get(w.worker_id).status, 'ready'); assert.equal(h.commands.some(c => c.type === 'gate_release'), false);
  } finally { f.cleanup(); }
});
