/**
 * Input and executions (P1-5) on the deterministic host seam: prompt (with if_busy), steer, follow-up queue, cancel
 * and interrupt; the binding check on every session-directed mutation; a lost reply is outcome_unknown and never
 * replayed. Ported cases from A0 `src/test/fix-round.test.ts`, `supervisor.test.ts` and `slice2-fix.test.ts` keep
 * every assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { Refusal } from '../src/b2/errors.js';
import { parseJournal } from '../src/journal/journal.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import type { Worker } from '../src/supervisor/state.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { privateTmp } from './helpers.js';
import { bind, fixture, tick } from './supervisor-fixture.js';

const records = (file: string) => parseJournal(readFileSync(file)).records;
const latestWorker = (file: string, id: string): Worker =>
  records(file).filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === id).at(-1)!.value.worker as Worker;
const noEffect = (message: RegExp | string) => (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && (typeof message === 'string' ? e.message === message : message.test(e.message));

test('input: prompt admission, pi start and agent_settled are distinct; settlement is journaled evidence', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    // The fixture host emits agent_start inside the request; hold it so admission is observable first.
    const native = h.request.bind(h);
    let started!: () => void;
    h.request = async c => {
      if (c.type === 'prompt') {
        h.prompts++;
        await new Promise<void>(r => (started = r));
        h.emit('event', { type: 'agent_start' });
        return { type: 'response', id: 'x', success: true, data: { disposition: 'started' } };
      }
      return native(c);
    };
    const pending = f.supervisor.prompt(w.worker_id, { ...bind(w, 'turn'), message: 'hello' });
    await tick();
    assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'admitted');
    assert.equal(f.supervisor.get(w.worker_id).foreground, 'running');
    started();
    const r = await pending;
    assert.deepEqual([r.state, r.admission, r.disposition, r.effect], ['delivered', 'accepted', 'started', 'observed']);
    const execution = f.supervisor.get(w.worker_id).execution!;
    assert.equal(execution.state, 'started');
    assert.equal(r.execution_id, execution.execution_id);
    h.emit('event', { type: 'agent_end' });
    assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'started', 'agent_end is not settlement');
    h.emit('event', { type: 'agent_settled' });
    assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'settled');
    assert.equal(f.supervisor.get(w.worker_id).foreground, 'idle');
    const settlement = records(f.journalFile).filter(x => x.kind === 'settlement');
    assert.deepEqual(settlement.map(x => [x.value.execution_id, x.value.command_id, x.value.source]), [[execution.execution_id, 'turn', 'pi.agent_settled']]);
    assert.equal(readFileSync(f.journalFile, 'utf8').includes('hello'), false, 'no prompt text in the journal');
  } finally {
    f.cleanup();
  }
});

test('supervisor dispatch marker with execution ID is fsynced before the host receives prompt (M2)', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.before = c => {
      if (c.type !== 'prompt') return;
      const all = records(f.journalFile);
      const last = all.at(-1)!;
      assert.equal(last.kind, 'receipt');
      assert.equal(last.value.state, 'accepted');
      assert.equal(last.value.execution_id, f.supervisor.get(w.worker_id).execution?.execution_id);
      assert.equal(last.value.command_id, 'ordered');
      assert.ok(all.some(r => r.kind === 'receipt' && r.value.command_id === 'ordered' && r.value.state === 'intent'));
    };
    const r = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'ordered'), message: 'hi' });
    assert.equal(r.state, 'delivered');
    assert.equal(f.hosts[0]!.prompts, 1);
  } finally {
    f.cleanup();
  }
});

test('input: every session-directed mutation refuses a stale binding no_effect, with no record and no native effect', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
    const stale = { ...bind(w, 'stale'), binding_revision: 2 };
    const before = readFileSync(f.journalFile);
    const calls: [string, () => Promise<unknown>][] = [
      ['prompt', () => f.supervisor.prompt(w.worker_id, { ...stale, message: 'x', if_busy: 'follow_up' })],
      ['steer', () => f.supervisor.steer(w.worker_id, { ...stale, message: 'x', execution_id })],
      ['follow_up', () => f.supervisor.followUp(w.worker_id, { ...stale, message: 'x', execution_id })],
      ['cancel', () => f.supervisor.control(w.worker_id, stale, false)],
      ['interrupt', () => f.supervisor.control(w.worker_id, stale, true)],
      ['stop', () => f.supervisor.stop(w.worker_id, stale)],
      ['epoch', () => f.supervisor.prompt(w.worker_id, { ...bind(w, 'stale'), worker_epoch: 'other', message: 'x' })],
    ];
    for (const [name, call] of calls) {
      await assert.rejects(call(), (e: unknown) => {
        assert.ok(e instanceof Refusal, name);
        assert.equal(e.message, 'stale_binding', name);
        assert.equal(e.effect, 'no_effect', name);
        assert.equal(e.details.received_binding_revision, name === 'epoch' ? 1 : 2, name);
        return true;
      });
    }
    assert.deepEqual(readFileSync(f.journalFile), before);
    assert.equal(f.supervisor.receipts.all.has('stale'), false);
    assert.equal(f.hosts[0]!.prompts, 1);
    assert.deepEqual(
      f.hosts[0]!.commands.filter(c => ['steer', 'abort', 'clear_queue'].includes(c.type)),
      [],
    );
  } finally {
    f.cleanup();
  }
});

test('input: a dropped prompt reply is outcome_unknown, durable before the reply, and a retry never replays it', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.failure = true;
    const p = { ...bind(w, 'lost'), message: 'run' };
    const r = await f.supervisor.prompt(w.worker_id, p);
    assert.deepEqual([r.state, r.effect, r.stage], ['outcome_unknown', 'unknown', 'unknown']);
    assert.equal(latestWorker(f.journalFile, w.worker_id).execution?.state, 'outcome_unknown');
    assert.equal(f.supervisor.get(w.worker_id).foreground, 'unknown');
    assert.deepEqual(await f.supervisor.prompt(w.worker_id, p), r);
    assert.equal(f.hosts[0]!.prompts, 1, 'no replay');
    // From P1-6 the unknown outcome fences the session: the next write is refused naming it.
    await assert.rejects(
      f.supervisor.prompt(w.worker_id, { ...bind(w, 'next'), message: 'no' }),
      (e: unknown) => noEffect('session_fenced')(e) && (e as Refusal).uncertain_command_id === 'lost',
    );
  } finally {
    f.cleanup();
  }
});

test('input: a negative pi reply is ProvenNoEffect with evidence; a handled prompt settles at once; slash commands refuse', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    const native = h.request.bind(h);
    let reply: 'negative' | 'handled' = 'negative';
    h.request = async c => (c.type === 'prompt' ? (h.prompts++, reply === 'negative' ? { type: 'response', id: 'x', success: false } : { type: 'response', id: 'x', success: true, data: { disposition: 'handled' } }) : native(c));
    const rejected = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'rejected'), message: 'x' });
    assert.deepEqual([rejected.state, rejected.effect, rejected.admission], ['rejected', 'no_effect', 'rejected']);
    assert.equal(f.supervisor.get(w.worker_id).execution, null);
    assert.equal(f.supervisor.get(w.worker_id).foreground, 'idle');
    reply = 'handled';
    const handled = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'handled'), message: 'x' });
    assert.equal(handled.disposition, 'handled');
    assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'settled');
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'slash'), message: ' /new' }), noEffect('slash_commands_use_typed_methods'));
    assert.equal(h.prompts, 2);
  } finally {
    f.cleanup();
  }
});

test('input: if_busy reject, follow_up and steer while an execution runs', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'busy'), message: 'x' }), noEffect('worker_busy'));
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'busy-2'), message: 'x', if_busy: 'reject' }), noEffect('worker_busy'));
    assert.equal(f.supervisor.receipts.all.has('busy'), false);
    const steered = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'steer-via-prompt'), message: 'also', if_busy: 'steer' });
    assert.deepEqual([steered.state, steered.disposition], ['delivered', 'queued']);
    assert.deepEqual(
      h.commands.filter(c => c.type === 'steer').map(c => c.message),
      ['also'],
    );
    const queued = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'after'), message: 'after', if_busy: 'follow_up' });
    assert.deepEqual([queued.state, queued.admission, queued.effect], ['queued', 'queued', 'no_effect']);
    assert.equal(h.prompts, 1, 'queued, not sent');
    h.emit('event', { type: 'agent_settled' });
    await tick();
    await tick();
    assert.equal(h.prompts, 2, 'dispatched once after settlement');
    assert.equal(f.supervisor.receipts.all.get('after')?.state, 'delivered');
    assert.equal(f.supervisor.get(w.worker_id).queued?.[0]?.state, 'dispatched');
    assert.equal(f.supervisor.get(w.worker_id).execution?.command_id, 'after');
  } finally {
    f.cleanup();
  }
});

test('input: sessions.steer needs the running execution; its disposition comes from pi', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    await assert.rejects(f.supervisor.steer(w.worker_id, { ...bind(w, 'idle'), message: 'x', execution_id: 'none' }), noEffect('stale_execution'));
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
    await assert.rejects(f.supervisor.steer(w.worker_id, { ...bind(w, 'other'), message: 'x', execution_id: 'other' }), noEffect('stale_execution'));
    const native = h.request.bind(h);
    h.request = async c => (c.type === 'steer' ? { type: 'response', id: 'x', success: true, data: { disposition: 'queued' } } : native(c));
    const r = await f.supervisor.steer(w.worker_id, { ...bind(w, 'steer'), message: 'look', execution_id });
    assert.deepEqual([r.state, r.disposition, r.execution_id], ['delivered', 'queued', execution_id]);
    h.emit('event', { type: 'agent_settled' });
    await assert.rejects(f.supervisor.steer(w.worker_id, { ...bind(w, 'late'), message: 'x', execution_id }), noEffect('no_running_execution'));
    h.request = async c => (c.type === 'steer' ? Promise.reject(new Error('lost')) : native(c));
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run-2'), message: 'run' });
    const lost = await f.supervisor.steer(w.worker_id, { ...bind(w, 'steer-lost'), message: 'x', execution_id: f.supervisor.get(w.worker_id).execution!.execution_id });
    assert.deepEqual([lost.state, lost.effect], ['outcome_unknown', 'unknown']);
  } finally {
    f.cleanup();
  }
});

test('input: follow-ups queue against the named execution, in order, capped at 32', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    await assert.rejects(f.supervisor.followUp(w.worker_id, { ...bind(w, 'nothing'), message: 'x', execution_id: 'x' }), noEffect('stale_execution'));
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
    for (let i = 0; i < 32; i++) assert.equal((await f.supervisor.followUp(w.worker_id, { ...bind(w, `q-${i}`), message: `q-${i}`, execution_id })).state, 'queued');
    await assert.rejects(f.supervisor.followUp(w.worker_id, { ...bind(w, 'q-32'), message: 'x', execution_id }), noEffect('queue_capacity'));
    const sent: string[] = [];
    const native = h.request.bind(h);
    h.request = async c => {
      if (c.type === 'prompt') sent.push(String(c.message));
      return native(c);
    };
    for (let i = 0; i < 3; i++) {
      h.emit('event', { type: 'agent_settled' });
      await tick();
      await tick();
    }
    assert.deepEqual(sent, ['q-0', 'q-1', 'q-2']);
    assert.equal(f.supervisor.receipts.all.get('q-1')?.operation, 'sessions.follow_up');
  } finally {
    f.cleanup();
  }
});

test('input: cancel and interrupt drop queued input, clear pi’s queue, abort, and report requested and observed', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
    const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
    await f.supervisor.followUp(w.worker_id, { ...bind(w, 'queued'), message: 'q', execution_id });
    await assert.rejects(f.supervisor.control(w.worker_id, { ...bind(w, 'wrong'), execution_id: 'other' }, false), noEffect('stale_execution'));
    const cancel = await f.supervisor.control(w.worker_id, { ...bind(w, 'cancel'), execution_id }, false);
    assert.equal(cancel.state, 'delivered');
    assert.deepEqual(cancel.result, { requested: true, disposition: 'settled', external_effects_stopped: 'unproven' });
    assert.equal(f.supervisor.receipts.all.get('queued')?.disposition, 'abandoned_without_dispatch');
    assert.equal(f.supervisor.get(w.worker_id).queued?.[0]?.state, 'dropped');
    assert.deepEqual(
      h.commands.filter(c => ['clear_queue', 'abort'].includes(c.type)).map(c => c.type),
      ['clear_queue', 'abort'],
    );
    const interrupt = await f.supervisor.control(w.worker_id, bind(w, 'interrupt'), true);
    assert.equal(interrupt.operation, 'executions.interrupt');
    assert.equal(interrupt.result?.requested, true);
    await tick();
    assert.equal(h.prompts, 1, 'the dropped follow-up never ran');
    h.emit('exit');
    const noHost = await f.supervisor.control(w.worker_id, bind(w, 'after-exit'), false);
    assert.deepEqual(noHost.result, { requested: true, disposition: 'unknown', profile: 'no_live_host' });
  } finally {
    f.cleanup();
  }
});

for (const failure of ['journal', 'header']) {
  test(`${failure} failure in a Pi event faults only that worker and keeps inventory readable`, async () => {
    const f = fixture();
    try {
      const w = await f.create();
      const healthy = await f.create();
      await f.supervisor.prompt(w.worker_id, { ...bind(w, 'active'), message: 'hi' });
      if (failure === 'journal') f.state.journal.failed = true;
      else writeFileSync(f.hosts[0]!.file, `${JSON.stringify({ type: 'session', id: 'wrong-header' })}\n`);
      assert.doesNotThrow(() => f.hosts[0]!.emit('event', { type: 'agent_settled' }));
      await new Promise<void>(r => setImmediate(r));
      assert.ok(f.hosts[0]!.stops > 0);
      assert.equal(f.hosts[1]!.stops, 0);
      assert.equal(f.supervisor.get(w.worker_id).status, 'failed');
      assert.equal(f.supervisor.get(w.worker_id).fence, null, 'observed settlement is not a new uncertainty');
      assert.equal(f.supervisor.list().find(x => x.worker_id === healthy.worker_id)?.status, 'ready');
      const hello = await createMemoryTransport(createApp({ supervisor: f.supervisor }).handle).request('GET', '/b2/hello');
      assert.equal((hello.body as { protocol: { major: number } }).protocol.major, 0);
      if (failure === 'journal') await assert.rejects(f.supervisor.prompt(healthy.worker_id, { ...bind(healthy, 'blocked'), message: 'no' }), /journal_failed/);
      else assert.equal((await f.supervisor.prompt(healthy.worker_id, { ...bind(healthy, 'allowed'), message: 'yes' })).state, 'delivered');
    } finally {
      f.cleanup();
    }
  });
}

test('validation refusals consume no durable storage, ordinary capacity never blocks termination', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const before = readFileSync(f.journalFile);
    for (let i = 0; i < 520; i++) await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, `stale-${i}`), binding_revision: 99, message: 'no' }), /stale_binding/);
    assert.deepEqual(readFileSync(f.journalFile), before);
    assert.equal(f.supervisor.receipts.all.size, 1);
    // Fill the real ordinary quota with accepted/handled no-run commands.
    f.hosts[0]!.request = async c => (c.type === 'prompt' ? { type: 'response', id: 'x', success: true, data: { disposition: 'handled' } } : assert.fail('unexpected'));
    for (let i = 0; i < 511; i++) assert.equal((await f.supervisor.prompt(w.worker_id, { ...bind(w, `handled-${i}`), message: 'hi' })).state, 'delivered');
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'full'), message: 'no' }), /receipt_capacity/);
    assert.equal((await f.supervisor.stop(w.worker_id, bind(w, 'stop'))).state, 'delivered');
  } finally {
    f.cleanup();
  }
});

test('fault after settlement never fences the settled execution (N-2)', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'done'), message: 'hi' });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    writeFileSync(f.hosts[0]!.file, `${JSON.stringify({ type: 'session', id: 'wrong' })}\n`);
    f.supervisor.get(w.worker_id);
    await new Promise<void>(r => setImmediate(r));
    assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'settled');
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
  } finally {
    f.cleanup();
  }
});

test('execution reservation cut before dispatch stays no_effect on recovery', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const id = w.worker_id;
    const journal = f.state.journal;
    const append = journal.append.bind(journal);
    const cut = privateTmp();
    journal.append = (kind, value, label, reservation) => {
      // Snapshot a real append boundary: reserved execution, just BEFORE dispatch.
      if (kind === 'receipt' && value.command_id === 'reserved' && value.state === 'accepted') writeFileSync(`${cut.dir}/journal.jsonl`, readFileSync(f.journalFile));
      return append(kind, value, label, reservation);
    };
    await f.supervisor.prompt(id, { ...bind(w, 'reserved'), message: 'fixture' });
    const state = openState(cut.dir);
    try {
      const recovered = new Supervisor({ journal: state.journal, receipts: new ReceiptStore(state.journal), supervisorEpoch: state.supervisorEpoch, stateDir: cut.dir, factory: () => assert.fail('no launch') });
      await recovered.recover();
      assert.equal(recovered.receipts.all.get('reserved')?.effect, 'no_effect');
      assert.equal(recovered.receipts.all.get('reserved')?.state, 'intent_recovered');
      assert.throws(() => recovered.receipts.dispatch('reserved'), /owner resolution/);
      assert.equal(recovered.get(id).fence, null);
      assert.equal(recovered.get(id).execution?.disposition, 'no_effect_before_dispatch');
    } finally {
      state.close();
      cut.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('automatic follow_up flush is not owner-ready and recovers without redispatch eligibility', async () => {
  const out = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/queue-cut.js', import.meta.url))], { encoding: 'utf8', timeout: 15000 });
  const dir = out.stdout.trim();
  assert.equal(out.signal, 'SIGKILL', out.stderr);
  const state = openState(dir);
  try {
    const pre = parseJournal(readFileSync(state.journal.file)).records;
    const queued = pre.filter(r => r.kind === 'receipt' && r.value.command_id === 'queued').at(-1)!;
    assert.equal(queued.value.state, 'queue_ready', 'automatic flush must never claim owner resolution');
    const s = new Supervisor({ journal: state.journal, receipts: new ReceiptStore(state.journal), supervisorEpoch: state.supervisorEpoch, stateDir: dir, factory: () => assert.fail('no spawn/replay') });
    await s.recover();
    const r = s.receipts.all.get('queued')!;
    assert.equal(r.state, 'intent_recovered');
    assert.equal(r.effect, 'no_effect');
    assert.deepEqual(s.list()[0]!.resolutions ?? [], []);
    assert.equal(s.list()[0]!.fence, null);
    const retry = await s.receipts.run(
      'queued',
      r.operation,
      { ...bind(s.list()[0]!, 'queued'), worker_id: s.list()[0]!.worker_id, execution_id: s.list()[0]!.execution!.execution_id, message: 'next' },
      async () => assert.fail('retry needs owner resolution'),
    );
    assert.deepEqual(retry, r);
  } finally {
    state.close();
    (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
  }
});
