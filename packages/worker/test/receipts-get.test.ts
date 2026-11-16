/** `receipts.get` over B2: reads a stored receipt without redispatch; an unknown command id is never no_effect. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { Journal } from '../src/journal/journal.js';
import { ReceiptStore, type Receipt } from '../src/receipts/receipts.js';
import { ownerGrant, privateTmp, wireFixtures } from './helpers.js';

test('receipts.get: answers each wire fixture from the store, and an unknown command id is unknown, never no_effect', async () => {
  const tmp = privateTmp();
  const journal = new Journal(join(tmp.dir, 'journal'));
  try {
    const receipts = new ReceiptStore(journal);
    const owner = ownerGrant(tmp.dir);
    const memory = createMemoryTransport(createApp({ receipts, grants: owner.grants }).handle, owner.headers);
    const fixtures = wireFixtures().filter(f => f.operationId === 'receipts.get');
    assert.ok(fixtures.length >= 2);
    for (const { name, fixture } of fixtures) {
      if (fixture.response.status === 200) receipts.put(fixture.response.body as Receipt, 'receipt.result');
      if ((fixture.response.body as { error?: string }).error === 'receipt_expired') {
        // P1-12: a delivered receipt past the retention age, evicted by a compaction, leaves only its id.
        const id = fixture.request.path!.command_id!;
        const old = Date.now() - receipts.limits.minAgeMs - 1000;
        receipts.now = () => old;
        await receipts.run(id, 'sessions.prompt', {}, async () => ({ state: 'delivered', stage: 'forwarded', effect: 'observed' }));
        receipts.now = Date.now;
        assert.deepEqual(receipts.compact({ goal: { receipts: 0, bytes: 0 } }), [id], name);
      }
      const response = await memory.request('GET', `/b2/receipts/${encodeURIComponent(fixture.request.path!.command_id!)}`);
      assert.deepEqual(response, { status: fixture.response.status, body: fixture.response.body }, name);
    }
    const before = journal.records.length;
    await memory.request('GET', '/b2/receipts/cmd-1');
    assert.equal(journal.records.length, before, 'a read writes nothing');
  } finally {
    journal.close();
    tmp.cleanup();
  }
});
