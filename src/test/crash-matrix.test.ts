import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseJournal } from '../journal.js';
import type { Receipt, Worker } from '../types.js';
const child = fileURLToPath(new URL('./fixtures/crash-child.js', import.meta.url));
function run(mode: string, root: string, cut?: number, trace = false, effectCut?: number) {
  return spawnSync(process.execPath, [child, mode, root], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, A0_TRACE_FSYNC: trace ? '1' : '', A0_CRASH_INDEX: cut ? String(cut) : '', A0_CRASH_AT: '', A0_CRASH_EFFECT: effectCut ? String(effectCut) : '' } });
}
type Summary = { receipts: Receipt[]; workers: Worker[] };
type Effect = { kind: 'create' | 'prompt' | 'rebind'; command_id: string; parent_launch_command_id?: string; session_file: string; session_id?: string; entry_id?: string; spawned?: boolean; cwd?: string };
function summary(output: string): Summary { return JSON.parse(output.trim().split('\n').at(-1)!) as Summary; }
const bytes = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const temp = (name: string) => mkdtempSync(join(tmpdir(), 'a0s2-' + name + '-'));
const effectsAt = (root: string): Effect[] => bytes(join(root, 'effects.jsonl')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Effect);
const sessionDirected = (r: Receipt) => ['sessions.prompt', 'sessions.follow_up', 'sessions.rebind', 'children.launch'].includes(r.operation);
function checkRecovery(root: string, pre: ReturnType<typeof parseJournal>['records']) {
  const before = bytes(join(root, 'effects.jsonl'));
  const recovered = run('recover', root); assert.equal(recovered.status, 0, recovered.stderr);
  const after = summary(recovered.stdout);
  const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  const latest = new Map<string, Receipt>(), workers = new Map<string, Worker>();
  for (const record of pre) {
    if (record.kind === 'receipt') latest.set(String(record.value.command_id), record.value as Receipt);
    if (record.kind === 'worker') { const w = record.value.worker as Worker; workers.set(w.worker_id, w); }
  }
  for (const r of latest.values()) {
    const got = receipts.get(r.command_id)!;
    const disposition = workers.get(r.worker_id ?? '')?.resolutions?.find(x => x.command_id === r.command_id)?.disposition;
    if (['intent', 'queued', 'queue_ready', 'intent_recovered'].includes(r.state) || (r.state === 'intent_ready' && disposition !== 'keep')) {
      assert.equal(got.state, disposition === 'keep' ? 'intent_ready' : disposition === 'abandon' ? 'rejected' : 'intent_recovered', r.command_id);
      assert.equal(got.effect, 'no_effect', r.command_id);
    } else if (r.state === 'accepted') { assert.equal(got.state, 'outcome_unknown', r.command_id); assert.equal(got.effect, 'unknown'); }
    else { assert.equal(got.state, r.state, r.command_id); assert.equal(got.effect, r.effect, r.command_id); }
  }
  // Independent oracle: native session-file entries/headers and spawn evidence,
  // not the journal's intent->bucket mapping. Also check the parent launch receipt.
  const count = new Set<string>();
  for (const effect of effectsAt(root)) {
    const native = bytes(effect.session_file).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    if (effect.kind === 'prompt') assert.ok(native.some(entry => entry.type === 'message' && entry.id === effect.entry_id), 'Pi input file must corroborate prompt effect');
    else assert.ok(native.some(entry => entry.type === 'session' && entry.id === effect.session_id), 'Pi header must corroborate create/rebind effect');
    if (effect.kind === 'create') { assert.equal(effect.spawned, true); assert.ok(effect.cwd); }
    for (const id of [effect.command_id, ...(effect.parent_launch_command_id ? [effect.parent_launch_command_id] : [])]) {
      const r = receipts.get(id); assert.ok(r, `effect ${effect.kind}:${id} needs a recovered receipt`);
      assert.notEqual(r.effect, 'no_effect', `native effect ${effect.kind}:${id} recovered ${r.state}/${r.effect}`);
    }
    const key = `${effect.kind}:${effect.command_id}`;
    assert.ok(!count.has(key), 'no duplicate native effect: ' + key); count.add(key);
  }
  // Bucket/fence oracle. A delivered admission may still have an unsettled run;
  // a delivered child launch without a child report is another independent cause.
  for (const w of after.workers) {
    const prior = workers.get(w.worker_id)!;
    const resolved = new Set((prior.resolutions ?? []).map(x => x.command_id));
    const required = new Set<string>();
    for (const r of after.receipts) if (r.worker_id === w.worker_id && sessionDirected(r) && r.state === 'outcome_unknown' && !resolved.has(r.command_id)) required.add(r.command_id);
    if (prior.execution && prior.execution.state !== 'settled' && (!resolved.has(prior.execution.command_id) || ['ready', 'starting'].includes(prior.status))) {
      const r = receipts.get(prior.execution.command_id);
      if (r?.effect !== 'no_effect') required.add(prior.execution.command_id);
    }
    for (const child of workers.values()) if (child.parent_worker_id === w.worker_id && child.parent_launch_command_id) {
      const launch = child.parent_launch_command_id;
      const reported = after.receipts.some(r => r.operation === 'children.report' && r.worker_id === child.worker_id && r.state === 'delivered' && r.result?.task_id === launch);
      if (!reported && !resolved.has(launch)) required.add(launch);
    }
    for (const id of prior.fence?.uncertain_command_ids ?? []) if (!resolved.has(id)) {
      const r = receipts.get(id); assert.ok(r && r.effect !== 'no_effect', 'persisted fence needs dispatched evidence or lineage'); required.add(id);
    }
    const actual = w.fence?.uncertain_command_ids ?? [];
    assert.deepEqual([...actual].sort(), [...required].sort(), `fence must match unknown/unsettled/lineage buckets for ${w.worker_id}`);
    assert.equal(w.fence === null, required.size === 0, 'no spurious empty fence');
  }
  assert.equal(bytes(join(root, 'effects.jsonl')), before, 'recovery/duplicate requests must perform zero new effects');
  const second = run('recover', root); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(summary(second.stdout).receipts, after.receipts);
  assert.deepEqual(summary(second.stdout).workers.map(w => w.fence), after.workers.map(w => w.fence), 'restart must not relatch a resolved item or churn a generation');
  return { buckets: [...new Set(after.receipts.map(r => `${r.state}/${r.effect}`))].sort(), effects: count.size };
}
for (const kind of ['prompt', 'rebind', 'create', 'child launch'] as const) test(`effect cut ${kind}: native evidence forbids no_effect and recovered buckets require fences`, { timeout: 120000 }, () => {
  const baseline = temp('effect-base');
  try {
    const full = run('scenario', baseline); assert.equal(full.status, 0, full.stderr);
    const effects = effectsAt(baseline);
    const points = effects.flatMap((e, i) => (kind === 'child launch' ? !!e.parent_launch_command_id : e.kind === kind && !e.parent_launch_command_id) ? [i + 1] : []);
    assert.ok(points.length > 0);
    for (const point of points) {
      const root = temp('effect-cut');
      try {
        const killed = run('scenario', root, undefined, false, point); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
        checkRecovery(root, parseJournal(readFileSync(join(root, 'journal'))).records);
      } finally { rmSync(root, { recursive: true }); }
    }
    console.log(JSON.stringify({ effect_kind: kind, cuts: points.length, result: 'pass' }));
  } finally { rmSync(baseline, { recursive: true }); }
});
test('SIGKILL after EVERY scenario fsync occurrence: recovery buckets, required fences and no duplicate effect', { timeout: 120000 }, () => {
  const suite = temp('crash-matrix'), baseline = join(suite, 'baseline');
  const matrix: { index: number; label: string; buckets: string[]; effects: number; result: string }[] = [];
  try {
    const full = run('scenario', baseline, undefined, true); assert.equal(full.status, 0, full.stderr);
    const points = full.stderr.trim().split('\n').filter(x => x.startsWith('{"fsync"')).map(x => (JSON.parse(x) as { fsync: { index: number; label: string } }).fsync);
    assert.ok(points.length > 80, 'scenario must cover control/rebind/queue/resolve/grant fsyncs');
    for (const point of points) {
      const root = temp('crash-cut');
      try {
        const killed = run('scenario', root, point.index, true); assert.equal(killed.signal, 'SIGKILL', `cut ${point.index} ${point.label}: ${killed.stderr}`);
        matrix.push({ ...point, ...checkRecovery(root, parseJournal(readFileSync(join(root, 'journal'))).records), result: 'pass' });
      } finally { rmSync(root, { recursive: true }); }
    }
    // Every recovery fsync occurrence from this single accepted-prompt seed only.
    const seed = points.find(p => p.label === 'receipt.sessions.prompt.accepted')!;
    const probe = temp('recovery-probe'); let recoveryPoints: typeof points;
    try {
      assert.equal(run('scenario', probe, seed.index).signal, 'SIGKILL');
      const traced = run('recover', probe, undefined, true); assert.equal(traced.status, 0, traced.stderr);
      recoveryPoints = traced.stderr.trim().split('\n').filter(x => x.startsWith('{"fsync"')).map(x => JSON.parse(x).fsync as typeof points[number]);
    } finally { rmSync(probe, { recursive: true }); }
    for (const point of recoveryPoints) {
      const root = temp('recovery-cut');
      try {
        assert.equal(run('scenario', root, seed.index).signal, 'SIGKILL');
        const killed = run('recover', root, point.index, true); assert.equal(killed.signal, 'SIGKILL', point.label);
        matrix.push({ ...point, label: 'recovery:' + point.label, ...checkRecovery(root, parseJournal(readFileSync(join(root, 'journal'))).records), result: 'pass' });
      } finally { rmSync(root, { recursive: true }); }
    }
    writeFileSync(join(suite, 'matrix.json'), JSON.stringify({ prototype: true, model: 'SIGKILL-after-fsync; no power-loss proof', matrix }, null, 2) + '\n');
    console.log(JSON.stringify({ fsync_cuts: matrix.length, result: 'pass' }));
  } finally { rmSync(suite, { recursive: true }); }
});
