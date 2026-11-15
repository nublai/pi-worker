import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, parseJournal } from '../journal.js';
import { ReceiptStore, requestHash } from '../receipts.js';
import { Refusal } from '../types.js';
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'a0-receipts-')); const journal = new Journal(join(dir, 'journal')); return { journal, store: new ReceiptStore(journal), cleanup: () => { journal.close(); rmSync(dir, { recursive: true }); } }; }
test('canonical idempotency ignores transport id, not operation content', () => {
  assert.equal(requestHash({ z: [1, { b: true, a: null }], request_id: 'one' }), requestHash({ request_id: 'two', z: [1, { a: null, b: true }] }));
  assert.notEqual(requestHash({ message: 'one' }), requestHash({ message: 'two' }));
});
test('intent and dispatch are durable before effect; duplicate attempts dispatch once', async () => {
  const f = fixture(); try {
    let effects = 0; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const effect = async () => {
      assert.equal(parseJournal(readFileSync(f.journal.file)).records.at(-1)?.value.state, 'intent');
      f.store.dispatch('id'); effects++; await gate;
      return { state: 'delivered' as const, stage: 'forwarded' as const, effect: 'observed' as const };
    };
    const first = f.store.run('id', 'sessions.prompt', { message: 'same' }, effect);
    const second = f.store.run('id', 'sessions.prompt', { message: 'same' }, effect);
    release(); assert.deepEqual(await first, await second); assert.equal(effects, 1);
    assert.deepEqual(await f.store.run('id', 'sessions.prompt', { message: 'same' }, effect), await first);
    assert.throws(() => f.store.run('id', 'sessions.prompt', { message: 'different' }, effect), /command_id_conflict/);
    assert.throws(() => f.store.run('id', 'workers.stop', { message: 'same' }, effect), /command_id_conflict/);
    assert.equal(parseJournal(readFileSync(f.journal.file)).records.at(-1)?.value.state, 'delivered');
  } finally { f.cleanup(); }
});
test('refusal versus uncertain timeout, plus no eviction at capacity', async () => {
  const f = fixture(); try {
    const no = await f.store.run('no', 'sessions.prompt', {}, async () => { throw new Refusal('no'); });
    assert.equal(no.effect, 'no_effect'); assert.equal(no.state, 'rejected');
    const unknown = await f.store.run('unknown', 'sessions.prompt', {}, async () => { f.store.dispatch('unknown'); throw new Error('lost response'); });
    assert.equal(unknown.state, 'outcome_unknown'); assert.equal(unknown.effect, 'unknown'); assert.equal(unknown.admission, undefined);
    const bounded = new ReceiptStore(f.journal, 2);
    await assert.rejects(bounded.run('third', 'sessions.prompt', {}, async () => ({})), /receipt_capacity/);
    assert.equal(bounded.all.size, 2);
  } finally { f.cleanup(); }
});
test('recovery separates undispatched intent from dispatch; neither is replayed', async () => {
  const f = fixture(); try {
    const base = { operation: 'sessions.prompt' as const, request_hash: 'hash', stage: 'reserved' as const, effect: 'no_effect' as const, evidence: 'supervisor_journal_fsynced' as const, created_at: new Date().toISOString() };
    f.store.put({ ...base, command_id: 'intent', state: 'intent' });
    f.store.put({ ...base, command_id: 'sent', state: 'accepted' });
    const recovered = new ReceiptStore(f.journal); recovered.recover();
    assert.equal(recovered.all.get('intent')?.effect, 'no_effect');
    assert.equal(recovered.all.get('intent')?.state, 'intent_recovered');
    const before = readFileSync(f.journal.file);
    recovered.recover(); assert.deepEqual(readFileSync(f.journal.file), before);
    assert.throws(() => recovered.dispatch('intent'), /owner resolution/);
    assert.throws(() => recovered.update('sent', { state: 'delivered' }), /receipt is final/);
    assert.equal(recovered.all.get('sent')?.state, 'outcome_unknown');
    assert.equal(recovered.all.get('sent')?.effect, 'unknown');
  } finally { f.cleanup(); }
});
test('journal admission reserves full result room and never begins an effect without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-capacity-'));
  const journal = new Journal(join(dir, 'journal'), 1024);
  try {
    const store = new ReceiptStore(journal);
    await assert.rejects(store.run('no-room', 'workers.create', {}, async () => { assert.fail('must not dispatch'); }), /journal_result_capacity/);
    assert.equal(journal.records.length, 0); assert.equal(journal.failed, false);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});
test('a late callback on a CLOSED journal cannot corrupt a newly opened journal via recycled fd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-closed-journal-'));
  const file = join(dir, 'journal'); const old = new Journal(file);
  old.append('supervisor', { supervisor_id: 'first' }); old.close();
  const next = new Journal(file);
  try {
    next.append('supervisor', { supervisor_id: 'second' }); const before = readFileSync(file);
    assert.throws(() => old.append('worker', { worker: { status: 'late-exit' } }), /closed/);
    assert.deepEqual(readFileSync(file), before); assert.equal(parseJournal(readFileSync(file)).records.length, 2);
  } finally { next.close(); rmSync(dir, { recursive: true }); }
});
test('journal truncates a torn final record, rejects complete corruption or sequence gaps', () => {
  const f = fixture(); try {
    f.journal.append('supervisor', { supervisor_id: 'id' });
    const valid = readFileSync(f.journal.file);
    appendFileSync(f.journal.file, '{"partial":');
    const recovered = new Journal(f.journal.file);
    assert.equal(recovered.records.length, 1); assert.deepEqual(readFileSync(f.journal.file), valid); recovered.close();
    assert.throws(() => parseJournal(Buffer.concat([valid, Buffer.from('{"bad":true}\n')])) , /journal corruption/);
    assert.throws(() => parseJournal(Buffer.concat([valid, valid])), /journal corruption/);
    const altered = Buffer.from(valid.toString().replace('supervisor_id', 'supervisor_ix'));
    assert.throws(() => parseJournal(altered), /journal corruption/);
  } finally { f.cleanup(); }
});
