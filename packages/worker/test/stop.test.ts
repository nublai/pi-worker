/**
 * Stop results of a superseded generation (P2-3), ported from A0 `src/test/issue1-stop.test.ts` and
 * `stop-superseded.test.ts`. A stop whose cleanup completes after a relaunch brought up a new generation reports
 * `superseded_generation_stopped` (old domain gone) or `superseded_generation_unknown` (not proven), with the stopped
 * and current epochs, and leaves the live generation alone; an ordinary stop names the same epoch twice.
 *
 * Two cleanups of one domain in flight at once take the seam of held-domains.ts (`independentCleanup`): production
 * shares one cleanup per worker (PR #21). A0's stop-superseded cases changed the worker's generation directly while
 * its cleanup waited; so do these (`supersede`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Receipt } from '../src/receipts/receipts.js';
import type { Supervisor } from '../src/supervisor/supervisor.js';
import { TestDomains } from './domains.js';
import { bind, fixture, tick } from './supervisor-fixture.js';
import { heldDomains, independentCleanup } from './held-domains.js';

/** What a relaunch does to the worker's generation, done directly while a stop's cleanup waits (A0 stop-superseded). */
function supersede(s: Supervisor, id: string): string {
  const live = s.state.require(id);
  const epoch = `new-relaunch-epoch-${randomUUID()}`;
  live.worker.worker_epoch = epoch;
  live.domain = s.lifecycle.containment.reserve(epoch);
  return epoch;
}

// A0 issue1-stop.test.ts

test('issue1: superseded stop (cleanup succeeded) reports superseded_generation_stopped, not observed_stopped', async () => {
  const held = heldDomains();
  const f = fixture({ domains: held.domains });
  try {
    const old = await f.create();
    const oldEpoch = old.worker_epoch;
    held.hold();
    // stop-a: its cleanup waits (calls[0]).
    const stopAPromise = f.supervisor.stop(old.worker_id, bind(old, 'stop-a'));
    await tick();
    // stop-b, same old generation: its own cleanup waits too (calls[1]).
    independentCleanup(f.supervisor, old.worker_id);
    const stopBPromise = f.supervisor.stop(old.worker_id, bind(old, 'stop-b'));
    await tick();
    assert.equal(held.calls.length, 2, 'both stops should trigger cleanup');
    held.calls[0]!.finish(true);
    const stopAReceipt = await stopAPromise;
    assert.equal(stopAReceipt.state, 'delivered', 'stop-a: delivered');
    assert.equal(stopAReceipt.result?.['termination'], 'observed_stopped', 'stop-a: ordinary observed_stopped');
    const stoppedWorker = f.supervisor.get(old.worker_id);
    assert.equal(stoppedWorker.status, 'stopped', 'worker should be stopped after stop-a');
    const relaunchReceipt = await f.supervisor.relaunch(old.worker_id, bind(stoppedWorker, 'relaunch'));
    assert.equal(relaunchReceipt.state, 'delivered', 'relaunch succeeded');
    const freshWorker = f.supervisor.get(old.worker_id);
    const freshEpoch = freshWorker.worker_epoch;
    assert.notEqual(freshEpoch, oldEpoch, 'new generation has a different epoch');
    assert.equal(freshWorker.status, 'ready', 'new generation is ready');
    held.calls[1]!.finish(true);
    const stopBReceipt: Receipt = await stopBPromise;
    assert.equal(stopBReceipt.result?.['termination'], 'superseded_generation_stopped', 'superseded stop (cleanup succeeded) must report superseded_generation_stopped, not observed_stopped');
    const stopBResult = stopBReceipt.result as Record<string, unknown>;
    assert.ok('stopped_worker_epoch' in stopBResult, 'superseded stop receipt must include stopped_worker_epoch');
    assert.ok('current_worker_epoch' in stopBResult, 'superseded stop receipt must include current_worker_epoch');
    assert.equal(stopBResult['stopped_worker_epoch'], oldEpoch, 'stopped_worker_epoch must be the old generation epoch');
    assert.equal(stopBResult['current_worker_epoch'], freshEpoch, 'current_worker_epoch must be the new generation epoch');
    assert.notEqual(stopBResult['stopped_worker_epoch'], stopBResult['current_worker_epoch'], 'stopped_worker_epoch !== current_worker_epoch proves supersession');
    assert.equal(f.supervisor.get(old.worker_id).status, 'ready', 'new generation must still be ready after superseded stop resolves');
    assert.equal(f.supervisor.get(old.worker_id).worker_epoch, freshEpoch, 'new generation epoch unchanged after superseded stop');
    const stopBAgain = await f.supervisor.stop(old.worker_id, bind(old, 'stop-b'));
    assert.deepEqual(stopBAgain, stopBReceipt, 'duplicate stop-b call returns the same receipt (idempotency)');
  } finally {
    held.release();
    await tick();
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

test('issue1: superseded stop (cleanup failed) reports superseded_generation_unknown with outcome_unknown', async () => {
  const held = heldDomains();
  const f = fixture({ domains: held.domains });
  try {
    const old = await f.create();
    const oldEpoch = old.worker_epoch;
    held.hold();
    const stopAPromise = f.supervisor.stop(old.worker_id, bind(old, 'stop-a'));
    await tick();
    independentCleanup(f.supervisor, old.worker_id);
    const stopBPromise = f.supervisor.stop(old.worker_id, bind(old, 'stop-b'));
    await tick();
    assert.equal(held.calls.length, 2, 'both stops trigger cleanup');
    held.calls[0]!.finish(true);
    await stopAPromise;
    const stoppedWorker = f.supervisor.get(old.worker_id);
    assert.equal(stoppedWorker.status, 'stopped');
    const relaunchReceipt = await f.supervisor.relaunch(old.worker_id, bind(stoppedWorker, 'relaunch'));
    assert.equal(relaunchReceipt.state, 'delivered');
    const freshWorker = f.supervisor.get(old.worker_id);
    const freshEpoch = freshWorker.worker_epoch;
    assert.notEqual(freshEpoch, oldEpoch);
    assert.equal(freshWorker.status, 'ready');
    held.calls[1]!.finish(false);
    const stopBReceipt: Receipt = await stopBPromise;
    const stopBResult = stopBReceipt.result as Record<string, unknown>;
    assert.equal(stopBResult['termination'], 'superseded_generation_unknown', 'superseded stop (cleanup failed) must report superseded_generation_unknown');
    assert.equal(stopBReceipt.state, 'outcome_unknown', 'superseded_generation_unknown: state must be outcome_unknown');
    assert.equal(stopBReceipt.effect, 'unknown', 'superseded_generation_unknown: effect must be unknown');
    assert.ok('stopped_worker_epoch' in stopBResult, 'superseded_generation_unknown receipt must include stopped_worker_epoch');
    assert.ok('current_worker_epoch' in stopBResult, 'superseded_generation_unknown receipt must include current_worker_epoch');
    assert.equal(stopBResult['stopped_worker_epoch'], oldEpoch);
    assert.equal(stopBResult['current_worker_epoch'], freshEpoch);
    assert.notEqual(stopBResult['stopped_worker_epoch'], stopBResult['current_worker_epoch']);
    assert.equal(f.supervisor.get(old.worker_id).status, 'ready');
    assert.equal(f.supervisor.get(old.worker_id).worker_epoch, freshEpoch);
  } finally {
    held.release();
    await tick();
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

test('issue1: ordinary observed_stopped includes stopped_worker_epoch === current_worker_epoch', async () => {
  const f = fixture({ domains: new TestDomains() });
  try {
    const w = await f.create();
    const workerEpoch = w.worker_epoch;
    const stopReceipt = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(stopReceipt.state, 'delivered', 'ordinary stop: delivered');
    assert.equal(stopReceipt.result?.['termination'], 'observed_stopped', 'ordinary stop: termination is observed_stopped');
    const stopResult = stopReceipt.result as Record<string, unknown>;
    assert.ok('stopped_worker_epoch' in stopResult, 'ordinary observed_stopped must include stopped_worker_epoch');
    assert.ok('current_worker_epoch' in stopResult, 'ordinary observed_stopped must include current_worker_epoch');
    assert.equal(stopResult['stopped_worker_epoch'], workerEpoch, 'stopped_worker_epoch must be the worker epoch');
    assert.equal(stopResult['current_worker_epoch'], workerEpoch, 'current_worker_epoch must also be the worker epoch for a non-superseded stop');
    assert.equal(stopResult['stopped_worker_epoch'], stopResult['current_worker_epoch'], 'stopped_worker_epoch === current_worker_epoch for ordinary stop');
    const stopAgain = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.deepEqual(stopAgain, stopReceipt, 'duplicate stop command returns identical receipt');
  } finally {
    f.cleanup();
  }
});

test('issue1: superseded stop receipt is stable on duplicate submission', async () => {
  const held = heldDomains();
  const f = fixture({ domains: held.domains });
  try {
    const old = await f.create();
    held.hold();
    const stopXPromise = f.supervisor.stop(old.worker_id, bind(old, 'stop-x'));
    await tick();
    independentCleanup(f.supervisor, old.worker_id);
    const stopYPromise = f.supervisor.stop(old.worker_id, bind(old, 'stop-y'));
    await tick();
    assert.equal(held.calls.length, 2);
    held.calls[0]!.finish(true);
    await stopXPromise;
    const stoppedW = f.supervisor.get(old.worker_id);
    await f.supervisor.relaunch(old.worker_id, bind(stoppedW, 'relaunch'));
    held.calls[1]!.finish(true);
    const stopYReceipt: Receipt = await stopYPromise;
    const stopYAgain = await f.supervisor.stop(old.worker_id, bind(old, 'stop-y'));
    assert.deepEqual(stopYAgain, stopYReceipt, 'duplicate superseded stop command returns the same receipt (idempotency)');
  } finally {
    held.release();
    await tick();
    await f.supervisor.shutdown();
    f.cleanup();
  }
});

test('stop: a relaunched generation cleans its own domain, never sharing a superseded cleanup still in flight', async () => {
  const held = heldDomains();
  const f = fixture({ domains: held.domains });
  try {
    const old = await f.create();
    held.hold();
    const stopA = f.supervisor.stop(old.worker_id, bind(old, 'stop-a'));
    await tick();
    independentCleanup(f.supervisor, old.worker_id);
    void f.supervisor.stop(old.worker_id, bind(old, 'stop-b'));
    await tick();
    held.calls[0]!.finish(true);
    await stopA;
    assert.equal((await f.supervisor.relaunch(old.worker_id, bind(old, 'relaunch'))).state, 'delivered');
    const fresh = f.supervisor.get(old.worker_id);
    const freshDomain = f.supervisor.state.require(old.worker_id).domain!;
    // The old domain's second cleanup (stop-b's) is still in flight; the new generation's stop starts its own.
    const stopFresh = f.supervisor.stop(old.worker_id, bind(fresh, 'stop-fresh'));
    await tick();
    assert.equal(held.calls.length, 3, 'the new generation is cleaned by its own cleanup');
    assert.equal(held.calls[2]!.domain, freshDomain);
    held.calls[1]!.finish(true);
    await tick();
    assert.equal(f.supervisor.get(old.worker_id).status, 'cleanup_pending', 'the old domain proves nothing about the new one');
    held.calls[2]!.finish(true);
    assert.equal((await stopFresh).result?.termination, 'observed_stopped');
    assert.equal(f.supervisor.get(old.worker_id).status, 'stopped');
  } finally {
    held.release();
    await tick();
    f.cleanup();
  }
});

// A0 stop-superseded.test.ts

test('late stop after successful relaunch: termination is superseded_generation_stopped with both epoch fields', async () => {
  const held = heldDomains();
  const f = fixture({ domains: held.domains });
  try {
    const w0 = await f.create();
    const originalEpoch = w0.worker_epoch;
    held.hold();
    const stopPromise = f.supervisor.stop(w0.worker_id, bind(w0, 'stop'));
    // The stop validated with the original epoch and waits for its cleanup; the generation changes meanwhile.
    await tick();
    const newEpoch = supersede(f.supervisor, w0.worker_id);
    held.calls[0]!.finish(true);
    const stopReceipt = await stopPromise;
    assert.equal(stopReceipt.state, 'delivered', `expected delivered, got ${stopReceipt.state}`);
    assert.equal(stopReceipt.result?.termination, 'superseded_generation_stopped', `expected superseded_generation_stopped, got ${stopReceipt.result?.termination}`);
    assert.equal(stopReceipt.result?.stopped_worker_epoch, originalEpoch, 'stopped_worker_epoch should be the old epoch');
    assert.equal(stopReceipt.result?.current_worker_epoch, newEpoch, 'current_worker_epoch should be the new running epoch');
    const after = f.supervisor.get(w0.worker_id);
    assert.notEqual(after.status, 'stopped', 'superseded stop must not mark new generation as stopped');
  } finally {
    held.release();
    f.cleanup();
  }
});

test('late stop after failed cleanup, superseded generation: termination is superseded_generation_unknown', async () => {
  const held = heldDomains();
  const f = fixture({ domains: held.domains });
  try {
    const w0 = await f.create();
    held.hold();
    const stopPromise = f.supervisor.stop(w0.worker_id, bind(w0, 'stop'));
    await tick();
    supersede(f.supervisor, w0.worker_id);
    held.calls[0]!.finish(false);
    const stopReceipt = await stopPromise;
    assert.equal(stopReceipt.state, 'outcome_unknown', `expected outcome_unknown, got ${stopReceipt.state}`);
    assert.equal(stopReceipt.result?.termination, 'superseded_generation_unknown', `expected superseded_generation_unknown, got ${stopReceipt.result?.termination}`);
    assert.equal(stopReceipt.effect, 'unknown', `expected effect unknown, got ${stopReceipt.effect}`);
  } finally {
    held.release();
    f.cleanup();
  }
});

test('ordinary stop (non-superseded): termination is observed_stopped with matching epoch fields', async () => {
  const f = fixture({ domains: new TestDomains() });
  try {
    const w0 = await f.create();
    const originalEpoch = w0.worker_epoch;
    const stopReceipt = await f.supervisor.stop(w0.worker_id, bind(w0, 'stop'));
    assert.equal(stopReceipt.state, 'delivered');
    assert.equal(stopReceipt.result?.termination, 'observed_stopped', `expected observed_stopped, got ${stopReceipt.result?.termination}`);
    assert.equal(stopReceipt.result?.stopped_worker_epoch, originalEpoch, 'stopped_worker_epoch must be present and equal to the stopped epoch');
    assert.equal(stopReceipt.result?.current_worker_epoch, originalEpoch, 'current_worker_epoch must equal stopped_worker_epoch for non-superseded stop');
  } finally {
    f.cleanup();
  }
});

test('stop idempotency: second stop call returns the same receipt', async () => {
  const f = fixture({ domains: new TestDomains() });
  try {
    const w0 = await f.create();
    const first = await f.supervisor.stop(w0.worker_id, bind(w0, 'stop-idempotent'));
    const second = await f.supervisor.stop(w0.worker_id, bind(w0, 'stop-idempotent'));
    assert.deepEqual(first, second, 'idempotent stop must return the same receipt');
    assert.equal(first.result?.termination, 'observed_stopped');
    assert.equal(first.result?.stopped_worker_epoch, first.result?.current_worker_epoch);
  } finally {
    f.cleanup();
  }
});

test('unknown stop (cleanup failed, no supersession): epoch fields still identify the targeted generation', async () => {
  const f = fixture({ domains: new TestDomains({ confirm: false }) });
  try {
    const w0 = await f.create();
    const originalEpoch = w0.worker_epoch;
    const stopReceipt = await f.supervisor.stop(w0.worker_id, bind(w0, 'stop-unknown'));
    assert.equal(stopReceipt.state, 'outcome_unknown');
    assert.equal(stopReceipt.result?.termination, 'unknown');
    assert.equal(stopReceipt.result?.stopped_worker_epoch, originalEpoch, 'unknown stop must still report stopped_worker_epoch for the targeted generation');
    assert.equal(stopReceipt.result?.current_worker_epoch, originalEpoch, 'unknown stop without supersession: current_worker_epoch equals stopped_worker_epoch');
  } finally {
    f.cleanup();
  }
});
