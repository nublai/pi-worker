import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker, Receipt } from '../types.js';
const fixture = new URL('./fixtures/children-cut.js', import.meta.url);
const run = (root: string, mode: string, cut?: number, effect?: number) => spawnSync(process.execPath, [fixture.pathname, mode, root], { encoding: 'utf8', env: { ...process.env, A0_TRACE_FSYNC: '1', A0_CRASH_INDEX: cut ? String(cut) : '', A0_CRASH_EFFECT: effect ? String(effect) : '' }, timeout: 15000 });
const bytes = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : '';
function check(root: string): void {
  const before = bytes(join(root, 'effects'));
  const recovered = run(root, 'recover'); assert.equal(recovered.status, 0, recovered.stderr);
  const after = JSON.parse(recovered.stdout) as { workers: Worker[]; receipts: Receipt[] };
  for (const raw of before.trim().split('\n').filter(Boolean)) {
    const effect = JSON.parse(raw);
    if (effect.kind === 'spawn') {
      const header = JSON.parse(readFileSync(effect.file, 'utf8').split('\n')[0]!);
      assert.equal(header.id, effect.session_id);
      assert.notEqual(after.receipts.find(r => r.command_id === effect.command_id)?.effect, 'no_effect');
      const receipt = after.receipts.find(r => r.command_id === effect.command_id);
      assert.ok(receipt);
      if (effect.parent) {
        const child = after.workers.find(w => w.worker_id === receipt.worker_id);
        assert.ok(child, 'every native child spawn must have a recovered reservation');
        assert.deepEqual(child.parent, effect.parent, 'native spawn requires lineage persisted before the effect');
        assert.equal(child.parent_worker_id, effect.parent.worker_id);
        assert.equal(child.parent_launch_command_id, effect.command_id);
      }
    }
    if (effect.kind === 'stop') {
      const receipt = after.receipts.find(r => r.command_id === effect.command_id);
      assert.ok(receipt); assert.notEqual(receipt.effect, 'no_effect', 'stop effect cannot recover as no_effect');
    }
    if (effect.kind === 'report_delivery') assert.equal(after.receipts.filter(r => r.operation === 'children.report' && r.state === 'delivered').length, 1);
  }
  const child = after.workers.find(w => w.parent);
  if (child) {
    const parent = after.workers.find(w => w.worker_id === child.parent_worker_id)!;
    const launch = after.receipts.find(r => r.command_id === child.parent_launch_command_id)!;
    const reported = after.receipts.some(r => r.worker_id === child.worker_id && r.operation === 'children.report' && r.state === 'delivered' && r.result?.kind !== 'help');
    assert.equal(!!parent.fence?.uncertain_command_ids?.includes(child.parent_launch_command_id!), launch.effect !== 'no_effect' && !reported, 'missing durable report fences parent, pre-dispatch does not');
    assert.equal(child.child_reports?.length, reported ? 1 : 0);
  }
  const second = run(root, 'recover'); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).receipts, after.receipts);
  assert.equal(bytes(join(root, 'effects')), before, 'restart and duplicate cause zero new effects');
}
test('slice4 typed child launch/report: every fsync and native spawn/FD/delivery cut', { timeout: 120000 }, () => {
  const baseline = mkdtempSync(join(tmpdir(), 'a0s4-base-'));
  try {
    const full = run(baseline, 'scenario'); assert.equal(full.status, 0, full.stderr);
    const points = full.stderr.split('\n').filter(l => l.startsWith('{"fsync"')).map(l => JSON.parse(l).fsync as { index: number; label: string });
    assert.ok(points.some(p => p.label === 'receipt.children.report.delivered'));
    assert.ok(points.some(p => p.label === 'receipt.workers.create.accepted'));
    const effects = bytes(join(baseline, 'effects')).trim().split('\n'); assert.equal(effects.length, 5);
    for (const p of points) {
      const root = mkdtempSync(join(tmpdir(), 'a0s4-cut-'));
      try { const cut = run(root, 'scenario', p.index); assert.equal(cut.signal, 'SIGKILL', p.label + cut.stderr); check(root); }
      finally { rmSync(root, { recursive: true }); }
    }
    for (let i = 1; i <= effects.length; i++) {
      const root = mkdtempSync(join(tmpdir(), 'a0s4-effect-'));
      try { assert.equal(run(root, 'scenario', undefined, i).signal, 'SIGKILL'); check(root); }
      finally { rmSync(root, { recursive: true }); }
    }
    console.log(JSON.stringify({ slice4_fsync_cuts: points.length, slice4_effect_cuts: effects.length, result: 'pass' }));
  } finally { rmSync(baseline, { recursive: true }); }
});
