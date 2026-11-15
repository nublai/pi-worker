import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, bind } from './helpers.js';

for (const event of ['agent_settled', 'tool_execution_end']) for (const kind of ['input', 'tool_approval'] as const) test(`sibling ${event} does not invalidate an accepted ${kind} answer`, async () => {
  const f = fixture();
  try {
    const w = await f.create(), h = f.hosts[0]!;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { entered = r; });
    Object.assign(h, { kind: 'sdk', answerUI: async () => { entered(); await held; return { stage: 3, consumed: true }; } });
    h.emit('event', { type: 'extension_ui_request', method: kind, id: 'answering' });
    h.emit('event', { type: 'extension_ui_request', method: 'input', id: 'sibling' });
    const i = f.supervisor.interactions.list(w.worker_id).find(x => x.native_id === 'answering')!;
    const a = { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind, outcome: 'answer' as const, value: kind === 'input' ? 'fixture' : true };
    const pending = f.supervisor.answer(w.worker_id, a); await waiting;
    h.emit('event', { type: event }); release();
    const result = await pending;
    assert.equal(result.state, 'delivered'); assert.equal(result.answer_stage, 3);
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
    assert.equal(f.supervisor.get(w.worker_id).binding_revision, 1);
    assert.deepEqual(f.supervisor.interactions.list(w.worker_id).map(x => x.native_id), ['sibling'], 'native resolver lifecycle, not unrelated settlement, owns closure');
    assert.deepEqual(await f.supervisor.answer(w.worker_id, a), result);
  } finally { f.cleanup(); }
});
