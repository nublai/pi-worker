/**
 * The independent fence oracle (P1-6, ported from A0 `crash-matrix.test.ts`'s bucket and fence oracle), shared by the
 * crash test files: the fence of every recovered worker must equal exactly its uncertainties. Moved out of
 * `fence.test.ts` (P1-12) so a crash file can use it without re-registering the fence tests; unchanged.
 */
import assert from 'node:assert/strict';
import type { Operation, Receipt } from '../../src/receipts/receipts.js';
import type { Check, PreCrash } from './oracle.js';

/**
 * Contract invariant 3 and transition `bound → fenced`: an `outcome_unknown` session write fences the session; reads,
 * cancel, interrupt, termination, resolution and child evidence reports never do. Specified independently of the
 * implementation and total over the operations: a new operation does not compile until it is classified here.
 * `NAMES_EXISTING_SESSION`: a session write only when the request names an existing session.
 */
export const NAMES_EXISTING_SESSION = 'when_the_request_names_an_existing_session';
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
    // Invariant 4a: a child whose launch may have run (its launch receipt is not no_effect) and that left no durable
    // non-help report for its task fences its parent on the launch command, unless the parent resolved it.
    for (const c of pre.workers.values()) {
      const launch = c.parent_launch_command_id;
      if (!launch || c.parent_worker_id !== w.worker_id || resolved.has(launch)) continue;
      const lr = receipts.get(launch);
      if (!lr || lr.effect === 'no_effect') continue;
      const task = c.parent?.task_id ?? launch;
      // A typed child's only report authority is its own FD 3: no other report discharges its launch.
      const typed = !!(c.parent || c.launch_spec);
      const reported = after.receipts.some(
        r => r.operation === 'children.report' && r.worker_id === c.worker_id && r.state === 'delivered' && r.result?.task_id === task && r.result?.kind !== 'help' && (!typed || r.result?.channel === 'fd3'),
      );
      if (!reported) required.add(launch);
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
