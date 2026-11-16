/**
 * Contract invariants, ported from A0 `src/test/invariants.test.ts` case by case (plan section 3.2), with every
 * assertion kept: the resolve, generation, recovered-intent and abandon-queue cases at P1-6; the binding case at
 * P1-10; the child cases at P1-11, when the file became green as a whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { Refusal } from '../../src/b2/errors.js';
import { requestHash } from '../../src/receipts/receipts.js';
import { bind, fixture, tick } from '../supervisor-fixture.js';

for (const disposition of ['keep', 'abandon', 'observed'] as const) {
  test(`resolve ${disposition}: latch, generation, binding, final receipt and durable tombstone`, async () => {
    const f = fixture();
    try {
      const w = await f.create();
      const host = f.hosts[0]!;
      const delivered = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'uncertain'), message: 'run' });
      host.emit('exit');
      if (disposition === 'observed') host.emit('event', { type: 'agent_settled' });
      const fenced = f.supervisor.get(w.worker_id);
      assert.equal(fenced.fence?.command_id, 'uncertain');
      const r = { ...bind(fenced, 'resolve'), uncertain_command_id: 'uncertain', fence_generation: fenced.fence!.fence_generation, disposition };
      await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, { ...r, fence_generation: 999 }), (e: unknown) => e instanceof Refusal && e.effect === 'no_effect');
      await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, { ...r, binding_revision: 999 }), /stale_binding/);
      const resolved = await f.supervisor.resolveUnknown(w.worker_id, r);
      assert.equal(resolved.state, 'delivered');
      assert.equal(f.supervisor.get(w.worker_id).fence, null);
      assert.deepEqual(await f.supervisor.resolveUnknown(w.worker_id, r), resolved);
      assert.deepEqual(f.supervisor.receipts.all.get('uncertain'), delivered);
      for (let i = 0; i < 2; i++) {
        const s = await f.restart(() => assert.fail('no replay'));
        assert.equal(s.get(w.worker_id).fence, null);
      }
    } finally {
      f.cleanup();
    }
  });
}

test('observed refuses mere memory and unknown dispatch, accepts exact session settlement only', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    host.failure = true;
    const r = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' });
    assert.equal(r.state, 'outcome_unknown');
    const now = f.supervisor.get(w.worker_id);
    const execution = now.execution!.execution_id;
    const resolve = { ...bind(now, 'resolve'), execution_id: execution, fence_generation: now.fence!.fence_generation, disposition: 'observed' as const };
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, resolve), /execution_settlement_not_in_session_file_or_fsynced_record/);
    appendFileSync(host.file, `${JSON.stringify({ type: 'custom', id: 'attribution', parentId: null, customType: 'agent_settled', data: { execution_id: execution, command_id: 'lost' } })}\n`);
    assert.equal((await f.supervisor.resolveUnknown(w.worker_id, resolve)).state, 'delivered');
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
  } finally {
    f.cleanup();
  }
});

test('multiple uncertainties retained, generation monotonic after partial resolution and refence', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    // Two fsynced session-directed uncertainties can be reconstructed after an interrupted control operation.
    const put = (id: string) =>
      f.supervisor.receipts.put(
        { command_id: id, worker_id: w.worker_id, operation: 'sessions.prompt', request_hash: id, state: 'outcome_unknown', stage: 'unknown', effect: 'unknown', evidence: 'supervisor_journal_fsynced', created_at: 'fixture' },
        'receipt.result',
      );
    put('first');
    put('second');
    const s = await f.restart(() => assert.fail());
    const fence = s.get(w.worker_id).fence!;
    assert.deepEqual(fence.uncertain_command_ids, ['first', 'second']);
    assert.equal(fence.fence_generation, 2);
    await s.resolveUnknown(w.worker_id, { ...bind(w, 'resolve-first'), uncertain_command_id: 'first', fence_generation: 2, disposition: 'abandon' });
    assert.equal(s.get(w.worker_id).fence?.command_id, 'second');
    assert.equal(s.get(w.worker_id).fence?.fence_generation, 3);
    await assert.rejects(s.resolveUnknown(w.worker_id, { ...bind(w, 'stale'), uncertain_command_id: 'second', fence_generation: 2, disposition: 'keep' }), /wrong_fence_generation/);
  } finally {
    f.cleanup();
  }
});

test('recovered intent only dispatches once after owner resolution and exact retry', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const p = { ...bind(w, 'recovered'), message: 'same' };
    const hash = requestHash({ ...p, worker_id: w.worker_id, operation: 'sessions.prompt' });
    f.supervisor.receipts.put(
      { command_id: p.command_id, worker_id: w.worker_id, operation: 'sessions.prompt', request_hash: hash, state: 'intent_recovered', stage: 'recovery_pending', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: 'fixture' },
      'receipt.recover',
    );
    assert.equal((await f.supervisor.prompt(w.worker_id, p)).state, 'intent_recovered');
    assert.equal(f.hosts[0]!.prompts, 0);
    await f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'resolve'), uncertain_command_id: 'recovered', fence_generation: 0, disposition: 'keep' });
    assert.equal(f.hosts[0]!.prompts, 0, 'resolution never auto-replays');
    const a = await f.supervisor.prompt(w.worker_id, p);
    assert.equal(a.state, 'delivered');
    assert.deepEqual(await f.supervisor.prompt(w.worker_id, p), a);
    assert.equal(f.hosts[0]!.prompts, 1);
    assert.ok(!readFileSync(f.journalFile, 'utf8').includes(`${p.message}"`));
  } finally {
    f.cleanup();
  }
});

test('abandon drops a recovered queue and its durable no-dispatch intent', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    await f.supervisor.followUp(w.worker_id, { ...bind(w, 'queued'), execution_id: f.supervisor.get(w.worker_id).execution!.execution_id, message: 'never dispatch' });
    const next = await f.restart(() => assert.fail('no host'));
    let now = next.get(w.worker_id);
    await next.resolveUnknown(w.worker_id, { ...bind(now, 'resolve-run'), uncertain_command_id: 'run', fence_generation: now.fence!.fence_generation, disposition: 'abandon' });
    now = next.get(w.worker_id);
    assert.equal(now.queued?.[0]?.state, 'dropped');
    assert.equal(next.receipts.all.get('queued')?.disposition, 'abandoned_without_dispatch');
    assert.equal(f.hosts[0]!.prompts, 1);
  } finally {
    f.cleanup();
  }
});

test('resolved duplicate stays read-only, but a NEW crash of a kept live run relatches at the next generation', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const p = { ...bind(w, 'lost'), message: 'live' };
    f.hosts[0]!.failure = true;
    const original = await f.supervisor.prompt(w.worker_id, p);
    await f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'resolve'), uncertain_command_id: 'lost', fence_generation: 1, disposition: 'keep' });
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
    assert.deepEqual(await f.supervisor.prompt(w.worker_id, p), original);
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
    const next = await f.restart(() => assert.fail('no adoption'));
    assert.equal(next.get(w.worker_id).fence?.fence_generation, 2);
    assert.equal(next.get(w.worker_id).fence?.command_id, 'lost');
  } finally {
    f.cleanup();
  }
});

test('new/fork/resume change same-process binding; stale delayed prompt and duplicate open name cause', async () => {
  const f = fixture();
  try {
    const original = await f.create();
    const id = original.worker_id;
    const h = f.hosts[0]!;
    const frames: string[] = [];
    const sub = f.supervisor.subscribe(frame => void frames.push(frame.type), { workerIds: [id] });
    h.holdUI = true;
    h.emit('event', { type: 'extension_ui_request', id: 'old-question', method: 'input' });
    assert.equal(f.supervisor.get(id).pending_interactions.length, 1);
    h.holdUI = false;
    const r = await f.supervisor.rebind(id, { ...bind(original, 'new'), action: 'new' });
    assert.equal(r.state, 'delivered');
    let current = f.supervisor.get(id);
    assert.equal(current.binding_revision, 2);
    assert.notEqual(current.session_id, original.session_id);
    await assert.rejects(
      f.supervisor.prompt(id, { ...bind(original, 'delayed'), message: 'no' }),
      (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.details.received_binding_revision === 1,
    );
    await f.supervisor.rebind(id, { ...bind(current, 'resume'), action: 'resume', target_session_id: original.session_id! });
    current = f.supervisor.get(id);
    assert.equal(current.session_id, original.session_id);
    assert.equal(current.binding_revision, 3);
    appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'user', parentId: null, message: { role: 'user', content: [] } })}\n`);
    current = f.supervisor.get(id);
    await assert.rejects(f.supervisor.rebind(id, { ...bind(current, 'stale-leaf'), action: 'fork', source_leaf_id: 'old', entry_id: 'user' }), /stale_source_leaf/);
    await f.supervisor.rebind(id, { ...bind(current, 'fork'), action: 'fork', source_leaf_id: current.leaf_id, entry_id: 'user' });
    current = f.supervisor.get(id);
    assert.equal(current.binding_revision, 4);
    // A0's RPC host refused B2 navigation (`tree_navigation_unavailable`); the SDK host navigates, so a navigation that
    // does not name the leaf it saw is the refusal here (no_effect, before any dispatch).
    await assert.rejects(f.supervisor.rebind(id, { ...bind(current, 'navigate'), action: 'navigate', entry_id: 'user' }), /stale_source_leaf/);
    const second = await f.create();
    await assert.rejects(
      f.supervisor.rebind(second.worker_id, { ...bind(second, 'duplicate-open'), action: 'resume', target_session_id: current.session_id! }),
      (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.details.holder_worker_id === id,
    );
    assert.equal(h.prompts, 0);
    assert.deepEqual(f.supervisor.get(id).pending_interactions, []);
    assert.ok(h.cancelled.includes('old-question'));
    assert.ok(frames.includes('session.rebound'));
    sub.close();
  } finally {
    f.cleanup();
  }
});

for (const disposition of ['keep', 'abandon'] as const) {
  test(`queued follow-up and pending child pause under fence then ${disposition}`, async () => {
    const f = fixture();
    try {
      const w = await f.create();
      const h = f.hosts[0]!;
      const native = h.request.bind(h);
      let reject!: () => void;
      let first = true;
      const dropped = new Promise<never>((_r, no) => {
        reject = () => no(new Error('lost reply'));
      });
      dropped.catch(() => {});
      h.request = async c => {
        const reply = await native(c);
        if (c.type === 'prompt' && first) {
          first = false;
          await dropped;
        }
        return reply;
      };
      const pending = f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
      await tick();
      const running = f.supervisor.get(w.worker_id);
      const execution_id = running.execution!.execution_id;
      await f.supervisor.followUp(w.worker_id, { ...bind(w, 'follow'), message: 'next', execution_id });
      await f.supervisor.launchChild(w.worker_id, { ...bind(w, 'child'), execution_id, launch: { command_id: 'create-child', cwd: f.dir, provider: 'p', model: 'm', thinking: 'off' } });
      reject();
      await pending;
      h.emit('event', { type: 'agent_settled' });
      await tick();
      assert.equal(h.prompts, 1);
      assert.equal(f.hosts.length, 1);
      const fenced = f.supervisor.get(w.worker_id);
      assert.ok(fenced.queued!.every(q => q.state === 'paused'));
      for (const action of [
        () => f.supervisor.prompt(w.worker_id, { ...bind(w, 'denied'), message: 'no' }),
        () => f.supervisor.rebind(w.worker_id, { ...bind(w, 'new'), action: 'new' }),
        () => f.supervisor.followUp(w.worker_id, { ...bind(w, 'more'), execution_id, message: 'no' }),
      ]) {
        await assert.rejects(action(), (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.uncertain_command_id === 'run');
      }
      await f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'resolve'), uncertain_command_id: 'run', fence_generation: fenced.fence!.fence_generation, disposition });
      await tick();
      await tick();
      if (disposition === 'keep') {
        assert.equal(h.prompts, 2);
        h.emit('event', { type: 'agent_settled' });
        await tick();
        await tick();
        assert.equal(f.hosts.length, 2);
        assert.equal(f.supervisor.receipts.all.get('follow')?.state, 'delivered');
      } else {
        assert.equal(h.prompts, 1);
        assert.equal(f.hosts.length, 1);
        assert.equal(f.supervisor.receipts.all.get('follow')?.disposition, 'abandoned_without_dispatch');
      }
    } finally {
      f.cleanup();
    }
  });
}

for (const reported of [false, true]) {
  test(`child recovery ${reported ? 'with' : 'without'} fsynced report preserves parent launch uncertainty`, async () => {
    const f = fixture();
    try {
      const w = await f.create();
      await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
      f.hosts[0]!.emit('event', { type: 'agent_settled' });
      await f.supervisor.launchChild(w.worker_id, { ...bind(w, 'launch'), execution_id: f.supervisor.get(w.worker_id).execution!.execution_id, launch: { command_id: 'create-child', cwd: f.dir, provider: 'p', model: 'm', thinking: 'off' } });
      await tick();
      await tick();
      const child = f.supervisor.list().find(x => x.parent_worker_id === w.worker_id)!;
      assert.ok(child);
      const delivered = f.supervisor.receipts.all.get('launch');
      assert.equal(delivered?.state, 'delivered');
      if (reported) await f.supervisor.report(child.worker_id, { ...bind(child, 'child-report'), task_id: 'launch', result_digest: 'sha256:claim' });
      const next = await f.restart(() => assert.fail('no replacement'));
      assert.equal(next.get(w.worker_id).fence?.command_id ?? null, reported ? null : 'launch');
      assert.deepEqual(next.receipts.all.get('launch'), delivered);
    } finally {
      f.cleanup();
    }
  });
}

test('cancel, interrupt and evidence reports allowed under fence without lifting it', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' });
    for (const interrupt of [false, true]) assert.equal((await f.supervisor.control(w.worker_id, bind(w, `control-${interrupt}`), interrupt)).state, 'delivered');
    assert.equal((await f.supervisor.report(w.worker_id, { ...bind(w, 'report'), task_id: 'task', result_digest: 'sha256:claim' })).state, 'delivered');
    assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'lost');
    assert.equal(f.hosts[0]!.commands.filter(c => c.type === 'clear_queue').length, 2);
  } finally {
    f.cleanup();
  }
});
