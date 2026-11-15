import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJournal } from '../journal.js';
import type { Receipt, Worker } from '../types.js';
import type { Interaction } from '../interactions.js';
const child = fileURLToPath(new URL('./fixtures/interaction-crash-child.js', import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), 'a0s3-crash-'));
const bytes = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : '';
function run(mode: string, root: string, cut?: number, effect?: number, trace = false) {
  return spawnSync(process.execPath, [child, mode, root], { encoding: 'utf8', timeout: 15000, env: { ...process.env, A0_TRACE_FSYNC: trace ? '1' : '', A0_CRASH_INDEX: cut ? String(cut) : '', A0_CRASH_AT: '', A0_CRASH_EFFECT: effect ? String(effect) : '' } });
}
type Summary = { receipts: Receipt[]; workers: Worker[]; interactions: Interaction[] };
const summary = (text: string) => JSON.parse(text.trim().split('\n').at(-1)!) as Summary;
function oracle(root: string) {
  const beforeEffects = bytes(join(root, 'effects.jsonl')); const pre = parseJournal(readFileSync(join(root, 'journal'))).records;
  const recovered = run('recover', root); assert.equal(recovered.status, 0, recovered.stderr);
  const after = summary(recovered.stdout); const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  const latest = new Map<string, Receipt>(); for (const r of pre) if (r.kind === 'receipt') latest.set(String(r.value.command_id), r.value as Receipt);
  for (const r of latest.values()) {
    const got = receipts.get(r.command_id)!;
    if (r.state === 'intent') { assert.equal(got.state, 'intent_recovered'); assert.equal(got.effect, 'no_effect'); }
    else if (r.state === 'accepted') { assert.equal(got.state, 'outcome_unknown'); assert.equal(got.effect, 'unknown'); }
    else assert.deepEqual(got, r);
    if (got.state === 'outcome_unknown' && ['interactions.answer_if_current', 'interactions.release', 'sessions.rebind'].includes(got.operation)) assert.ok(after.workers.find(w => w.worker_id === got.worker_id)?.fence?.uncertain_command_ids?.includes(got.command_id), 'every unknown session write must fence');
  }
  // Independent native effect files, not state->bucket rules, constrain receipts.
  const seen = new Set<string>();
  for (const e of beforeEffects.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)) {
    const key = `${e.kind}:${e.native_id ?? e.gate_token ?? e.native_result}`; assert.equal(seen.has(key), false, 'no duplicate native effect'); seen.add(key);
    if (e.kind === 'answer') {
      assert.equal(bytes(String(e.native_result)), 'resolver consumed once\n');
      const receipt = receipts.get(String(e.native_id) + '-answer'); assert.ok(receipt); assert.notEqual(receipt.effect, 'no_effect');
    } else if (e.kind === 'gate') {
      if (e.released) assert.equal(bytes(String(e.native_result)), 'gate released once\n');
      else assert.equal(existsSync(String(e.native_result)), false);
      const receipt = receipts.get(String(e.gate_token) + '-answer:release'); assert.ok(receipt); assert.notEqual(receipt.effect, 'no_effect');
    } else if (e.kind === 'navigate') {
      assert.equal(bytes(String(e.native_result)), 'entry'); const r = receipts.get('navigate'); assert.ok(r); assert.notEqual(r.effect, 'no_effect');
    } else {
      // Timeout cancellation has its own write-ahead marker; rebinding cancellation
      // is covered by the enclosing sessions.rebind dispatch marker.
      if (e.native_id === 'timeout') {
        const i = after.interactions.find(i => i.native_id === 'timeout'); assert.ok(i);
        assert.ok(pre.some(r => r.kind === 'interaction_effect' && r.value.operation === 'cancel' && r.value.interaction_id === i.interaction_id));
      } else { assert.equal(e.native_id, 'navigate-dialog'); const r = receipts.get('navigate'); assert.ok(r); assert.notEqual(r.effect, 'no_effect'); }
    }
  }
  assert.equal(bytes(join(root, 'effects.jsonl')), beforeEffects, 'recovery and duplicate lookups never dispatch');
  for (const i of after.interactions) assert.notEqual(i.status, 'pending');
  const second = run('recover', root); assert.equal(second.status, 0, second.stderr);
  const twice = summary(second.stdout); assert.deepEqual(twice.interactions, after.interactions); assert.deepEqual(twice.receipts, after.receipts); assert.deepEqual(twice.workers.map(w => w.fence), after.workers.map(w => w.fence));
  assert.equal(bytes(join(root, 'effects.jsonl')), beforeEffects);
}
test('new interactions: SIGKILL at every scenario and recovery fsync occurrence, no answer replay, native effect oracle', { timeout: 120000 }, () => {
  const baseline = temp();
  try {
    const full = run('scenario', baseline, undefined, undefined, true); assert.equal(full.status, 0, full.stderr);
    const points = full.stderr.trim().split('\n').filter(s => s.startsWith('{"fsync"')).map(s => JSON.parse(s).fsync as { index: number; label: string });
    assert.ok(points.some(p => p.label === 'journal.interaction')); assert.ok(points.some(p => p.label === 'journal.interaction_effect'));
    assert.ok(points.some(p => p.label === 'receipt.interactions.answer_if_current.accepted')); assert.ok(points.some(p => p.label === 'receipt.interactions.release.accepted'));
    for (const p of points) { const root = temp(); try { const killed = run('scenario', root, p.index); assert.equal(killed.signal, 'SIGKILL', p.label + killed.stderr); oracle(root); } finally { rmSync(root, { recursive: true }); } }
    const seed = points.find(p => p.label === 'receipt.interactions.answer_if_current.accepted')!;
    const probe = temp(); let recoveryPoints: typeof points;
    try { assert.equal(run('scenario', probe, seed.index).signal, 'SIGKILL'); const r = run('recover', probe, undefined, undefined, true); assert.equal(r.status, 0, r.stderr); recoveryPoints = r.stderr.trim().split('\n').filter(s => s.startsWith('{"fsync"')).map(s => JSON.parse(s).fsync); } finally { rmSync(probe, { recursive: true }); }
    for (const p of recoveryPoints) { const root = temp(); try { assert.equal(run('scenario', root, seed.index).signal, 'SIGKILL'); assert.equal(run('recover', root, p.index).signal, 'SIGKILL'); oracle(root); } finally { rmSync(root, { recursive: true }); } }
    console.log(JSON.stringify({ interaction_scenario_fsync_cuts: points.length, interaction_recovery_fsync_cuts: recoveryPoints.length, result: 'pass' }));
  } finally { rmSync(baseline, { recursive: true }); }
});
test('new interactions: cut at each answer/cancel/gate/navigation effect before reply, independent native evidence', { timeout: 120000 }, () => {
  const baseline = temp(); try {
    const full = run('scenario', baseline); assert.equal(full.status, 0, full.stderr);
    const effects = bytes(join(baseline, 'effects.jsonl')).trim().split('\n').filter(Boolean); assert.ok(effects.length >= 8);
    for (let i = 1; i <= effects.length; i++) { const root = temp(); try { const killed = run('scenario', root, undefined, i); assert.equal(killed.signal, 'SIGKILL', killed.stderr); oracle(root); } finally { rmSync(root, { recursive: true }); } }
    console.log(JSON.stringify({ interaction_effect_cuts: effects.length, result: 'pass' }));
  } finally { rmSync(baseline, { recursive: true }); }
});
