/**
 * Fence regressions (P1-6), ported from A0 `src/test/fix-round.test.ts` (M1, M6, M9, unknown stop),
 * `supervisor.test.ts` (crash after admission) and `slice2-fix.test.ts` (observed evidence). Every assertion kept;
 * A0's direct journal and supervisor construction become the fixture's restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { parseJournal } from '../src/journal/journal.js';
import type { Receipt } from '../src/receipts/receipts.js';
import type { Worker } from '../src/supervisor/state.js';
import { bind, fixture } from './supervisor-fixture.js';

function latestWorker(file: string, id: string): Worker {
  return parseJournal(readFileSync(file)).records.filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === id).at(-1)!.value.worker as Worker;
}

for (const failure of ['pi prompt response timeout', 'stdin write failed']) {
  test(`HTTP ${failure}: unknown and durable fence before response headers (M1, M6)`, async () => {
    const f = fixture();
    const server = createB2Server(createApp({ supervisor: f.supervisor }).handle);
    try {
      await listenPrivate(server, join(f.dir, 'socket'));
      const w = await f.create();
      const h = f.hosts[0]!;
      const native = h.request.bind(h);
      h.request = async c => {
        if (c.type !== 'prompt') return native(c);
        h.prompts++;
        throw new Error(failure);
      };
      const r = await new Promise<Receipt>((resolve, reject) => {
        const data = JSON.stringify({ ...bind(w, 'uncertain'), message: 'hello' });
        const req = request({ socketPath: join(f.dir, 'socket'), method: 'POST', path: `/b2/workers/${w.worker_id}/prompt`, headers: { 'Content-Type': 'application/json' } }, res => {
          try {
            // Inspect disk as headers arrive, before the HTTP result promise resolves.
            const persisted = latestWorker(f.journalFile, w.worker_id);
            assert.equal(persisted.fence?.command_id, 'uncertain');
            assert.equal(persisted.execution?.state, 'outcome_unknown');
            assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'uncertain');
            assert.equal(res.statusCode, 200);
          } catch (error) {
            res.resume();
            reject(error);
            return;
          }
          let text = '';
          res.setEncoding('utf8');
          res.on('data', c => {
            text += c;
          });
          res.on('end', () => resolve(JSON.parse(text) as Receipt));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(data);
      });
      assert.equal(r.state, 'outcome_unknown');
      await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'next'), message: 'no' }), /session_fenced/);
      assert.equal(f.hosts[0]!.prompts, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
      f.cleanup();
    }
  });
}

test('Pi exit fences an admitted run durably without rewriting delivered admission (M9)', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const p = { ...bind(w, 'running'), message: 'hi' };
    const delivered = await f.supervisor.prompt(w.worker_id, p);
    f.hosts[0]!.emit('exit');
    assert.equal(latestWorker(f.journalFile, w.worker_id).fence?.command_id, 'running');
    assert.equal(latestWorker(f.journalFile, w.worker_id).execution?.state, 'outcome_unknown');
    assert.deepEqual(await f.supervisor.prompt(w.worker_id, p), delivered);
  } finally {
    f.cleanup();
  }
});

test('unknown stop never replaces the prompt fence; two restarts preserve fence and delivered receipt', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const delivered = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'active'), message: 'hi' });
    f.hosts[0]!.stopOk = false;
    assert.equal((await f.supervisor.stop(w.worker_id, bind(w, 'unknown-stop'))).state, 'outcome_unknown');
    const fence = f.supervisor.get(w.worker_id).fence;
    assert.equal(fence?.command_id, 'active');
    for (let i = 0; i < 2; i++) {
      const next = await f.restart(() => assert.fail('no replay'));
      assert.deepEqual(next.get(w.worker_id).fence, fence);
      assert.deepEqual(next.receipts.all.get('active'), delivered);
    }
  } finally {
    f.cleanup();
  }
});

test('crash after admission while running: journal unknown/fence, no prompt replay, rejected future write', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const id = w.worker_id;
    const p = { ...bind(w, 'active'), message: 'do not duplicate' };
    const delivered = await f.supervisor.prompt(id, p);
    assert.equal(f.hosts[0]!.prompts, 1);
    const recovered = await f.restart(() => {
      throw new Error('MUST NOT replay');
    });
    assert.deepEqual(recovered.receipts.all.get('active'), delivered);
    assert.equal(recovered.get(id).fence?.command_id, 'active');
    assert.equal(recovered.get(id).execution?.state, 'outcome_unknown');
    await assert.rejects(recovered.prompt(id, { ...p, command_id: 'new' }), (error: unknown) => {
      assert.equal((error as { effect: string }).effect, 'no_effect');
      assert.equal((error as { uncertain_command_id: string }).uncertain_command_id, 'active');
      return true;
    });
    assert.equal(recovered.receipts.all.has('new'), false);
    const again = await recovered.prompt(id, p);
    assert.deepEqual(again, delivered);
    const fence = recovered.get(id).fence;
    for (let restart = 0; restart < 2; restart++) {
      const next = await f.restart(() => {
        throw new Error('MUST NOT replay');
      });
      assert.deepEqual(next.get(id).fence, fence);
      assert.deepEqual(next.receipts.all.get('active'), delivered);
    }
  } finally {
    f.cleanup();
  }
});

test('observed accepts an exact fsynced settlement after restart, never a different run', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' });
    const now = f.supervisor.get(w.worker_id);
    const execution_id = now.execution!.execution_id;
    for (const fields of [
      { execution_id: 'other', command_id: 'lost' },
      { execution_id, command_id: 'other' },
    ]) {
      f.state.journal.append('settlement', { worker_id: w.worker_id, session_id: w.session_id, ...fields, source: 'pi.agent_settled' }, 'settlement.record');
      appendFileSync(f.hosts[0]!.file, `${JSON.stringify({ type: 'custom', id: `settlement-${fields.command_id}${fields.execution_id}`, customType: 'agent_settled', data: fields })}\n`);
    }
    const request = { ...bind(now, 'resolve'), execution_id, fence_generation: now.fence!.fence_generation, disposition: 'observed' as const };
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, request), /execution_settlement_not_in_session_file_or_fsynced_record/);
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const next = await f.restart(() => assert.fail('no replay'));
    assert.equal((await next.resolveUnknown(w.worker_id, request)).state, 'delivered');
    assert.equal(next.get(w.worker_id).fence, null);
  } finally {
    f.cleanup();
  }
});

test('observed rejects delivered admission, agent_end and attribution without settlement', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'admission'), message: 'run' });
    f.hosts[0]!.emit('event', { type: 'agent_end' });
    f.hosts[0]!.emit('exit');
    const now = f.supervisor.get(w.worker_id);
    const execution_id = now.execution!.execution_id;
    appendFileSync(f.hosts[0]!.file, `${JSON.stringify({ type: 'custom', id: 'admitted', customType: 'a0_execution', data: { execution_id, command_id: 'admission' } })}\n`);
    await assert.rejects(
      f.supervisor.resolveUnknown(w.worker_id, { ...bind(now, 'observed'), execution_id, fence_generation: now.fence!.fence_generation, disposition: 'observed' }),
      /execution_settlement_not_in_session_file_or_fsynced_record/,
    );
    assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'admission');
  } finally {
    f.cleanup();
  }
});

test('fence: cancel, interrupt and stop stay allowed under a fence and never lift it; resolve needs exactly one target', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' });
    for (const interrupt of [false, true]) assert.equal((await f.supervisor.control(w.worker_id, bind(w, `control-${interrupt}`), interrupt)).state, 'delivered');
    assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'lost');
    await assert.rejects(
      f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'both'), uncertain_command_id: 'lost', execution_id: 'x', fence_generation: 1, disposition: 'keep' }),
      /name_exactly_one_uncertain_command_or_execution/,
    );
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'other'), uncertain_command_id: 'other', fence_generation: 1, disposition: 'keep' }), /uncertainty_not_current/);
    assert.equal((await f.supervisor.stop(w.worker_id, bind(w, 'stop'))).state, 'delivered');
    assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'lost');
    const resolved = await f.supervisor.resolveUnknown(w.worker_id, { ...bind(w, 'resolve'), uncertain_command_id: 'lost', fence_generation: 1, disposition: 'abandon' });
    assert.deepEqual(resolved.result, { command_id: 'lost', disposition: 'abandon', fence_generation: 1, external_effects_undone: false, fence: null });
  } finally {
    f.cleanup();
  }
});
