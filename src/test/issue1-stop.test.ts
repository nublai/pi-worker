/**
 * Issue #1: workers.stop reports observed_stopped for a superseded generation.
 *
 * RED on base (409bd88): the superseded stop receipt still returns
 * termination:"observed_stopped" instead of "superseded_generation_stopped".
 *
 * GREEN after the fix adds:
 *   - termination:"superseded_generation_stopped" (old cleanup succeeded, generation superseded)
 *   - termination:"superseded_generation_unknown"  (old cleanup failed,   generation superseded)
 *   - stopped_worker_epoch / current_worker_epoch on superseded receipts
 *   - stopped_worker_epoch / current_worker_epoch on regular "observed_stopped" too
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import type { Containment, CleanupUnit } from '../containment.js';
import { Host, bind, tick } from './helpers.js';
import type { Receipt } from '../types.js';

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'a0-issue1-stop-'));
  const cwd = join(root, 'work'); mkdirSync(cwd);
  const journal = new Journal(join(root, 'journal'));
  const hosts: Host[] = [];

  const jail: Containment = {
    profile: 'test',
    reserve: epoch => ({ root, name: 'w-' + epoch, boot: 'test' }),
    spawn: () => { throw new Error('unused'); },
    clean: async () => true,
  };

  const factory = (_c: unknown, dir: string) => {
    const sid = 'native-' + hosts.length;
    const file = join(dir, sid + '.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
    const h = new Host(dir, sid, file);
    h.pid = 2147483000 + hosts.length;
    hosts.push(h);
    return h;
  };

  const s = new Supervisor(root, journal, 'test', factory, jail);

  const create = () =>
    s.create({ command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const });

  const close = async () => {
    jail.clean = async () => true;
    await s.shutdown();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  };

  return { root, cwd, journal, hosts, jail, s, create, close };
}

// ---------------------------------------------------------------------------
// Helper: controllable cleanup calls
// ---------------------------------------------------------------------------
function makeControllableClean(jail: Containment) {
  const calls: { unit: CleanupUnit; finish: (gone: boolean) => void }[] = [];
  jail.clean = unit => new Promise<boolean>(finish => calls.push({ unit, finish }));
  return calls;
}

// ---------------------------------------------------------------------------
// Test 3a: superseded_generation_stopped (old cleanup succeeded)
//   The late stop targeted the OLD generation; a new generation is now live.
//   Receipt must NOT say "observed_stopped"; must say "superseded_generation_stopped".
// ---------------------------------------------------------------------------
test('issue1: superseded stop (cleanup succeeded) reports superseded_generation_stopped, not observed_stopped', async () => {
  const f = setup();
  const calls = makeControllableClean(f.jail);
  try {
    const made = await f.create();
    const old = f.s.get(made.worker_id!);
    const oldEpoch = old.worker_epoch;

    // stop-a: triggers jail.clean → blocked (calls[0])
    const stopAPromise = f.s.stop(old.worker_id, bind(old, 'stop-a'));
    await tick(); // let stop-a register its cleanup call

    // stop-b (second stop, same old generation): also blocked (calls[1])
    const stopBPromise = f.s.stop(old.worker_id, bind(old, 'stop-b'));
    await tick();

    // Two cleanup calls pending, both for the old unit
    assert.equal(calls.length, 2, 'both stops should trigger cleanup');

    // Resolve the first cleanup as succeeded → stop-a completes normally
    calls[0]!.finish(true);
    // Let stop-a fully settle (sets status=stopped, cleanup=cgroup_empty_removed)
    const stopAReceipt = await stopAPromise;
    assert.equal(stopAReceipt.state, 'delivered', 'stop-a: delivered');
    assert.equal(stopAReceipt.result?.['termination'], 'observed_stopped', 'stop-a: ordinary observed_stopped');

    // Worker is now stopped → relaunch is eligible
    const stoppedWorker = f.s.get(old.worker_id);
    assert.equal(stoppedWorker.status, 'stopped', 'worker should be stopped after stop-a');

    // Relaunch produces a new generation
    const relaunchReceipt = await f.s.relaunch(old.worker_id, bind(stoppedWorker, 'relaunch'));
    assert.equal(relaunchReceipt.state, 'delivered', 'relaunch succeeded');

    const freshWorker = f.s.get(old.worker_id);
    const freshEpoch = freshWorker.worker_epoch;
    assert.notEqual(freshEpoch, oldEpoch, 'new generation has a different epoch');
    assert.equal(freshWorker.status, 'ready', 'new generation is ready');

    // Now resolve stop-b's cleanup (it was for the OLD unit, but relaunch happened)
    calls[1]!.finish(true); // old cleanup succeeded
    const stopBReceipt: Receipt = await stopBPromise;

    // --- The core assertion: stop-b should NOT claim it observed the current worker stopped ---
    // RED on base: base returns 'observed_stopped' but fix should return 'superseded_generation_stopped'
    assert.equal(
      stopBReceipt.result?.['termination'],
      'superseded_generation_stopped',
      'superseded stop (cleanup succeeded) must report superseded_generation_stopped, not observed_stopped',
    );

    // After fix: stopped_worker_epoch and current_worker_epoch must be present
    const stopBResult = stopBReceipt.result as Record<string, unknown>;
    assert.ok('stopped_worker_epoch' in stopBResult,
      'superseded stop receipt must include stopped_worker_epoch');
    assert.ok('current_worker_epoch' in stopBResult,
      'superseded stop receipt must include current_worker_epoch');

    // The stopped epoch is the OLD generation
    assert.equal(stopBResult['stopped_worker_epoch'], oldEpoch,
      'stopped_worker_epoch must be the old generation epoch');
    // The current epoch is the NEW generation (freshEpoch)
    assert.equal(stopBResult['current_worker_epoch'], freshEpoch,
      'current_worker_epoch must be the new generation epoch');
    // They must differ — proving supersession
    assert.notEqual(stopBResult['stopped_worker_epoch'], stopBResult['current_worker_epoch'],
      'stopped_worker_epoch !== current_worker_epoch proves supersession');

    // The new generation must still be live / ready
    assert.equal(f.s.get(old.worker_id).status, 'ready',
      'new generation must still be ready after superseded stop resolves');
    assert.equal(f.s.get(old.worker_id).worker_epoch, freshEpoch,
      'new generation epoch unchanged after superseded stop');

    // Duplicate receipt idempotency: re-calling stop-b returns the same receipt
    const stopBAgain = await f.s.stop(old.worker_id, bind(old, 'stop-b'));
    assert.deepEqual(stopBAgain, stopBReceipt,
      'duplicate stop-b call returns the same receipt (idempotency)');

  } finally {
    for (const call of calls) call.finish(true);
    await tick();
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Test 3b: superseded_generation_unknown (old cleanup failed)
//   Old cleanup returned false (gone=false) AND generation was superseded.
//   Receipt must say termination:"superseded_generation_unknown",
//   state:"outcome_unknown", effect:"unknown".
// ---------------------------------------------------------------------------
test('issue1: superseded stop (cleanup failed) reports superseded_generation_unknown with outcome_unknown', async () => {
  const f = setup();
  const calls = makeControllableClean(f.jail);
  try {
    const made = await f.create();
    const old = f.s.get(made.worker_id!);
    const oldEpoch = old.worker_epoch;

    // stop-a: blocked (calls[0])
    const stopAPromise = f.s.stop(old.worker_id, bind(old, 'stop-a'));
    await tick();

    // stop-b: blocked (calls[1])
    const stopBPromise = f.s.stop(old.worker_id, bind(old, 'stop-b'));
    await tick();

    assert.equal(calls.length, 2, 'both stops trigger cleanup');

    // Resolve first stop as succeeded → stop-a completes normally
    calls[0]!.finish(true);
    await stopAPromise;

    // Relaunch before stop-b's cleanup resolves
    const stoppedWorker = f.s.get(old.worker_id);
    assert.equal(stoppedWorker.status, 'stopped');
    const relaunchReceipt = await f.s.relaunch(old.worker_id, bind(stoppedWorker, 'relaunch'));
    assert.equal(relaunchReceipt.state, 'delivered');

    const freshWorker = f.s.get(old.worker_id);
    const freshEpoch = freshWorker.worker_epoch;
    assert.notEqual(freshEpoch, oldEpoch);
    assert.equal(freshWorker.status, 'ready');

    // Now resolve stop-b's OLD cleanup as FAILED (gone=false)
    calls[1]!.finish(false);
    const stopBReceipt: Receipt = await stopBPromise;

    // RED on base: base returns state='outcome_unknown' (since gone=false) but
    // termination:'unknown'. Fix should return termination:'superseded_generation_unknown'
    // with state:'outcome_unknown', effect:'unknown'.
    const stopBResult = stopBReceipt.result as Record<string, unknown>;
    assert.equal(
      stopBResult['termination'],
      'superseded_generation_unknown',
      'superseded stop (cleanup failed) must report superseded_generation_unknown',
    );
    assert.equal(stopBReceipt.state, 'outcome_unknown',
      'superseded_generation_unknown: state must be outcome_unknown');
    assert.equal(stopBReceipt.effect, 'unknown',
      'superseded_generation_unknown: effect must be unknown');

    // Epoch fields must be present
    assert.ok('stopped_worker_epoch' in stopBResult,
      'superseded_generation_unknown receipt must include stopped_worker_epoch');
    assert.ok('current_worker_epoch' in stopBResult,
      'superseded_generation_unknown receipt must include current_worker_epoch');
    assert.equal(stopBResult['stopped_worker_epoch'], oldEpoch);
    assert.equal(stopBResult['current_worker_epoch'], freshEpoch);
    assert.notEqual(stopBResult['stopped_worker_epoch'], stopBResult['current_worker_epoch']);

    // New generation still running
    assert.equal(f.s.get(old.worker_id).status, 'ready');
    assert.equal(f.s.get(old.worker_id).worker_epoch, freshEpoch);

  } finally {
    for (const call of calls) call.finish(true);
    await tick();
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Test 3c: Ordinary observed_stopped — both epoch fields present and equal
//   When no supersession occurs, the receipt must include stopped_worker_epoch
//   and current_worker_epoch, and they must be equal (same generation stopped).
// ---------------------------------------------------------------------------
test('issue1: ordinary observed_stopped includes stopped_worker_epoch === current_worker_epoch', async () => {
  const f = setup();
  try {
    const made = await f.create();
    const w = f.s.get(made.worker_id!);
    const workerEpoch = w.worker_epoch;

    // Normal stop — no race, no relaunch
    const stopReceipt = await f.s.stop(w.worker_id, bind(w, 'stop'));

    assert.equal(stopReceipt.state, 'delivered', 'ordinary stop: delivered');
    assert.equal(stopReceipt.result?.['termination'], 'observed_stopped',
      'ordinary stop: termination is observed_stopped');

    // After fix: both epoch fields present
    const stopResult = stopReceipt.result as Record<string, unknown>;
    assert.ok('stopped_worker_epoch' in stopResult,
      'ordinary observed_stopped must include stopped_worker_epoch');
    assert.ok('current_worker_epoch' in stopResult,
      'ordinary observed_stopped must include current_worker_epoch');

    // Epochs match (same generation)
    assert.equal(stopResult['stopped_worker_epoch'], workerEpoch,
      'stopped_worker_epoch must be the worker epoch');
    assert.equal(stopResult['current_worker_epoch'], workerEpoch,
      'current_worker_epoch must also be the worker epoch for a non-superseded stop');
    assert.equal(stopResult['stopped_worker_epoch'], stopResult['current_worker_epoch'],
      'stopped_worker_epoch === current_worker_epoch for ordinary stop');

    // Idempotency: duplicate receipt
    const stopAgain = await f.s.stop(w.worker_id, bind(w, 'stop'));
    assert.deepEqual(stopAgain, stopReceipt, 'duplicate stop command returns identical receipt');

  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Test 3d: Duplicate receipt idempotency for superseded stop
//   Re-submitting a superseded stop command returns the same receipt.
// ---------------------------------------------------------------------------
test('issue1: superseded stop receipt is stable on duplicate submission', async () => {
  const f = setup();
  const calls = makeControllableClean(f.jail);
  try {
    const made = await f.create();
    const old = f.s.get(made.worker_id!);

    // stop-x: blocked (calls[0])
    const stopXPromise = f.s.stop(old.worker_id, bind(old, 'stop-x'));
    await tick();

    // stop-y (blocked, calls[1]) — this will be the superseded one
    const stopYPromise = f.s.stop(old.worker_id, bind(old, 'stop-y'));
    await tick();

    assert.equal(calls.length, 2);

    // Let stop-x win and complete
    calls[0]!.finish(true);
    await stopXPromise;

    // Relaunch
    const stoppedW = f.s.get(old.worker_id);
    await f.s.relaunch(old.worker_id, bind(stoppedW, 'relaunch'));

    // Resolve stop-y late (superseded)
    calls[1]!.finish(true);
    const stopYReceipt: Receipt = await stopYPromise;

    // The superseded receipt should be final and stable
    // (On base it says 'observed_stopped'; on fixed it says 'superseded_generation_stopped')
    // Either way, re-submitting the same command_id returns the same receipt.
    const stopYAgain = await f.s.stop(old.worker_id, bind(old, 'stop-y'));
    assert.deepEqual(stopYAgain, stopYReceipt,
      'duplicate superseded stop command returns the same receipt (idempotency)');

  } finally {
    for (const call of calls) call.finish(true);
    await tick();
    await f.close();
  }
});
