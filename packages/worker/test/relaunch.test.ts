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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineHost } from '../src/host/host.js';
import { procInfo, processToken } from '../src/host/process.js';
import { parseJournal } from '../src/journal/journal.js';
import { requestHash } from '../src/receipts/receipts.js';
import type { PiResponse } from '../src/host/host.js';
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

/** A refusal with exactly this name (`target_session_fenced` is another refusal than `session_fenced`). */
const named = (name: string) => (e: Error) => e.message === name;

/** The owner keeps an uncertain command: the only write that lifts its fence. */
const resolve = (s: Supervisor, w: Worker, command: string, uncertain: string) =>
  s.resolveUnknown(w.worker_id, { ...bind(w, command), uncertain_command_id: uncertain, fence_generation: w.fence?.fence_generation ?? w.fence_generation ?? 0, disposition: 'keep' });

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
    await assert.rejects(s().relaunch(fresh.worker_id, bind(stopped, 'unsafe-relaunch')), named('session_fenced'));
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
    await assert.rejects(f.supervisor.relaunch(w.worker_id, bind(stopped, 'relaunch')), named('session_fenced'));
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
        // The frozen contract, not A0 (PR #27): a spawn refused before any host existed is proven no_effect; a failure
        // once pi runs is outcome_unknown and fences the session until the owner resolves it.
        assert.equal(failed.state, failure === 'spawn' ? 'rejected' : 'outcome_unknown');
        assert.equal(failed.effect, failure === 'spawn' ? 'no_effect' : 'unknown');
        assert.match(failed.error!, failure === 'spawn' ? /test_spawn_failure/ : /initialization_failed/);
        assert.equal(recovered.get(old.worker_id).cleanup, 'cgroup_empty_removed');
        assert.equal(recovered.get(old.worker_id).fence?.command_id, failure === 'spawn' ? undefined : 'failed-relaunch');
        assert.equal(recovered.receipts.all.get(p.command_id)!.state, 'intent_ready');
        fail = false;
        if (restart) recovered = await f.restart(f.factory);
        if (failure === 'get_state') {
          const fenced = recovered.get(old.worker_id);
          assert.equal(fenced.fence?.command_id, 'failed-relaunch');
          await assert.rejects(recovered.relaunch(old.worker_id, bind(fenced, 'unresolved-retry')), named('session_fenced'));
          await resolve(recovered, fenced, 'resolve-relaunch', 'failed-relaunch');
        }
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

// PR #27 review fixes (GPT 1 to 3, Grok 1): the frozen contract's fence, not A0's retryable unknown relaunch.

test('relaunch: a former owner never relaunches around the unresolved fence of the session it later owned', async () => {
  const f = fixture({ domains: new TestDomains() });
  try {
    const a = await f.create();
    await f.supervisor.stop(a.worker_id, bind(a, 'stop-a'));
    // B resumes A's session in another cwd, its prompt's outcome becomes unknown, and B stops with confirmed cleanup.
    const cwd = join(f.dir, 'b');
    mkdirSync(cwd);
    const created = await f.supervisor.create({ command_id: 'b', cwd, provider: 'p', model: 'm', thinking: 'off', resume_session_id: a.session_id! });
    assert.equal(created.state, 'delivered');
    const b = f.supervisor.get(created.worker_id!);
    f.hosts[1]!.failure = true;
    assert.equal((await f.supervisor.prompt(b.worker_id, { ...bind(b, 'lost'), message: 'lost' })).state, 'outcome_unknown');
    await f.supervisor.stop(b.worker_id, bind(f.supervisor.get(b.worker_id), 'stop-b'));
    const fenced = f.supervisor.get(b.worker_id);
    assert.equal(fenced.cleanup, 'cgroup_empty_removed');
    assert.equal(fenced.fence?.command_id, 'lost');
    const records = parseJournal(readFileSync(f.journalFile)).records.length;
    await assert.rejects(
      f.supervisor.relaunch(a.worker_id, bind(a, 'around')),
      (e: Error & { effect?: string; uncertain_command_id?: string }) => e.message === 'target_session_fenced' && e.effect === 'no_effect' && e.uncertain_command_id === 'lost',
    );
    assert.equal(f.supervisor.receipts.all.get('around'), undefined);
    assert.equal(parseJournal(readFileSync(f.journalFile)).records.length, records, 'the refusal records nothing');
    assert.equal(f.hosts.length, 2, 'no host on the fenced session');
    // The owner resolves B's uncertainty: the session is writable again, and A may relaunch on it.
    await resolve(f.supervisor, fenced, 'resolve-b', 'lost');
    assert.equal((await f.supervisor.relaunch(a.worker_id, bind(a, 'after'))).state, 'delivered');
  } finally {
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

for (const restart of [false, true]) {
  test(`relaunch: an unknown outcome after pi was spawned fences the session; no relaunch until it is resolved (restart=${restart})`, async () => {
    let fail = true;
    const f = fixture({
      domains: new TestDomains(),
      initHost: h => {
        const request = h.request.bind(h);
        // pi opened the worker's session (its switch hooks ran), then its inventory is lost.
        h.request = async c => (fail && f.hosts.length > 1 && c.type === 'inventory' ? Promise.reject(new Error('lost_inventory_reply')) : request(c));
      },
    });
    try {
      const w = await f.create();
      await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
      const r = await f.supervisor.relaunch(w.worker_id, bind(w, 'unknown'));
      assert.equal(r.state, 'outcome_unknown');
      assert.ok(f.hosts[1]!.commands.some(c => c.type === 'switch_session'), 'the session was opened');
      const failed = f.supervisor.get(w.worker_id);
      assert.equal(failed.cleanup, 'cgroup_empty_removed');
      assert.equal(failed.fence?.command_id, 'unknown', 'the unknown relaunch fences the session');
      assert.equal(latestRow(f, w.worker_id).fence?.command_id, 'unknown', 'the fence is durable before the reply');
      const s = restart ? await f.restart(f.factory) : f.supervisor;
      const now = s.get(w.worker_id);
      assert.equal(now.fence?.command_id, 'unknown', 'recovery keeps the fence of a dispatched unknown relaunch');
      fail = false;
      await assert.rejects(s.relaunch(w.worker_id, bind(now, 'retry')), (e: Error & { uncertain_command_id?: string }) => e.message === 'session_fenced' && e.uncertain_command_id === 'unknown');
      assert.equal(f.hosts.length, 2);
      await resolve(s, now, 'resolve', 'unknown');
      assert.equal((await s.relaunch(w.worker_id, bind(s.get(w.worker_id), 'retry'))).state, 'delivered');
    } finally {
      await f.supervisor.shutdown();
      f.cleanup();
    }
  });
}

test('relaunch: a spawn refused before any host existed is proven no_effect, not fenced, and may be retried', async () => {
  let fail = false;
  const f = fixture({
    domains: new TestDomains(),
    launch: () => {
      if (fail) throw new Error('test_spawn_refused');
      return undefined;
    },
  });
  try {
    const w = await f.create();
    await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    fail = true;
    const r = await f.supervisor.relaunch(w.worker_id, bind(w, 'refused'));
    assert.equal(r.state, 'rejected');
    assert.equal(r.effect, 'no_effect');
    assert.match(r.error!, /test_spawn_refused/);
    const failed = f.supervisor.get(w.worker_id);
    assert.equal(failed.fence, null);
    assert.equal(failed.cleanup, 'cgroup_empty_removed');
    fail = false;
    assert.equal((await f.supervisor.relaunch(w.worker_id, bind(failed, 'retry'))).state, 'delivered');
  } finally {
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

test('relaunch: a refused spawn whose domain is not proven removed is unknown and fences the session', async () => {
  const domains = new TestDomains();
  let fail = false;
  const f = fixture({
    domains,
    launch: () => {
      if (fail) throw new Error('test_spawn_refused');
      return undefined;
    },
  });
  try {
    const w = await f.create();
    await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    fail = true;
    domains.confirm = false;
    const r = await f.supervisor.relaunch(w.worker_id, bind(w, 'unproven'));
    assert.equal(r.state, 'outcome_unknown');
    const pending = f.supervisor.get(w.worker_id);
    assert.equal(pending.status, 'cleanup_pending');
    assert.equal(pending.fence?.command_id, 'unproven');
    assert.equal(latestRow(f, w.worker_id).fence?.command_id, 'unproven', 'the fence is durable before the reply');
  } finally {
    f.cleanup();
  }
});

for (const trigger of ['stop', 'exit', 'fault'] as const) {
  test(`relaunch: a ${trigger} that ends a relaunch while it initializes fences the session before any cleanup confirms; once resolved it never fences again`, async () => {
    let held: { reject: (e: Error) => void } | undefined;
    const f = fixture({
      domains: new TestDomains(),
      initHost: h => {
        const request = h.request.bind(h);
        h.request = async c => (f.hosts.length === 2 && h === f.hosts[1] && c.type === 'inventory' ? new Promise((_r, reject) => (held = { reject })) : request(c));
      },
    });
    try {
      const w = await f.create();
      await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
      const first = f.supervisor.relaunch(w.worker_id, bind(w, 'relaunch-1'));
      for (let i = 0; i < 6 && !held; i++) await tick();
      assert.ok(held, 'the relaunch waits on its inventory');
      const starting = f.supervisor.get(w.worker_id);
      if (trigger === 'stop') await f.supervisor.stop(w.worker_id, bind(starting, 'stop-starting'));
      else if (trigger === 'exit') f.hosts[1]!.emit('exit');
      else f.hosts[1]!.emit('event', { type: 'host_identity', sessionId: 'wrong', sessionFile: '/wrong' });
      for (let i = 0; i < 6; i++) await tick();
      const ended = f.supervisor.get(w.worker_id);
      assert.equal(ended.cleanup, 'cgroup_empty_removed');
      assert.equal(ended.fence?.command_id, 'relaunch-1');
      assert.equal(latestRow(f, w.worker_id).fence?.command_id, 'relaunch-1', 'the fence is durable');
      await assert.rejects(f.supervisor.relaunch(w.worker_id, bind(ended, 'relaunch-2')), named('session_fenced'));
      assert.equal(f.hosts.length, 2);
      await resolve(f.supervisor, ended, 'resolve', 'relaunch-1');
      held!.reject(new Error('pi exited'));
      assert.equal((await first).state, 'outcome_unknown');
      for (let i = 0; i < 4; i++) await tick();
      assert.equal(f.supervisor.get(w.worker_id).fence, null, 'a resolved uncertainty never fences again');
      assert.equal(latestRow(f, w.worker_id).fence, null);
      assert.equal((await f.supervisor.relaunch(w.worker_id, bind(f.supervisor.get(w.worker_id), 'relaunch-2'))).state, 'delivered');
    } finally {
      await f.supervisor.shutdown();
      f.cleanup();
    }
  });
}

for (const late of ['fails', 'succeeds'] as const) {
  test(`relaunch: a retired relaunch whose initialization ${late} late never touches the newer epoch`, async () => {
    let held: { resolve: (r: PiResponse) => void; reject: (e: Error) => void } | undefined;
    const f = fixture({
      domains: new TestDomains(),
      initHost: h => {
        const request = h.request.bind(h);
        // The first relaunch's inventory reply is held (its identity is checked, the session is open).
        h.request = async c => (f.hosts.length === 2 && h === f.hosts[1] && c.type === 'inventory' ? new Promise<PiResponse>((resolve, reject) => (held = { resolve, reject })) : request(c));
      },
    });
    try {
      const w = await f.create();
      await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
      const first = f.supervisor.relaunch(w.worker_id, bind(w, 'relaunch-1'));
      for (let i = 0; i < 6 && !held; i++) await tick();
      assert.ok(held, 'the first relaunch waits on its inventory');
      const starting = f.supervisor.get(w.worker_id);
      // The starting epoch is stopped; its domain is observed removed while the relaunch still waits.
      const stop = await f.supervisor.stop(w.worker_id, bind(starting, 'stop-starting'));
      assert.equal(stop.result?.termination, 'observed_stopped');
      const stopped = f.supervisor.get(w.worker_id);
      assert.equal(stopped.fence?.command_id, 'relaunch-1', 'the relaunch the stop ended is uncertain: it fences the session');
      await resolve(f.supervisor, stopped, 'resolve', 'relaunch-1');
      assert.equal((await f.supervisor.relaunch(w.worker_id, bind(f.supervisor.get(w.worker_id), 'relaunch-2'))).state, 'delivered');
      const fresh = f.supervisor.get(w.worker_id);
      const domain = f.supervisor.state.require(w.worker_id).domain;
      // The retired host's pending request now fails, as LineHost.fail does when that process is gone, or its reply
      // arrives late.
      if (late === 'fails') held!.reject(new Error('pi exited'));
      else held!.resolve({ type: 'response', id: 'late', success: true, data: { extensions: [], extension_errors: [], skills: [], tools: [], active_tools: [], commands: [] } });
      assert.equal((await first).state, 'outcome_unknown', 'the retired relaunch is never delivered');
      for (let i = 0; i < 4; i++) await tick();
      const now = f.supervisor.get(w.worker_id);
      assert.equal(now.status, 'ready', 'the newer epoch stays ready');
      assert.equal(now.worker_epoch, fresh.worker_epoch);
      assert.equal(now.cleanup, 'live_cgroup');
      assert.equal(now.failure, undefined);
      assert.equal(now.fence, null, 'a resolved uncertainty never fences again');
      assert.equal(f.supervisor.state.require(w.worker_id).domain, domain);
      assert.equal(f.hosts[2]!.stops, 0, 'the newer host is never stopped');
      assert.equal(latestRow(f, w.worker_id).status, 'ready');
      assert.equal(latestRow(f, w.worker_id).worker_epoch, fresh.worker_epoch);
    } finally {
      await f.supervisor.shutdown();
      f.cleanup();
    }
  });
}

for (const restart of [false, true]) {
  test(`relaunch: a domain observed removed while its pi leader still runs confirms nothing, so no second writer starts (restart=${restart})`, async () => {
    const f = fixture({
      domains: new TestDomains(),
      // The leader left the domain (a same-user process can move itself): the domain is observed empty and removed, and
      // the leader is still alive. This test's own process stands in for it; nothing signals it.
      initHost: h => {
        h.pid = process.pid;
        h.token = processToken(process.pid);
        h.stop = async () => {
          h.stops++;
          return true;
        };
      },
    });
    try {
      const w = await f.create();
      const stop = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
      assert.equal(stop.state, 'outcome_unknown', 'a removed domain alone is not termination');
      const s = restart ? await f.restart(f.factory) : f.supervisor;
      const pending = s.get(w.worker_id);
      assert.equal(pending.status, 'cleanup_pending');
      assert.notEqual(pending.cleanup, 'cgroup_empty_removed');
      assert.notEqual(latestRow(f, w.worker_id).cleanup, 'cgroup_empty_removed');
      await assert.rejects(s.relaunch(w.worker_id, bind(pending, 'second-writer')), /cleanup_pending_or_cleanup_unproven/);
      assert.equal(f.hosts.length, 1, 'no second pi on the session');
    } finally {
      f.cleanup();
    }
  });
}

// PR #27 delta review (9a3e93f): a stop wins over the relaunch it retires (GPT D1).

for (const late of ['succeeds', 'fails'] as const) {
  for (const resolved of [true, false]) {
    test(`relaunch: a stop wins over the relaunch it ends; that relaunch's initialization ${late} late and changes nothing (resolved=${resolved})`, async () => {
      let held: { resolve: (r: PiResponse) => void; reject: (e: Error) => void } | undefined;
      const f = fixture({
        domains: new TestDomains(),
        initHost: h => {
          const request = h.request.bind(h);
          // The first relaunch's inventory reply is held (its identity is checked, the session is open).
          h.request = async c => (f.hosts.length === 2 && h === f.hosts[1] && c.type === 'inventory' ? new Promise<PiResponse>((resolve, reject) => (held = { resolve, reject })) : request(c));
        },
      });
      try {
        const w = await f.create();
        await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
        const first = f.supervisor.relaunch(w.worker_id, bind(w, 'relaunch-1'));
        for (let i = 0; i < 6 && !held; i++) await tick();
        assert.ok(held, 'the relaunch waits on its inventory');
        const stop = await f.supervisor.stop(w.worker_id, bind(f.supervisor.get(w.worker_id), 'stop-starting'));
        assert.equal(stop.result?.termination, 'observed_stopped');
        assert.equal(f.supervisor.get(w.worker_id).fence?.command_id, 'relaunch-1', 'the relaunch the stop ended fences the session');
        // No newer epoch is started: the stopped generation is the current one when the late reply arrives.
        if (resolved) await resolve(f.supervisor, f.supervisor.get(w.worker_id), 'resolve', 'relaunch-1');
        const settled = structuredClone(f.supervisor.get(w.worker_id));
        const row = latestRow(f, w.worker_id);
        if (late === 'succeeds') held!.resolve({ type: 'response', id: 'late', success: true, data: { extensions: [], extension_errors: [], skills: [], tools: [], active_tools: [], commands: [] } });
        else held!.reject(new Error('pi exited'));
        assert.equal((await first).state, 'outcome_unknown', 'the relaunch a stop ended is never delivered');
        for (let i = 0; i < 6; i++) await tick();
        const now = f.supervisor.get(w.worker_id);
        assert.equal(now.status, 'stopped', 'the stop wins: the worker is not resurrected');
        assert.equal(now.cleanup, 'cgroup_empty_removed');
        assert.equal(now.worker_epoch, settled.worker_epoch);
        assert.equal(now.failure, undefined);
        assert.deepEqual(now.fence, settled.fence, resolved ? 'a resolved uncertainty never fences again' : 'the fence stays');
        assert.equal(f.supervisor.state.require(w.worker_id).pid, null);
        assert.deepEqual(latestRow(f, w.worker_id), row, 'the stop\'s row stands: no later row rewrites it');
        assert.equal(f.hosts[1]!.stops, 1, 'only the stop cleaned the domain');
        if (resolved) assert.equal((await f.supervisor.relaunch(w.worker_id, bind(now, 'relaunch-2'))).state, 'delivered', 'a genuine replacement is not blocked');
        else await assert.rejects(f.supervisor.relaunch(w.worker_id, bind(now, 'relaunch-2')), named('session_fenced'));
      } finally {
        await f.supervisor.shutdown();
        f.cleanup();
      }
    });
  }
}

// PR #27 delta review (9a3e93f): only OS evidence about the leader proves it gone (Grok 1 and 2, GPT D2).

/** A real process stays alive: not gone from /proc and not a zombie. */
const running = (pid: number) => {
  const info = procInfo(pid);
  return info !== null && info.state !== 'Z';
};

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

for (const restart of [false, true]) {
  test(`relaunch: a transport failure (stdin EPIPE) while the pi leader still runs proves nothing, so no second writer starts (restart=${restart})`, { timeout: 30_000 }, async () => {
    let real: LineHost | undefined;
    const f = fixture({
      domains: new TestDomains(),
      launch: launch => {
        if (launch.commandId !== 'create-0') return undefined;
        // A real process that closes its stdin and keeps running: the supervisor's next write fails with EPIPE, and
        // LineHost emits its `exit` event for that transport failure while the pid is alive.
        const host = new LineHost(process.execPath, ['-e', "require('node:fs').closeSync(0); setInterval(() => {}, 1000);"], { cwd: launch.cwd, env: process.env, timeoutMs: 5000 });
        const file = join(launch.sessionDir, 'real.jsonl');
        writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'real-session' })}\n`);
        const request = host.request.bind(host);
        host.request = async c =>
          c.type === 'get_state'
            ? { type: 'response', id: 'x', success: true, data: { sessionId: 'real-session', sessionFile: file } }
            : c.type === 'inventory'
              ? { type: 'response', id: 'x', success: true, data: { extensions: [], extension_errors: [] } }
              : request(c);
        // The leader left the domain: the domain is observed empty and removed, and nothing signals the leader.
        host.stop = async () => true;
        real = host;
        return host;
      },
    });
    try {
      const w = await f.create();
      const pid = real!.pid!;
      await until(() => !existsSync(`/proc/${pid}/fd/0`), 'the leader to close its stdin');
      const exited = new Promise<void>(r => real!.once('exit', () => r()));
      // The prompt's write meets the closed pipe: EPIPE, then LineHost's `exit` event.
      await f.supervisor.prompt(w.worker_id, { ...bind(w, 'epipe'), message: 'x' }).catch(() => undefined);
      await exited;
      await until(() => f.supervisor.get(w.worker_id).cleanup !== 'leader_exit_only', 'the exit cleanup to settle');
      assert.ok(running(pid), 'the leader still runs after the transport failure');
      assert.equal(f.supervisor.get(w.worker_id).status, 'cleanup_pending', 'a host exit event is not process death');
      assert.notEqual(f.supervisor.get(w.worker_id).cleanup, 'cgroup_empty_removed');
      const stop = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
      assert.equal(stop.state, 'outcome_unknown', 'a removed domain and a host exit event are not termination');
      const s = restart ? await f.restart(f.factory) : f.supervisor;
      const pending = s.get(w.worker_id);
      assert.equal(pending.status, 'cleanup_pending');
      assert.notEqual(pending.cleanup, 'cgroup_empty_removed');
      assert.notEqual(latestRow(f, w.worker_id).cleanup, 'cgroup_empty_removed');
      await assert.rejects(s.relaunch(w.worker_id, bind(pending, 'second-writer')), named('cleanup_pending_or_cleanup_unproven'));
      assert.equal(f.hosts.length, 0, 'no second pi on the session');
      assert.ok(running(pid), 'the leader is the one still running');
    } finally {
      const pid = real?.pid;
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await f.supervisor.shutdown();
      f.cleanup();
    }
  });
}

/** A python3 leader whose main thread exits (the raw exit syscall) while another thread keeps running. */
const ZOMBIE_LEADER = 'import ctypes, threading, time\ndef run():\n    while True:\n        time.sleep(0.05)\nthreading.Thread(target=run).start()\nctypes.CDLL(None).syscall(60, 0)\n';
/** A python3 parent that never reaps its exited child: that child is a zombie with no live thread. Prints its pid. */
const DEAD_ZOMBIE = 'import os, sys, time\npid = os.fork()\nif pid == 0:\n    os._exit(0)\nprint(pid, flush=True)\ntime.sleep(60)\n';

test('relaunch: a zombie pi leader with a live thread is not gone, so no second writer starts; one with no live thread is', { timeout: 30_000 }, async () => {
  const leader = spawn('/usr/bin/python3', ['-c', ZOMBIE_LEADER], { detached: true, stdio: 'ignore' });
  const parent = spawn('/usr/bin/python3', ['-c', DEAD_ZOMBIE], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let pid = leader.pid!;
  const f = fixture({
    domains: new TestDomains(),
    initHost: h => {
      // The domain is observed empty and removed; nothing signals the recorded leader.
      h.pid = pid;
      h.token = processToken(pid);
      h.stop = async () => {
        h.stops++;
        return true;
      };
    },
  });
  try {
    await until(() => procInfo(pid)?.state === 'Z' && readdirSync(`/proc/${pid}/task`).length > 1, 'a zombie leader with a live thread');
    const w = await f.create();
    const stop = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(stop.state, 'outcome_unknown', 'a zombie leader whose thread still runs is not gone');
    const pending = f.supervisor.get(w.worker_id);
    assert.equal(pending.status, 'cleanup_pending');
    assert.notEqual(latestRow(f, w.worker_id).cleanup, 'cgroup_empty_removed');
    await assert.rejects(f.supervisor.relaunch(w.worker_id, bind(pending, 'second-writer')), named('cleanup_pending_or_cleanup_unproven'));
    assert.equal(f.hosts.length, 1, 'no second pi on the session');
    // Control: an unreaped zombie whose every thread has exited is gone (the state a cgroup kill leaves before Node
    // reaps the leader).
    pid = Number(await new Promise<string>(r => parent.stdout!.once('data', (b: Buffer) => r(b.toString()))));
    await until(() => procInfo(pid)?.state === 'Z', 'an unreaped zombie');
    const other = await f.create();
    assert.equal((await f.supervisor.stop(other.worker_id, bind(other, 'stop-other'))).result?.termination, 'observed_stopped');
  } finally {
    for (const p of [leader, parent]) {
      try {
        process.kill(-p.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    f.cleanup();
  }
});
