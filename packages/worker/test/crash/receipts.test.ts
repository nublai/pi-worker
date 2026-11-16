/**
 * Receipts: the command flow, ProvenNoEffect, recovery buckets and capacity (ported from A0
 * `src/test/receipts.test.ts`), plus real SIGKILL cuts after every receipt fsync and after every native effect, with
 * an independent effect oracle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProvenNoEffect, Refusal } from '../../src/b2/errors.js';
import { Journal, parseJournal } from '../../src/journal/journal.js';
import { journalPath, openState } from '../../src/journal/state.js';
import { ReceiptStore, requestHash, type Receipt } from '../../src/receipts/receipts.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { COMMANDS, effectsAt } from './receipt-scenario.js';

function fixture() {
  const { root, cleanup } = tempRoot('receipts');
  const journal = new Journal(join(root, 'journal'));
  return {
    journal,
    store: new ReceiptStore(journal),
    cleanup: () => {
      journal.close();
      cleanup();
    },
  };
}

test('canonical idempotency ignores transport id, not operation content', () => {
  assert.equal(requestHash({ z: [1, { b: true, a: null }], request_id: 'one' }), requestHash({ request_id: 'two', z: [1, { a: null, b: true }] }));
  assert.notEqual(requestHash({ message: 'one' }), requestHash({ message: 'two' }));
});

test('intent and dispatch are durable before effect; duplicate attempts dispatch once', async () => {
  const f = fixture();
  try {
    let effects = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const effect = async () => {
      assert.equal(parseJournal(readFileSync(f.journal.file)).records.at(-1)?.value.state, 'intent');
      f.store.dispatch('id');
      effects++;
      await gate;
      return { state: 'delivered' as const, stage: 'forwarded' as const, effect: 'observed' as const };
    };
    const first = f.store.run('id', 'sessions.prompt', { message: 'same' }, effect);
    const second = f.store.run('id', 'sessions.prompt', { message: 'same' }, effect);
    release();
    assert.deepEqual(await first, await second);
    assert.equal(effects, 1);
    assert.deepEqual(await f.store.run('id', 'sessions.prompt', { message: 'same' }, effect), await first);
    assert.throws(() => f.store.run('id', 'sessions.prompt', { message: 'different' }, effect), /command_id_conflict/);
    assert.throws(() => f.store.run('id', 'workers.stop', { message: 'same' }, effect), /command_id_conflict/);
    assert.equal(parseJournal(readFileSync(f.journal.file)).records.at(-1)?.value.state, 'delivered');
  } finally {
    f.cleanup();
  }
});

test('refusal versus uncertain timeout, plus no eviction at capacity', async () => {
  const f = fixture();
  try {
    const no = await f.store.run('no', 'sessions.prompt', {}, async () => {
      throw new Refusal('no');
    });
    assert.equal(no.effect, 'no_effect');
    assert.equal(no.state, 'rejected');
    const unknown = await f.store.run('unknown', 'sessions.prompt', {}, async () => {
      f.store.dispatch('unknown');
      throw new Error('lost response');
    });
    assert.equal(unknown.state, 'outcome_unknown');
    assert.equal(unknown.effect, 'unknown');
    assert.equal(unknown.admission, undefined);
    const bounded = new ReceiptStore(f.journal, 2);
    await assert.rejects(
      bounded.run('third', 'sessions.prompt', {}, async () => ({})),
      /receipt_capacity/,
    );
    assert.equal(bounded.all.size, 2);
    for (const operation of ['sessions.resolve_unknown', 'executions.cancel', 'executions.interrupt', 'children.report'] as const) {
      const r = await bounded.run(operation, operation, {}, async () => {
        bounded.dispatch(operation);
        return { state: 'delivered', stage: 'resolved', effect: 'observed' };
      });
      assert.equal(r.state, 'delivered', `${operation} must bypass the ordinary count quota`);
    }
  } finally {
    f.cleanup();
  }
});

test('recovery separates undispatched intent from dispatch; neither is replayed', async () => {
  const f = fixture();
  try {
    const base = {
      operation: 'sessions.prompt' as const,
      request_hash: 'hash',
      stage: 'reserved' as const,
      effect: 'no_effect' as const,
      evidence: 'supervisor_journal_fsynced' as const,
      created_at: new Date().toISOString(),
    };
    f.store.put({ ...base, command_id: 'intent', state: 'intent' }, 'receipt.intent');
    f.store.put({ ...base, command_id: 'sent', state: 'accepted' }, 'receipt.dispatch');
    const recovered = new ReceiptStore(f.journal);
    recovered.recover();
    assert.equal(recovered.all.get('intent')?.effect, 'no_effect');
    assert.equal(recovered.all.get('intent')?.state, 'intent_recovered');
    const before = readFileSync(f.journal.file);
    recovered.recover();
    assert.deepEqual(readFileSync(f.journal.file), before);
    assert.throws(() => recovered.dispatch('intent'), /owner resolution/);
    assert.throws(() => recovered.update('sent', { state: 'delivered' }, 'receipt.result'), /receipt is final/);
    assert.equal(recovered.all.get('sent')?.state, 'outcome_unknown');
    assert.equal(recovered.all.get('sent')?.effect, 'unknown');
  } finally {
    f.cleanup();
  }
});

test('legacy intent_ready without an owner tombstone recovers as no_effect, not ready', () => {
  const f = fixture();
  try {
    f.store.put(
      {
        command_id: 'legacy-auto',
        operation: 'sessions.follow_up',
        worker_id: 'w',
        request_hash: 'hash',
        state: 'intent_ready',
        stage: 'recovery_pending',
        effect: 'no_effect',
        evidence: 'supervisor_journal_fsynced',
        created_at: 'fixture',
      },
      'receipt.resolve_intent',
    );
    const recovered = new ReceiptStore(f.journal);
    recovered.recover();
    assert.equal(recovered.all.get('legacy-auto')?.state, 'intent_recovered');
  } finally {
    f.cleanup();
  }
});

test('journal admission reserves full result room and never begins an effect without it', async () => {
  const { root, cleanup } = tempRoot('capacity');
  const journal = new Journal(join(root, 'journal'), 1024);
  try {
    const store = new ReceiptStore(journal);
    await assert.rejects(
      store.run('no-room', 'workers.create', {}, async () => {
        assert.fail('must not dispatch');
      }),
      /journal_result_capacity/,
    );
    assert.equal(journal.records.length, 0);
    assert.equal(journal.failed, false);
  } finally {
    journal.close();
    cleanup();
  }
});

test('receipts: a default Refusal after the dispatch record is outcome_unknown; only ProvenNoEffect is no_effect', async () => {
  const f = fixture();
  try {
    const refused = await f.store.run('refused-after-dispatch', 'sessions.prompt', {}, async () => {
      f.store.dispatch('refused-after-dispatch');
      throw new Refusal('host_said_no');
    });
    assert.equal(refused.state, 'outcome_unknown');
    assert.equal(refused.effect, 'unknown');
    const proven = await f.store.run('proven', 'sessions.prompt', {}, async () => {
      f.store.dispatch('proven');
      throw new ProvenNoEffect('host_refused', 'host_negative_ack');
    });
    assert.equal(proven.state, 'rejected');
    assert.equal(proven.effect, 'no_effect');
    assert.equal(proven.admission, 'rejected');
  } finally {
    f.cleanup();
  }
});

test('receipts: dispatchThen makes the dispatch marker durable before the write starts', async () => {
  const f = fixture();
  try {
    const r = await f.store.run('ordered', 'sessions.prompt', {}, async () => {
      await f.store.dispatchThen('ordered', { execution_id: 'x' }, async () => {
        const last = parseJournal(readFileSync(f.journal.file)).records.at(-1)!;
        assert.equal(last.value.state, 'accepted');
        assert.equal(last.value.execution_id, 'x');
      });
      return { state: 'delivered', stage: 'forwarded', effect: 'observed' };
    });
    assert.equal(r.state, 'delivered');
  } finally {
    f.cleanup();
  }
});

/**
 * Recovery oracle after a cut: buckets by pre-crash state, the independent effect file (an effect is never
 * `no_effect`), idempotent recovery and exact retries that return the stored receipt with no new effect.
 */
function checkRecovery(root: string): void {
  const pre = new Map<string, Receipt>();
  for (const r of parseJournal(readFileSync(journalPath(root))).records) if (r.kind === 'receipt') pre.set(String(r.value.command_id), r.value as Receipt);
  const state = openState(root);
  try {
    const store = new ReceiptStore(state.journal);
    store.recover();
    for (const r of pre.values()) {
      const got = store.all.get(r.command_id)!;
      if (['intent', 'queued', 'queue_ready', 'intent_recovered', 'intent_ready'].includes(r.state)) {
        assert.deepEqual([got.state, got.effect], ['intent_recovered', 'no_effect'], r.command_id);
      } else if (r.state === 'accepted') assert.deepEqual([got.state, got.effect], ['outcome_unknown', 'unknown'], r.command_id);
      else assert.deepEqual([got.state, got.effect], [r.state, r.effect], r.command_id);
    }
    const effects = effectsAt(root);
    for (const id of effects) {
      const r = store.all.get(id);
      assert.ok(r, `native effect ${id} needs a recovered receipt`);
      assert.notEqual(r.effect, 'no_effect', `native effect ${id} recovered ${r.state}/${r.effect}`);
    }
    assert.equal(new Set(effects).size, effects.length, 'no duplicate native effect');
    const bytes = readFileSync(journalPath(root));
    store.recover();
    assert.deepEqual(readFileSync(journalPath(root)), bytes, 'recovery is idempotent');
  } finally {
    state.close();
  }
}

async function checkRetries(root: string): Promise<void> {
  const state = openState(root);
  try {
    const store = new ReceiptStore(state.journal);
    store.recover();
    const before = effectsAt(root).length;
    for (const r of [...store.all.values()]) {
      const c = COMMANDS[r.command_id]!;
      assert.deepEqual(await store.run(c.command_id, c.operation, c.request, async () => assert.fail(`retry of ${c.command_id} replayed`)), r);
    }
    assert.equal(effectsAt(root).length, before);
  } finally {
    state.close();
  }
}

test('crash: SIGKILL after every receipt-scenario fsync recovers the right bucket with no replay', { timeout: 300_000 }, async () => {
  const base = tempRoot('receipts-base');
  let points: FsyncPoint[];
  try {
    const full = run('receipts', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    assert.deepEqual(effectsAt(base.root), ['sent', 'lost', 'cancel', 'queued', 'exit', 'hanging', 'pending']);
  } finally {
    base.cleanup();
  }
  assert.ok(points.length >= 35, `only ${points.length} fsyncs`);
  for (const point of points) {
    const cut = tempRoot('receipts-cut');
    try {
      cutAt('receipts', cut.root, point);
      checkRecovery(cut.root);
      await checkRetries(cut.root);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL right after every native effect finds an effect-bearing receipt (dispatch marker before write)', { timeout: 120_000 }, async () => {
  for (let effect = 1; effect <= 7; effect++) {
    const cut = tempRoot('receipts-effect');
    try {
      const killed = run('receipts', cut.root, undefined, { PIW_CRASH_EFFECT: String(effect) });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      assert.equal(effectsAt(cut.root).length, effect);
      checkRecovery(cut.root);
      await checkRetries(cut.root);
    } finally {
      cut.cleanup();
    }
  }
});
