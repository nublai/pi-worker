/**
 * `workers.relaunch` (P2-3), ported from A0 `src/test/relaunch.test.ts`, `slice5-followups.test.ts` and
 * `review5-fixes.test.ts` (PORTED.md names each adaptation). The supervisor runs over the test domains
 * (domains.ts); the kernel case, a setsid grandchild of the old epoch proven dead before the new epoch starts, is in
 * security/relaunch.test.ts.
 *
 * Production shares one cleanup per worker (PR #21): a late completion for a superseded generation cannot happen
 * through B2, because a relaunch needs the recorded confirmation that only follows that one cleanup. A0 ran one
 * cleanup per caller. The late-cleanup cases recreate A0's two independent cleanups of one domain with one seam,
 * `independentCleanup` (it drops the shared cleanup handle, so the next caller starts its own); everything else goes
 * through the supervisor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal } from '../src/journal/journal.js';
import { requestHash } from '../src/receipts/receipts.js';
import type { Prompt, Worker } from '../src/supervisor/state.js';
import type { Supervisor } from '../src/supervisor/supervisor.js';
import { TestDomains } from './domains.js';
import { heldDomains, independentCleanup } from './held-domains.js';
import { bind, fixture, tick, type Fixture } from './supervisor-fixture.js';

const latestRow = (f: Fixture, id: string): Worker =>
  parseJournal(readFileSync(f.journalFile))
    .records.filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === id)
    .at(-1)!.value.worker as Worker;

/** A recovered `sessions.prompt` intent, as a restart between its intent and its dispatch record leaves it. */
function intent(s: Supervisor, w: Worker, p: Prompt): void {
  s.receipts.put(
    {
      command_id: p.command_id,
      worker_id: w.worker_id,
      operation: 'sessions.prompt',
      request_hash: requestHash({ ...p, worker_id: w.worker_id, operation: 'sessions.prompt' }),
      state: 'intent',
      stage: 'reserved',
      effect: 'no_effect',
      evidence: 'supervisor_journal_fsynced',
      created_at: new Date().toISOString(),
    },
    'receipt.intent',
  );
}

// A0 relaunch.test.ts

test('relaunch refuses a replacement checkout writer; fresh epoch rejects ordinary stale writes and ignores retired callbacks', async () => {
  const f = fixture({ domains: new TestDomains() });
  const s = () => f.supervisor;
  try {
    const cwd = join(f.dir, 'cwd');
    mkdirSync(cwd);
    const c = { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const a = await s().create(c);
    const old = s().get(a.worker_id!);
    await s().stop(old.worker_id, bind(old, 'stop'));
    const replacement = await s().create({ ...c, command_id: 'replacement' });
    await assert.rejects(s().relaunch(old.worker_id, bind(old, 'relaunch-blocked')), /exclusive_environment/);
    const second = s().get(replacement.worker_id!);
    await s().stop(second.worker_id, bind(second, 'stop-replacement'));
    const receipt = await s().relaunch(old.worker_id, bind(old, 'relaunch'));
    assert.equal(receipt.state, 'delivered');
    const fresh = s().get(old.worker_id);
    assert.notEqual(fresh.worker_epoch, old.worker_epoch);
    assert.equal(fresh.session_id, old.session_id);
    assert.equal(f.hosts.at(-1)!.prompts, 0, 'relaunch opens history, never prompts');
    f.hosts[0]!.emit('exit');
    f.hosts[0]!.emit('event', { type: 'host_identity', sessionId: 'WRONG', sessionFile: '/bad' });
    assert.equal(s().get(old.worker_id).status, 'ready');
    assert.equal(s().get(old.worker_id).fence, null);
    await assert.rejects(s().prompt(old.worker_id, { ...bind(old, 'stale'), message: 'stale' }), /stale_binding/);
    assert.equal((await s().prompt(old.worker_id, { ...bind(fresh, 'fresh'), message: 'fresh' })).state, 'delivered');
    assert.equal(f.hosts.at(-1)!.prompts, 1);
    // Cgroup emptiness can be observed before Node delivers the leader's exit callback. Stop must fence the active
    // execution independently of that event.
    await s().stop(fresh.worker_id, bind(fresh, 'stop-running'));
    const stopped = s().get(fresh.worker_id);
    assert.equal(stopped.execution?.state, 'outcome_unknown');
    assert.equal(stopped.fence?.command_id, 'fresh');
    await assert.rejects(s().relaunch(fresh.worker_id, bind(stopped, 'unsafe-relaunch')), /session_fenced/);
  } finally {
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

test('relaunch: a stop whose domain is observed empty before pi exits still fences the running execution, so no relaunch skips it', async () => {
  const f = fixture({
    domains: new TestDomains(),
    // The leader's exit event never arrives during the cleanup (the domain is observed empty first).
    initHost: h => {
      h.stop = async () => {
        h.stops++;
        return true;
      };
    },
  });
  try {
    const w = await f.create();
    assert.equal((await f.supervisor.prompt(w.worker_id, { ...bind(w, 'running'), message: 'running' })).state, 'delivered');
    const stop = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(stop.result?.termination, 'observed_stopped');
    const stopped = f.supervisor.get(w.worker_id);
    assert.equal(stopped.fence?.command_id, 'running');
    assert.equal(latestRow(f, w.worker_id).fence?.command_id, 'running', 'the fence is durable');
    await assert.rejects(f.supervisor.relaunch(w.worker_id, bind(stopped, 'relaunch')), /session_fenced/);
    assert.equal(f.hosts.length, 1);
  } finally {
    f.cleanup();
  }
});

test('relaunch: refusals are no_effect and record nothing (live worker, stale binding, child, session held by another worker)', async () => {
  const f = fixture({ domains: new TestDomains() });
  try {
    const w = await f.create();
    const records = () => parseJournal(readFileSync(f.journalFile)).records.length;
    const before = records();
    await assert.rejects(f.supervisor.relaunch(w.worker_id, bind(w, 'live')), (e: Error & { effect?: string }) => e.message === 'cleanup_pending_or_cleanup_unproven' && e.effect === 'no_effect');
    await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    await assert.rejects(f.supervisor.relaunch(w.worker_id, { ...bind(w, 'stale'), binding_revision: 2 }), /stale_binding/);
    const after = records();
    // Another worker resumes the stopped worker's session: it holds it now.
    const cwd = join(f.dir, 'other');
    mkdirSync(cwd);
    const other = await f.supervisor.create({ command_id: 'other', cwd, provider: 'p', model: 'm', thinking: 'off', resume_session_id: w.session_id! });
    assert.equal(other.state, 'delivered');
    await assert.rejects(f.supervisor.relaunch(w.worker_id, bind(w, 'held')), (e: Error & { holder_worker_id?: string }) => e.message === 'session_already_bound');
    assert.equal(f.supervisor.receipts.all.get('live'), undefined);
    assert.equal(f.supervisor.receipts.all.get('held'), undefined);
    assert.ok(after > before, 'the stop recorded');
    assert.equal(f.hosts.length, 2);
    // A child launched under a parent's execution is not relaunched: its lineage belongs to that launch.
    const parent = f.supervisor.get(other.worker_id!);
    await f.supervisor.prompt(parent.worker_id, { ...bind(parent, 'run'), message: 'x' });
    const running = f.supervisor.get(parent.worker_id);
    const childCwd = join(f.dir, 'child');
    mkdirSync(childCwd);
    await f.supervisor.launchChild(parent.worker_id, { ...bind(running, 'launch'), execution_id: running.execution!.execution_id, launch: { command_id: 'child-create', cwd: childCwd, provider: 'p', model: 'm', thinking: 'off' } });
    f.hosts[1]!.emit('event', { type: 'agent_settled' });
    for (let i = 0; i < 6; i++) await tick();
    const child = f.supervisor.list().find(x => x.parent_worker_id === parent.worker_id)!;
    await f.supervisor.stop(child.worker_id, bind(child, 'stop-child'));
    assert.equal(f.supervisor.get(child.worker_id).cleanup, 'cgroup_empty_removed');
    await assert.rejects(f.supervisor.relaunch(child.worker_id, bind(child, 'relaunch-child')), /child_relaunch_unsupported/);
    assert.equal(f.hosts.length, 3);
  } finally {
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

test('relaunch: the new epoch and its domain are durable before the dispatch record, and both before anything is spawned', async () => {
  type Seen = { rowEpoch: string; rowDomain: string | undefined; rowStatus: string; dispatchAfterRow: boolean; launchDomain: string };
  let seen: Seen | undefined;
  let f!: Fixture;
  f = fixture({
    domains: new TestDomains(),
    launch: launch => {
      if (launch.commandId !== 'relaunch') return undefined;
      const records = parseJournal(readFileSync(f.journalFile)).records;
      const row = records.findLastIndex(r => r.kind === 'worker');
      const dispatch = records.findLastIndex(r => r.kind === 'receipt' && r.value.command_id === 'relaunch' && r.value.state === 'accepted');
      const value = records[row]!.value as { worker: Worker; domain?: { name: string } };
      seen = { rowEpoch: value.worker.worker_epoch, rowDomain: value.domain?.name, rowStatus: value.worker.status, dispatchAfterRow: dispatch > row, launchDomain: launch.domain.name };
      return undefined;
    },
  });
  try {
    const w = await f.create();
    await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal((await f.supervisor.relaunch(w.worker_id, bind(w, 'relaunch'))).state, 'delivered');
    const fresh = f.supervisor.get(w.worker_id);
    assert.ok(seen, 'the relaunch spawned');
    assert.deepEqual(seen, { rowEpoch: fresh.worker_epoch, rowDomain: seen.launchDomain, rowStatus: 'starting', dispatchAfterRow: true, launchDomain: `w-${fresh.worker_epoch}` });
  } finally {
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

// A0 slice5-followups.test.ts

for (const trigger of ['exit', 'stop', 'fault'] as const) {
  for (const lateGone of [true, false]) {
    test(`late ${trigger} cleanup cannot retire a relaunched generation (gone=${lateGone})`, async () => {
      const held = heldDomains();
      let pids = 0;
      const f = fixture({ domains: held.domains, initHost: h => void (h.pid = 2147483000 + pids++) });
      const s = () => f.supervisor;
      try {
        const old = await f.create();
        const oldUnit = s().state.require(old.worker_id).domain!;
        held.hold();
        let firstStop: Promise<unknown> | undefined;
        if (trigger === 'exit') f.hosts[0]!.emit('exit');
        else if (trigger === 'fault') f.hosts[0]!.emit('event', { type: 'host_identity', sessionId: 'wrong', sessionFile: '/wrong' });
        else firstStop = s().stop(old.worker_id, bind(old, 'stop-a'));
        await tick();
        independentCleanup(s(), old.worker_id);
        const secondStop = s().stop(old.worker_id, bind(old, 'stop-b'));
        await tick();
        assert.equal(held.calls.length, 2);
        assert.ok(held.calls.every(call => call.domain === oldUnit));
        // The cleanup that confirms finishes first: the stop's (an exit's or a fault's defers to the stop that took
        // over, P2-1). The other one, the trigger's for exit and fault, stays outstanding.
        const early = trigger === 'stop' ? 0 : 1;
        const late = 1 - early;
        held.calls[early]!.finish(true);
        await tick();
        assert.equal(s().get(old.worker_id).cleanup, 'cgroup_empty_removed');
        assert.equal((await s().relaunch(old.worker_id, bind(s().get(old.worker_id), 'relaunch'))).state, 'delivered');
        const fresh = s().get(old.worker_id);
        const freshUnit = s().state.require(old.worker_id).domain;
        assert.notEqual(freshUnit, oldUnit);
        assert.notEqual(fresh.worker_epoch, old.worker_epoch);
        held.calls[late]!.finish(lateGone);
        await Promise.all([firstStop, secondStop]);
        await tick();
        assert.equal(s().get(old.worker_id).status, 'ready', 'old domain completion must not mark the live replacement stopped or pending');
        assert.equal(s().get(old.worker_id).cleanup, 'live_cgroup');
        assert.equal(s().state.require(old.worker_id).domain, freshUnit);
        assert.equal(s().state.require(old.worker_id).pid, f.hosts[1]!.pid, 'replacement process identity is retained');
        assert.equal(f.hosts[1]!.stops, 0);
        assert.equal(latestRow(f, old.worker_id).status, 'ready');
        await assert.rejects(s().relaunch(old.worker_id, bind(fresh, 'second-relaunch')), /cleanup_pending_or_cleanup_unproven/);
        assert.equal(f.hosts.length, 2, 'no second live Pi on the same session');
      } finally {
        held.release();
        await tick();
        await f.supervisor.shutdown();
        f.cleanup();
      }
    });
  }
}

test('relaunch: a late exit cleanup of the old domain never confirms the cleanup of the relaunched generation', async () => {
  const held = heldDomains();
  const f = fixture({ domains: held.domains });
  const s = () => f.supervisor;
  try {
    const old = await f.create();
    held.hold();
    f.hosts[0]!.emit('exit');
    await tick();
    independentCleanup(s(), old.worker_id);
    const stop = s().stop(old.worker_id, bind(old, 'stop'));
    await tick();
    held.calls[1]!.finish(true);
    await stop;
    assert.equal((await s().relaunch(old.worker_id, bind(old, 'relaunch'))).state, 'delivered');
    const freshUnit = s().state.require(old.worker_id).domain!;
    // The new pi exits: its own domain's cleanup starts and is held.
    f.hosts[1]!.emit('exit');
    await tick();
    assert.equal(held.calls.length, 3);
    assert.equal(held.calls[2]!.domain, freshUnit);
    // The old exit's cleanup completes now: it proves the old domain gone, never the new one.
    held.calls[0]!.finish(true);
    await tick();
    assert.equal(s().get(old.worker_id).status, 'cleanup_pending');
    assert.notEqual(s().get(old.worker_id).cleanup, 'cgroup_empty_removed');
    assert.equal(latestRow(f, old.worker_id).status, 'cleanup_pending');
    held.calls[2]!.finish(true);
    await tick();
    assert.equal(s().get(old.worker_id).cleanup, 'cgroup_empty_removed');
  } finally {
    held.release();
    await tick();
    f.cleanup();
  }
});

for (const failure of ['spawn', 'get_state'] as const) {
  for (const restart of [false, true]) {
    test(`owner-kept prompt binds to the successful retry after ${failure} failure (restart=${restart})`, async () => {
      let fail = false;
      const f = fixture({
        domains: new TestDomains(),
        launch: () => {
          if (fail && failure === 'spawn') throw new Error('test_spawn_failure');
          return undefined;
        },
        initHost: h => {
          const request = h.request.bind(h);
          h.request = async c => (fail && c.type === 'get_state' ? { type: 'response', id: 'failed', success: false } : request(c));
        },
      });
      try {
        const old = await f.create();
        const p = { ...bind(old, 'kept'), message: 'EXACT ONCE' };
        intent(f.supervisor, old, p);
        fail = true;
        let recovered = await f.restart(f.factory);
        await recovered.resolveUnknown(old.worker_id, { ...bind(recovered.get(old.worker_id), 'keep'), uncertain_command_id: p.command_id, fence_generation: 0, disposition: 'keep' });
        const failed = await recovered.relaunch(old.worker_id, bind(recovered.get(old.worker_id), 'failed-relaunch'));
        assert.equal(failed.state, 'outcome_unknown');
        assert.match(failed.error!, failure === 'spawn' ? /test_spawn_failure/ : /initialization_failed/);
        assert.equal(recovered.get(old.worker_id).cleanup, 'cgroup_empty_removed');
        assert.equal(recovered.receipts.all.get(p.command_id)!.state, 'intent_ready');
        fail = false;
        if (restart) recovered = await f.restart(f.factory);
        const retry = await recovered.relaunch(old.worker_id, bind(recovered.get(old.worker_id), 'retry-relaunch'));
        assert.equal(retry.state, 'delivered');
        const fresh = recovered.get(old.worker_id);
        const host = f.hosts.at(-1)!;
        assert.equal(fresh.session_id, old.session_id);
        assert.equal(fresh.binding_revision, old.binding_revision);
        assert.equal(host.file, f.hosts[0]!.file);
        assert.equal(host.prompts, 0, 'neither recovery nor relaunch sends the kept prompt');
        await assert.rejects(recovered.prompt(old.worker_id, { ...p, message: 'changed payload' }), /command_id_conflict/);
        assert.throws(() => recovered.followUp(old.worker_id, { ...p, execution_id: 'wrong-operation' }), /command_id_conflict/);
        await assert.rejects(recovered.prompt(old.worker_id, { ...bind(old, 'ordinary-stale'), message: p.message }), /stale_binding/);
        const sent = await recovered.prompt(old.worker_id, p).catch(error => assert.fail(`exact owner-kept retry refused: ${String(error)}`));
        assert.equal(sent.state, 'delivered');
        assert.deepEqual(await recovered.prompt(old.worker_id, p), sent);
        assert.equal(host.prompts, 1);
        // The worker stamps its command and execution ids into the prompt (P1-14); the text is the kept one.
        assert.deepEqual(
          host.commands.filter(c => c.type === 'prompt').map(c => ({ type: c.type, message: c.message })),
          [{ type: 'prompt', message: p.message }],
        );
        assert.equal(f.hosts.reduce((n, h) => n + h.prompts, 0), 1);
      } finally {
        await f.supervisor.shutdown();
        f.cleanup();
      }
    });
  }
}

test('a second successful relaunch does not rebind an undispatched owner-kept prompt', async () => {
  const f = fixture({ domains: new TestDomains() });
  try {
    const old = await f.create();
    const p = { ...bind(old, 'kept'), message: 'NOT REBOUND' };
    intent(f.supervisor, old, p);
    const recovered = await f.restart(f.factory);
    await recovered.resolveUnknown(old.worker_id, { ...bind(recovered.get(old.worker_id), 'keep'), uncertain_command_id: p.command_id, fence_generation: 0, disposition: 'keep' });
    assert.equal((await recovered.relaunch(old.worker_id, bind(recovered.get(old.worker_id), 'first'))).state, 'delivered');
    const first = recovered.get(old.worker_id);
    await recovered.stop(old.worker_id, bind(first, 'stop-first'));
    assert.equal((await recovered.relaunch(old.worker_id, bind(first, 'second'))).state, 'delivered');
    await assert.rejects(recovered.prompt(old.worker_id, p), /stale_binding/);
    assert.equal(f.hosts.reduce((n, h) => n + h.prompts, 0), 0);
  } finally {
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

// A0 review5-fixes.test.ts

for (const move of ['none', 'new', 'resume', 'new-relaunch']) {
  test(`owner-kept intent is session-bound and once only (move=${move})`, async () => {
    const f = fixture({ domains: new TestDomains() });
    try {
      const old = await f.create();
      const p = { ...bind(old, 'kept'), message: 'ONCE' };
      intent(f.supervisor, old, p);
      const recovered = await f.restart(f.factory);
      const w = recovered.get(old.worker_id);
      await recovered.resolveUnknown(w.worker_id, { ...bind(w, 'keep'), uncertain_command_id: 'kept', fence_generation: 0, disposition: 'keep' });
      await recovered.relaunch(w.worker_id, bind(w, 'relaunch'));
      if (move !== 'none') {
        const fresh = recovered.get(w.worker_id);
        assert.equal(
          (await recovered.rebind(w.worker_id, { ...bind(fresh, 'move'), action: move === 'resume' ? 'resume' : 'new', ...(move === 'resume' ? { target_session_id: fresh.session_id! } : {}) })).state,
          'delivered',
        );
        if (move === 'new-relaunch') {
          const moved = recovered.get(w.worker_id);
          await recovered.stop(w.worker_id, bind(moved, 'stop-moved'));
          assert.equal((await recovered.relaunch(w.worker_id, bind(moved, 'relaunch-moved'))).state, 'delivered');
        }
        await assert.rejects(recovered.prompt(w.worker_id, p), /stale_binding/);
        assert.equal(f.hosts.at(-1)!.prompts, 0);
      } else {
        const result = await recovered.prompt(w.worker_id, p);
        assert.equal(result.state, 'delivered');
        assert.deepEqual(await recovered.prompt(w.worker_id, p), result);
        assert.equal(f.hosts.at(-1)!.prompts, 1);
      }
    } finally {
      await f.supervisor.shutdown();
      f.cleanup();
    }
  });
}

for (const restart of [false, true]) {
  test(`relaunch requires recorded confirmed cleanup (restart=${restart})`, async () => {
    const domains = new TestDomains();
    const f = fixture({ domains });
    try {
      const w = await f.create();
      domains.confirm = false;
      await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
      const s = restart ? await f.restart(f.factory) : f.supervisor;
      await assert.rejects(s.relaunch(w.worker_id, bind(s.get(w.worker_id), 'blocked')), /cleanup_pending_or_cleanup_unproven/);
      assert.equal(f.hosts.length, 1, 'no new host while old domain may be populated');
    } finally {
      f.cleanup();
    }
  });
}

test('relaunch verifies the returned session file, not just successful switch', async () => {
  let mismatch = false;
  const f = fixture({
    domains: new TestDomains(),
    initHost: h => {
      const request = h.request.bind(h);
      h.request = async c => {
        const r = await request(c);
        if (mismatch && c.type === 'get_state') r.data = { ...r.data, sessionFile: '/wrong-file' };
        return r;
      };
    },
  });
  try {
    const w = await f.create();
    await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    mismatch = true;
    const r = await f.supervisor.relaunch(w.worker_id, bind(w, 'relaunch'));
    assert.equal(r.state, 'outcome_unknown');
    assert.match(r.error!, /session_identity_mismatch/);
    assert.notEqual(f.supervisor.get(w.worker_id).status, 'ready');
  } finally {
    f.cleanup();
  }
});

for (const confirmed of [false, true]) {
  test(`spontaneous leader exit immediately cleans domain (confirmed=${confirmed})`, async () => {
    const domains = new TestDomains();
    const f = fixture({ domains });
    try {
      const made = await f.create();
      domains.confirm = confirmed;
      f.hosts[0]!.emit('exit');
      await tick();
      assert.equal(domains.cleaned.length, 1);
      const w = f.supervisor.get(made.worker_id);
      assert.equal(w.status, confirmed ? 'stopped' : 'cleanup_pending');
      assert.equal(w.cleanup, confirmed ? 'cgroup_empty_removed' : 'unresolved');
      assert.equal(latestRow(f, made.worker_id).cleanup, w.cleanup);
    } finally {
      f.cleanup();
    }
  });
}
