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
] as const;

export type DurableLabel = (typeof DURABLE_LABELS)[number];

const known: ReadonlySet<string> = new Set(DURABLE_LABELS);

export function isDurableLabel(label: string): label is DurableLabel {
  return known.has(label);
}
