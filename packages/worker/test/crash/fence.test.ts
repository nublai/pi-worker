/**
 * Fence crash cuts (P1-6): a real SIGKILL after every fsync of the fence scenario and after every native effect.
 * Besides the recovery oracle, the fence of every worker must equal exactly its uncertainties (ported from A0
 * `crash-matrix.test.ts`'s bucket and fence oracle): every unresolved outcome_unknown session-directed receipt, an
 * unsettled dispatched execution unless it was resolved and the worker was no longer live, and every unresolved
 * uncertainty already in the persisted fence (which must have dispatched evidence). No spurious empty fence.
 *
 * Which operations are session writes comes from the contract (`FENCES_WHEN_UNKNOWN` below), never from the
 * implementation: an oracle that imported the supervisor's own set agreed with its omission of `sessions.new`
 * (review F4), and a table that called every `workers.create` non-fencing agreed with an unfenced unknown
 * create-with-resume (fix round 3). Whether a create named an existing session comes from the client's request log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Operation, Receipt } from '../../src/receipts/receipts.js';
import { BINDS_EXISTING_SESSION, SESSION_DIRECTED } from '../../src/supervisor/fence.js';
import { checkRecovery, type Check, type PreCrash } from './oracle.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt } from './world.js';

/**
 * Contract invariant 3 and transition `bound → fenced`: an `outcome_unknown` session write fences the session; reads,
 * cancel, interrupt, termination, resolution and child evidence reports never do. Specified independently of the
 * implementation and total over the operations: a new operation does not compile until it is classified here.
 * `NAMES_EXISTING_SESSION`: a session write only when the request names an existing session.
 */
const NAMES_EXISTING_SESSION = 'when_the_request_names_an_existing_session';
export const FENCES_WHEN_UNKNOWN: Readonly<Record<Operation, boolean | typeof NAMES_EXISTING_SESSION>> = {
  'sessions.prompt': true,
  'sessions.follow_up': true,
  'sessions.steer': true,
  'sessions.rebind': true, // new, fork, resume and tree moves
  'sessions.new': true, // the /new move under its own operation
  'children.launch': true,
  'interactions.answer_if_current': true,
  'interactions.release': true,
  // A create with `resume_session_id` binds that session: pi may have run its switch hooks or opened it. A plain
  // create's fresh session has no prior state to protect.
  'workers.create': NAMES_EXISTING_SESSION,
  'workers.stop': false, // termination stays allowed under a fence and never replaces it
  'workers.relaunch': false, // termination and relaunch of the worker, gated by cleanup (invariant 2)
  'executions.cancel': false,
  'executions.interrupt': false,
  'sessions.resolve_unknown': false,
  'children.report': false, // child evidence reports stay allowed under a fence
  'attachments.stage': false, // staging writes the worker's staging area, not the session
};
function fencesWhenUnknown(pre: PreCrash, r: Receipt): boolean {
  const rule = FENCES_WHEN_UNKNOWN[r.operation];
  if (rule !== NAMES_EXISTING_SESSION) return rule;
  return pre.requests.some(q => q.body.command_id === r.command_id && typeof q.body.resume_session_id === 'string');
}

export const fences: Check = (pre, after) => {
  const receipts = new Map(after.receipts.map(r => [r.command_id, r]));
  for (const w of after.workers) {
    const prior = pre.workers.get(w.worker_id)!;
    const resolved = new Set((prior.resolutions ?? []).map(x => x.command_id));
    const required = new Set<string>();
    for (const r of after.receipts) if (r.worker_id === w.worker_id && fencesWhenUnknown(pre, r) && r.state === 'outcome_unknown' && !resolved.has(r.command_id)) required.add(r.command_id);
    if (prior.execution && prior.execution.state !== 'settled' && (!resolved.has(prior.execution.command_id) || ['ready', 'starting'].includes(prior.status))) {
      if (receipts.get(prior.execution.command_id)?.effect !== 'no_effect') required.add(prior.execution.command_id);
    }
    for (const id of prior.fence?.uncertain_command_ids ?? []) {
      if (resolved.has(id)) continue;
      const r = receipts.get(id);
      assert.ok(r && r.effect !== 'no_effect', 'a persisted fence needs dispatched evidence');
      required.add(id);
    }
    assert.deepEqual([...(w.fence?.uncertain_command_ids ?? [])].sort(), [...required].sort(), `the fence of ${w.worker_id} is exactly its uncertainties`);
    assert.equal(w.fence === null, required.size === 0, 'no spurious empty fence');
  }
};

test('fence: the supervisor recovers exactly the contract session writes as fencing uncertainties', () => {
  const contract = (rule: boolean | typeof NAMES_EXISTING_SESSION) =>
    Object.entries(FENCES_WHEN_UNKNOWN)
      .filter(([, fences]) => fences === rule)
      .map(([operation]) => operation)
      .sort();
  assert.deepEqual([...SESSION_DIRECTED].sort(), contract(true));
  assert.deepEqual([...BINDS_EXISTING_SESSION].sort(), contract(NAMES_EXISTING_SESSION), 'create-with-resume fences when unknown');
});

test('crash: SIGKILL after every fence-scenario fsync: the fence is exactly the uncertainties, no replay', { timeout: 600_000 }, async () => {
  const base = tempRoot('fence-base');
  let points: FsyncPoint[];
  try {
    const full = run('fence', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('fence-cut');
    try {
      cutAt('fence', cut.root, point);
      await checkRecovery(cut.root, [fences]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL after every fence-scenario native effect: effect-bearing receipts and exact fences', { timeout: 300_000 }, async () => {
  const base = tempRoot('fence-effects');
  let count: number;
  try {
    assert.equal(run('fence', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('fence-effect');
    try {
      assert.equal(run('fence', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      await checkRecovery(cut.root, [fences]);
    } finally {
      cut.cleanup();
    }
  }
});
