/**
 * Retention evidence (PR #12 review fixes): what a compaction must keep so that nothing it forgets changes a decision.
 * - F1: a command id the worker may have admitted never runs again, also after its `receipt_expired` id rolled over:
 *   the forgotten-ids horizon refuses it `command_id_beyond_retention` (`no_effect`).
 * - F3: the report that discharges a child's launch (its task, its channel) is kept with the launch it discharges, so
 *   recovery from a compacted journal reaches the same fence decision as from the journal it replaced.
 * - F4: the resume catalog (every session a worker ever bound, with its file and owner) survives compaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { Refusal } from '../src/b2/errors.js';
import { Journal } from '../src/journal/journal.js';
import { DEFAULT_RETENTION } from '../src/journal/retention.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import { bind, fixture, tick } from './supervisor-fixture.js';
import { ownerGrant, privateTmp } from './helpers.js';

const HOUR = 60 * 60 * 1000;

/** A UUIDv7 (RFC 9562) command id issued at `ms`. */
export function uuidv7(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0') + randomBytes(10).toString('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const beyond = (e: unknown) => e instanceof Refusal && e.message === 'command_id_beyond_retention' && e.effect === 'no_effect';

test('retention: an exact retry after its expired id rolled over is refused no_effect and never runs again (review F1)', async () => {
  const f = fixture({ receiptCap: 4, retention: { expiredIds: 2, minAgeMs: 0 } });
  try {
    const owner = ownerGrant(f.dir);
    const b2 = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const w = await f.create();
    const prompt = (body: Record<string, unknown>) => b2.request('POST', `/b2/workers/${w.worker_id}/prompt`, { json: body });
    const settle = async () => {
      f.hosts[0]!.emit('event', { type: 'agent_settled' });
      await tick();
    };
    const evict = () => f.supervisor.receipts.compact({ goal: { receipts: 0, bytes: 0 } });
    for (const id of ['once', uuidv7(Date.now())]) {
      const original = { ...bind(f.supervisor.get(w.worker_id), id), message: 'same' };
      assert.equal((await prompt(original)).status, 200);
      await settle();
      assert.ok(evict().includes(id));
      assert.deepEqual((await prompt(original)).body, { error: 'receipt_expired', effect: 'unknown', uncertain_command_id: id }, 'a retry before the rollover');
      // Two later commands are evicted after it: its expired id rolls over (receipt_expired_ids_max is 2).
      for (const later of [uuidv7(Date.now() + 1), uuidv7(Date.now() + 2)]) {
        assert.equal((await prompt({ ...bind(f.supervisor.get(w.worker_id), later), message: later })).status, 200);
        await settle();
        evict();
      }
      assert.ok(!f.supervisor.receipts.expired.has(id), 'the expired id rolled over');
      const before = f.hosts[0]!.prompts;
      const records = f.state.journal.records.length;
      const retry = await prompt(original);
      assert.deepEqual([retry.status, retry.body], [409, { error: 'command_id_beyond_retention', effect: 'no_effect' }], `an exact retry of ${id} after the rollover`);
      assert.equal(f.hosts[0]!.prompts, before, 'the forgotten command never reaches pi again');
      assert.equal(f.state.journal.records.length, records, 'the refusal wrote nothing');
    }
    // A fresh UUIDv7 id still runs; a fresh id that is not a UUIDv7 cannot be told from a forgotten one.
    assert.equal((await prompt({ ...bind(f.supervisor.get(w.worker_id), uuidv7(Date.now() + 10)), message: 'fresh' })).status, 200);
    await settle();
    assert.deepEqual((await prompt({ ...bind(f.supervisor.get(w.worker_id), 'fresh-but-untimed'), message: 'fresh' })).body, { error: 'command_id_beyond_retention', effect: 'no_effect' });
    // The horizon survives a restart.
    const restarted = await f.restart();
    await assert.rejects(restarted.prompt(w.worker_id, { ...bind(restarted.get(w.worker_id), 'once'), message: 'same' }), beyond);
  } finally {
    f.cleanup();
  }
});

test('retention: at the default receipt_expired_ids_max an exact retry of a rolled-over id is refused (review F1, seeded tombstones)', async () => {
  const tmp = privateTmp();
  const journal = new Journal(join(tmp.dir, 'journal'));
  try {
    const receipts = new ReceiptStore(journal);
    assert.equal(receipts.limits.expiredIds, DEFAULT_RETENTION.expiredIds);
    let clock = Date.parse('2026-11-16T00:00:00Z');
    receipts.now = () => clock;
    let runs = 0;
    const effect = async () => {
      runs++;
      return { state: 'delivered' as const, stage: 'forwarded' as const, effect: 'observed' as const };
    };
    const once = uuidv7(clock);
    await receipts.run(once, 'sessions.prompt', { message: 'same' }, effect);
    clock += 2 * HOUR;
    assert.deepEqual(receipts.compact({ goal: { receipts: 0, bytes: 0 } }), [once]);
    // The seam: exactly the default number of newer expired ids, written in one compacted journal.
    const seeded = Array.from({ length: DEFAULT_RETENTION.expiredIds }, (_, i) => ({
      kind: 'receipt_expired' as const,
      value: { command_id: uuidv7(clock + i), operation: 'sessions.prompt', request_hash: 'h' },
    }));
    journal.compact([...journal.records.map(r => ({ kind: r.kind, value: r.value })), ...seeded]);
    assert.equal(receipts.expired.size, DEFAULT_RETENTION.expiredIds + 1);
    assert.throws(() => receipts.run(once, 'sessions.prompt', { message: 'same' }, effect), /receipt_expired/);
    // One more eviction: the oldest expired id, `once`, is the one forgotten.
    const next = uuidv7(clock + DEFAULT_RETENTION.expiredIds + 1);
    await receipts.run(next, 'sessions.prompt', { message: 'next' }, effect);
    clock += 2 * HOUR;
    receipts.compact({ goal: { receipts: 0, bytes: 0 } });
    assert.equal(receipts.expired.size, DEFAULT_RETENTION.expiredIds);
    assert.ok(!receipts.expired.has(once), 'the default boundary rolled the id over');
    assert.throws(() => receipts.run(once, 'sessions.prompt', { message: 'same' }, effect), beyond);
    assert.equal(runs, 2, 'the forgotten command never runs again');
    assert.equal((await receipts.run(uuidv7(clock), 'sessions.prompt', { message: 'fresh' }, effect)).state, 'delivered', 'a fresh id after the horizon runs');
  } finally {
    journal.close();
    tmp.cleanup();
  }
});

for (const compacted of [false, true]) {
  test(`retention: an untyped child's discharging report survives a later report for another task${compacted ? ' and a compaction' : ''}; recovery adds no parent fence (review F3)`, async () => {
    const f = fixture();
    try {
      const owner = ownerGrant(f.dir);
      const b2 = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
      const parent = await f.create();
      await f.supervisor.prompt(parent.worker_id, { ...bind(parent, 'run'), message: 'x' });
      const running = f.supervisor.get(parent.worker_id);
      const cwd = join(f.dir, 'child');
      mkdirSync(cwd);
      await f.supervisor.launchChild(parent.worker_id, { ...bind(running, 'launch'), execution_id: running.execution!.execution_id, launch: { command_id: 'child-create', cwd, provider: 'p', model: 'm', thinking: 'off' } });
      f.hosts[0]!.emit('event', { type: 'agent_settled' });
      for (let i = 0; i < 6; i++) await tick();
      const child = f.supervisor.list().find(w => w.parent_worker_id === parent.worker_id)!;
      assert.ok(child, 'the child launched');
      const report = (id: string, task: string) =>
        b2.request('POST', `/b2/workers/${child.worker_id}/report`, { json: { ...bind(f.supervisor.get(child.worker_id), id), task_id: task, result_digest: 'sha256:claim', kind: 'result', message: 'done' } });
      assert.equal((await report('valid-report', 'launch')).status, 200, 'the report for the launch task');
      assert.equal((await report('other-report', 'another-task')).status, 200, 'a later report for another task');
      if (compacted) {
        const later = Date.now() + 2 * HOUR;
        f.supervisor.receipts.now = () => later;
        f.supervisor.receipts.compact({ goal: { receipts: 0, bytes: 0 } });
      }
      assert.ok(f.supervisor.receipts.all.has('valid-report'), 'the discharging report is retained');
      const recovered = await f.restart();
      assert.deepEqual(recovered.get(parent.worker_id).fence?.uncertain_command_ids ?? [], [], 'recovery adds no parent fence');
    } finally {
      f.cleanup();
    }
  });
}

for (const compacted of [false, true]) {
  test(`retention: the resume catalog keeps every session a worker bound across a restart${compacted ? ' and a compaction' : ''} (review F4)`, async () => {
    const f = fixture();
    try {
      const w = await f.create();
      const first = w.session_id!;
      await f.supervisor.newSession(w.worker_id, bind(w, 'fresh'));
      const second = f.supervisor.get(w.worker_id).session_id!;
      assert.notEqual(first, second);
      if (compacted) f.supervisor.receipts.compact({ rewrite: true });
      const recovered = await f.restart();
      assert.deepEqual(
        [...recovered.state.sessionFiles.entries()].map(([id, e]) => [id, e.worker_id]).sort(),
        [
          [first, w.worker_id],
          [second, w.worker_id],
        ].sort(),
        'both sessions are known resume targets, owned by the worker that bound them',
      );
    } finally {
      f.cleanup();
    }
  });
}
