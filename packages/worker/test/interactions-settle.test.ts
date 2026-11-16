/**
 * Every gate outcome settles its approval exactly once (P1-10, re-review R1). A consumed `tool_approval` owns the
 * child's gate and stays live until that gate ends; each ending removes it from the live set once, so the per-worker
 * capacity (32) counts only open interactions. Each terminal path runs CAPACITY + 1 times on one worker: a leaked
 * slot faults the worker with `interaction_capacity` when the 33rd approval opens. The ending's journal record is
 * written exactly once, and a settled approval is never re-interrupted by a restart.
 *
 * The fixture host plays the SDK child's protocol (sdk-child/main.ts): `resolver_closed` when the resolver is
 * consumed, then `gate_check` for an Allow, and the terminal `gate_closed` (with its reason) or `gate_released`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Refusal } from '../src/b2/errors.js';
import type { PiRecord } from '../src/host/host.js';
import type { Answer } from '../src/interactions/interactions.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';

const CAPACITY = 32;
const TERMINAL = new Set(['gate_closed', 'release_reported', 'tool_released', 'release_denied', 'interrupted', 'release_contradicted']);

const approval = (n: number) => ({ gate_token: `gate-${n}`, digest: 'digest', policy_revision: 'p1', expiry: Date.now() + 30_000, operation: 'bash', resource: 'fixture', environment: 'fixture', offered_scope: 'once' });

/** A receipt once it is final. */
const final = <T extends { state: string }>(r: T | undefined): T | undefined => (r && !['intent', 'accepted'].includes(r.state) ? r : undefined);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Terminal records per interaction id, from the journal (the durable truth, not the in-memory map). */
function terminalWrites(f: Fixture): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of f.state.journal.records) {
    if (r.kind !== 'interaction' || !TERMINAL.has(String(r.value.status))) continue;
    const id = String(r.value.interaction_id);
    out.set(id, [...(out.get(id) ?? []), String(r.value.status)]);
  }
  return out;
}

/** Opens one approval; a leaked slot faults the worker here, and the assertion names it. */
function openApproval(f: Fixture, workerId: string, n: number) {
  const gate = approval(n);
  f.hosts[0]!.emit('event', { type: 'extension_ui_request', method: 'tool_approval', id: `native-${n}`, approval: gate });
  const i = f.supervisor.interactionList(workerId).find(x => x.native_id === `native-${n}`);
  const w = f.supervisor.get(workerId);
  assert.ok(i, `approval #${n + 1} did not open: worker ${w.status}, failure ${JSON.stringify(w.failure ?? null)}`);
  return { gate, i };
}

const answerOf = (f: Fixture, workerId: string, n: number, interaction: { interaction_id: string }, extra: Partial<Answer>): Answer => ({
  ...bind(f.supervisor.get(workerId), `answer-${n}`),
  answer_id: `answer-${n}`,
  interaction_id: interaction.interaction_id,
  revision: 1,
  kind: 'tool_approval',
  outcome: 'answer',
  value: true,
  ...extra,
});

/** Runs one terminal path CAPACITY + 1 times; `path` returns the status its approval must end in. */
async function repeated(path: (f: Fixture, workerId: string, n: number) => Promise<string>): Promise<void> {
  const f = fixture();
  try {
    const w = await f.create();
    const ids: string[] = [];
    for (let n = 0; n <= CAPACITY; n++) {
      const expected = await path(f, w.worker_id, n);
      const record = [...f.supervisor.interactions.records.values()].find(r => r.native_id === `native-${n}`)!;
      ids.push(record.interaction_id);
      assert.equal(record.status, expected, `approval #${n + 1}`);
      assert.equal(f.supervisor.interactionList(w.worker_id).length, 0, 'no card is left open');
    }
    const after = f.supervisor.get(w.worker_id);
    assert.equal(after.status, 'ready', `worker ${after.status}, failure ${JSON.stringify(after.failure ?? null)}`);
    // One more approval still opens: every ended gate freed its slot.
    openApproval(f, w.worker_id, CAPACITY + 1);
    const writes = terminalWrites(f);
    for (const id of ids) assert.equal(writes.get(id)?.length, 1, `${id}: ${JSON.stringify(writes.get(id))} — the ending is written exactly once`);
    // A settled approval is not open: a restart leaves its ending, it does not interrupt it.
    const ended = new Map(ids.map(id => [id, f.supervisor.interactions.records.get(id)!.status]));
    await f.restart();
    for (const [id, status] of ended) assert.equal(f.supervisor.interactions.records.get(id)!.status, status, `${id} after restart`);
  } finally {
    f.cleanup();
  }
}

/** The child's order for a No or a cancel: the resolver closes inside the answer, then the gate closes. */
async function negative(f: Fixture, workerId: string, n: number, extra: Partial<Answer>, outcome: string): Promise<string> {
  const h = f.hosts[0]!;
  const { gate, i } = openApproval(f, workerId, n);
  h.answerUI = async nativeId => {
    h.emit('event', { type: 'resolver_closed', native_id: nativeId, outcome });
    queueMicrotask(() => h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'not_approved' }));
    return { consumed: true, outcome };
  };
  const r = await f.supervisor.answer(workerId, answerOf(f, workerId, n, i, extra));
  assert.equal(r.answer_stage, 3, 'stage 3, honestly: the resolver consumed it and no tool was released');
  await tick();
  const record = f.supervisor.interactionStatus(workerId, i.interaction_id);
  assert.equal(record.outcome, outcome);
  assert.equal(record.answer_stage, 3, 'never stage 4');
  assert.equal(h.commands.some(c => c.type === 'gate_release'), false, 'no release command for a gate that never asked');
  return 'gate_closed';
}

test('interactions settle: 33 approvals answered No each close their gate and free their slot', () => repeated((f, id, n) => negative(f, id, n, { value: false }, 'no')));

test('interactions settle: 33 approvals cancelled each close their gate and free their slot', () =>
  repeated((f, id, n) => negative(f, id, n, { outcome: 'cancel', value: undefined }, 'cancel')));

test('interactions settle: a gate that closes before the answer reply lands settles when the answer returns', () =>
  repeated(async (f, id, n) => {
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, id, n);
    // The resolver, then the gate close, both before the answer's reply is processed (one stdout chunk).
    h.answerUI = async nativeId => {
      h.emit('event', { type: 'resolver_closed', native_id: nativeId, outcome: 'no' });
      h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'not_approved' });
      return { consumed: true, outcome: 'no' };
    };
    const r = await f.supervisor.answer(id, answerOf(f, id, n, i, { value: false }));
    assert.equal(r.state, 'delivered', 'the in-flight answer is not mistaken for a moved binding');
    assert.equal(r.answer_stage, 3);
    return 'gate_closed';
  }));

test('interactions settle: an Allow whose approval expires before the release check closes at stage 3', () =>
  repeated(async (f, id, n) => {
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, id, n);
    h.answerUI = async () => ({ consumed: true, outcome: 'answered' });
    assert.equal((await f.supervisor.answer(id, answerOf(f, id, n, i, {}))).answer_stage, 3);
    h.emit('event', { type: 'resolver_closed', native_id: `native-${n}`, outcome: 'answered' });
    h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'expired' });
    const record = f.supervisor.interactionStatus(id, i.interaction_id);
    assert.equal(record.outcome, 'answered');
    assert.equal(record.answer_stage, 3);
    return 'gate_closed';
  }));

test('interactions settle: a release refused before dispatch, then the gate times out, closes once', () =>
  repeated(async (f, id, n) => {
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, id, n);
    await f.supervisor.answer(id, answerOf(f, id, n, i, {}));
    // A fenced or moving session refuses the release before any dispatch; the child's gate times out meanwhile.
    const live = f.supervisor.state.require(id);
    const checking = f.supervisor.interactions.gate(live.worker, { type: 'gate_check', ...gate } as PiRecord, () => {
      throw new Refusal('session_fenced');
    });
    h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'release_timeout' });
    await checking;
    assert.equal(f.supervisor.receipts.all.get(`answer-${n}:release`)?.state, 'rejected');
    assert.equal(h.commands.some(c => c.type === 'gate_release'), false);
    return 'gate_closed';
  }));

test('interactions settle: a gate that times out while its release is in flight is settled by the release, once', () =>
  repeated(async (f, id, n) => {
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, id, n);
    await f.supervisor.answer(id, answerOf(f, id, n, i, {}));
    const reply = deferred<void>();
    const sent = deferred<void>();
    const original = h.request.bind(h);
    h.request = async c => {
      if (c.type !== 'gate_release') return original(c);
      h.commands.push(c);
      sent.resolve();
      await reply.promise;
      // The child's gate already timed out: no live gate, a correlated denial.
      return { type: 'response', id: 'r', success: true, data: { released: false } };
    };
    h.emit('event', { type: 'gate_check', ...gate });
    await sent.promise;
    h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'release_timeout' });
    reply.resolve();
    for (let k = 0; k < 20 && f.supervisor.receipts.all.get(`answer-${n}:release`)?.state !== 'delivered'; k++) await tick();
    h.request = original;
    const receipt = f.supervisor.receipts.all.get(`answer-${n}:release`)!;
    assert.equal(receipt.state, 'delivered');
    assert.equal(receipt.result?.released, false);
    return 'release_denied';
  }));

test('interactions settle: an answer reply, its release check and the gate close buffered together end the approval once, at its release', () =>
  repeated(async (f, id, n) => {
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, id, n);
    const entered = deferred<void>();
    const reply = deferred<{ consumed: boolean; outcome?: string }>();
    h.answerUI = () => {
      entered.resolve();
      return reply.promise;
    };
    const releaseReply = deferred<void>();
    const original = h.request.bind(h);
    h.request = async c => {
      if (c.type !== 'gate_release') return original(c);
      h.commands.push(c);
      // Its reply comes on a later stdout read. The child's gate already timed out while the supervisor's reader
      // stalled: no live gate, a correlated denial.
      await releaseReply.promise;
      return { type: 'response', id: 'r', success: true, data: { released: false } };
    };
    const answering = f.supervisor.answer(id, answerOf(f, id, n, i, {}));
    await entered.promise;
    // One stdout chunk after a stalled reader (GPT review D1): the answer's reply resolves, then the gate check and
    // the gate's timeout close are handled synchronously, before the answer's continuation runs.
    reply.resolve({ consumed: true, outcome: 'answered' });
    h.emit('event', { type: 'gate_check', ...gate });
    h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'release_timeout' });
    const r = await answering;
    assert.equal(r.state, 'delivered');
    assert.equal(r.answer_stage, 3, 'the answer is honestly stage 3: the exact resolver consumed it');
    releaseReply.resolve();
    for (let k = 0; k < 20 && final(f.supervisor.receipts.all.get(`answer-${n}:release`)) === undefined; k++) await tick();
    h.request = original;
    const receipt = f.supervisor.receipts.all.get(`answer-${n}:release`)!;
    assert.equal(receipt.state, 'delivered', 'the release keeps its own receipt');
    assert.equal(receipt.answer_stage, 3, 'a denied release is never stage 4');
    assert.equal(receipt.result?.released, false);
    assert.deepEqual(terminalWrites(f).get(i.interaction_id), ['release_denied'], 'the release owns the ending: one terminal journal record');
    return 'release_denied';
  }));

test('interactions settle: a released gate settles at its release; the later gate_released changes nothing', () =>
  repeated(async (f, id, n) => {
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, id, n);
    await f.supervisor.answer(id, answerOf(f, id, n, i, {}));
    h.emit('event', { type: 'gate_check', ...gate });
    h.emit('event', { type: 'gate_released', gate_token: gate.gate_token });
    for (let k = 0; k < 5; k++) await tick();
    const receipt = f.supervisor.receipts.all.get(`answer-${n}:release`)!;
    assert.equal(receipt.state, 'delivered');
    assert.equal(receipt.answer_stage, 4);
    h.emit('event', { type: 'gate_released', gate_token: gate.gate_token });
    assert.equal(f.supervisor.interactionStatus(id, i.interaction_id).answer_stage, 4);
    return 'tool_released';
  }));

test('interactions settle: a revoked answering grant denies the release and frees the slot; the child close changes nothing', () =>
  repeated(async (f, id, n) => {
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, id, n);
    await f.supervisor.answer(id, answerOf(f, id, n, i, {}));
    const live = f.supervisor.state.require(id);
    const check = f.supervisor.interactions.gate.bind(f.supervisor.interactions);
    // The answering grant, revoked after the answer and before the release check.
    const l = (f.supervisor.interactions as unknown as { live: Map<string, { guard?: () => void }> }).live.get(i.interaction_id)!;
    l.guard = () => {
      throw new Refusal('grant_revoked');
    };
    await check(live.worker, { type: 'gate_check', ...gate } as PiRecord, () => {});
    h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'release_denied' });
    const receipt = f.supervisor.receipts.all.get(`answer-${n}:release`)!;
    assert.equal(receipt.result?.released, false);
    assert.equal(receipt.answer_stage, 3);
    return 'release_denied';
  }));

test('interactions settle: a consumed approval is interrupted once when pi exits; its late gate close changes nothing', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    const { gate, i } = openApproval(f, w.worker_id, 0);
    await f.supervisor.answer(w.worker_id, answerOf(f, w.worker_id, 0, i, {}));
    h.emit('exit');
    h.emit('event', { type: 'gate_closed', gate_token: gate.gate_token, reason: 'binding_moved' });
    assert.equal(f.supervisor.interactionStatus(w.worker_id, i.interaction_id).status, 'interrupted');
    assert.deepEqual(terminalWrites(f).get(i.interaction_id), ['interrupted']);
  } finally {
    f.cleanup();
  }
});
