/**
 * Labelled fsync points with deterministic crash injection, ported from A0 `src/fsync.ts`.
 *
 * - `PIW_TRACE_FSYNC=1` writes `{"fsync":{"index","label","occurrence"}}` to stderr after every fsync.
 * - `PIW_CRASH_AT=<label>` SIGKILLs the process right after the first fsync with that label; `<label>@<n>` after its
 *   n-th occurrence; `#<n>` after the n-th fsync of the process. Use them only on test state.
 *
 * A SIGKILL after a real fsync tests ordering and recovery, not a power-loss or device-flush guarantee.
 */
import { fsyncSync } from 'node:fs';
import { isDurableLabel, type DurableLabel } from './labels.js';

let ordinal = 0;
const occurrences = new Map<string, number>();

export class UnknownDurableLabel extends Error {}

/** fsync `fd`, then trace and crash-inject under `label`. An unregistered label throws before the fsync. */
export function durable(fd: number, label: DurableLabel): void {
  if (!isDurableLabel(label)) throw new UnknownDurableLabel(`unregistered durable label ${String(label)}`);
  fsyncSync(fd);
  const index = ++ordinal;
  const occurrence = (occurrences.get(label) ?? 0) + 1;
  occurrences.set(label, occurrence);
  if (process.env.PIW_TRACE_FSYNC === '1') process.stderr.write(`${JSON.stringify({ fsync: { index, label, occurrence } })}\n`);
  const at = process.env.PIW_CRASH_AT;
  if (at && (at === label || at === `${label}@${occurrence}` || at === `#${index}`)) process.kill(process.pid, 'SIGKILL');
}
