/**
 * The journal budget (PR #12 review F2): every record ordinary work can emit (its receipts, its worker's rows,
 * settlements, interactions) is budgeted before dispatch, ordinary work that cannot fit is refused `no_effect`, and
 * ordinary records never spend the control reserve or the room each worker's own stop needs. Control records may.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { Journal, JournalCapacity } from '../src/journal/journal.js';
import { bind, fixture, tick, type Fixture, type Host } from './supervisor-fixture.js';
import { ownerGrant, privateTmp } from './helpers.js';

/** The reviewer's spec: schema-valid, 1,800 unused denied-tool names of 126 characters (a 232 KB request). */
const largeSpec = (i: number) => ({
  environment: { id: 'env', revision: 1, allowed_methods: ['children.report'] },
  role: 'worker',
  tools: [],
  denied_tools: Array.from({ length: 1800 }, (_, k) => `d${i}-${k}-`.padEnd(126, 'x')),
  resources: { extensions: [], skills: [] },
  grant_methods: ['children.report'],
  seed_mode: 'standalone' as const,
});

test('retention: large ordinary creates are refused no_effect before they reach the control reserve; every stop still runs (review F2)', { timeout: 300_000 }, async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const b2 = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const journal = f.state.journal;
    const small = await f.create();
    const created: string[] = [];
    let refusal: unknown;
    for (let i = 0; i < 200 && refusal === undefined; i++) {
      const cwd = join(f.dir, `big-${i}`);
      mkdirSync(cwd);
      const body = { command_id: `big-${i}`, cwd, provider: 'p', model: 'm', thinking: 'off', launch_spec: largeSpec(i) };
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < 256 * 1024, 'within the JSON body limit');
      const r = await b2.request('POST', '/b2/workers', { json: body });
      if (r.status !== 200) {
        refusal = [r.status, r.body];
        break;
      }
      const id = (r.body as { worker_id: string }).worker_id;
      created.push(id);
      // A prompt that settles spends the worker's ordinary budget (admit, reply, start, settle rows).
      const p = await b2.request('POST', `/b2/workers/${id}/prompt`, { json: { ...bind(f.supervisor.get(id), `run-${i}`), message: 'x' } });
      if (p.status !== 200) refusal = [p.status, p.body];
      else f.hosts.at(-1)!.emit('event', { type: 'agent_settled' });
      await tick();
    }
    assert.ok(created.length >= 3, `large creates run while they fit (${created.length})`);
    assert.deepEqual(refusal, [409, { error: 'journal_result_capacity', effect: 'no_effect' }], 'the ordinary command that does not fit is refused before dispatch');
    assert.equal(journal.failed, false, 'the journal never fails');
    const free = journal.maxBytes - journal.size() - journal.reservedBytes;
    assert.ok(free >= f.supervisor.receipts.limits.controlReserveBytes, `ordinary work left the control reserve free (${free} B)`);
    // Every large worker's pi exits at once: their exit rows are written with no compaction in between.
    for (const host of f.hosts.slice(1)) host.emit('exit');
    assert.ok(created.every(id => f.supervisor.get(id).cleanup === 'leader_exit_only'), 'every exit is recorded');
    assert.equal(journal.failed, false, 'the exits never fail the journal');
    for (const id of [small.worker_id, ...created]) {
      const r = await b2.request('POST', `/b2/workers/${id}/stop`, { json: bind(f.supervisor.get(id), `stop-${id}`) });
      assert.deepEqual([r.status, (r.body as { state?: string }).state], [200, 'delivered'], `stop of ${id === small.worker_id ? 'the small worker' : 'a large worker'} runs`);
    }
    assert.equal(journal.failed, false, 'stopping every worker never fails the journal');
  } finally {
    f.cleanup();
  }
});

test('retention: an ordinary record that would enter the control reserve is refused and leaves the journal usable; a control record may use it (review F2)', () => {
  const tmp = privateTmp();
  const journal = new Journal(join(tmp.dir, 'journal'), 64 * 1024);
  try {
    journal.controlReserveBytes = 16 * 1024;
    const value = { pad: 'x'.repeat(4000) };
    let n = 0;
    for (;;) {
      try {
        journal.append('settlement', value, 'settlement.record');
        n++;
      } catch (error) {
        assert.ok(error instanceof JournalCapacity, String(error));
        break;
      }
    }
    assert.ok(n > 0);
    assert.equal(journal.failed, false, 'a refused ordinary record fails nothing');
    assert.ok(journal.maxBytes - journal.size() >= 16 * 1024 - 0, 'the control reserve is still free');
    journal.append('worker', value, 'worker.stop', { control: true });
    journal.append('worker', value, 'worker.stopped', { control: true });
    assert.equal(journal.failed, false, 'control records use the reserve');
  } finally {
    journal.close();
    tmp.cleanup();
  }
});

/** A prompt reply the test holds: the host counts the prompt and emits `agent_start`, then waits for `release`. */
function holdPrompts(host: Host): { release: (ok: boolean) => void; started: () => boolean } {
  let release!: (ok: boolean) => void;
  const reply = new Promise<boolean>(r => (release = r));
  let started = false;
  const native = host.request.bind(host);
  host.request = async c => {
    if (c.type !== 'prompt') return native(c);
    host.prompts++;
    started = true;
    host.emit('event', { type: 'agent_start' });
    if (!(await reply)) throw new Error('lost_prompt_reply');
    return { type: 'response', id: 'x', success: true, data: { disposition: 'started' } };
  };
  return { release: ok => release(ok), started: () => started };
}

/** Quota-exempt `children.report`s over B2 with 8 KiB messages until admission refuses one; returns how many ran. */
async function fillWithReports(b2: ReturnType<typeof createMemoryTransport>, f: Fixture, reporter: string): Promise<number> {
  for (let i = 0; i < 10_000; i++) {
    const r = await b2.request('POST', `/b2/workers/${reporter}/report`, { json: { ...bind(f.supervisor.get(reporter), `report-${i}`), task_id: 'task', result_digest: 'sha256:claim', kind: 'result', message: 'r'.repeat(8192) } });
    if (r.status !== 200) {
      assert.deepEqual([r.status, r.body], [409, { error: 'journal_result_capacity', effect: 'no_effect' }], 'control traffic stops only at the journal bound');
      return i;
    }
  }
  throw new Error('reports never filled the journal');
}

test('retention: an admitted prompt whose reply waits while quota-exempt reports fill the journal still records its result (review F7)', { timeout: 120_000 }, async () => {
  const f = fixture({ journalBytes: 512 * 1024, retention: { controlReserveBytes: 64 * 1024 } });
  try {
    const owner = ownerGrant(f.dir);
    const b2 = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const journal = f.state.journal;
    const w = await f.create();
    const hold = holdPrompts(f.hosts[0]!);
    const prompt = b2.request('POST', `/b2/workers/${w.worker_id}/prompt`, { json: { ...bind(w, 'held'), message: 'run' } });
    while (!hold.started()) await tick();
    const reports = await fillWithReports(b2, f, w.worker_id);
    assert.ok(reports > 0, 'reports ran while the prompt waited');
    assert.ok(journal.maxBytes - journal.size() - journal.reservedBytes < journal.floor(), 'control traffic used the room ordinary records leave free');
    hold.release(true);
    const r = await prompt;
    assert.deepEqual([r.status, (r.body as { state?: string }).state], [200, 'delivered'], 'the prompt held across control traffic is delivered');
    assert.equal(f.supervisor.receipts.all.get('held')?.state, 'delivered', 'its stored receipt is final');
    assert.equal(journal.failed, false, 'the journal never fails');
    assert.equal(f.hosts[0]!.prompts, 1, 'pi received the prompt once');
  } finally {
    f.cleanup();
  }
});

test('retention: a prompt whose reply is lost after control traffic drained its worker budget and the free room still ends outcome_unknown and fences (review F7)', { timeout: 120_000 }, async () => {
  const f = fixture({ journalBytes: 2 * 1024 * 1024, retention: { controlReserveBytes: 128 * 1024 } });
  try {
    const owner = ownerGrant(f.dir);
    const b2 = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const journal = f.state.journal;
    const reporter = await f.create();
    // A worker whose rows are large (its launch spec is part of each row): one row does not fit in what control
    // traffic leaves free.
    const cwd = join(f.dir, 'big');
    mkdirSync(cwd);
    const spec = { ...largeSpec(0), denied_tools: largeSpec(0).denied_tools.slice(0, 300) };
    const created = await b2.request('POST', '/b2/workers', { json: { command_id: 'big', cwd, provider: 'p', model: 'm', thinking: 'off', launch_spec: spec } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = (created.body as { worker_id: string }).worker_id;
    const hold = holdPrompts(f.hosts.at(-1)!);
    const prompt = b2.request('POST', `/b2/workers/${id}/prompt`, { json: { ...bind(f.supervisor.get(id), 'lost'), message: 'run' } });
    while (!hold.started()) await tick();
    // Interrupts (quota exempt) write the worker's rows: they spend what is left of its budget.
    for (let i = 0; i < 3; i++) {
      const r = await b2.request('POST', `/b2/workers/${id}/interrupt`, { json: bind(f.supervisor.get(id), `interrupt-${i}`) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    await fillWithReports(b2, f, reporter.worker_id);
    const row = Buffer.byteLength(JSON.stringify(f.state.journal.records.findLast(r => r.kind === 'worker' && r.value.worker && (r.value.worker as { worker_id: string }).worker_id === id)!.value));
    assert.ok(journal.maxBytes - journal.size() - journal.reservedBytes < row, `control traffic left less free room than one row of the worker (${row} B)`);
    hold.release(false);
    const r = await prompt;
    assert.equal((r.body as { state?: string }).state, 'outcome_unknown', `the lost reply is outcome_unknown (${r.status} ${JSON.stringify(r.body)})`);
    assert.equal(f.supervisor.receipts.all.get('lost')?.state, 'outcome_unknown', 'its stored receipt is outcome_unknown');
    assert.equal(journal.failed, false, 'the journal never fails');
    assert.equal(f.supervisor.get(id).fence?.command_id, 'lost', 'the unknown prompt fences its session');
    const durable = f.state.journal.records.findLast(r => r.kind === 'worker' && (r.value.worker as { worker_id: string }).worker_id === id)!.value.worker as { fence?: { command_id: string } };
    assert.equal(durable.fence?.command_id, 'lost', 'the fence is durable');
    const steer = await b2.request('POST', `/b2/workers/${id}/prompt`, { json: { ...bind(f.supervisor.get(id), 'after'), message: 'again' } });
    assert.deepEqual([steer.status, (steer.body as { error?: string }).error], [409, 'session_fenced'], 'a later write is refused session_fenced');
  } finally {
    f.cleanup();
  }
});
