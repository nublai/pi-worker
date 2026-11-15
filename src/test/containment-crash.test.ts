import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJournal } from '../journal.js';
import type { Receipt, Worker } from '../types.js';
const child = fileURLToPath(new URL('./fixtures/containment-cut.js', import.meta.url));
function run(mode: string, root: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [child, mode, root], { env: { ...process.env, A0_CRASH_INDEX: '', A0_CRASH_EFFECT: '', A0_CRASH_AT: '', ...env }, encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0 && result.signal !== 'SIGKILL') assert.fail(result.stderr || String(result.error));
  return result;
}
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'a0s5-cut-'));
  assert.equal(run('seed', root).signal, 'SIGKILL'); return root;
}
function check(root: string) {
  const records = parseJournal(readFileSync(join(root, 'journal'))).records;
  const effects = existsSync(join(root, 'effects')) ? readFileSync(join(root, 'effects'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  for (const e of effects) {
    const at = records.slice(0, e.seq);
    if (e.kind === 'spawn' || e.kind === 'kill') {
      const w = at.findLast(r => r.kind === 'worker' && (r.value.unit as { name: string })?.name === e.unit.name);
      assert.ok(w, 'EVERY spawn/kill requires its exact durable domain, not just workers that happen to have it');
      if (e.kind === 'kill') assert.equal((w.value.worker as Worker).status, 'cleanup_pending', 'pending precedes native kill');
      if (e.parent) {
        assert.deepEqual((w.value.worker as Worker).parent, e.parent, 'sandbox spawn cannot lose lineage');
        assert.equal((w.value.worker as Worker).launch_spec?.environment.filesystem, 'bwrap', 'confinement declaration precedes spawn');
      }
    }
    if (e.command_id !== 'recovery') {
      const r = at.findLast(r => r.kind === 'receipt' && r.value.command_id === e.command_id);
      assert.ok(r && r.value.state !== 'intent', `${e.kind} must follow durable dispatch, not only intent`);
    }
  }
  const after = JSON.parse(run('recover', root).stdout) as { workers: Worker[]; receipts: Receipt[] };
  const ownerKeep = records.some(r => r.kind === 'worker' && (r.value.worker as Worker).resolutions?.some(x => x.command_id === 'work' && x.disposition === 'keep'));
  const priorWork = records.findLast(r => r.kind === 'receipt' && r.value.command_id === 'work')?.value;
  if (ownerKeep && priorWork && ['intent_recovered', 'intent_ready'].includes(String(priorWork.state))) assert.equal(after.receipts.find(r => r.command_id === 'work')?.state, 'intent_ready', 'durable owner tombstone repairs readiness after a crash');
  for (const e of effects) if (['spawn', 'switch', 'prompt'].includes(e.kind)) {
    const r = after.receipts.find(r => r.command_id === e.command_id);
    assert.ok(r && r.effect !== 'no_effect', `${e.kind} effect cannot recover no_effect`);
  }
  if (effects.some(e => e.kind === 'prompt') && !records.some(r => r.kind === 'settlement' && r.value.command_id === 'work')) {
    assert.ok(after.workers.some(w => w.fence?.uncertain_command_ids?.includes('work')), 'post-owner-resolution dispatch still fences after crash');
  }
  for (const e of effects.filter(e => e.parent)) {
    const child = after.workers.find(w => w.parent?.task_id === e.parent.task_id); assert.ok(child);
    const reported = after.receipts.some(r => r.worker_id === child.worker_id && r.operation === 'children.report' && r.state === 'delivered' && r.result?.kind === 'result');
    if (!reported) assert.ok(after.workers.find(w => w.worker_id === e.parent.worker_id)?.fence?.uncertain_command_ids?.includes('sandbox-child'), 'unreported sandbox spawn fences its parent');
  }
  const count = effects.filter(e => e.kind === 'prompt').length; assert.ok(count <= 1);
  if (existsSync(join(root, 'native-input'))) assert.equal(readFileSync(join(root, 'native-input'), 'utf8'), 'ONCE\n');
  const again = JSON.parse(run('recover', root).stdout) as typeof after;
  assert.deepEqual(again.receipts, after.receipts);
  assert.deepEqual(again.workers.map(w => w.fence), after.workers.map(w => w.fence));
}

test('slice 5: contained initial create reserves its domain before every spawn and survives all fsync/effect cuts', () => {
  let root = mkdtempSync(join(tmpdir(), 'a0s5-create-cut-')), count: number;
  try {
    const baseline = run('seed', root, { A0_TRACE_FSYNC: '1' }); assert.equal(baseline.signal, 'SIGKILL');
    count = baseline.stderr.trim().split('\n').filter(l => l.startsWith('{"fsync":')).length;
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (let i = 1; i <= count!; i++) {
    root = mkdtempSync(join(tmpdir(), 'a0s5-create-cut-'));
    try { assert.equal(run('seed', root, { A0_CRASH_INDEX: String(i) }).signal, 'SIGKILL'); check(root); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  root = mkdtempSync(join(tmpdir(), 'a0s5-create-cut-'));
  try { assert.equal(run('seed', root, { A0_CRASH_EFFECT: '1' }).signal, 'SIGKILL'); check(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ slice5_create_fsync_cuts: count!, slice5_create_effect_cuts: 1 }));
});

test('slice 5: SIGKILL after every recovery/resolve/relaunch/sandbox/report/stop fsync and native lifecycle effect', () => {
  let root = fresh(); let count: number, effectCount: number;
  try {
    const baseline = run('scenario', root, { A0_TRACE_FSYNC: '1' }); assert.equal(baseline.status, 0);
    count = baseline.stderr.trim().split('\n').filter(l => l.startsWith('{"fsync":')).length;
    effectCount = JSON.parse(baseline.stdout).effects;
    check(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (let i = 1; i <= count!; i++) {
    root = fresh(); try { assert.equal(run('scenario', root, { A0_CRASH_INDEX: String(i) }).signal, 'SIGKILL', `fsync ${i}`); check(root); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  for (let i = 1; i <= effectCount!; i++) {
    root = fresh(); try { assert.equal(run('scenario', root, { A0_CRASH_EFFECT: String(i) }).signal, 'SIGKILL', `effect ${i}`); check(root); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ slice5_fsync_cuts: count!, slice5_effect_cuts: effectCount! }));
});
