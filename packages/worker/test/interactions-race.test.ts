/**
 * Answer races (P1-10): ported from A0 `src/test/gate1-sibling.test.ts` and `src/test/binding-answer-race.test.ts`
 * with every assertion. A0's held `answerUI` is the fixture host's `answerUI` hook (the child's `answer_ui` reply), and
 * A0's `cancelUI` is an `answer_ui` cancel recorded in `host.cancelled`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import type { Answer } from '../src/interactions/interactions.js';
import type { PiRecord } from '../src/host/host.js';
import { bind, fixture, tick } from './supervisor-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const event of ['agent_settled', 'tool_execution_end']) {
  for (const kind of ['input', 'tool_approval'] as const) {
    test(`interactions: sibling ${event} does not invalidate an accepted ${kind} answer`, async () => {
      const f = fixture();
      try {
        const w = await f.create();
        const h = f.hosts[0]!;
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>(r => {
          release = r;
        });
        const waiting = new Promise<void>(r => {
          entered = r;
        });
        h.answerUI = async () => {
          entered();
          await held;
          return { consumed: true, outcome: 'answered' };
        };
        h.emit('event', { type: 'extension_ui_request', method: kind, id: 'answering' });
        h.emit('event', { type: 'extension_ui_request', method: 'input', id: 'sibling' });
        const i = f.supervisor.interactionList(w.worker_id).find(x => x.native_id === 'answering')!;
        const a: Answer = { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind, outcome: 'answer', value: kind === 'input' ? 'fixture' : true };
        const pending = f.supervisor.answer(w.worker_id, a);
        await waiting;
        h.emit('event', { type: event });
        release();
        const result = await pending;
        assert.equal(result.state, 'delivered');
        assert.equal(result.answer_stage, 3);
        assert.equal(f.supervisor.get(w.worker_id).fence, null);
        assert.equal(f.supervisor.get(w.worker_id).binding_revision, 1);
        assert.deepEqual(
          f.supervisor.interactionList(w.worker_id).map(x => x.native_id),
          ['sibling'],
          'native resolver lifecycle, not unrelated settlement, owns closure',
        );
        assert.deepEqual(await f.supervisor.answer(w.worker_id, a), result);
      } finally {
        f.cleanup();
      }
    });
  }
}

const approval = () => ({ gate_token: 'gate', digest: 'digest', policy_revision: 'p1', expiry: Date.now() + 30000, operation: 'bash', resource: 'fixture', environment: 'fixture', offered_scope: 'once' });

for (const kind of ['input', 'tool_approval'] as const) {
  for (const consumed of [false, true]) {
    test(`interactions: in-flight ${kind}, consumed=${consumed}: navigate cancels accepted resolver and refuses stale success`, async () => {
      const f = fixture();
      try {
        const w = await f.create();
        const h = f.hosts[0]!;
        const entered = deferred<void>();
        const release = deferred<void>();
        h.answerUI = async () => {
          entered.resolve();
          await release.promise;
          return { consumed, outcome: consumed ? 'answered' : 'aborted' };
        };
        appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: [] } })}\n`);
        const gate = approval();
        h.emit('event', { type: 'extension_ui_request', method: kind, id: 'native', approval: gate });
        const i = f.supervisor.interactionList(w.worker_id)[0]!;
        const a: Answer = { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind, outcome: 'answer', value: kind === 'input' ? 'synthetic' : true };
        const pending = f.supervisor.answer(w.worker_id, a);
        await entered.promise;
        const before = f.supervisor.get(w.worker_id);
        let cancelledBeforeMove = false;
        h.before = c => {
          if (c.type === 'navigate') cancelledBeforeMove = h.cancelled.includes('native');
        };
        const nav = await f.supervisor.rebind(w.worker_id, { ...bind(before, 'nav'), action: 'navigate', entry_id: 'entry', source_leaf_id: before.leaf_id });
        release.resolve();
        const receipt = await pending;
        assert.equal(nav.state, 'delivered');
        assert.equal(f.supervisor.get(w.worker_id).binding_revision, 2);
        assert.equal(cancelledBeforeMove, true, 'cancelUI must include accepted interactions before navigate');
        assert.equal(receipt.state, consumed ? 'outcome_unknown' : 'rejected');
        assert.equal(receipt.effect, consumed ? 'unknown' : 'no_effect');
        assert.ok((receipt.answer_stage ?? 0) < 3);
        assert.equal(Boolean(f.supervisor.get(w.worker_id).fence), consumed);
        assert.ok(
          !f.state.journal.records.some(r => r.kind === 'interaction' && r.value.interaction_id === i.interaction_id && Number(r.value.answer_stage) >= 3),
          'no stale stage-3 journal record',
        );
        assert.deepEqual(await f.supervisor.answer(w.worker_id, a), receipt, 'duplicate never replays');
        if (kind === 'tool_approval') {
          h.emit('event', { type: 'gate_check', ...gate });
          await tick();
          await tick();
          assert.equal(f.supervisor.get(w.worker_id).status, 'ready', 'late cancelled gate is not a worker fault');
          assert.equal(
            h.commands.some(c => c.type === 'gate_release'),
            false,
          );
        }
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const change of ['epoch', 'fence', 'rebinding'] as const) {
  test(`interactions: in-flight answer rechecks ${change} even without a revision move`, async () => {
    const f = fixture();
    try {
      const w = await f.create();
      const h = f.hosts[0]!;
      const entered = deferred<void>();
      const release = deferred<void>();
      h.answerUI = async () => {
        entered.resolve();
        await release.promise;
        return { consumed: true, outcome: 'answered' };
      };
      h.emit('event', { type: 'extension_ui_request', method: 'input', id: 'native' });
      const i = f.supervisor.interactionList(w.worker_id)[0]!;
      const pending = f.supervisor.answer(w.worker_id, { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind: 'input', outcome: 'answer', value: 'synthetic' });
      await entered.promise;
      const live = f.supervisor.state.require(w.worker_id);
      if (change === 'epoch') live.worker.worker_epoch = 'replacement';
      if (change === 'fence') live.worker.fence_generation = 1; // A fence appeared and was resolved while awaiting.
      if (change === 'rebinding') live.rebinding = true;
      release.resolve();
      const r = await pending;
      assert.equal(r.state, 'outcome_unknown');
      assert.equal(r.effect, 'unknown');
      assert.ok(live.worker.fence);
      assert.ok((r.answer_stage ?? 0) < 3);
    } finally {
      f.cleanup();
    }
  });
}

test('interactions: already-consumed approval is cancelled by navigate; late gate check does not fault or release', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: [] } })}\n`);
    const gate = approval();
    h.emit('event', { type: 'extension_ui_request', method: 'tool_approval', id: 'native', approval: gate });
    const i = f.supervisor.interactionList(w.worker_id)[0]!;
    await f.supervisor.answer(w.worker_id, { ...bind(w, 'answer'), answer_id: 'answer', interaction_id: i.interaction_id, revision: 1, kind: 'tool_approval', outcome: 'answer', value: true });
    const before = f.supervisor.get(w.worker_id);
    await f.supervisor.rebind(w.worker_id, { ...bind(before, 'nav'), action: 'navigate', entry_id: 'entry', source_leaf_id: before.leaf_id });
    h.emit('event', { type: 'gate_check', ...gate } as PiRecord);
    await tick();
    await tick();
    assert.ok(h.cancelled.includes('native'));
    assert.equal(f.supervisor.get(w.worker_id).status, 'ready');
    assert.equal(
      h.commands.some(c => c.type === 'gate_release'),
      false,
    );
  } finally {
    f.cleanup();
  }
});
