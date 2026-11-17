/**
 * The supervisor recovery oracle after a SIGKILL cut, ported from A0 `src/test/crash-matrix.test.ts`
 * (`checkRecovery`): recovered receipt buckets by pre-crash state, independent native-effect evidence (an effect is
 * never `no_effect`, never duplicated, and corroborated by its native artifact), no worker left live, every
 * logged request retried with no replay, and a second recovery that changes nothing.
 *
 * Under retention (a scenario with `world.json`, P1-12) a receipt may be missing after recovery only if retention may
 * evict it by the contract's own terms, decided here and not by the code under test: it was final (`delivered` or
 * `rejected`, or an `outcome_unknown` its worker's owner resolved) and its id is reported expired. A native effect
 * whose receipt was evicted must have been reported to the client, or recorded before the cut, as not `no_effect`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import type { Receipt } from '../../src/receipts/receipts.js';
import type { Worker } from '../../src/supervisor/state.js';
import { effectsAt, recoverWorld, repliesAt, requestsAt, type Logged, type Summary } from './world.js';

const bytes = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

export interface PreCrash {
  receipts: Map<string, Receipt>;
  workers: Map<string, Worker>;
  /** A worker's durable resume target at the cut (a create-with-resume or a rebind resume not yet bound). */
  targets: Map<string, string>;
  /** The client's own request log: what each command asked for, independent of the supervisor's records. */
  requests: Logged[];
}

export function preCrash(root: string): PreCrash {
  const receipts = new Map<string, Receipt>();
  const workers = new Map<string, Worker>();
  const targets = new Map<string, string>();
  for (const record of parseJournal(readFileSync(journalPath(root))).records) {
    if (record.kind === 'receipt') receipts.set(String(record.value.command_id), record.value as Receipt);
    if (record.kind === 'worker') {
      const { worker: w, resume } = record.value as { worker: Worker; resume?: { session_id: string } };
      workers.set(w.worker_id, w);
      if (resume) targets.set(w.worker_id, resume.session_id);
      else targets.delete(w.worker_id);
    }
  }
  return { receipts, workers, targets, requests: requestsAt(root) };
}

/** Extra per-PR checks over the pre-crash state and the recovered summary (fences, executions, bindings). */
export type Check = (pre: PreCrash, after: Summary) => void;

/** The contract's evictable receipts (P1-12): final, and not an `outcome_unknown` its owner has not resolved. */
function evictable(pre: PreCrash, r: Receipt): boolean {
  if (r.state === 'delivered' || r.state === 'rejected') return true;
  return r.state === 'outcome_unknown' && [...pre.workers.values()].some(w => (w.resolutions ?? []).some(x => x.command_id === r.command_id));
}

export async function checkRecovery(root: string, extra: Check[] = []): Promise<Summary> {
  const pre = preCrash(root);
  const retention = existsSync(join(root, 'world.json'));
  const before = bytes(join(root, 'effects.jsonl'));
  const after = await recoverWorld(root);
  const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  const expired = new Set(after.expired);
  for (const r of pre.receipts.values()) {
    const got = receipts.get(r.command_id)!;
    if (!got && retention) {
      assert.ok(evictable(pre, r), `${r.command_id} (${r.state}) is not evictable, yet recovery lost it`);
      assert.ok(expired.has(r.command_id), `evicted ${r.command_id} is reported expired`);
      continue;
    }
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
    const key0 = `${e.kind}:${e.command_id}`;
    if (e.command_id.startsWith('timeout:') || e.command_id.startsWith('claim:')) {
      // A deadline cancel has no command (its write-ahead marker is checked by the interactions oracle); a report a
      // child wrote to its FD is a claim, durable only once its receipt is (the children oracle checks delivery).
      assert.ok(!seen.has(key0), `no duplicate native effect: ${key0}`);
      seen.add(key0);
      continue;
    }
    const r = receipts.get(e.command_id);
    if (!r && retention && expired.has(e.command_id)) {
      // Evicted after the effect: what the client was told (or the journal said at the cut) is not no_effect.
      const told = [...repliesAt(root)].reverse().find(x => x.command_id === e.command_id && x.state);
      const cut = pre.receipts.get(e.command_id);
      assert.ok(told ?? cut, `native effect ${e.kind}:${e.command_id}: evicted with no reply and no record`);
      for (const known of [told, cut]) if (known) assert.notEqual(known.effect, 'no_effect', `native effect ${e.kind}:${e.command_id} was ${known.state}/${known.effect}`);
    } else {
      assert.ok(r, `native effect ${e.kind}:${e.command_id} needs a recovered receipt`);
      assert.notEqual(r.effect, 'no_effect', `native effect ${e.kind}:${e.command_id} recovered ${r.state}/${r.effect}`);
    }
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
  if (retention) {
    // A second recovery may only evict more (its open may compact); every receipt it keeps is unchanged.
    const kept = new Map(second.receipts.map(r => [r.command_id, r]));
    for (const r of after.receipts) {
      if (kept.has(r.command_id)) assert.deepEqual(kept.get(r.command_id), r, 'a second recovery changes no receipt');
      else assert.ok(second.expired.includes(r.command_id) && evictable(pre, r), `a second recovery lost ${r.command_id}`);
    }
    assert.equal(second.receipts.length <= after.receipts.length, true);
  } else assert.deepEqual(second.receipts, after.receipts, 'a second recovery changes no receipt');
  assert.deepEqual(
    second.workers.map(w => [w.status, w.fence]),
    after.workers.map(w => [w.status, w.fence]),
    'a second recovery relatches nothing',
  );
  return after;
}
