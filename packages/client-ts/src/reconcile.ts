/**
 * Receipt reconciliation (P3-2, suite C2). A mutation is sent once. When its reply is lost (`ClientFailure` with
 * `effect: 'unknown'`), the caller reconciles its `command_id` here: one `receipts.get`, never the mutation again.
 *
 * Rules:
 * - The caller records the expected identity before transport: the command id, the operation, the worker (when the
 *   request names one) and `requestHash` of the exact request. A receipt resolves the uncertainty only when all of
 *   them match.
 * - Only a matching `delivered` receipt with `effect: observed` is `observed`. Only a matching `rejected` receipt
 *   with `effect: no_effect` is `no_effect` (the worker journaled that this command began nothing). Every other state
 *   (`accepted`, `outcome_unknown`, a queued or recovered intent, even with `effect: no_effect`) stays `unknown`.
 * - A receipt that cannot be read is `unknown`: missing, expired, scope-denied, malformed or a transport failure. The
 *   read's own `no_effect` refusal is about the read, never about the command.
 * - `unknown` is never permission to resend. A new attempt is a new command id, and only after the owner resolved the
 *   old one.
 */
import { createHash } from 'node:crypto';
import { ClientFailure, type Client, type PathParams, type Receipt, type RequestBody } from './client.js';

export type ReceiptOperation = Receipt['operation'];

/**
 * The operations whose receipt hashes the JSON body plus the `worker_id` path parameter, which `requestHash` can
 * reproduce. Others hash a request the worker derives (an answer's metadata, an attachment's headers, a report's
 * channel); reconcile those by their own status reads (`interactions.status`, `attachments.status`).
 */
export type HashedOperation =
  | 'workers.create'
  | 'sessions.prompt'
  | 'sessions.follow_up'
  | 'sessions.steer'
  | 'workers.stop'
  | 'workers.relaunch'
  | 'sessions.resolve_unknown'
  | 'sessions.rebind'
  | 'sessions.new'
  | 'children.launch'
  | 'executions.cancel'
  | 'executions.interrupt'
  | 'session.configure'
  | 'sessions.compact'
  | 'resources.reload'
  | 'commands.invoke';

/** The JSON form the worker hashes: object keys sorted, undefined members dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The `request_hash` the worker records for this request: SHA-256 (hex) of the canonical JSON of the body, its
 * `worker_id` path parameter and the operation, without the transport `request_id`. Compute it from the exact
 * options passed to `call` and record it with the command id before sending.
 */
export function requestHash<O extends HashedOperation>(operation: O, request: { path?: PathParams<O>; body: RequestBody<O> }): string {
  const { request_id: _requestId, ...fields } = { ...(request.body as Record<string, unknown>), ...(request.path as Record<string, unknown> | undefined), operation } as Record<string, unknown>;
  return createHash('sha256').update(canonical(fields)).digest('hex');
}

/** What the caller recorded before sending the mutation. */
export interface Expected {
  command_id: string;
  operation: ReceiptOperation;
  /** `requestHash` of the request as sent. */
  request_hash: string;
  /** The worker the request named (its path); absent for `workers.create`, whose worker the receipt names. */
  worker_id?: string;
}

export type UnknownReason =
  /** A receipt with another command id, operation, worker or request hash: not this command's outcome. */
  | 'receipt_mismatch'
  /** The worker recorded the outcome as unknown (a lost reply after dispatch, a restart mid-command). */
  | 'outcome_unknown'
  /** Not settled: accepted or dispatched, queued, or an intent awaiting the owner. Never resend it. */
  | 'receipt_not_settled'
  /** The worker has no receipt under this id; absence is not proof that nothing ran. */
  | 'receipt_missing'
  /** Retention evicted the receipt; its outcome is no longer readable. */
  | 'receipt_expired'
  /** The grant may not read this receipt. Do not widen the grant to find out; ask the owner. */
  | 'receipt_scope_denied'
  /** The read failed (transport, refusal or a reply that failed its checks). */
  | 'receipt_unreadable';

export type Reconciliation =
  /** The command took effect: its matching receipt is delivered and observed. */
  | { outcome: 'observed'; receipt: Receipt }
  /** The worker journaled a refusal: this command began nothing. A new attempt needs a new command id. */
  | { outcome: 'no_effect'; receipt: Receipt }
  /** Still uncertain. `receipt` is present only when it matched the expected identity. */
  | { outcome: 'unknown'; reason: UnknownReason; receipt?: Receipt };

/** Classifies a receipt (from `receipts.get` or a 200 reply) against what the caller sent. Reads nothing. */
export function classifyReceipt(receipt: Receipt, expected: Expected): Reconciliation {
  if (
    receipt.command_id !== expected.command_id ||
    receipt.operation !== expected.operation ||
    receipt.request_hash !== expected.request_hash ||
    (expected.worker_id !== undefined && receipt.worker_id !== expected.worker_id)
  ) {
    return { outcome: 'unknown', reason: 'receipt_mismatch' };
  }
  if (receipt.state === 'delivered' && receipt.effect === 'observed') return { outcome: 'observed', receipt };
  if (receipt.state === 'rejected' && receipt.effect === 'no_effect') return { outcome: 'no_effect', receipt };
  if (receipt.state === 'outcome_unknown') return { outcome: 'unknown', reason: 'outcome_unknown', receipt };
  return { outcome: 'unknown', reason: 'receipt_not_settled', receipt };
}

/** The read refusals that name why a receipt is unreadable. Any other failure is `receipt_unreadable`. */
const READ_REFUSALS: Readonly<Record<string, UnknownReason>> = {
  unknown_command_id_is_not_proof_of_no_effect: 'receipt_missing',
  receipt_expired: 'receipt_expired',
  grant_scope_denied: 'receipt_scope_denied',
};

/**
 * Reads the receipt of `expected.command_id` once (`receipts.get`) and classifies it. Sends no mutation, never
 * retries, and never throws: a failed read is `unknown`. Call it again later if the outcome is still unknown.
 */
export async function reconcile(client: Client, expected: Expected): Promise<Reconciliation> {
  let receipt: Receipt;
  try {
    receipt = await client.call('receipts.get', { path: { command_id: expected.command_id } });
  } catch (error) {
    const reason = error instanceof ClientFailure && error.phase === 'http' ? (READ_REFUSALS[error.message] ?? 'receipt_unreadable') : 'receipt_unreadable';
    return { outcome: 'unknown', reason };
  }
  return classifyReceipt(receipt, expected);
}

/** A fresh worker's binding, from its create receipt's `result`. */
export interface WorkerBinding {
  worker_id: string;
  worker_epoch: string;
  session_id: string;
  binding_revision: number;
}

export type Acquisition =
  /** The create began nothing: no worker exists for it. */
  | { worker: 'not_acquired' }
  /**
   * Whether a worker exists is unknown. Never create again in its place before the owner resolved it; `worker_id` is
   * present when a matching receipt names one (to inspect or stop it).
   */
  | { worker: 'unknown'; worker_id?: string }
  /**
   * The worker exists. `prompt` is the first input's outcome: `prompted` (admitted), `queued`, `not_prompted` (refused
   * or never sent: the worker is idle, the draft is the caller's to keep) or `unknown` (never send it again).
   */
  | { worker: 'acquired'; worker_id: string; binding?: WorkerBinding; prompt: 'prompted' | 'queued' | 'not_prompted' | 'unknown'; prompt_error?: string; execution_id?: string };

type Settled = Reconciliation | ClientFailure;

/** A ClientFailure is no_effect or unknown; a Reconciliation says so with its receipt. */
function outcomeOf(result: Settled): { outcome: Reconciliation['outcome']; receipt?: Receipt } {
  if (result instanceof ClientFailure) return { outcome: result.effect };
  return result;
}

function bindingOf(receipt: Receipt): WorkerBinding | undefined {
  const r = receipt.result;
  if (!r) return undefined;
  const { worker_id, worker_epoch, session_id, binding_revision } = r as Record<string, unknown>;
  if (typeof worker_id !== 'string' || typeof worker_epoch !== 'string' || typeof session_id !== 'string' || !Number.isInteger(binding_revision)) return undefined;
  if (worker_id !== receipt.worker_id) return undefined;
  return { worker_id, worker_epoch, session_id, binding_revision: binding_revision as number };
}

/** The admission a prompt receipt reports, as a first input's outcome. */
function admitted(receipt: Receipt): 'prompted' | 'queued' | 'not_prompted' | 'unknown' {
  if (receipt.admission === 'accepted') return 'prompted';
  if (receipt.admission === 'queued') return 'queued';
  if (receipt.admission === 'rejected') return 'not_prompted';
  return 'unknown';
}

/**
 * Classifies a worker acquisition: the `workers.create` outcome and, when the first input went as its own
 * `sessions.prompt`, that prompt's outcome. A created worker whose first prompt was refused is acquired and not
 * prompted, never a failed acquisition (and never a reason to create another). The create's outcome comes from
 * `classifyReceipt` of its 200 reply, `reconcile`, or its ClientFailure.
 */
export function acquisition(create: Settled, prompt?: Settled): Acquisition {
  const c = outcomeOf(create);
  if (c.outcome === 'no_effect') return { worker: 'not_acquired' };
  const receipt = c.receipt;
  if (c.outcome !== 'observed' || !receipt || receipt.operation !== 'workers.create' || receipt.worker_id === undefined) {
    return receipt?.operation === 'workers.create' && receipt.worker_id !== undefined ? { worker: 'unknown', worker_id: receipt.worker_id } : { worker: 'unknown' };
  }
  const binding = bindingOf(receipt);
  const base = { worker: 'acquired' as const, worker_id: receipt.worker_id, ...(binding ? { binding } : {}) };
  // A first_prompt in the create: the create's receipt reports its admission.
  if (receipt.admission !== undefined) {
    return {
      ...base,
      prompt: admitted(receipt),
      ...(receipt.error !== undefined && receipt.admission === 'rejected' ? { prompt_error: receipt.error } : {}),
      ...(receipt.execution_id !== undefined ? { execution_id: receipt.execution_id } : {}),
    };
  }
  if (prompt === undefined) return { ...base, prompt: 'not_prompted' };
  const p = outcomeOf(prompt);
  if (p.outcome === 'no_effect') {
    const code = prompt instanceof ClientFailure ? prompt.message : p.receipt?.error;
    return { ...base, prompt: 'not_prompted', ...(code !== undefined ? { prompt_error: code } : {}) };
  }
  if (p.outcome !== 'observed' || !p.receipt || p.receipt.operation !== 'sessions.prompt' || p.receipt.worker_id !== receipt.worker_id) return { ...base, prompt: 'unknown' };
  return {
    ...base,
    prompt: admitted(p.receipt),
    ...(p.receipt.error !== undefined && p.receipt.admission === 'rejected' ? { prompt_error: p.receipt.error } : {}),
    ...(p.receipt.execution_id !== undefined ? { execution_id: p.receipt.execution_id } : {}),
  };
}
