/**
 * Every durable point of the supervisor: each fsync is a labelled `durable(fd, label)` call, and each label here must
 * have a SIGKILL cut scenario in `test/crash/cuts.ts` (the label-coverage test fails otherwise). A PR that adds a label
 * adds its cut in the same PR (plan section 5).
 */
export const DURABLE_LABELS = [
  // The journal file after open and torn-tail truncation, then its directory entry.
  'journal.open_file',
  'journal.open_directory',
  // The supervisor start record: persistent supervisor id, fresh epoch.
  'supervisor.start',
  // Receipts (receipts/receipts.ts): intent, dispatch marker, result, recovery transitions, a late outcome_unknown,
  // an automatic queue flush and the owner's disposition of a recovered or queued intent.
  'receipt.intent',
  'receipt.dispatch',
  'receipt.result',
  'receipt.recover',
  'receipt.unknown',
  'receipt.queue_ready',
  'receipt.resolve_intent',
  // Worker lifecycle (supervisor/lifecycle.ts): the starting row before dispatch, the process identity right after
  // spawn and before any request, the session identity, ready, a failed launch, stop (pending, then the observed
  // result), a pi exit, a worker fault, and the cleanup_pending record a restart writes.
  'worker.create',
  'worker.spawned',
  'worker.identity',
  'worker.ready',
  'worker.failed',
  'worker.stop',
  'worker.stopped',
  'worker.exit',
  'worker.fault',
  'worker.recover',
  // Input and executions (supervisor/input.ts): the admitted execution before its dispatch record, pi's start, the
  // admission reply, settlement (the worker row and the separate settlement evidence record), an execution whose
  // outcome became unknown, a follow-up queued and flushed, and a control request's result.
  'execution.admit',
  'execution.start',
  'execution.reply',
  'execution.settle',
  'execution.unknown',
  'settlement.record',
  'queue.add',
  'queue.flush',
  'control.done',
  // Fence (supervisor/fence.ts): the owner's resolution tombstone, durable before any receipt it clears or authorizes.
  // The latch itself is durable under the label of the step that caused it (execution.unknown, worker.exit, ...).
  'fence.resolve',
  // Binding changes (supervisor/binding.ts): a B2 move's new binding, a native move pi made, and the fence latched on
  // its own when a move's outcome became unknown.
  'binding.rebind',
  'binding.native',
  'fence.latch',
  // Grants (grants/store.ts): the grant directory's entry in the state directory, a registered record (its temporary
  // file, then the directory after the link), a revocation (the same pair after the rename), and the bearer file the
  // `grant register` command writes for the caller.
  'grant.directory',
  'grant.register_file',
  'grant.register_directory',
  'grant.revoke_file',
  'grant.revoke_directory',
  'grant.bearer_file',
  // Interactions (interactions/interactions.ts): a dialog's metadata when it opens, its close (timeout, cancel,
  // resolver closed, binding change), the accepted answer before dispatch, the resolver's acknowledgement (stage 2 or
  // 3), a tool release (stage 4 or denied), a consumed approval whose gate ended without a release receipt (the
  // child's terminal `gate_closed`), the write-ahead marker before a native cancel, and restart interruption.
  'interaction.open',
  'interaction.close',
  'interaction.accept',
  'interaction.answer',
  'interaction.release',
  'interaction.gate_close',
  'interaction.cancel',
  'interaction.recover',
] as const;

export type DurableLabel = (typeof DURABLE_LABELS)[number];

const known: ReadonlySet<string> = new Set(DURABLE_LABELS);

export function isDurableLabel(label: string): label is DurableLabel {
  return known.has(label);
}
