/**
 * The supervisor recovery oracle after a SIGKILL cut, ported from A0 `src/test/crash-matrix.test.ts`
 * (`checkRecovery`): recovered receipt buckets by pre-crash state, independent native-effect evidence (an effect is
 * never `no_effect`, never duplicated, and corroborated by its native artifact), no worker left live, every
 * logged request retried with no replay, and a second recovery that changes nothing.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import type { Receipt } from '../../src/receipts/receipts.js';
import type { Worker } from '../../src/supervisor/state.js';
import { effectsAt, recoverWorld, type Summary } from './world.js';

const bytes = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

export interface PreCrash {
  receipts: Map<string, Receipt>;
  workers: Map<string, Worker>;
}

export function preCrash(root: string): PreCrash {
  const receipts = new Map<string, Receipt>();
  const workers = new Map<string, Worker>();
  for (const record of parseJournal(readFileSync(journalPath(root))).records) {
    if (record.kind === 'receipt') receipts.set(String(record.value.command_id), record.value as Receipt);
    if (record.kind === 'worker') {
      const w = (record.value as { worker: Worker }).worker;
      workers.set(w.worker_id, w);
    }
  }
  return { receipts, workers };
}

/** Extra per-PR checks over the pre-crash state and the recovered summary (fences, executions, bindings). */
export type Check = (pre: PreCrash, after: Summary) => void;

export async function checkRecovery(root: string, extra: Check[] = []): Promise<Summary> {
  const pre = preCrash(root);
  const before = bytes(join(root, 'effects.jsonl'));
  const after = await recoverWorld(root);
  const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  for (const r of pre.receipts.values()) {
    const got = receipts.get(r.command_id)!;
    const disposition = pre.workers.get(r.worker_id ?? '')?.resolutions?.find(x => x.command_id === r.command_id)?.disposition;
    if (['intent', 'queued', 'queue_ready', 'intent_recovered'].includes(r.state) || (r.state === 'intent_ready' && disposition !== 'keep')) {
      assert.equal(got.state, disposition === 'keep' ? 'intent_ready' : disposition === 'abandon' ? 'rejected' : 'intent_recovered', r.command_id);
      assert.equal(got.effect, 'no_effect', r.command_id);
    } else if (r.state === 'accepted') {
      assert.equal(got.state, 'outcome_unknown', r.command_id);
      assert.equal(got.effect, 'unknown', r.command_id);
    } else {
      assert.equal(got.state, r.state, r.command_id);
      assert.equal(got.effect, r.effect, r.command_id);
    }
  }
  // Independent oracle: native artifacts, not the journal's bucket mapping.
  const seen = new Set<string>();
  for (const e of effectsAt(root)) {
    const native = bytes(e.native_file ?? e.session_file ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    if (e.native_file) assert.ok(native.some(n => n.command_id === e.command_id && n.operation === e.operation), 'a native control artifact corroborates the effect');
    else if (e.kind === 'prompt' || e.kind === 'steer') assert.ok(native.some(n => n.type === 'message' && n.id === e.entry_id), 'the session file corroborates the input');
    else assert.ok(native.some(n => n.type === 'session' && n.id === e.session_id), 'a session header corroborates the spawn or move');
    const r = receipts.get(e.command_id);
    assert.ok(r, `native effect ${e.kind}:${e.command_id} needs a recovered receipt`);
    assert.notEqual(r.effect, 'no_effect', `native effect ${e.kind}:${e.command_id} recovered ${r.state}/${r.effect}`);
    const key = `${e.kind}:${e.command_id}`;
    assert.ok(!seen.has(key), `no duplicate native effect: ${key}`);
    seen.add(key);
  }
  // Nothing is adopted or left live: a worker that held a session is cleanup_pending after any restart.
  for (const w of after.workers) {
    assert.ok(!['ready', 'starting'].includes(w.status), `${w.worker_id} recovered ${w.status}`);
    const prior = pre.workers.get(w.worker_id);
    if (prior && ['ready', 'starting', 'cleanup_pending'].includes(prior.status)) assert.equal(w.status, 'cleanup_pending', w.worker_id);
  }
  for (const check of extra) check(pre, after);
  assert.equal(bytes(join(root, 'effects.jsonl')), before, 'recovery and duplicate requests perform zero new effects');
  const second = await recoverWorld(root);
  assert.deepEqual(second.receipts, after.receipts, 'a second recovery changes no receipt');
  assert.deepEqual(
    second.workers.map(w => [w.status, w.fence]),
    after.workers.map(w => [w.status, w.fence]),
    'a second recovery relatches nothing',
  );
  return after;
}
