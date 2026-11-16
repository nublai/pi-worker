/**
 * Retention (P1-12): the count quota never blocks control and recovery; the journal's control reserve is theirs; what
 * compaction keeps (unresolved unknowns, lineage, a worker's create, in-flight commands) and evicts (old final
 * receipts, oldest first), and that an evicted id is refused `receipt_expired` and never runs again. `hello` states the
 * limits the store enforces. The crash cuts and the 10,000-receipt bound are in `crash/compaction*.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { Refusal } from '../src/b2/errors.js';
import { Journal } from '../src/journal/journal.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import { bind, fixture, tick } from './supervisor-fixture.js';
import { ownerGrant, privateTmp } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const delivered = async () => ({ state: 'delivered' as const, stage: 'forwarded' as const, effect: 'observed' as const });
const expired = (id: string) => (e: unknown) => e instanceof Refusal && e.message === 'receipt_expired' && e.effect === 'unknown' && e.uncertain_command_id === id;

function store(options: { maxBytes?: number; cap?: number; reserve?: number } = {}) {
  const tmp = privateTmp();
  const journal = new Journal(join(tmp.dir, 'journal'), options.maxBytes);
  const receipts = new ReceiptStore(journal, options.cap, undefined, options.reserve === undefined ? {} : { controlReserveBytes: options.reserve });
  return {
    tmp,
    journal,
    receipts,
    cleanup() {
      journal.close();
      tmp.cleanup();
    },
  };
}

test('retention: stop, cancel, interrupt, resolve_unknown and child reports are never blocked by the count quota', async () => {
  const f = fixture({ receiptCap: 6 });
  try {
    const a = await f.create();
    const b = await f.create();
    f.hosts[1]!.failure = true;
    assert.equal((await f.supervisor.prompt(b.worker_id, { ...bind(b, 'b-lost'), message: 'x' })).state, 'outcome_unknown');
    for (let i = 0; f.supervisor.receipts.all.size < 6; i++) {
      await f.supervisor.prompt(a.worker_id, { ...bind(a, `a-${i}`), message: 'x' });
      f.hosts[0]!.emit('event', { type: 'agent_settled' });
      await tick();
    }
    // Every receipt is young: nothing is evictable, so an ordinary command is refused before anything is written.
    const before = f.state.journal.records.length;
    await assert.rejects(f.supervisor.prompt(a.worker_id, { ...bind(a, 'one-too-many'), message: 'x' }), /receipt_capacity/);
    assert.equal(f.state.journal.records.length, before);
    const run = await f.supervisor.prompt(a.worker_id, { ...bind(a, 'a-0'), message: 'x' });
    assert.equal(run.state, 'delivered', 'a duplicate still reads its receipt at capacity');
    await f.supervisor.prompt(a.worker_id, { ...bind(a, 'a-0'), message: 'x' });
    const fenced = f.supervisor.get(b.worker_id);
    const results = [
      await f.supervisor.control(a.worker_id, bind(a, 'cancel'), false),
      await f.supervisor.control(a.worker_id, bind(a, 'interrupt'), true),
      await f.supervisor.resolveUnknown(b.worker_id, { ...bind(fenced, 'resolve'), uncertain_command_id: 'b-lost', fence_generation: fenced.fence!.fence_generation, disposition: 'abandon' }),
      await f.supervisor.report(a.worker_id, { ...bind(a, 'report'), task_id: 'task', result_digest: 'sha256:claim' }),
      await f.supervisor.stop(a.worker_id, bind(a, 'stop-a')),
      await f.supervisor.stop(b.worker_id, bind(f.supervisor.get(b.worker_id), 'stop-b')),
    ];
    assert.deepEqual(
      results.map(r => [r.command_id, r.state]),
      ['cancel', 'interrupt', 'resolve', 'report', 'stop-a', 'stop-b'].map(id => [id, 'delivered']),
      'control and recovery commands run past the count quota',
    );
  } finally {
    f.cleanup();
  }
});

test('retention: an ordinary command is refused before the control reserve; control commands may use it', async () => {
  const s = store({ maxBytes: 160 * 1024, reserve: 48 * 1024 });
  try {
    let n = 0;
    for (;; n++) {
      try {
        await s.receipts.run(`fill-${n}`, 'sessions.prompt', { n }, async () => {
          s.receipts.dispatch(`fill-${n}`);
          return { state: 'delivered', stage: 'forwarded', effect: 'observed' };
        });
      } catch (error) {
        assert.ok(error instanceof Refusal && error.message === 'journal_result_capacity' && error.effect === 'no_effect', String(error));
        break;
      }
      assert.ok(n < 10_000, 'the journal fills');
    }
    const room = s.journal.maxBytes - s.journal.size();
    assert.ok(room > 48 * 1024 - 17 * 1024, `an ordinary command stopped short of the control reserve (${room} B left)`);
    for (const operation of ['workers.stop', 'executions.cancel', 'executions.interrupt', 'sessions.resolve_unknown', 'children.report'] as const) {
      const r = await s.receipts.run(operation, operation, {}, async () => {
        s.receipts.dispatch(operation);
        return { state: 'delivered', stage: 'resolved', effect: 'observed' };
      });
      assert.equal(r.state, 'delivered', `${operation} runs inside the control reserve`);
    }
    assert.equal(s.journal.failed, false);
    assert.ok(s.journal.size() <= s.journal.maxBytes);
  } finally {
    s.cleanup();
  }
});

test('retention: compaction never evicts an unresolved outcome_unknown or a young receipt; it evicts old final ones, oldest first', async () => {
  const s = store();
  try {
    let clock = Date.parse('2026-11-16T00:00:00Z');
    s.receipts.now = () => clock;
    await s.receipts.run('old-delivered', 'sessions.prompt', { w: 1 }, delivered);
    await s.receipts.run('old-rejected', 'sessions.prompt', { w: 2 }, async () => {
      throw new Refusal('worker_busy');
    });
    await s.receipts.run('old-unknown', 'sessions.prompt', { worker_id: 'w', w: 3 }, async () => {
      s.receipts.dispatch('old-unknown');
      throw new Error('lost reply');
    });
    clock += 2 * HOUR;
    await s.receipts.run('young', 'sessions.prompt', { w: 4 }, delivered);
    assert.deepEqual(s.receipts.compact({ goal: { receipts: 0, bytes: 0 } }), ['old-delivered', 'old-rejected'], 'old final receipts, oldest first');
    assert.deepEqual([...s.receipts.all.keys()], ['old-unknown', 'young']);
    assert.equal(s.receipts.all.get('old-unknown')?.state, 'outcome_unknown', 'an unresolved outcome_unknown is never evicted');
    assert.deepEqual([...s.receipts.expired.keys()], ['old-delivered', 'old-rejected']);
    // The compacted journal is what a restart reads.
    s.journal.close();
    const reopened = new Journal(s.journal.file);
    try {
      const again = new ReceiptStore(reopened);
      assert.deepEqual([...again.all.keys()], ['old-unknown', 'young']);
      assert.deepEqual([...again.expired.keys()], ['old-delivered', 'old-rejected']);
    } finally {
      reopened.close();
    }
  } finally {
    s.tmp.cleanup();
  }
});

test('retention: a resolved outcome_unknown may be evicted once old; the unresolved one beside it stays', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost-1'), message: 'x' });
    f.hosts[0]!.failure = true;
    const fenced = f.supervisor.get(w.worker_id);
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    await tick();
    await f.supervisor.resolveUnknown(w.worker_id, { ...bind(fenced, 'resolve-1'), uncertain_command_id: 'lost-1', fence_generation: fenced.fence!.fence_generation, disposition: 'abandon' });
    const free = f.supervisor.get(w.worker_id);
    await f.supervisor.prompt(w.worker_id, { ...bind(free, 'lost-2'), message: 'x' });
    assert.equal(f.supervisor.receipts.all.get('lost-2')?.state, 'outcome_unknown');
    const later = Date.now() + 2 * HOUR;
    f.supervisor.receipts.now = () => later;
    const evicted = f.supervisor.receipts.compact({ goal: { receipts: 0, bytes: 0 } });
    assert.ok(evicted.includes('lost-1'), 'the resolved unknown is evictable');
    assert.ok(!evicted.includes('lost-2') && f.supervisor.receipts.all.get('lost-2')?.state === 'outcome_unknown', 'the unresolved unknown stays');
    assert.ok(f.supervisor.receipts.all.has(f.supervisor.get(w.worker_id).fence!.command_id), 'the fence names a retained receipt');
  } finally {
    f.cleanup();
  }
});

test('retention: a worker keeps the receipt that created it and a child its launch; a live execution keeps its command', async () => {
  const f = fixture();
  try {
    const parent = await f.create();
    await f.supervisor.prompt(parent.worker_id, { ...bind(parent, 'run'), message: 'x' });
    const running = f.supervisor.get(parent.worker_id);
    const cwd = join(f.dir, 'child');
    mkdirSync(cwd);
    await f.supervisor.launchChild(parent.worker_id, { ...bind(running, 'launch'), execution_id: running.execution!.execution_id, launch: { command_id: 'child-create', cwd, provider: 'p', model: 'm', thinking: 'off' } });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    for (let i = 0; i < 6; i++) await tick();
    const child = f.supervisor.list().find(w => w.parent_worker_id === parent.worker_id);
    assert.ok(child, 'the child launched');
    await f.supervisor.prompt(child.worker_id, { ...bind(child, 'child-run'), message: 'x' });
    const later = Date.now() + 2 * HOUR;
    f.supervisor.receipts.now = () => later;
    const evicted = f.supervisor.receipts.compact({ goal: { receipts: 0, bytes: 0 } });
    assert.ok(evicted.includes('run'), 'a settled prompt is evictable');
    for (const id of ['create-0', 'child-create', 'launch', 'child-run']) assert.ok(f.supervisor.receipts.all.has(id), `${id} is retained`);
  } finally {
    f.cleanup();
  }
});

test('retention: a reused evicted command id is refused receipt_expired (unknown) and never runs; a changed request is a conflict', async () => {
  const s = store();
  try {
    let clock = Date.parse('2026-11-16T00:00:00Z');
    s.receipts.now = () => clock;
    let runs = 0;
    const effect = async () => {
      runs++;
      return { state: 'delivered' as const, stage: 'forwarded' as const, effect: 'observed' as const };
    };
    await s.receipts.run('once', 'sessions.prompt', { message: 'same' }, effect);
    clock += 2 * HOUR;
    assert.deepEqual(s.receipts.compact({ goal: { receipts: 0, bytes: 0 } }), ['once']);
    const records = s.journal.records.length;
    assert.throws(() => s.receipts.run('once', 'sessions.prompt', { message: 'same' }, effect), expired('once'));
    assert.throws(() => s.receipts.run('once', 'sessions.prompt', { message: 'different' }, effect), /command_id_conflict/);
    assert.equal(runs, 1, 'the evicted command never runs again');
    assert.equal(s.journal.records.length, records, 'the refusals wrote nothing');
    const owner = ownerGrant(s.tmp.dir);
    const b2 = createMemoryTransport(createApp({ receipts: s.receipts, grants: owner.grants }).handle, owner.headers);
    assert.deepEqual(await b2.request('GET', '/b2/receipts/once'), { status: 409, body: { error: 'receipt_expired', effect: 'unknown', uncertain_command_id: 'once' } });
  } finally {
    s.cleanup();
  }
});

test('retention: the oldest expired ids are forgotten beyond receipt_expired_ids_max', async () => {
  const tmp = privateTmp();
  const journal = new Journal(join(tmp.dir, 'journal'));
  try {
    const receipts = new ReceiptStore(journal, undefined, undefined, { expiredIds: 2 });
    let clock = Date.parse('2026-11-16T00:00:00Z');
    receipts.now = () => clock;
    for (const id of ['r1', 'r2', 'r3']) await receipts.run(id, 'sessions.prompt', { id }, delivered);
    clock += 2 * HOUR;
    receipts.compact({ goal: { receipts: 0, bytes: 0 } });
    assert.deepEqual([...receipts.expired.keys()], ['r2', 'r3']);
  } finally {
    journal.close();
    tmp.cleanup();
  }
});

test('retention: hello states the limits the receipt store enforces', async () => {
  const s = store({ maxBytes: 2 * 1024 * 1024, cap: 64, reserve: 128 * 1024 });
  try {
    const owner = ownerGrant(s.tmp.dir);
    const hello = await createMemoryTransport(createApp({ receipts: s.receipts, grants: owner.grants }).handle, owner.headers).request('GET', '/b2/hello');
    const limits = (hello.body as { limits: Record<string, number> }).limits;
    assert.deepEqual(
      [limits.journal_max_bytes, limits.journal_control_reserve_bytes, limits.receipts_max, limits.receipt_retention_min_seconds, limits.receipt_expired_ids_max],
      [2 * 1024 * 1024, 128 * 1024, 64, 3600, 16384],
    );
  } finally {
    s.cleanup();
  }
});

test('retention: a journal past half its bound is compacted when it opens, before recovery writes; the supervisor id stays', async () => {
  const tmp = privateTmp();
  try {
    // Written under a larger bound, reopened under one it is past half of.
    let state = openState(tmp.dir, { maxBytes: 1024 * 1024 });
    const id = state.supervisorId;
    const receipts = new ReceiptStore(state.journal, undefined, undefined, { controlReserveBytes: 16 * 1024 });
    for (let i = 0; state.journal.size() < 128 * 1024; i++) {
      await receipts.run(`r-${i}`, 'sessions.prompt', { i }, async () => {
        receipts.dispatch(`r-${i}`);
        return { state: 'delivered', stage: 'forwarded', effect: 'observed' };
      });
    }
    const kept = [...receipts.all.values()];
    const size = state.journal.size();
    state.close();
    state = openState(tmp.dir, { maxBytes: 256 * 1024 });
    try {
      assert.ok(state.journal.size() < size / 2, `compacted at open: ${size} B became ${state.journal.size()} B`);
      assert.equal(state.supervisorId, id, 'the first start record survives compaction');
      assert.deepEqual([...new ReceiptStore(state.journal).all.values()], kept, 'young receipts are all kept, each at its latest record');
    } finally {
      state.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('retention: a compacted copy a cut left before its rename is removed when the journal opens; the journal is unchanged', () => {
  const tmp = privateTmp();
  try {
    const file = join(tmp.dir, 'journal');
    const first = new Journal(file);
    first.append('supervisor', { supervisor_id: 'kept' }, 'supervisor.start');
    first.close();
    const before = readFileSync(file);
    writeFileSync(`${file}.compact`, 'half a compacted copy');
    const again = new Journal(file);
    try {
      assert.equal(existsSync(`${file}.compact`), false, 'the stray copy is gone');
      assert.deepEqual(readFileSync(file), before, 'the journal is the one before the compaction');
      assert.equal(again.records[0]?.value.supervisor_id, 'kept');
    } finally {
      again.close();
    }
  } finally {
    tmp.cleanup();
  }
});
