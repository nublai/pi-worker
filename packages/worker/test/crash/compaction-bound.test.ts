/**
 * Retention bound (P1-12): 10,000 receipts on a test journal with the default limits, read from `hello` over B2, never
 * take the journal past `journal_max_bytes` or the store past `receipts_max`; no command is refused for capacity;
 * every unresolved `outcome_unknown` is retained; every evicted command id reads `receipt_expired` (unknown) and its
 * reuse never runs again; a restart reads back the same retained receipts and expired ids. Real fsyncs throughout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { createApp } from '../../src/b2/app.js';
import { createMemoryTransport } from '../../src/b2/memory.js';
import { Refusal } from '../../src/b2/errors.js';
import { journalPath, openState } from '../../src/journal/state.js';
import { ReceiptStore, type Operation, type Receipt } from '../../src/receipts/receipts.js';
import { ownerGrant } from '../helpers.js';
import { tempRoot } from './harness.js';

type Limits = { journal_max_bytes: number; receipts_max: number; receipt_retention_min_seconds: number; receipt_expired_ids_max: number };

const TOTAL = 10_000;
/** Control and recovery operations (the contract's list of what a count quota never blocks). */
const CONTROL: Operation[] = ['workers.stop', 'executions.cancel', 'executions.interrupt', 'sessions.resolve_unknown', 'children.report'];

test('retention: 10,000 receipts stay within the journal and receipt bounds hello advertises; unresolved unknowns stay', { timeout: 1_800_000 }, async () => {
  const { root, cleanup } = tempRoot('bound');
  let state = openState(root);
  let receipts = new ReceiptStore(state.journal);
  try {
    const owner = ownerGrant(root);
    const read = (store: ReceiptStore) => createMemoryTransport(createApp({ receipts: store, grants: owner.grants }).handle, owner.headers);
    const hello = await read(receipts).request('GET', '/b2/hello');
    assert.equal(hello.status, 200);
    const limits = (hello.body as { limits: Limits }).limits;
    // A clock one second per command: receipts reach the retention age while the run goes on.
    let clock = Date.parse('2026-11-16T00:00:00Z');
    receipts.now = () => clock;
    const outcome = new Map<string, Receipt>();
    const unknowns: string[] = [];
    const request = (i: number) => ({ worker_id: 'bound-worker', n: i });
    const run = (i: number): Promise<Receipt> => {
      const id = `cmd-${i}`;
      if (i % 250 === 249) {
        unknowns.push(id);
        return receipts.run(id, 'sessions.prompt', request(i), async () => {
          receipts.dispatch(id);
          throw new Error('lost reply');
        });
      }
      if (i % 10 === 5) {
        return receipts.run(id, CONTROL[(i / 10) % CONTROL.length | 0]!, request(i), async () => {
          receipts.dispatch(id);
          return { state: 'delivered', stage: 'forwarded', effect: 'observed' };
        });
      }
      if (i % 2 === 0) {
        return receipts.run(id, 'sessions.prompt', request(i), async () => {
          throw new Refusal('worker_busy');
        });
      }
      return receipts.run(id, 'sessions.prompt', request(i), async () => {
        receipts.dispatch(id);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed' };
      });
    };
    let peakBytes = 0;
    let peakCount = 0;
    for (let i = 0; i < TOTAL; i++) {
      clock += 1000;
      const r = await run(i); // A capacity refusal would throw here.
      outcome.set(r.command_id, r);
      peakBytes = Math.max(peakBytes, statSync(journalPath(root)).size);
      peakCount = Math.max(peakCount, receipts.all.size);
      assert.ok(peakBytes <= limits.journal_max_bytes, `journal ${peakBytes} B within journal_max_bytes after ${i + 1} commands`);
      assert.ok(peakCount <= limits.receipts_max, `${peakCount} receipts within receipts_max after ${i + 1} commands`);
      assert.equal(state.journal.failed, false);
    }
    console.log(JSON.stringify({ receipts: TOTAL, peak_journal_bytes: peakBytes, peak_retained: peakCount, retained: receipts.all.size, expired: receipts.expired.size, limits }));
    assert.ok(receipts.expired.size > 0, 'retention evicted receipts');
    for (const id of unknowns) assert.equal(receipts.all.get(id)?.state, 'outcome_unknown', `unresolved ${id} is never evicted`);
    // Every command reads back as its stored receipt or as expired (unknown); a reuse of an evicted id never runs.
    const check = async (store: ReceiptStore) => {
      const b2 = read(store);
      for (let i = 0; i < TOTAL; i++) {
        const id = `cmd-${i}`;
        const got = await b2.request('GET', `/b2/receipts/${id}`);
        if (store.all.has(id)) assert.deepEqual(got, { status: 200, body: outcome.get(id) }, id);
        else {
          assert.deepEqual(got, { status: 409, body: { error: 'receipt_expired', effect: 'unknown', uncertain_command_id: id } }, id);
          if (i % 97 === 0) {
            assert.throws(
              () => store.run(id, outcome.get(id)!.operation, request(i), async () => assert.fail(`evicted ${id} ran again`)),
              (e: unknown) => e instanceof Refusal && e.message === 'receipt_expired' && e.effect === 'unknown',
            );
          }
        }
      }
    };
    await check(receipts);
    const retained = [...receipts.all.keys()];
    const expired = [...receipts.expired.keys()];
    state.close();
    state = openState(root);
    receipts = new ReceiptStore(state.journal);
    assert.deepEqual([...receipts.all.keys()], retained, 'a restart reads back the retained receipts');
    assert.deepEqual([...receipts.expired.keys()], expired, 'and the expired ids');
    await check(receipts);
    assert.ok(statSync(journalPath(root)).size <= limits.journal_max_bytes);
  } finally {
    state.close();
    cleanup();
  }
});
