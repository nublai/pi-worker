import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { Journal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { Refusal } from '../types.js';
import { fixture, bind, tick } from './helpers.js';

for (const disposition of ['keep', 'abandon', 'observed'] as const) test(`resolve ${disposition}: latch, generation, binding, final receipt and durable tombstone`, async () => {
  const f = fixture(); try {
    const w = await f.create(), host = f.hosts[0]!;
    const delivered = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'uncertain'), message: 'run' });
    host.emit('exit');
    const fenced = f.supervisor.get(w.worker_id);
    assert.equal(fenced.fence?.command_id, 'uncertain');
    const r = { ...bind(fenced, 'resolve'), uncertain_command_id: 'uncertain', fence_generation: fenced.fence!.fence_generation, disposition };
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, { ...r, fence_generation: 999 }), (e: unknown) => e instanceof Refusal && e.effect === 'no_effect');
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, { ...r, binding_revision: 999 }), /stale_binding/);
    const resolved = await f.supervisor.resolveUnknown(w.worker_id, r);
    assert.equal(resolved.state, 'delivered'); assert.equal(f.supervisor.get(w.worker_id).fence, null);
    assert.deepEqual(await f.supervisor.resolveUnknown(w.worker_id, r), resolved);
    assert.deepEqual(f.supervisor.receipts.all.get('uncertain'), delivered);
    for (let i = 0; i < 2; i++) {
      const journal = new Journal(f.journal.file);
      try { const s = new Supervisor(f.dir, journal, '1.5.2', () => { assert.fail('no replay'); }); await s.recover(); assert.equal(s.get(w.worker_id).fence, null); }
      finally { journal.close(); }
    }
  } finally { f.cleanup(); }
});
test('observed refuses mere memory and unknown dispatch, accepts exact session attribution only', async () => {
  const f = fixture(); try {
    const w = await f.create(), host = f.hosts[0]!; host.failure = true;
    const r = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' }); assert.equal(r.state, 'outcome_unknown');
    const now = f.supervisor.get(w.worker_id), execution = now.execution!.execution_id;
    const resolve = { ...bind(now, 'resolve'), execution_id: execution, fence_generation: now.fence!.fence_generation, disposition: 'observed' as const };
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, resolve), /execution_not_in_session_file_or_fsynced_receipt/);
    appendFileSync(host.file, JSON.stringify({ type: 'custom', id: 'attribution', parentId: null, customType: 'a0_execution', data: { execution_id: execution, command_id: 'lost' } }) + '\n');
    assert.equal((await f.supervisor.resolveUnknown(w.worker_id, resolve)).state, 'delivered');
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
  } finally { f.cleanup(); }
});
test('multiple uncertainties retained, generation monotonic after partial resolution and refence', async () => {
  const f = fixture(); try {
    const w = await f.create();
    // Two fsynced session-directed uncertainties can be reconstructed after an interrupted control operation.
    const put = (id: string) => f.supervisor.receipts.put({ command_id: id, worker_id: w.worker_id, operation: 'sessions.prompt', request_hash: id, state: 'outcome_unknown', stage: 'unknown', effect: 'unknown', evidence: 'supervisor_journal_fsynced', created_at: 'fixture' });
    put('first'); put('second');
    const journal = new Journal(f.journal.file);
    try {
      const s = new Supervisor(f.dir, journal, '1.5.2', () => { assert.fail(); }); await s.recover();
      const fence = s.get(w.worker_id).fence!; assert.deepEqual(fence.uncertain_command_ids, ['first', 'second']); assert.equal(fence.fence_generation, 2);
      await s.resolveUnknown(w.worker_id, { ...bind(w, 'resolve-first'), uncertain_command_id: 'first', fence_generation: 2, disposition: 'abandon' });
      assert.equal(s.get(w.worker_id).fence?.command_id, 'second'); assert.equal(s.get(w.worker_id).fence?.fence_generation, 3);
      await assert.rejects(s.resolveUnknown(w.worker_id, { ...bind(w, 'stale'), uncertain_command_id: 'second', fence_generation: 2, disposition: 'keep' }), /wrong_fence_generation/);
    } finally { journal.close(); }
  } finally { f.cleanup(); }
});
for (const disposition of ['keep', 'abandon'] as const) test(`queued follow-up and pending child pause under fence then ${disposition}`, async () => {
  const f = fixture(); try {
    const w = await f.create(), h = f.hosts[0]!;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    const running = f.supervisor.get(w.worker_id), execution_id = running.execution!.execution_id;
    await f.supervisor.followUp(w.worker_id, { ...bind(w, 'follow'), message: 'next', execution_id });
    await f.supervisor.launchChild(w.worker_id, { ...bind(w, 'child'), execution_id, launch: { command_id: 'create-child', cwd: f.dir, provider: 'p', model: 'm', thinking: 'off' } });
    h.failure = true;
    // Host exit preserves the queue; emulate a transport loss without stopping the live host.
    h.emit('exit');
    h.emit('event', { type: 'agent_settled' }); await tick();
    assert.equal(h.prompts, 1); assert.equal(f.hosts.length, 1);
    const fenced = f.supervisor.get(w.worker_id); assert.ok(fenced.queued!.every(q => q.state === 'paused'));
    for (const action of [() => f.supervisor.prompt(w.worker_id, { ...bind(w, 'denied'), message: 'no' }), () => f.supervisor.rebind(w.worker_id, { ...bind(w, 'new'), action: 'new' }), () => f.supervisor.followUp(w.worker_id, { ...bind(w, 'more'), execution_id, message: 'no' })]) await assert.rejects(action(), (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.uncertain_command_id === 'run');
    // The fake host remains available: only the fence, not readiness, controls due work here.
    f.supervisor.require(w.worker_id).worker.status = 'ready'; h.failure = false;
    await f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'resolve'), uncertain_command_id: 'run', fence_generation: fenced.fence!.fence_generation, disposition });
    await tick(); await tick();
    if (disposition === 'keep') {
      assert.equal(h.prompts, 2); h.emit('event', { type: 'agent_settled' }); await tick(); await tick();
      assert.equal(f.hosts.length, 2); assert.equal(f.supervisor.receipts.all.get('follow')?.state, 'delivered');
    } else { assert.equal(h.prompts, 1); assert.equal(f.hosts.length, 1); assert.equal(f.supervisor.receipts.all.get('follow')?.disposition, 'abandoned_without_dispatch'); }
  } finally { f.cleanup(); }
});
test('new/fork/resume change same-process binding; stale delayed prompt and duplicate open name cause', async () => {
  const f = fixture(); try {
    const original = await f.create(), id = original.worker_id, h = f.hosts[0]!;
    const frames: string[] = []; const detach = h.on('event', () => {});
    f.supervisor.require(id).hub.attach(() => f.supervisor.get(id), null, frame => frames.push(frame.type))();
    const r = await f.supervisor.rebind(id, { ...bind(original, 'new'), action: 'new' }); assert.equal(r.state, 'delivered');
    let current = f.supervisor.get(id); assert.equal(current.binding_revision, 2); assert.notEqual(current.session_id, original.session_id);
    await assert.rejects(f.supervisor.prompt(id, { ...bind(original, 'delayed'), message: 'no' }), (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.details.received_binding_revision === 1);
    await f.supervisor.rebind(id, { ...bind(current, 'resume'), action: 'resume', target_session_id: original.session_id! });
    current = f.supervisor.get(id); assert.equal(current.session_id, original.session_id); assert.equal(current.binding_revision, 3);
    appendFileSync(h.file, JSON.stringify({ type: 'message', id: 'user', parentId: null, message: { role: 'user', content: [] } }) + '\n');
    current = f.supervisor.get(id);
    await assert.rejects(f.supervisor.rebind(id, { ...bind(current, 'stale-leaf'), action: 'fork', source_leaf_id: 'old', entry_id: 'user' }), /stale_source_leaf/);
    await f.supervisor.rebind(id, { ...bind(current, 'fork'), action: 'fork', source_leaf_id: current.leaf_id, entry_id: 'user' });
    current = f.supervisor.get(id); assert.equal(current.binding_revision, 4);
    await assert.rejects(f.supervisor.rebind(id, { ...bind(current, 'navigate'), action: 'navigate', entry_id: 'user' }), /tree_navigation_unavailable/);
    const second = await f.create();
    await assert.rejects(f.supervisor.rebind(second.worker_id, { ...bind(second, 'duplicate-open'), action: 'resume', target_session_id: current.session_id! }), (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.details.holder_worker_id === id);
    assert.equal(h.prompts, 0); assert.equal(detach, h);
  } finally { f.cleanup(); }
});
test('recovered intent only dispatches once after owner resolution and exact retry', async () => {
  const f = fixture(); try {
    const w = await f.create(), p = { ...bind(w, 'recovered'), message: 'same' };
    const hash = (await import('../receipts.js')).requestHash({ ...p, worker_id: w.worker_id, operation: 'sessions.prompt' });
    f.supervisor.receipts.put({ command_id: p.command_id, worker_id: w.worker_id, operation: 'sessions.prompt', request_hash: hash, state: 'intent_recovered', stage: 'recovery_pending', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: 'fixture' });
    assert.equal((await f.supervisor.prompt(w.worker_id, p)).state, 'intent_recovered'); assert.equal(f.hosts[0]!.prompts, 0);
    await f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'resolve'), uncertain_command_id: 'recovered', fence_generation: 0, disposition: 'keep' });
    assert.equal(f.hosts[0]!.prompts, 0, 'resolution never auto-replays');
    const a = await f.supervisor.prompt(w.worker_id, p); assert.equal(a.state, 'delivered');
    assert.deepEqual(await f.supervisor.prompt(w.worker_id, p), a); assert.equal(f.hosts[0]!.prompts, 1);
    assert.ok(!readFileSync(f.journal.file, 'utf8').includes(p.message + '"'));
  } finally { f.cleanup(); }
});
test('cancel, interrupt and evidence reports allowed under fence without lifting it', async () => {
  const f = fixture(); try {
    const w = await f.create(); f.hosts[0]!.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' });
    for (const interrupt of [false, true]) assert.equal((await f.supervisor.control(w.worker_id, bind(w, 'control-' + interrupt), interrupt)).state, 'delivered');
    assert.equal((await f.supervisor.report(w.worker_id, { ...bind(w, 'report'), task_id: 'task', result_digest: 'sha256:claim' })).state, 'delivered');
    assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'lost');
    assert.equal(f.hosts[0]!.commands.filter(c => c.type === 'clear_queue').length, 2);
  } finally { f.cleanup(); }
});
