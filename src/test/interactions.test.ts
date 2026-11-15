import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fixture, bind } from './helpers.js';
import { Resolvers, type UIAnswer } from '../resolvers.js';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { Interactions, type Answer } from '../interactions.js';
import { requestHash } from '../receipts.js';
import type { PiRecord } from '../host.js';
import { Client } from '../client.js';
import { router, listenPrivate } from '../server.js';
import type { Snapshot } from '../types.js';
function setup(stage: 2 | 3 = 3) {
  const f = fixture(); const forwarded: { id: string; answer: UIAnswer }[] = [];
  const attach = () => {
    const h = f.hosts[0]!;
    Object.assign(h, { kind: 'sdk', answerUI: async (id: string, answer: UIAnswer) => { forwarded.push({ id, answer }); return { stage, consumed: true, outcome: answer.outcome }; } });
  };
  const open = (kind = 'input', id = 'native', extra = {}) => { f.hosts[0]!.emit('event', { type: 'extension_ui_request', method: kind, id, ...extra }); return f.supervisor.interactions.list(f.supervisor.list()[0]!.worker_id)[0]!; };
  const answer = (i: Record<string, unknown>, command = 'answer', extra = {}) => ({ ...bind(f.supervisor.list()[0]!, command), answer_id: command, interaction_id: i.interaction_id, revision: 1, kind: i.kind, outcome: 'answer', value: 'PRIVATE_ANSWER_😀', ...extra }) as Answer;
  return { ...f, attach, open, answer, forwarded };
}
for (const stage of [2, 3] as const) test(`first valid answer wins, honest stage ${stage}, invalid answer does not win`, async () => {
  const f = setup(stage); try {
    const w = await f.create(); f.attach(); const i = f.open('select', 'choice', { options: ['same', 'same'] });
    await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'bad', { value: undefined, option_id: '2' })), /invalid_option/);
    await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'leading-zero', { value: undefined, option_id: '01' })), /invalid_option/);
    const a = f.answer(i, 'one', { value: undefined, option_id: '1' });
    const races = await Promise.allSettled([f.supervisor.answer(w.worker_id, a), f.supervisor.answer(w.worker_id, f.answer(i, 'two', { value: undefined, option_id: '0' }))]);
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.forwarded.length, 1);
    const r = await f.supervisor.answer(w.worker_id, a); assert.equal(r.answer_stage, stage);
    assert.equal(r.stage, stage === 3 ? 'resolver_consumed' : 'forwarded');
    assert.deepEqual(await f.supervisor.answer(w.worker_id, { ...a, command_id: 'different-attempt' }), r);
    assert.equal(f.supervisor.interactions.list(w.worker_id).length, 0);
    assert.equal(f.supervisor.interactions.status(w.worker_id, String(i.interaction_id)).answer_stage, stage);
  } finally { f.cleanup(); }
});
test('concurrent exact command with conflicting value refuses; private value and hash never persist', async () => {
  const f = setup(); try {
    const w = await f.create(); f.attach(); const i = f.open(); const a = f.answer(i);
    const first = f.supervisor.answer(w.worker_id, a);
    await assert.rejects(f.supervisor.answer(w.worker_id, { ...a, value: 'DIFFERENT_PRIVATE' }), /answer_id_conflict/);
    const receipt = await first;
    const { value: _v, option_id: _o, outcome: _outcome, ...metadata } = a;
    assert.equal(receipt.request_hash, requestHash({ ...metadata, worker_id: w.worker_id, operation: 'interactions.answer_if_current' }), 'answer hashes must depend on metadata only');
    await assert.rejects(f.supervisor.answer(w.worker_id, { ...a, value: 'DIFFERENT_PRIVATE' }), /answer_id_conflict/);
    const bytes = readFileSync(join(f.dir, 'journal'), 'utf8');
    for (const secret of [String(a.value), 'DIFFERENT_PRIVATE', createHash('sha256').update(JSON.stringify({ outcome: a.outcome, value: a.value })).digest('hex')]) assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes('"value":"PRIVATE'), false);
  } finally { f.cleanup(); }
});
test('deadline, timeout, stale kind/revision/worker binding, fence, and old interaction after recovery', async () => {
  const f = setup(); try {
    const w = await f.create(); f.attach(); const i = f.open('confirm', 'c', { timeout: 30 });
    for (const change of [{ kind: 'editor' }, { revision: 2 }, { worker_epoch: 'stale' }, { binding_revision: 99 }, { value: 'false' }]) await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'bad' + JSON.stringify(change), { value: false, ...change })));
    f.supervisor.require(w.worker_id).worker.fence = { command_id: 'unknown', fence_generation: 1 };
    await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'fenced', { value: false })), /session_fenced/);
    f.supervisor.require(w.worker_id).worker.fence = null;
    await delay(40);
    await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'late', { value: false })), /interaction_not_pending|deadline/);
    assert.equal(f.forwarded.length, 0); assert.equal(f.supervisor.interactions.status(w.worker_id, String(i.interaction_id)).status, 'timeout');
    const pending = f.open('input', 'restart');
    f.journal.close(); const j = new Journal(join(f.dir, 'journal'));
    const recovered = new Supervisor(f.dir, j, '1.5.2', () => { throw new Error('must never launch'); });
    try {
      await recovered.recover();
      assert.equal(recovered.interactions.status(w.worker_id, String(pending.interaction_id)).status, 'interrupted');
      assert.equal(recovered.interactions.list(w.worker_id).length, 0);
      await assert.rejects(recovered.answer(w.worker_id, f.answer(pending, 'stale-restart')), /worker_not_ready|interaction_not_pending/);
    } finally { j.close(); }
  } finally { f.cleanup(); }
});
test('restart answer_id lookup returns outcome without revalidating private content or redispatching', async () => {
  const f = setup(); try {
    const w = await f.create(); f.attach(); const i = f.open(); const a = f.answer(i); const before = await f.supervisor.answer(w.worker_id, a);
    f.journal.close(); const j = new Journal(join(f.dir, 'journal')); const s = new Supervisor(f.dir, j, '1.5.2', () => { throw new Error('no replay'); });
    try { await s.recover(); assert.deepEqual(await s.answer(w.worker_id, { ...a, command_id: 'new-wire-attempt', value: false }), before); assert.equal(f.forwarded.length, 1); } finally { j.close(); }
  } finally { f.cleanup(); }
});
test('SDK resolver atomically arbitrates answer/timeout/abort and distinguishes No, cancel, timeout', async () => {
  let now = 0; const events: PiRecord[] = []; const r = new Resolvers(e => events.push(e), () => now);
  const ask = (opts = {}) => { const promise = r.ask('confirm', {}, opts); const id = String(events.at(-1)!.id); return { id, promise }; };
  let q = ask(); assert.equal(r.answer(q.id, { outcome: 'answer', value: false }).outcome, 'no'); assert.equal(await q.promise, false);
  assert.equal(r.answer(q.id, { outcome: 'answer', value: true }).consumed, false);
  q = ask(); assert.equal(r.answer(q.id, { outcome: 'cancel' }).outcome, 'cancel'); assert.equal(await q.promise, false);
  q = ask({ timeout: 10 }); now = 10;
  assert.equal(r.answer(q.id, { outcome: 'answer', value: true }).outcome, 'timeout'); assert.equal(await q.promise, false);
  const abort = new AbortController(); abort.abort(); q = ask({ signal: abort.signal }); assert.equal(await q.promise, false);
  assert.equal(r.pending.size, 0); assert.ok(events.some(e => e.outcome === 'aborted'));
  assert.deepEqual(events.filter(e => e.type === 'resolver_closed').map(e => e.outcome), ['no', 'cancel', 'timeout', 'aborted']);
});
test('all four kinds, editor prefill, duplicate labels; exact resolver rejects invalid option/text/boolean', async () => {
  const events: PiRecord[] = []; const r = new Resolvers(e => events.push(e));
  for (const [kind, content, invalid, valid, expected] of [
    ['select', { options: ['duplicate', 'duplicate'] }, { value: 'duplicate' }, { option_id: '1' }, 'duplicate'],
    ['input', { placeholder: 'hint' }, { value: true }, { value: '' }, ''],
    ['editor', { prefill: 'shown' }, { value: false }, { value: 'edited\nlines' }, 'edited\nlines'],
    ['confirm', {}, { value: 'no' }, { value: false }, false],
  ] as const) {
    const pending = r.ask(kind, content); const id = String(events.at(-1)!.id);
    assert.equal(r.answer(id, { outcome: 'answer', ...invalid }).consumed, false);
    assert.equal(r.answer(id, { outcome: 'answer', ...valid }).consumed, true); assert.equal(await pending, expected);
  }
});
test('two HTTP clients race through public B2 list/answer/status with method-scoped grants', async () => {
  const f = setup(); const socket = join(f.dir, 'worker.sock'); const server = router(f.supervisor);
  try {
    const w = await f.create(); f.attach(); await listenPrivate(server, socket);
    const grant = f.supervisor.grants.register('bridge', { worker_ids: [w.worker_id], cwd_roots: [] }, ['interactions.list', 'interactions.answer_if_current', 'interactions.status'], 'bridge');
    const one = new Client(socket, grant), two = new Client(socket, grant); f.open('editor', 'e', { prefill: 'visible prefill' });
    const list = await one.call('interactions.list', { id: w.worker_id }); assert.equal(list[0]!.prefill, 'visible prefill');
    let snapshot: Snapshot | undefined;
    await new Client(socket).watch(w.worker_id, frame => { if ('workers' in frame) snapshot = frame; return false; });
    const pending = snapshot!.workers[0]!.pending_interactions[0]!;
    assert.ok('interaction_id' in pending); assert.equal(pending.interaction_id, list[0]!.interaction_id); assert.equal(pending.prefill, 'visible prefill');
    assert.equal(readFileSync(join(f.dir, 'journal'), 'utf8').includes('visible prefill'), false, 'snapshot payload must not become durable metadata');
    const a = f.answer(list[0]!, 'empty-editor', { value: '' }); const results = await Promise.allSettled([one.call('interactions.answer_if_current', { id: w.worker_id, body: a }), two.call('interactions.answer_if_current', { id: w.worker_id, body: { ...a, command_id: 'second', answer_id: 'second', value: 'second' } })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.forwarded.length, 1);
    const status = await one.call('interactions.status', { id: w.worker_id, query: { interaction_id: a.interaction_id } }); assert.equal(status.answer_stage, 3); assert.equal(status.actor, 'bridge'); assert.equal(status.grant_id, 'bridge');
    f.supervisor.grants.checkIdentity('bridge', 'bridge', w);
    assert.throws(() => f.supervisor.grants.checkIdentity('bridge', 'different-actor', w), /release_grant_no_longer_valid/);
    f.supervisor.grants.revoke('bridge'); await assert.rejects(one.call('interactions.list', { id: w.worker_id }), /grant_revoked/);
    assert.throws(() => f.supervisor.grants.checkIdentity('bridge', 'bridge', w), /release_grant_no_longer_valid/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});
for (const mutation of ['none', 'grant', 'policy', 'expiry', 'digest', 'binding', 'fence'] as const) test(`typed tool approval separates resolver consumption from gate release: ${mutation}`, async () => {
  const f = setup(); try {
    const w = await f.create(); f.attach(); let authorized = true;
    const approval = { gate_token: 'gate', digest: 'input-sha256', policy_revision: 'p1', expiry: Date.now() + 30000, operation: 'bash', resource: f.dir, environment: f.dir, offered_scope: 'once' };
    const i = f.open('tool_approval', 'approval', { approval });
    const a = f.answer(i, 'approve', { value: true });
    const before = await f.supervisor.authority.run(() => { if (!authorized) throw new Error('revoked'); }, () => f.supervisor.answer(w.worker_id, a));
    assert.equal(before.answer_stage, 3); assert.equal(f.hosts[0]!.commands.some(c => c.type === 'gate_release'), false);
    const event = { type: 'gate_check', ...approval };
    if (mutation === 'grant') authorized = false;
    if (mutation === 'policy') event.policy_revision = 'p2';
    if (mutation === 'digest') event.digest = 'changed';
    if (mutation === 'expiry') event.expiry = 1;
    if (mutation === 'binding') f.supervisor.require(w.worker_id).worker.binding_revision++;
    if (mutation === 'fence') f.supervisor.require(w.worker_id).worker.fence = { command_id: 'u', fence_generation: 1 };
    const original = f.hosts[0]!.request.bind(f.hosts[0]);
    f.hosts[0]!.request = async c => c.type === 'gate_release' ? { type: 'response', id: 'r', success: true, data: { released: c.allowed === true } } : original(c);
    await f.supervisor.interactions.gate(f.supervisor.require(w.worker_id).worker, event, () => { if (f.supervisor.require(w.worker_id).worker.fence) throw new Error('fenced'); });
    const release = f.supervisor.receipts.all.get('approve:release')!;
    if (mutation === 'fence') {
      assert.equal(release.state, 'rejected'); assert.equal(release.effect, 'no_effect');
      assert.equal(f.hosts[0]!.commands.some(c => c.type === 'gate_release'), false, 'fenced release must not reach child');
      assert.equal(f.journal.records.some(r => r.kind === 'receipt' && r.value.command_id === 'approve:release' && r.value.state === 'accepted'), false, 'fenced release must not dispatch');
    } else { assert.equal(release.answer_stage, mutation === 'none' ? 4 : 3); assert.equal(release.result?.released, mutation === 'none'); }
  } finally { f.cleanup(); }
});
test('deadline validation refuses at the boundary before the timeout callback can run', async () => {
  const f = setup(); try {
    const w = await f.create(); f.attach(); let now = 0;
    const controller = new Interactions(f.journal, f.supervisor.receipts, () => {}, () => {}, () => now);
    controller.open(w, f.hosts[0]!, { type: 'extension_ui_request', id: 'native', method: 'input', deadline: 30000 });
    const i = controller.list(w.worker_id)[0]!; now = 30000;
    await assert.rejects(controller.answer(w, f.answer(i), () => {}, () => {}), /deadline_passed/);
    assert.equal(f.forwarded.length, 0); controller.invalidate(w.worker_id, 'interrupted');
  } finally { f.cleanup(); }
});
test('SDK refusal acknowledgement never claims stage 3 for an expired exact resolver', async () => {
  const f = setup(); try {
    const w = await f.create(); f.attach(); const i = f.open();
    Object.assign(f.hosts[0]!, { answerUI: async () => ({ stage: 3, consumed: false, outcome: 'timeout' }) });
    const r = await f.supervisor.answer(w.worker_id, f.answer(i)); assert.equal(r.answer_stage, 2);
    assert.equal(r.result?.resolver_consumed, false); assert.equal(f.supervisor.interactions.status(w.worker_id, String(i.interaction_id)).answer_stage, 2);
  } finally { f.cleanup(); }
});
test('a consumed answer with a dropped host acknowledgement is unknown/fenced, never blindly replayed', async () => {
  const f = setup(); try {
    const w = await f.create(); f.attach(); let consumed = 0;
    Object.assign(f.hosts[0]!, { answerUI: async () => { consumed++; throw new Error('dropped_ack'); } });
    const i = f.open(); const a = f.answer(i); const r = await f.supervisor.answer(w.worker_id, a);
    assert.equal(r.state, 'outcome_unknown'); assert.equal(f.supervisor.get(w.worker_id).fence!.command_id, a.command_id);
    assert.deepEqual(await f.supervisor.answer(w.worker_id, a), r); assert.equal(consumed, 1);
    await assert.rejects(f.supervisor.answer(w.worker_id, { ...a, command_id: 'retry', answer_id: 'retry' }), /session_fenced/);
  } finally { f.cleanup(); }
});
