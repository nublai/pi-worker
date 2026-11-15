/**
 * Regression tests for the late-stop / superseded-generation race.
 * Before the fix, workers.stop always returned termination: "observed_stopped"
 * even when a relaunch had already started a new generation - making clients
 * believe a running worker was stopped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { Host, bind } from './helpers.js';
import type { Containment, CleanupUnit } from '../containment.js';

/** Build a cgroup-style containment where cleanup resolves immediately with given result. */
function makeContainment(opts: { cleanResult?: boolean } = {}): Containment & { units: CleanupUnit[] } {
  const units: CleanupUnit[] = [];
  let seq = 0;
  return {
    profile: 'test_superseded',
    units,
    reserve: (epoch: string) => {
      const u: CleanupUnit = { root: '/fake', name: `w-${seq++}-${epoch}`, boot: 'test' };
      units.push(u);
      return u;
    },
    spawn: () => { throw new Error('seam'); },
    clean: async (_unit: CleanupUnit) => opts.cleanResult ?? true,
  };
}

/** Build a cgroup-style containment where cleanup is manually triggered. */
function makeSlowContainment(opts: { cleanResult?: boolean } = {}): Containment & { units: CleanupUnit[]; triggerClean: () => void } {
  const units: CleanupUnit[] = [];
  let seq = 0;
  let cleanResolve: (() => void) | null = null;
  return {
    profile: 'test_superseded_slow',
    units,
    triggerClean: () => { cleanResolve?.(); cleanResolve = null; },
    reserve: (epoch: string) => {
      const u: CleanupUnit = { root: '/fake', name: `w-${seq++}-${epoch}`, boot: 'test' };
      units.push(u);
      return u;
    },
    spawn: () => { throw new Error('seam'); },
    clean: async (_unit: CleanupUnit) => {
      await new Promise<void>(r => { cleanResolve = r; });
      return opts.cleanResult ?? true;
    },
  };
}

/** Create a supervisor with cgroup containment and a simple session factory. */
function makeFixture(root: string, containment: Containment) {
  const journal = new Journal(join(root, 'journal'));
  const hosts: Host[] = [];
  const factory = (_c: unknown, dir: string) => {
    const sid = `sid-${hosts.length}`;
    const file = join(dir, sid + '.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
    const h = new Host(dir, sid, file);
    hosts.push(h);
    return h;
  };
  const cwd = join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const supervisor = new Supervisor(root, journal, 'test', factory, containment);
  return { journal, supervisor, hosts, cwd };
}

test('late stop after successful relaunch: termination is superseded_generation_stopped with both epoch fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s6-superseded-ok-'));
  const containment = makeSlowContainment({ cleanResult: true });
  const { journal, supervisor, cwd } = makeFixture(root, containment);
  try {
    const createArgs = { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await supervisor.create(createArgs);
    const w0 = supervisor.get(r.worker_id!);
    const originalEpoch = w0.worker_epoch;

    // Start stop. The validate() phase runs synchronously first with the original
    // epoch, then the async body awaits cleanup. We interleave the generation
    // change between validate and cleanup completing.
    const stopPromise = supervisor.stop(w0.worker_id, bind(w0, 'stop'));

    // Let receipts.run enter the async body and hit the cleanup await.
    // After one Promise.resolve() tick, validate() has run and cleanup is suspended.
    await Promise.resolve();

    // Simulate what a concurrent relaunch would do: change live.unit to a new generation.
    const live = supervisor.require(w0.worker_id);
    const newEpoch = 'new-relaunch-epoch-' + Date.now();
    live.worker.worker_epoch = newEpoch;
    live.unit = containment.reserve(newEpoch) as CleanupUnit;

    // Now allow cleanup to complete (old generation confirmed gone)
    containment.triggerClean();
    const stopReceipt = await stopPromise;

    assert.equal(stopReceipt.state, 'delivered', `expected delivered, got ${stopReceipt.state}`);
    assert.equal(stopReceipt.result?.termination, 'superseded_generation_stopped',
      `expected superseded_generation_stopped, got ${stopReceipt.result?.termination}`);
    assert.equal(stopReceipt.result?.stopped_worker_epoch, originalEpoch,
      'stopped_worker_epoch should be the old epoch');
    assert.equal(stopReceipt.result?.current_worker_epoch, newEpoch,
      'current_worker_epoch should be the new running epoch');

    // Worker itself should still be running (not stopped) since it was superseded
    const after = supervisor.get(w0.worker_id);
    assert.notEqual(after.status, 'stopped', 'superseded stop must not mark new generation as stopped');
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('late stop after failed cleanup, superseded generation: termination is superseded_generation_unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s6-superseded-fail-'));
  const containment = makeSlowContainment({ cleanResult: false });
  const { journal, supervisor, cwd } = makeFixture(root, containment);
  try {
    const createArgs = { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await supervisor.create(createArgs);
    const w0 = supervisor.get(r.worker_id!);

    const stopPromise = supervisor.stop(w0.worker_id, bind(w0, 'stop'));

    // Let receipts.run enter async body and suspend on cleanup
    await Promise.resolve();
    const live = supervisor.require(w0.worker_id);
    const newEpoch = 'new-relaunch-epoch-fail-' + Date.now();
    live.worker.worker_epoch = newEpoch;
    live.unit = containment.reserve(newEpoch) as CleanupUnit;

    // Allow cleanup to complete (with failure)
    containment.triggerClean();
    const stopReceipt = await stopPromise;

    assert.equal(stopReceipt.state, 'outcome_unknown',
      `expected outcome_unknown, got ${stopReceipt.state}`);
    assert.equal(stopReceipt.result?.termination, 'superseded_generation_unknown',
      `expected superseded_generation_unknown, got ${stopReceipt.result?.termination}`);
    assert.equal(stopReceipt.effect, 'unknown',
      `expected effect unknown, got ${stopReceipt.effect}`);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary stop (non-superseded): termination is observed_stopped with matching epoch fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s6-ordinary-stop-'));
  const containment = makeContainment({ cleanResult: true });
  const { journal, supervisor, cwd } = makeFixture(root, containment);
  try {
    const createArgs = { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await supervisor.create(createArgs);
    const w0 = supervisor.get(r.worker_id!);
    const originalEpoch = w0.worker_epoch;

    // No generation change: stop runs normally
    const stopReceipt = await supervisor.stop(w0.worker_id, bind(w0, 'stop'));

    assert.equal(stopReceipt.state, 'delivered');
    assert.equal(stopReceipt.result?.termination, 'observed_stopped',
      `expected observed_stopped, got ${stopReceipt.result?.termination}`);
    assert.equal(stopReceipt.result?.stopped_worker_epoch, originalEpoch,
      'stopped_worker_epoch must be present and equal to the stopped epoch');
    assert.equal(stopReceipt.result?.current_worker_epoch, originalEpoch,
      'current_worker_epoch must equal stopped_worker_epoch for non-superseded stop');
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stop idempotency: second stop call returns the same receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s6-stop-idempotent-'));
  const containment = makeContainment({ cleanResult: true });
  const { journal, supervisor, cwd } = makeFixture(root, containment);
  try {
    const createArgs = { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await supervisor.create(createArgs);
    const w0 = supervisor.get(r.worker_id!);

    const first = await supervisor.stop(w0.worker_id, bind(w0, 'stop-idempotent'));
    const second = await supervisor.stop(w0.worker_id, bind(w0, 'stop-idempotent'));

    assert.deepEqual(first, second, 'idempotent stop must return the same receipt');
    assert.equal(first.result?.termination, 'observed_stopped');
    assert.equal(first.result?.stopped_worker_epoch, first.result?.current_worker_epoch);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown stop (cleanup failed, no supersession): epoch fields still identify the targeted generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s6-unknown-epoch-'));
  const containment = makeContainment({ cleanResult: false });
  const { journal, supervisor, cwd } = makeFixture(root, containment);
  try {
    const createArgs = { command_id: 'create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    const r = await supervisor.create(createArgs);
    const w0 = supervisor.get(r.worker_id!);
    const originalEpoch = w0.worker_epoch;

    const stopReceipt = await supervisor.stop(w0.worker_id, bind(w0, 'stop-unknown'));

    assert.equal(stopReceipt.state, 'outcome_unknown');
    assert.equal(stopReceipt.result?.termination, 'unknown');
    assert.equal(stopReceipt.result?.stopped_worker_epoch, originalEpoch,
      'unknown stop must still report stopped_worker_epoch for the targeted generation');
    assert.equal(stopReceipt.result?.current_worker_epoch, originalEpoch,
      'unknown stop without supersession: current_worker_epoch equals stopped_worker_epoch');
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
