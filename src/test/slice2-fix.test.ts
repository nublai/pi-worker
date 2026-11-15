/** Review regressions: direct supervisor dispatch and exact settlement evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Journal, parseJournal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { join } from 'node:path';
import { Refusal } from '../types.js';
import { fixture, bind, tick } from './helpers.js';

for (const kind of ['follow_up', 'child']) test(`automatic ${kind} flush is not owner-ready and recovers without redispatch eligibility`, async () => {
  const out = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/queue-cut.js', import.meta.url)), kind], { encoding: 'utf8', timeout: 15000 });
  const dir = out.stdout.trim(); assert.equal(out.signal, 'SIGKILL', out.stderr);
  const journal = new Journal(join(dir, 'journal'));
  try {
    const pre = parseJournal(readFileSync(journal.file)).records;
    const queued = pre.filter(r => r.kind === 'receipt' && r.value.command_id === 'queued').at(-1)!;
    assert.equal(queued.value.state, 'queue_ready', 'automatic flush must never claim owner resolution');
    const s = new Supervisor(dir, journal, '1.5.2', () => assert.fail('no spawn/replay')); await s.recover();
    const r = s.receipts.all.get('queued')!;
    assert.equal(r.state, 'intent_recovered'); assert.equal(r.effect, 'no_effect');
    assert.deepEqual(s.list()[0]!.resolutions ?? [], []); assert.equal(s.list()[0]!.fence, null);
    assert.equal(s.receipts.all.get('create-child'), undefined);
    const retry = await s.receipts.run('queued', r.operation, kind === 'follow_up'
      ? { ...bind(s.list()[0]!, 'queued'), worker_id: s.list()[0]!.worker_id, execution_id: s.list()[0]!.execution!.execution_id, message: 'next' }
      : { ...bind(s.list()[0]!, 'queued'), worker_id: s.list()[0]!.worker_id, execution_id: s.list()[0]!.execution!.execution_id, launch: { command_id: 'create-child', cwd: dir, provider: 'p', model: 'm', thinking: 'off' } }, async () => assert.fail('retry needs owner resolution'));
    assert.deepEqual(retry, r);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});

const revoked = () => { throw new Refusal('grant_revoked: direct dispatch test'); };
test('direct revoked prompt leaves no running execution and never fences on exit', async () => {
  const f = fixture(); try {
    const w = await f.create();
    const r = await f.supervisor.authority.run(revoked, () => f.supervisor.prompt(w.worker_id, { ...bind(w, 'revoked'), message: 'no' }));
    assert.equal(r.state, 'rejected'); assert.equal(r.effect, 'no_effect');
    const now = f.supervisor.get(w.worker_id);
    assert.equal(now.execution, null); assert.equal(now.foreground, 'idle'); assert.equal(f.hosts[0]!.prompts, 0);
    f.hosts[0]!.emit('exit');
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
  } finally { f.cleanup(); }
});
test('direct revoked create leaves no ghost worker or cwd reservation', async () => {
  const f = fixture(); try {
    const cwd = join(f.dir, 'revoked-cwd'); mkdirSync(cwd);
    const c = { command_id: 'revoked-create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await f.supervisor.authority.run(revoked, () => f.supervisor.create(c));
    assert.equal(r.state, 'rejected'); assert.equal(r.effect, 'no_effect');
    assert.equal(f.supervisor.list().length, 0); assert.equal(f.hosts.length, 0);
    assert.equal((await f.supervisor.create({ ...c, command_id: 'valid-create' })).state, 'delivered');
  } finally { f.cleanup(); }
});
for (const failure of ['collision', 'resume-mismatch', 'cancelled'] as const) test(`post-write rebind ${failure} is unknown and fenced`, async () => {
  const f = fixture(); try {
    const a = await f.create(), b = await f.create(), h = f.hosts[1]!;
    // Catalog a prior session owned by b for the resume case.
    await f.supervisor.rebind(b.worker_id, { ...bind(b, 'setup-new'), action: 'new' });
    const current = f.supervisor.get(b.worker_id), native = h.request.bind(h);
    h.request = async c => {
      const reply = await native(c);
      if (c.type === 'new_session' || c.type === 'switch_session') {
        if (failure === 'collision') h.sid = a.session_id!;
        if (failure === 'resume-mismatch') {
          h.sid = 'unexpected-target'; h.file = join(f.dir, 'unexpected.jsonl');
          writeFileSync(h.file, JSON.stringify({ type: 'session', id: h.sid }) + '\n');
        }
        if (failure === 'cancelled') return { ...reply, data: { cancelled: true } };
      }
      return reply;
    };
    const r = await f.supervisor.rebind(b.worker_id, { ...bind(current, 'bad-bind'), action: failure === 'resume-mismatch' ? 'resume' : 'new', ...(failure === 'resume-mismatch' ? { target_session_id: b.session_id! } : {}) });
    assert.equal(r.state, 'outcome_unknown'); assert.equal(r.effect, 'unknown');
    assert.ok(f.supervisor.get(b.worker_id).fence?.uncertain_command_ids?.includes('bad-bind'));
    await tick();
  } finally { f.cleanup(); }
});
test('observed accepts an exact fsynced settlement after restart, never a different run', async () => {
  const f = fixture(); try {
    const w = await f.create(); f.hosts[0]!.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'run' });
    const now = f.supervisor.get(w.worker_id), execution_id = now.execution!.execution_id;
    for (const fields of [{ execution_id: 'other', command_id: 'lost' }, { execution_id, command_id: 'other' }]) {
      f.journal.append('settlement', { worker_id: w.worker_id, session_id: w.session_id, ...fields, source: 'pi.agent_settled' });
      appendFileSync(f.hosts[0]!.file, JSON.stringify({ type: 'custom', id: 'settlement-' + fields.command_id + fields.execution_id, customType: 'agent_settled', data: fields }) + '\n');
    }
    const request = { ...bind(now, 'resolve'), execution_id, fence_generation: now.fence!.fence_generation, disposition: 'observed' as const };
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, request), /execution_settlement_not_in_session_file_or_fsynced_record/);
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const journal = new Journal(f.journal.file);
    try {
      const next = new Supervisor(f.dir, journal, '1.5.2', () => assert.fail('no replay')); await next.recover();
      assert.equal((await next.resolveUnknown(w.worker_id, request)).state, 'delivered');
      assert.equal(next.get(w.worker_id).fence, null);
    } finally { journal.close(); }
  } finally { f.cleanup(); }
});

test('observed rejects delivered admission, agent_end and attribution without settlement', async () => {
  const f = fixture(); try {
    const w = await f.create();
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'admission'), message: 'run' });
    f.hosts[0]!.emit('event', { type: 'agent_end' }); f.hosts[0]!.emit('exit');
    const now = f.supervisor.get(w.worker_id), execution_id = now.execution!.execution_id;
    appendFileSync(f.hosts[0]!.file, JSON.stringify({ type: 'custom', id: 'admitted', customType: 'a0_execution', data: { execution_id, command_id: 'admission' } }) + '\n');
    await assert.rejects(f.supervisor.resolveUnknown(w.worker_id, { ...bind(now, 'observed'), execution_id, fence_generation: now.fence!.fence_generation, disposition: 'observed' }), /execution_settlement_not_in_session_file_or_fsynced_record/);
    assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'admission');
  } finally { f.cleanup(); }
});
