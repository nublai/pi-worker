/**
 * Input and executions (P1-5) on the deterministic host seam: prompt (with if_busy), steer, follow-up queue, cancel
 * and interrupt; the binding check on every session-directed mutation; a lost reply is outcome_unknown and never
 * replayed. Ported cases from A0 `src/test/fix-round.test.ts`, `supervisor.test.ts` and `slice2-fix.test.ts` keep
 * every assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { Refusal } from '../src/b2/errors.js';
import { SdkHost } from '../src/host/host.js';
import { parseJournal } from '../src/journal/journal.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import type { Worker } from '../src/supervisor/state.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { ownerGrant, privateTmp } from './helpers.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';
import type { Receipt } from '../src/receipts/receipts.js';
import { domained } from './domains.js';

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

test('input: an explicit pi refusal before its input hooks is ProvenNoEffect with evidence; a handled prompt settles at once; slash commands refuse', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    const native = h.request.bind(h);
    let reply: 'refused' | 'handled' = 'refused';
    h.request = async c =>
      c.type === 'prompt'
        ? (h.prompts++,
          reply === 'refused'
            ? { type: 'response', id: 'x', success: false, error: 'pi_busy', refused: 'before_input' }
            : { type: 'response', id: 'x', success: true, data: { disposition: 'handled' } })
        : native(c);
    const rejected = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'rejected'), message: 'x' });
    assert.deepEqual([rejected.state, rejected.effect, rejected.admission], ['rejected', 'no_effect', 'rejected']);
    assert.match(rejected.error ?? '', /pi_busy/);
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

test('input: a generic negative pi reply after dispatch is not proof of no effect: prompt and steer are outcome_unknown and fence', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    const native = h.request.bind(h);
    h.request = async c => (c.type === 'prompt' ? (h.prompts++, { type: 'response', id: 'x', success: false, error: 'sdk_command_failed' }) : native(c));
    const failed = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'failed'), message: 'x' });
    assert.deepEqual([failed.state, failed.effect], ['outcome_unknown', 'unknown']);
    let row = f.supervisor.get(w.worker_id);
    assert.equal(row.execution?.state, 'outcome_unknown');
    assert.equal(row.fence?.command_id, 'failed');
    assert.equal(latestWorker(f.journalFile, w.worker_id).fence?.command_id, 'failed', 'the fence is durable');
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'next'), message: 'x' }), (e: unknown) => noEffect('session_fenced')(e) && (e as Refusal).uncertain_command_id === 'failed');

    // A steer pi answers negatively may already have run its input hooks or queued: unknown too.
    const g = fixture();
    try {
      const v = await g.create();
      const hv = g.hosts[0]!;
      const nativeV = hv.request.bind(hv);
      hv.request = async c => (c.type === 'steer' ? { type: 'response', id: 'x', success: false, error: 'sdk_command_failed' } : nativeV(c));
      await g.supervisor.prompt(v.worker_id, { ...bind(v, 'run'), message: 'x' });
      const execution = g.supervisor.get(v.worker_id).execution!;
      const steer = await g.supervisor.steer(v.worker_id, { ...bind(v, 'steer'), execution_id: execution.execution_id, message: 'y' });
      assert.deepEqual([steer.state, steer.effect], ['outcome_unknown', 'unknown']);
      row = g.supervisor.get(v.worker_id);
      assert.ok(row.fence?.uncertain_command_ids?.includes('steer'));
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('input (real pi): a prompt pi refuses after its input hooks ran is outcome_unknown and fences, never no_effect', { timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const state = join(root, 'state');
  const agent = join(root, 'agent');
  const home = join(root, 'home');
  for (const dir of [cwd, state, home, join(agent, 'extensions')]) mkdirSync(dir, { recursive: true });
  // An input hook with an observable effect; pi runs it before its model and credential checks.
  writeFileSync(
    join(agent, 'extensions', 'effect.ts'),
    `import {writeFileSync} from 'node:fs';\nexport default pi => { pi.on('input', (_e, ctx) => { writeFileSync(ctx.cwd + '/input-effect', '1'); return { action: 'continue' }; }); };\n`,
  );
  const opened = openState(state);
  // No credentials anywhere: only PATH, an empty HOME and an empty agent directory. pi refuses at its auth check.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PI_CODING_AGENT_DIR: agent };
  const s = new Supervisor(domained({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: state,
    factory: launch =>
      new SdkHost(
        { cwd: launch.cwd, sessionDir: launch.sessionDir, provider: launch.create.provider, model: launch.create.model, thinking: launch.create.thinking, projectTrusted: false },
        { env },
      ),
  }));
  try {
    const created = await s.create({ command_id: 'create', cwd, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off' });
    assert.equal(created.state, 'delivered', JSON.stringify(created));
    const w = s.get(created.worker_id!);
    const r = await s.prompt(w.worker_id, { ...bind(w, 'hooked'), message: 'an ordinary prompt' });
    assert.equal(existsSync(join(cwd, 'input-effect')), true, 'the input hook ran: an effect happened before pi refused');
    assert.deepEqual([r.state, r.effect], ['outcome_unknown', 'unknown'], JSON.stringify(r));
    assert.equal(s.get(w.worker_id).fence?.command_id, 'hooked');
    assert.equal(latestWorker(opened.journal.file, w.worker_id).fence?.command_id, 'hooked', 'durable');
  } finally {
    await s.shutdown();
    opened.close();
    tmp.cleanup();
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
    // The execution was running when the abort was sent and settled during it (#49).
    assert.deepEqual(cancel.result, { requested: true, disposition: 'interrupted', external_effects_stopped: 'unproven' });
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

/** B2 over the fixture's supervisor, as the bridge calls it (request and response validation on): POST a worker method. */
function b2(f: Fixture): (workerId: string, method: string, json: unknown) => Promise<{ status: number; body: unknown }> {
  const owner = ownerGrant(f.dir);
  const memory = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
  return (workerId, method, json) => memory.request('POST', `/b2/workers/${workerId}/${method}`, { json });
}
const receiptOf = (reply: { body: unknown }) => reply.body as Receipt;
const errorOf = (reply: { body: unknown }) => reply.body as { error: string; effect: string };
const count = (h: { commands: { type: string }[] }, ...types: string[]) => h.commands.filter(c => types.includes(c.type)).length;

test('input: interrupt and cancel naming an already settled execution are refused no_running_execution over B2 with no record; queued input stays and pi gets nothing (#49)', async () => {
  const f = fixture();
  try {
    const call = b2(f);
    const w = await f.create();
    const h = f.hosts[0]!;
    const run = await call(w.worker_id, 'prompt', { ...bind(w, 'run'), message: 'run' });
    assert.equal(run.status, 200);
    const execution_id = receiptOf(run).execution_id!;
    const queued = await call(w.worker_id, 'follow_up', { ...bind(w, 'queued'), message: 'next', execution_id });
    assert.equal(receiptOf(queued).state, 'queued');
    // A lost steer reply fences the session, so the follow-up pauses instead of dispatching when the run settles.
    const native = h.request.bind(h);
    h.request = async c => (c.type === 'steer' ? Promise.reject(new Error('lost')) : native(c));
    const lost = await call(w.worker_id, 'steer', { ...bind(w, 'steer-lost'), message: 'x', execution_id });
    assert.equal(receiptOf(lost).state, 'outcome_unknown');
    h.request = native;
    h.emit('event', { type: 'agent_settled' });
    await tick();
    assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'settled');
    assert.equal(f.supervisor.get(w.worker_id).queued?.[0]?.state, 'paused');
    const journal = readFileSync(f.journalFile);
    for (const method of ['interrupt', 'cancel']) {
      const refused = await call(w.worker_id, method, { ...bind(w, `late-${method}`), execution_id });
      assert.equal(refused.status, 409, method);
      assert.deepEqual([errorOf(refused).error, errorOf(refused).effect], ['no_running_execution', 'no_effect'], method);
      assert.equal(f.supervisor.receipts.all.has(`late-${method}`), false, method);
    }
    assert.deepEqual(readFileSync(f.journalFile), journal, 'a refusal writes nothing');
    assert.equal(count(h, 'clear_queue', 'abort', 'cancel_ui'), 0, 'pi gets nothing');
    assert.equal(f.supervisor.receipts.all.get('queued')?.state, 'queued');
    assert.equal(f.supervisor.get(w.worker_id).queued?.[0]?.state, 'paused');
    // The queue is intact: keeping the uncertain steer lifts the fence and the follow-up dispatches.
    const fence = f.supervisor.get(w.worker_id).fence!;
    const keep = await call(w.worker_id, 'resolve_unknown', { ...bind(w, 'keep'), uncertain_command_id: 'steer-lost', fence_generation: fence.fence_generation, disposition: 'keep' });
    assert.equal(keep.status, 200);
    await tick();
    await tick();
    assert.equal(h.prompts, 2, 'the follow-up ran after the fence lifted');
    assert.equal(f.supervisor.receipts.all.get('queued')?.state, 'delivered');
  } finally {
    f.cleanup();
  }
});

test('input: interrupt and cancel of a running execution report interrupted over B2; with no execution id a settled one is aborted again and reported settled (#49)', async () => {
  const f = fixture();
  try {
    const call = b2(f);
    const w = await f.create();
    const h = f.hosts[0]!;
    for (const method of ['interrupt', 'cancel']) {
      const run = await call(w.worker_id, 'prompt', { ...bind(w, `run-${method}`), message: 'run' });
      const execution_id = receiptOf(run).execution_id!;
      assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'started', method);
      const stopped = await call(w.worker_id, method, { ...bind(w, `stop-${method}`), execution_id });
      assert.equal(stopped.status, 200, method);
      const r = receiptOf(stopped);
      assert.deepEqual([r.operation, r.state, r.effect, r.execution_id], [`executions.${method}`, 'delivered', 'observed', execution_id], method);
      assert.deepEqual(r.result, { requested: true, disposition: 'interrupted', external_effects_stopped: 'unproven' }, method);
      assert.equal(f.supervisor.get(w.worker_id).execution?.state, 'settled', method);
      await tick();
    }
    // No execution id keeps the old behaviour: whatever is current is aborted, and an already settled one is `settled`.
    const aborts = count(h, 'abort');
    const bare = await call(w.worker_id, 'interrupt', bind(w, 'bare'));
    assert.equal(bare.status, 200);
    assert.deepEqual(receiptOf(bare).result, { requested: true, disposition: 'settled', external_effects_stopped: 'unproven' });
    assert.equal(count(h, 'abort'), aborts + 1);
  } finally {
    f.cleanup();
  }
});

test('input: a lost or negative abort reply leaves interrupt and cancel outcome_unknown over B2, with no result, never replayed (#49)', async () => {
  const f = fixture();
  try {
    const call = b2(f);
    const w = await f.create();
    const h = f.hosts[0]!;
    const native = h.request.bind(h);
    for (const failure of ['lost', 'negative']) {
      for (const method of ['interrupt', 'cancel']) {
        const name = `${failure} ${method}`;
        const run = await call(w.worker_id, 'prompt', { ...bind(w, `run-${failure}-${method}`), message: 'run' });
        const execution_id = receiptOf(run).execution_id!;
        h.request = async c => {
          if (c.type !== 'abort') return native(c);
          h.commands.push(c);
          if (failure === 'lost') throw new Error('lost');
          return { type: 'response', id: 'x', success: false, error: 'abort_failed' };
        };
        const body = { ...bind(w, `${failure}-${method}`), execution_id };
        const unknown = receiptOf(await call(w.worker_id, method, body));
        assert.deepEqual([unknown.state, unknown.effect, unknown.result], ['outcome_unknown', 'unknown', undefined], name);
        const aborts = count(h, 'abort');
        const again = receiptOf(await call(w.worker_id, method, body));
        assert.deepEqual([again.state, again.effect, again.result], ['outcome_unknown', 'unknown', undefined], name);
        assert.equal(count(h, 'abort'), aborts, 'the same command is never sent again');
        h.request = native;
        h.emit('event', { type: 'agent_settled' });
        await tick();
      }
    }
  } finally {
    f.cleanup();
  }
});

for (const hold of ['cancel_ui', 'clear_queue'] as const) {
  for (const method of ['interrupt', 'cancel']) {
    test(`input: a ${method} of A held at ${hold} while A settles and B is admitted never aborts B; the receipt and result describe A (#49 review F1)`, async () => {
      const f = fixture();
      try {
        const call = b2(f);
        const w = await f.create();
        const h = f.hosts[0]!;
        const a = receiptOf(await call(w.worker_id, 'prompt', { ...bind(w, 'run-a'), message: 'a' })).execution_id!;
        assert.equal(receiptOf(await call(w.worker_id, 'follow_up', { ...bind(w, 'queued'), message: 'next', execution_id: a })).state, 'queued');
        // A live dialog, so the control waits at its native cancellation.
        h.emit('event', { type: 'extension_ui_request', method: 'input', id: 'dialog' });
        const native = h.request.bind(h);
        let reached = false;
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        h.request = async c => {
          if (c.type === hold) {
            reached = true;
            await gate;
          }
          return native(c);
        };
        const stopping = call(w.worker_id, method, { ...bind(w, `stop-${method}`), execution_id: a });
        for (let n = 0; n < 200 && !reached; n++) await tick();
        assert.equal(reached, true, `the control reached ${hold}`);
        // A settles on its own; another caller's prompt B is admitted and running.
        h.emit('event', { type: 'agent_settled' });
        await tick();
        const b = receiptOf(await call(w.worker_id, 'prompt', { ...bind(w, 'run-b'), message: 'b' }));
        assert.equal(b.state, 'delivered');
        assert.notEqual(b.execution_id, a);
        release();
        const r = receiptOf(await stopping);
        assert.deepEqual([r.state, r.effect, r.execution_id], ['delivered', 'observed', a]);
        assert.deepEqual(r.result, { requested: true, disposition: 'settled', abort_sent: false, clear_queue_sent: hold === 'clear_queue', queued_dropped: 1, dialogs_cancelled: 1 });
        assert.equal(count(h, 'abort'), 0, 'pi never got an abort');
        assert.equal(count(h, 'clear_queue'), hold === 'clear_queue' ? 1 : 0, "pi's queue is cleared only while A is current");
        assert.equal(f.supervisor.receipts.all.get('queued')?.disposition, 'abandoned_without_dispatch');
        const row = f.supervisor.get(w.worker_id);
        assert.deepEqual([row.execution?.execution_id, row.execution?.state, row.foreground], [b.execution_id, 'started', 'running'], 'B keeps running');
      } finally {
        f.cleanup();
      }
    });
  }
}

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
      // P2-1: a failed journal cannot record the domain's removal, and an unrecorded removal is no confirmation, so the
      // worker stays cleanup_pending (A0 containment: "a failed journal … never records cleanup as confirmed").
      assert.equal(f.supervisor.get(w.worker_id).status, failure === 'journal' ? 'cleanup_pending' : 'failed');
      assert.equal(f.supervisor.get(w.worker_id).fence, null, 'observed settlement is not a new uncertainty');
      assert.equal(f.supervisor.list().find(x => x.worker_id === healthy.worker_id)?.status, 'ready');
      const owner = ownerGrant(f.dir);
      const hello = await createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers).request('GET', '/b2/hello');
      assert.equal((hello.body as { protocol: { major: number } }).protocol.major, 0);
      if (failure === 'journal') await assert.rejects(f.supervisor.prompt(healthy.worker_id, { ...bind(healthy, 'blocked'), message: 'no' }), /journal_failed/);
      else assert.equal((await f.supervisor.prompt(healthy.worker_id, { ...bind(healthy, 'allowed'), message: 'yes' })).state, 'delivered');
    } finally {
      f.cleanup();
    }
  });
}

test('validation refusals consume no durable storage, ordinary capacity never blocks termination', async () => {
  // A0's ordinary quota was 512 receipts; P1-12 raised the default, so this port runs with A0's bound.
  const f = fixture({ receiptCap: 512 });
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
      const recovered = new Supervisor(domained({ journal: state.journal, receipts: new ReceiptStore(state.journal), supervisorEpoch: state.supervisorEpoch, stateDir: cut.dir, factory: () => assert.fail('no launch') }));
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
    const s = new Supervisor(domained({ journal: state.journal, receipts: new ReceiptStore(state.journal), supervisorEpoch: state.supervisorEpoch, stateDir: dir, factory: () => assert.fail('no spawn/replay') }));
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
