import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { ProcessGroupContainment, type Containment } from '../containment.js';
import { requestHash } from '../receipts.js';
import { Host, bind, tick } from './helpers.js';

function setup(fallback = false) {
  const root = mkdtempSync(join(tmpdir(), 'a0-review5-')), cwd = join(root, 'work'); mkdirSync(cwd);
  const journal = new Journal(join(root, 'journal')); const hosts: Host[] = [];
  const state = { confirmed: true, kills: 0, mismatch: false };
  const jail: Containment = fallback ? new ProcessGroupContainment() : { profile: 'test', reserve: epoch => ({ root, name: 'w-' + epoch, boot: 'test' }), spawn: () => { throw new Error('unused'); }, clean: async () => { state.kills++; return state.confirmed; } };
  const factory = (_c: unknown, dir: string) => {
    const sid = 'native-' + hosts.length, file = join(dir, sid + '.jsonl'); writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
    const h = new Host(dir, sid, file); const request = h.request.bind(h);
    h.request = async c => { const r = await request(c); if (state.mismatch && c.type === 'get_state') r.data = { ...r.data, sessionFile: '/wrong-file' }; return r; };
    hosts.push(h); return h;
  };
  const s = new Supervisor(root, journal, 'test', factory, jail);
  return { root, cwd, journal, hosts, state, jail, factory, s, create: () => s.create({ command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' }), close: async () => { await s.shutdown(); journal.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const move of ['none', 'new', 'resume', 'new-relaunch']) test(`owner-kept intent is session-bound and once only (move=${move})`, async () => {
  const f = setup();
  try {
    const made = await f.create(), old = f.s.get(made.worker_id!);
    const p = { ...bind(old, 'kept'), message: 'ONCE' };
    f.s.receipts.put({ command_id: p.command_id, worker_id: old.worker_id, operation: 'sessions.prompt', request_hash: requestHash({ ...p, worker_id: old.worker_id, operation: 'sessions.prompt' }), state: 'intent', stage: 'reserved', effect: 'no_effect', evidence: 'supervisor_journal_fsynced', created_at: new Date().toISOString() });
    const recovered = new Supervisor(f.root, f.journal, 'test', f.factory, f.jail); await recovered.recover();
    const w = recovered.get(old.worker_id);
    await recovered.resolveUnknown(w.worker_id, { ...bind(w, 'keep'), uncertain_command_id: 'kept', fence_generation: 0, disposition: 'keep' });
    await recovered.relaunch(w.worker_id, bind(w, 'relaunch'));
    if (move !== 'none') {
      const fresh = recovered.get(w.worker_id);
      assert.equal((await recovered.rebind(w.worker_id, { ...bind(fresh, 'move'), action: move === 'resume' ? 'resume' : 'new', ...(move === 'resume' ? { target_session_id: fresh.session_id! } : {}) })).state, 'delivered');
      if (move === 'new-relaunch') {
        const moved = recovered.get(w.worker_id); await recovered.stop(w.worker_id, bind(moved, 'stop-moved'));
        assert.equal((await recovered.relaunch(w.worker_id, bind(moved, 'relaunch-moved'))).state, 'delivered');
      }
      await assert.rejects(recovered.prompt(w.worker_id, p), /stale_binding/);
      assert.equal(f.hosts.at(-1)!.prompts, 0);
    } else {
      const result = await recovered.prompt(w.worker_id, p); assert.equal(result.state, 'delivered');
      assert.deepEqual(await recovered.prompt(w.worker_id, p), result); assert.equal(f.hosts.at(-1)!.prompts, 1);
    }
    await recovered.shutdown();
  } finally { await f.close(); }
});

for (const restart of [false, true]) test(`relaunch requires recorded confirmed cleanup (restart=${restart})`, async () => {
  const f = setup();
  try {
    const made = await f.create(), w = f.s.get(made.worker_id!); f.state.confirmed = false;
    await f.s.stop(w.worker_id, bind(w, 'stop'));
    const s = restart ? new Supervisor(f.root, f.journal, 'test', f.factory, f.jail) : f.s;
    if (restart) await s.recover();
    await assert.rejects(s.relaunch(w.worker_id, bind(s.get(w.worker_id), 'blocked')), /cleanup_pending_or_cleanup_unproven/);
    assert.equal(f.hosts.length, 1, 'no new host while old domain may be populated');
  } finally { await f.close(); }
});

test('process-group fallback never authorizes fresh-process relaunch', async () => {
  const f = setup(true);
  try {
    const made = await f.create(), w = f.s.get(made.worker_id!); await f.s.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(f.s.get(w.worker_id).status, 'stopped');
    await assert.rejects(f.s.relaunch(w.worker_id, bind(w, 'blocked')), /cleanup_pending_or_cleanup_unproven/);
    assert.equal(f.hosts.length, 1);
  } finally { await f.close(); }
});

test('relaunch verifies the returned session file, not just successful switch', async () => {
  const f = setup();
  try {
    const made = await f.create(), w = f.s.get(made.worker_id!); await f.s.stop(w.worker_id, bind(w, 'stop')); f.state.mismatch = true;
    const r = await f.s.relaunch(w.worker_id, bind(w, 'relaunch'));
    assert.equal(r.state, 'outcome_unknown'); assert.match(r.error!, /session_identity_mismatch/);
    assert.notEqual(f.s.get(w.worker_id).status, 'ready');
  } finally { await f.close(); }
});

for (const confirmed of [false, true]) test(`spontaneous leader exit immediately cleans domain (confirmed=${confirmed})`, async () => {
  const f = setup();
  try {
    const made = await f.create(); f.state.confirmed = confirmed;
    f.hosts[0]!.emit('exit'); await tick();
    assert.equal(f.state.kills, 1);
    const w = f.s.get(made.worker_id!);
    assert.equal(w.status, confirmed ? 'stopped' : 'cleanup_pending');
    assert.equal(w.cleanup, confirmed ? 'cgroup_empty_removed' : 'unresolved');
    const latest = f.journal.records.filter(r => r.kind === 'worker').at(-1)!;
    assert.equal((latest.value.worker as { cleanup: string }).cleanup, w.cleanup);
  } finally { await f.close(); }
});
