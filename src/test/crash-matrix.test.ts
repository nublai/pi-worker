import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseJournal } from '../journal.js';
import type { Receipt, Worker } from '../types.js';
const child = fileURLToPath(new URL('./fixtures/crash-child.js', import.meta.url));
function run(mode: string, root: string, cut?: number, trace = false) {
  return spawnSync(process.execPath, [child, mode, root], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, A0_TRACE_FSYNC: trace ? '1' : '', A0_CRASH_INDEX: cut ? String(cut) : '', A0_CRASH_AT: '' } });
}
type Summary = { receipts: { command_id: string; state: Receipt['state']; effect: Receipt['effect'] }[]; workers: { worker_id: string; fence: Worker['fence'] }[] };
function summary(output: string): Summary { return JSON.parse(output.trim().split('\n').at(-1)!) as Summary; }
const bytes = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
function checkRecovery(root: string, pre: ReturnType<typeof parseJournal>['records']) {
  const before = bytes(join(root, 'effects.jsonl'));
  const recovered = run('recover', root); assert.equal(recovered.status, 0, recovered.stderr);
  const after = summary(recovered.stdout);
  const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  const latest = new Map<string, Receipt>(), resolutions = new Map<string, string>();
  for (const record of pre) {
    if (record.kind === 'receipt') latest.set(String(record.value.command_id), record.value as Receipt);
    if (record.kind === 'worker') for (const r of (record.value.worker as Worker).resolutions ?? []) resolutions.set(r.command_id, r.disposition);
  }
  for (const r of latest.values()) {
    const got = receipts.get(r.command_id)!;
    if (r.state === 'intent' || r.state === 'queued' || r.state === 'intent_recovered') {
      const disposition = resolutions.get(r.command_id);
      assert.equal(got.state, disposition === 'keep' ? 'intent_ready' : disposition === 'abandon' ? 'rejected' : 'intent_recovered', r.command_id);
      assert.equal(got.effect, 'no_effect', r.command_id);
    } else if (r.state === 'accepted') { assert.equal(got.state, 'outcome_unknown', r.command_id); assert.equal(got.effect, 'unknown'); }
    else { assert.equal(got.state, r.state, r.command_id); assert.equal(got.effect, r.effect, r.command_id); }
  }
  assert.equal(bytes(join(root, 'effects.jsonl')), before, 'recovery/duplicate requests must perform zero new effects');
  const count = new Map<string, number>();
  for (const line of before.trim().split('\n').filter(Boolean)) count.set(line, (count.get(line) ?? 0) + 1);
  assert.ok([...count.values()].every(n => n === 1), 'no duplicate native effect in the scenario');
  const second = run('recover', root); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(summary(second.stdout).receipts, after.receipts);
  assert.deepEqual(summary(second.stdout).workers.map(w => w.fence), after.workers.map(w => w.fence), 'restart must not relatch a resolved item or churn a generation');
  return { buckets: [...new Set(after.receipts.map(r => `${r.state}/${r.effect}`))].sort(), effects: count.size };
}
test('SIGKILL after EVERY scenario fsync occurrence: recovery buckets, stable latches and no duplicate effect', { timeout: 120000 }, () => {
  mkdirSync('/tmp/a0s2', { recursive: true });
  const baseline = mkdtempSync('/tmp/a0s2/crash-base-');
  const matrix: { index: number; label: string; buckets: string[]; effects: number; result: string }[] = [];
  try {
    const full = run('scenario', baseline, undefined, true); assert.equal(full.status, 0, full.stderr);
    const points = full.stderr.trim().split('\n').filter(x => x.startsWith('{"fsync"')).map(x => (JSON.parse(x) as { fsync: { index: number; label: string } }).fsync);
    assert.ok(points.length > 80, 'scenario must cover control/rebind/queue/resolve/grant fsyncs');
    for (const point of points) {
      const root = mkdtempSync('/tmp/a0s2/crash-cut-');
      try {
        const killed = run('scenario', root, point.index, true); assert.equal(killed.signal, 'SIGKILL', `cut ${point.index} ${point.label}: ${killed.stderr}`);
        const pre = parseJournal(readFileSync(join(root, 'journal'))).records;
        matrix.push({ ...point, ...checkRecovery(root, pre), result: 'pass' });
      } finally { rmSync(root, { recursive: true }); }
    }
    // Crash DURING recovery too, then recover twice again. All recovery fsync occurrences are covered.
    const seed = points.find(p => p.label === 'receipt.sessions.prompt.accepted')!;
    const probe = mkdtempSync('/tmp/a0s2/recovery-probe-'); let recoveryPoints: typeof points;
    try {
      assert.equal(run('scenario', probe, seed.index).signal, 'SIGKILL');
      const traced = run('recover', probe, undefined, true); assert.equal(traced.status, 0, traced.stderr);
      recoveryPoints = traced.stderr.trim().split('\n').filter(x => x.startsWith('{"fsync"')).map(x => JSON.parse(x).fsync as typeof points[number]);
    } finally { rmSync(probe, { recursive: true }); }
    for (const point of recoveryPoints) {
      const root = mkdtempSync('/tmp/a0s2/recovery-cut-');
      try {
        assert.equal(run('scenario', root, seed.index).signal, 'SIGKILL');
        const killed = run('recover', root, point.index, true); assert.equal(killed.signal, 'SIGKILL', point.label);
        const pre = parseJournal(readFileSync(join(root, 'journal'))).records;
        matrix.push({ ...point, label: 'recovery:' + point.label, ...checkRecovery(root, pre), result: 'pass' });
      } finally { rmSync(root, { recursive: true }); }
    }
    writeFileSync('/tmp/a0s2/crash-matrix.json', JSON.stringify({ prototype: true, model: 'SIGKILL-after-fsync; no power-loss proof', matrix }, null, 2) + '\n');
  } finally { rmSync(baseline, { recursive: true }); }
});
