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
import { bind, fixture, tick } from './supervisor-fixture.js';
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
