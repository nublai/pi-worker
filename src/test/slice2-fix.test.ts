/** Review regressions: direct supervisor dispatch and exact settlement evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../types.js';
import { fixture, bind, tick } from './helpers.js';

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
