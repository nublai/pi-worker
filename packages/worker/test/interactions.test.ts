/**
 * Interactions (P1-10), ported from A0 `src/test/interactions.test.ts` with every assertion. The SDK host has no RPC
 * stage 2: A0's `stage` parameter (2 for RPC, 3 for SDK) becomes the exact resolver's acknowledgement (consumed or
 * not), and A0's `answerUI` / `cancelUI` host methods are the child's correlated `answer_ui` requests. Grants come from
 * `grants/store.ts` (the registry keeps no bearer), so A0's `grants.register(...)` returns a bearer file here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { authority } from '../src/grants/authority.js';
import { GrantStore, writeBearerFile } from '../src/grants/store.js';
import type { Answer, Interaction } from '../src/interactions/interactions.js';
import { requestHash } from '../src/receipts/receipts.js';
import { Resolvers, type UIAnswer } from '../src/sdk-child/resolvers.js';
import type { PiRecord } from '../src/host/host.js';
import { validateEventFrame, type EventFrame } from '../src/generated/events.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';

type Forwarded = { id: string; answer: Record<string, unknown> };

/** A0's `setup(stage)`: stage 3 consumes at the exact resolver; stage 2 is a resolver that acknowledges without consuming. */
function setup(consumed = true) {
  const f = fixture();
  const forwarded: Forwarded[] = [];
  const attach = () => {
    f.hosts[0]!.answerUI = async (id, answer) => {
      forwarded.push({ id, answer });
      return { consumed, outcome: consumed ? String(answer.outcome) : 'timeout' };
    };
  };
  const workerId = () => f.supervisor.list()[0]!.worker_id;
  const open = (kind = 'input', id = 'native', extra = {}) => {
    f.hosts[0]!.emit('event', { type: 'extension_ui_request', method: kind, id, ...extra });
    return f.supervisor.interactionList(workerId()).find(i => i.native_id === id)!;
  };
  const answer = (i: Interaction, command = 'answer', extra: Partial<Answer> & { value?: unknown } = {}) =>
    ({ ...bind(f.supervisor.list()[0]!, command), answer_id: command, interaction_id: i.interaction_id, revision: 1, kind: i.kind, outcome: 'answer', value: 'PRIVATE_ANSWER_😀', ...extra }) as Answer;
  return { ...f, attach, open, answer, forwarded };
}

for (const consumed of [false, true]) {
  test(`interactions: first valid answer wins, honest stage ${consumed ? 3 : 2}, invalid answer does not win`, async () => {
    const f = setup(consumed);
    try {
      const w = await f.create();
      f.attach();
      const i = f.open('select', 'choice', { options: ['same', 'same'] });
      await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'bad', { value: undefined, option_id: '2' })), /invalid_option/);
      await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'leading-zero', { value: undefined, option_id: '01' })), /invalid_option/);
      const a = f.answer(i, 'one', { value: undefined, option_id: '1' });
      const races = await Promise.allSettled([f.supervisor.answer(w.worker_id, a), f.supervisor.answer(w.worker_id, f.answer(i, 'two', { value: undefined, option_id: '0' }))]);
      assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(f.forwarded.length, 1);
      const r = await f.supervisor.answer(w.worker_id, a);
      const stage = consumed ? 3 : 2;
      assert.equal(r.answer_stage, stage);
      assert.equal(r.stage, stage === 3 ? 'resolver_consumed' : 'forwarded');
      assert.deepEqual(await f.supervisor.answer(w.worker_id, { ...a, command_id: 'different-attempt' }), r);
      assert.equal(f.supervisor.interactionList(w.worker_id).length, 0);
      assert.equal(f.supervisor.interactionStatus(w.worker_id, String(i.interaction_id)).answer_stage, stage);
    } finally {
      f.cleanup();
    }
  });
}

test('interactions: concurrent exact command with conflicting value refuses; private value and hash never persist', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    const i = f.open();
    const a = f.answer(i);
    const first = f.supervisor.answer(w.worker_id, a);
    await assert.rejects(f.supervisor.answer(w.worker_id, { ...a, value: 'DIFFERENT_PRIVATE' }), /answer_id_conflict/);
    const receipt = await first;
    const { value: _v, option_id: _o, outcome: _outcome, ...metadata } = a;
    assert.equal(receipt.request_hash, requestHash({ ...metadata, worker_id: w.worker_id, operation: 'interactions.answer_if_current' }), 'answer hashes must depend on metadata only');
    await assert.rejects(f.supervisor.answer(w.worker_id, { ...a, value: 'DIFFERENT_PRIVATE' }), /answer_id_conflict/);
    const bytes = readFileSync(f.journalFile, 'utf8');
    for (const secret of [String(a.value), 'DIFFERENT_PRIVATE', createHash('sha256').update(JSON.stringify({ outcome: a.outcome, value: a.value })).digest('hex')]) assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes('"value":"PRIVATE'), false);
  } finally {
    f.cleanup();
  }
});

test('interactions: deadline, timeout, stale kind/revision/worker binding, fence, and old interaction after recovery', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    const i = f.open('confirm', 'c', { timeout: 30 });
    for (const change of [{ kind: 'editor' as const }, { revision: 2 }, { worker_epoch: 'stale' }, { binding_revision: 99 }, { value: 'false' }]) {
      await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, `bad${JSON.stringify(change)}`, { value: false, ...change })));
    }
    f.supervisor.state.require(w.worker_id).worker.fence = { command_id: 'unknown', fence_generation: 1 };
    await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'fenced', { value: false })), /session_fenced/);
    f.supervisor.state.require(w.worker_id).worker.fence = null;
    await delay(40);
    await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i, 'late', { value: false })), /interaction_not_pending|deadline/);
    assert.equal(f.forwarded.length, 0);
    assert.equal(f.supervisor.interactionStatus(w.worker_id, String(i.interaction_id)).status, 'timeout');
    const pending = f.open('input', 'restart');
    const recovered = await f.restart(() => {
      throw new Error('must never launch');
    });
    assert.equal(recovered.interactionStatus(w.worker_id, String(pending.interaction_id)).status, 'interrupted');
    assert.equal(recovered.interactionList(w.worker_id).length, 0);
    await assert.rejects(recovered.answer(w.worker_id, f.answer(pending, 'stale-restart')), /worker_not_ready|interaction_not_pending/);
  } finally {
    f.cleanup();
  }
});

test('interactions: restart answer_id lookup returns outcome without revalidating private content or redispatching', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    const i = f.open();
    const a = f.answer(i);
    const before = await f.supervisor.answer(w.worker_id, a);
    const s = await f.restart(() => {
      throw new Error('no replay');
    });
    assert.deepEqual(await s.answer(w.worker_id, { ...a, command_id: 'new-wire-attempt', value: false }), before);
    assert.equal(f.forwarded.length, 1);
  } finally {
    f.cleanup();
  }
});

test('interactions: SDK resolver atomically arbitrates answer/timeout/abort and distinguishes No, cancel, timeout', async () => {
  let now = 0;
  const events: PiRecord[] = [];
  const r = new Resolvers(e => events.push(e), () => now);
  const ask = (opts = {}) => {
    const promise = r.ask('confirm', {}, opts);
    const id = String(events.at(-1)!.id);
    return { id, promise };
  };
  let q = ask();
  assert.equal(r.answer(q.id, { outcome: 'answer', value: false }).outcome, 'no');
  assert.equal(await q.promise, false);
  assert.equal(r.answer(q.id, { outcome: 'answer', value: true }).consumed, false);
  q = ask();
  assert.equal(r.answer(q.id, { outcome: 'cancel' }).outcome, 'cancel');
  assert.equal(await q.promise, false);
  q = ask({ timeout: 10 });
  now = 10;
  assert.equal(r.answer(q.id, { outcome: 'answer', value: true }).outcome, 'timeout');
  assert.equal(await q.promise, false);
  const abort = new AbortController();
  abort.abort();
  q = ask({ signal: abort.signal });
  assert.equal(await q.promise, false);
  assert.equal(r.pending.size, 0);
  assert.ok(events.some(e => e.outcome === 'aborted'));
  assert.deepEqual(
    events.filter(e => e.type === 'resolver_closed').map(e => e.outcome),
    ['no', 'cancel', 'timeout', 'aborted'],
  );
});

test('interactions: all four kinds, editor prefill, duplicate labels; exact resolver rejects invalid option/text/boolean', async () => {
  const events: PiRecord[] = [];
  const r = new Resolvers(e => events.push(e));
  for (const [kind, content, invalid, valid, expected] of [
    ['select', { options: ['duplicate', 'duplicate'] }, { value: 'duplicate' }, { option_id: '1' }, 'duplicate'],
    ['input', { placeholder: 'hint' }, { value: true }, { value: '' }, ''],
    ['editor', { prefill: 'shown' }, { value: false }, { value: 'edited\nlines' }, 'edited\nlines'],
    ['confirm', {}, { value: 'no' }, { value: false }, false],
  ] as const) {
    const pending = r.ask(kind, content);
    const id = String(events.at(-1)!.id);
    assert.equal(r.answer(id, { outcome: 'answer', ...(invalid as Partial<UIAnswer>) }).consumed, false);
    assert.equal(r.answer(id, { outcome: 'answer', ...(valid as Partial<UIAnswer>) }).consumed, true);
    assert.equal(await pending, expected);
  }
});

async function serve(f: Fixture) {
  const grants = new GrantStore(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, grants }).handle);
  const socket = join(f.dir, 'worker.sock');
  await listenPrivate(server, socket);
  const register = (caller: string, scope: { worker_ids: string[]; cwd_roots: string[] }, methods: string[], id: string, answersForPerson = false) => {
    const { token } = grants.register({ caller, scope, methods, grant_id: id, answers_for_person: answersForPerson });
    const file = join(f.dir, `${id}.bearer.json`);
    writeBearerFile(file, token);
    return file;
  };
  return {
    socket,
    grants,
    register,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test('interactions: two HTTP clients race through public B2 list/answer/status with method-scoped grants', { timeout: 30_000 }, async () => {
  const f = setup();
  const s = await serve(f);
  try {
    const w = await f.create();
    f.attach();
    const grant = s.register('bridge', { worker_ids: [w.worker_id], cwd_roots: [] }, ['interactions.list', 'interactions.answer_if_current', 'interactions.status'], 'bridge', true);
    const watcher = s.register('watcher', { worker_ids: ['*'], cwd_roots: [] }, ['events.subscribe'], 'watcher');
    const one = new Client({ socketPath: s.socket, grantFile: grant });
    const two = new Client({ socketPath: s.socket, grantFile: grant });
    f.open('editor', 'e', { prefill: 'visible prefill' });
    const list = await one.call('interactions.list', { path: { worker_id: w.worker_id } });
    assert.equal(list[0]!.prefill, 'visible prefill');
    let snapshot: { workers: { pending_interactions: unknown[] }[] } | undefined;
    await new Client({ socketPath: s.socket, grantFile: watcher }).watch(
      frame => {
        if (frame.type === 'snapshot') snapshot = frame;
        return false;
      },
      { workerIds: [w.worker_id] },
    );
    const pending = snapshot!.workers[0]!.pending_interactions[0] as Interaction;
    assert.ok('interaction_id' in pending);
    assert.equal(pending.interaction_id, list[0]!.interaction_id);
    assert.equal(pending.prefill, 'visible prefill');
    assert.equal(readFileSync(f.journalFile, 'utf8').includes('visible prefill'), false, 'snapshot payload must not become durable metadata');
    const a = f.answer(list[0]! as Interaction, 'empty-editor', { value: '' });
    const results = await Promise.allSettled([
      one.call('interactions.answer_if_current', { path: { worker_id: w.worker_id }, body: a }),
      two.call('interactions.answer_if_current', { path: { worker_id: w.worker_id }, body: { ...a, command_id: 'second', answer_id: 'second', value: 'second' } }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.forwarded.length, 1);
    const status = await one.call('interactions.status', { path: { worker_id: w.worker_id }, query: { interaction_id: a.interaction_id } });
    assert.equal(status.answer_stage, 3);
    assert.equal(status.actor, 'bridge');
    assert.equal(status.grant_id, 'bridge');
    // A0's checkIdentity: the answering grant authorizes a release only while it is unrevoked and holds the method.
    assert.equal(s.grants.current({ grant_id: 'bridge' } as never).caller, 'bridge');
    s.grants.revoke('bridge');
    await assert.rejects(one.call('interactions.list', { path: { worker_id: w.worker_id } }), /grant_revoked/);
    assert.throws(() => s.grants.current({ grant_id: 'bridge' } as never), /grant_revoked/);
    // A grant that does not answer for a person cannot answer, even with the method.
    const orchestrator = s.register('orchestrator', { worker_ids: ['*'], cwd_roots: [] }, ['interactions.answer_if_current'], 'orchestrator');
    f.open('input', 'later');
    const later = f.supervisor.interactionList(w.worker_id).find(x => x.native_id === 'later')!;
    await assert.rejects(new Client({ socketPath: s.socket, grantFile: orchestrator }).call('interactions.answer_if_current', { path: { worker_id: w.worker_id }, body: f.answer(later, 'not-a-person') }), /grant_cannot_answer_for_person/);
  } finally {
    await s.close();
    f.cleanup();
  }
});

for (const mutation of ['none', 'grant', 'policy', 'expiry', 'digest', 'binding', 'fence'] as const) {
  test(`interactions: typed tool approval separates resolver consumption from gate release: ${mutation}`, async () => {
    const f = setup();
    try {
      const w = await f.create();
      f.attach();
      let authorized = true;
      const approval = { gate_token: 'gate', digest: 'input-sha256', policy_revision: 'p1', expiry: Date.now() + 30000, operation: 'bash', resource: f.dir, environment: f.dir, offered_scope: 'once' };
      const i = f.open('tool_approval', 'approval', { approval });
      const a = f.answer(i, 'approve', { value: true });
      const guard = Object.assign(
        () => {
          if (!authorized) throw new Error('revoked');
        },
        { grant_id: 'fixture' },
      );
      const before = await authority.run(guard, () => f.supervisor.answer(w.worker_id, a));
      assert.equal(before.answer_stage, 3);
      assert.equal(
        f.hosts[0]!.commands.some(c => c.type === 'gate_release'),
        false,
      );
      const event: Record<string, unknown> = { type: 'gate_check', ...approval };
      if (mutation === 'grant') authorized = false;
      if (mutation === 'policy') event.policy_revision = 'p2';
      if (mutation === 'digest') event.digest = 'changed';
      if (mutation === 'expiry') event.expiry = 1;
      if (mutation === 'binding') f.supervisor.state.require(w.worker_id).worker.binding_revision++;
      if (mutation === 'fence') f.supervisor.state.require(w.worker_id).worker.fence = { command_id: 'u', fence_generation: 1 };
      const original = f.hosts[0]!.request.bind(f.hosts[0]);
      f.hosts[0]!.request = async c => (c.type === 'gate_release' ? { type: 'response', id: 'r', success: true, data: { released: c.allowed === true } } : original(c));
      await f.supervisor.interactions.gate(f.supervisor.state.require(w.worker_id).worker, event as PiRecord, () => {
        if (f.supervisor.state.require(w.worker_id).worker.fence) throw new Error('fenced');
      });
      const release = f.supervisor.receipts.all.get('approve:release')!;
      if (mutation === 'fence') {
        assert.equal(release.state, 'rejected');
        assert.equal(release.effect, 'no_effect');
        assert.equal(
          f.hosts[0]!.commands.some(c => c.type === 'gate_release'),
          false,
          'fenced release must not reach child',
        );
        assert.equal(
          f.state.journal.records.some(r => r.kind === 'receipt' && r.value.command_id === 'approve:release' && r.value.state === 'accepted'),
          false,
          'fenced release must not dispatch',
        );
      } else {
        assert.equal(release.answer_stage, mutation === 'none' ? 4 : 3);
        assert.equal(release.result?.released, mutation === 'none');
      }
    } finally {
      f.cleanup();
    }
  });
}

for (const denial of ['grant', 'binding', 'approval'] as const) {
  test(`interactions: a release the supervisor denied (${denial}) is never stage 4, even when the child claims it released`, async () => {
    const f = setup();
    try {
      const w = await f.create();
      f.attach();
      let authorized = true;
      const approval = { gate_token: 'gate', digest: 'input-sha256', policy_revision: 'p1', expiry: Date.now() + 30000, operation: 'bash', resource: f.dir, environment: f.dir, offered_scope: 'once' };
      const i = f.open('tool_approval', 'approval', { approval });
      const guard = Object.assign(
        () => {
          if (!authorized) throw new Error('revoked');
        },
        { grant_id: 'fixture' },
      );
      assert.equal((await authority.run(guard, () => f.supervisor.answer(w.worker_id, f.answer(i, 'approve', { value: true })))).answer_stage, 3);
      const event: Record<string, unknown> = { type: 'gate_check', ...approval };
      if (denial === 'grant') authorized = false;
      if (denial === 'binding') f.supervisor.state.require(w.worker_id).worker.binding_revision++;
      if (denial === 'approval') event.digest = 'changed';
      // A child that ignores the denial and says it released the tool anyway.
      const sent: PiRecord[] = [];
      const original = f.hosts[0]!.request.bind(f.hosts[0]);
      f.hosts[0]!.request = async c => {
        if (c.type !== 'gate_release') return original(c);
        sent.push(c);
        return { type: 'response', id: 'r', success: true, data: { released: true } };
      };
      await f.supervisor.interactions.gate(f.supervisor.state.require(w.worker_id).worker, event as PiRecord, () => {});
      assert.equal(sent[0]?.allowed, false, 'the supervisor denied the release');
      const release = f.supervisor.receipts.all.get('approve:release')!;
      assert.notEqual(release.answer_stage, 4, 'a denied release is never stage 4');
      assert.notEqual(release.stage, 'tool_released');
      // The child contradicted the denial: what it did is unknown, and the session fences.
      assert.equal(release.state, 'outcome_unknown');
      assert.equal(release.effect, 'unknown');
      const status = f.supervisor.interactionStatus(w.worker_id, String(i.interaction_id));
      assert.notEqual(status.answer_stage, 4);
      assert.notEqual(status.status, 'tool_released');
      assert.ok(f.supervisor.get(w.worker_id).fence?.uncertain_command_ids?.includes('approve:release'));
    } finally {
      f.cleanup();
    }
  });
}

test('interactions: deadline validation refuses at the boundary before the timeout callback can run', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    let now = 0;
    f.supervisor.interactions.now = () => now;
    f.hosts[0]!.emit('event', { type: 'extension_ui_request', id: 'native', method: 'input', deadline: 30000 });
    const i = f.supervisor.interactionList(w.worker_id)[0]!;
    now = 30000;
    await assert.rejects(f.supervisor.answer(w.worker_id, f.answer(i)), /deadline_passed/);
    assert.equal(f.forwarded.length, 0);
    f.supervisor.interactions.invalidate(w.worker_id, 'interrupted');
  } finally {
    f.cleanup();
  }
});

test('interactions: a deadline crossed after acceptance, before dispatch, closes the interaction timeout (no accepted leftover)', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    f.hosts[0]!.emit('event', { type: 'extension_ui_request', id: 'q', method: 'input', deadline: 1000 });
    const i = f.supervisor.interactionList(w.worker_id)[0]!;
    // Validation sees deadline - 1; the check after the acceptance fsync sees the deadline.
    let checks = 0;
    f.supervisor.interactions.now = () => (++checks === 1 ? 999 : 1000);
    const r = await f.supervisor.answer(w.worker_id, f.answer(i));
    assert.equal(r.state, 'rejected');
    assert.equal(r.effect, 'no_effect');
    assert.equal(r.error, 'interaction_deadline_passed');
    assert.equal(f.forwarded.length, 0, 'nothing reached the resolver');
    const status = f.supervisor.interactionStatus(w.worker_id, String(i.interaction_id));
    assert.equal(status.status, 'timeout', 'the interaction is finalized, not left accepted');
    assert.equal(status.outcome, 'timeout');
    assert.equal(f.supervisor.interactionList(w.worker_id).length, 0);
    assert.deepEqual(f.hosts[0]!.cancelled, ['q'], 'the native resolver is cancelled');
    // Durable: the last record of the interaction is the close, after a write-ahead cancellation marker.
    const records = f.state.journal.records.filter(x => (x.kind === 'interaction' || x.kind === 'interaction_effect') && x.value.interaction_id === i.interaction_id);
    assert.equal(records.filter(x => x.kind === 'interaction').at(-1)!.value.status, 'timeout');
    assert.equal(records.at(-1)!.kind, 'interaction_effect');
    // The child's own timeout closure arrives later and changes nothing.
    f.hosts[0]!.emit('event', { type: 'resolver_closed', native_id: 'q', outcome: 'timeout' });
    assert.equal(f.supervisor.interactionStatus(w.worker_id, String(i.interaction_id)).status, 'timeout');
    // A retry returns the recorded refusal; it is not a second answer.
    assert.deepEqual(await f.supervisor.answer(w.worker_id, f.answer(i)), r);
    assert.equal(f.forwarded.length, 0);
  } finally {
    f.cleanup();
  }
});

test('interactions: SDK refusal acknowledgement never claims stage 3 for an expired exact resolver', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    const i = f.open();
    f.hosts[0]!.answerUI = async () => ({ consumed: false, outcome: 'timeout' });
    const r = await f.supervisor.answer(w.worker_id, f.answer(i));
    assert.equal(r.answer_stage, 2);
    assert.equal(r.result?.resolver_consumed, false);
    assert.equal(f.supervisor.interactionStatus(w.worker_id, String(i.interaction_id)).answer_stage, 2);
  } finally {
    f.cleanup();
  }
});

test('interactions: a consumed answer with a dropped host acknowledgement is unknown/fenced, never blindly replayed', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    let consumed = 0;
    f.hosts[0]!.answerUI = async () => {
      consumed++;
      throw new Error('dropped_ack');
    };
    const i = f.open();
    const a = f.answer(i);
    const r = await f.supervisor.answer(w.worker_id, a);
    assert.equal(r.state, 'outcome_unknown');
    assert.equal(f.supervisor.get(w.worker_id).fence!.command_id, a.command_id);
    assert.deepEqual(await f.supervisor.answer(w.worker_id, a), r);
    assert.equal(consumed, 1);
    await assert.rejects(f.supervisor.answer(w.worker_id, { ...a, command_id: 'retry', answer_id: 'retry' }), /session_fenced/);
  } finally {
    f.cleanup();
  }
});

test('interactions: live cards reach the snapshot and interactions.changed; history and restart never create one', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    const frames: { type: string; data?: unknown }[] = [];
    const sub = f.supervisor.subscribe(frame => void frames.push(frame), { workerIds: [w.worker_id] });
    f.open('select', 'pick', { title: 'Pick one', options: ['a', 'b'] });
    const changed = frames.filter(x => x.type === 'interactions.changed').at(-1) as { data: { interactions: Interaction[] } };
    assert.equal(changed.data.interactions[0]!.title, 'Pick one');
    assert.deepEqual(
      changed.data.interactions[0]!.options,
      [
        { option_id: '0', label: 'a' },
        { option_id: '1', label: 'b' },
      ],
    );
    sub.close();
    // A worker record written while the card is pending (a prompt's admission) carries its metadata only.
    await f.supervisor.prompt(w.worker_id, { ...bind(f.supervisor.get(w.worker_id), 'prompt'), message: 'go' });
    assert.equal(readFileSync(f.journalFile, 'utf8').includes('Pick one'), false, 'a persisted worker row never carries a card payload');
    let snapshot: Interaction[] = [];
    f.supervisor.subscribe(frame => void (snapshot = frame.type === 'snapshot' ? (frame.workers[0]!.pending_interactions as Interaction[]) : snapshot), { workerIds: [w.worker_id] }).close();
    assert.equal(snapshot[0]!.title, 'Pick one');
    assert.equal(readFileSync(f.journalFile, 'utf8').includes('Pick one'), false, 'payloads stay in memory');
    const next = await f.restart(() => {
      throw new Error('no relaunch');
    });
    assert.deepEqual(next.get(w.worker_id).pending_interactions, []);
  } finally {
    f.cleanup();
  }
});

test('interactions: a tool_approval card carries exactly the typed approval binding; one without a valid binding is never shown and its gate is denied (P1-19 follow-up 6)', async () => {
  const f = setup();
  try {
    const w = await f.create();
    f.attach();
    const frames: EventFrame[] = [];
    const sub = f.supervisor.subscribe(frame => void frames.push(frame), { workerIds: [w.worker_id] });
    const binding = { digest: 'sha256-9f2c41', policy_revision: 'policy-3', expiry: Date.now() + 60_000, operation: 'write', resource: 'src/login.ts', environment: f.dir, offered_scope: 'once', gate_token: 'gate-1' };
    // An extension's extra field is not part of the binding.
    const card = f.open('tool_approval', 'gate', { approval: { ...binding, note: 'not in the binding' } });
    assert.deepEqual(card?.approval, binding);
    // A binding without its gate token (or with a field out of bounds) is never shown: the dialog is cancelled.
    const { gate_token: _token, ...tokenless } = binding;
    for (const [id, approval] of [
      ['no-token', tokenless],
      ['long-digest', { ...binding, digest: 'd'.repeat(4097) }],
      ['negative-expiry', { ...binding, expiry: -1 }],
      ['none', undefined],
    ] as const) {
      assert.equal(f.open('tool_approval', id, { approval }), undefined, `${id}: no card`);
      await tick();
      assert.ok(f.hosts[0]!.cancelled.includes(id), `${id}: its native dialog is cancelled`);
    }
    sub.close();
    assert.equal(f.supervisor.get(w.worker_id).status, 'ready');
    for (const frame of frames) assert.equal(validateEventFrame(frame), true, `${frame.type}: ${JSON.stringify(validateEventFrame.errors)}`);
    assert.deepEqual(
      f.supervisor.interactionList(w.worker_id).map(i => i.native_id),
      ['gate'],
    );
  } finally {
    f.cleanup();
  }
});
