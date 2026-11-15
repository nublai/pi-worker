/** THROWAWAY deterministic SIGKILL injection immediately AFTER each real supervisor fsync.
 * SIGKILL tests ordering/recovery, not a power-loss/device flush guarantee.
 */
import { fsyncSync } from 'node:fs';
let ordinal = 0;
export function syncPoint(fd: number, label: string): void {
  fsyncSync(fd);
  const index = ++ordinal;
  if (process.env.A0_TRACE_FSYNC === '1') process.stderr.write(JSON.stringify({ fsync: { index, label } }) + '\n');
  if (process.env.A0_CRASH_INDEX === String(index) || process.env.A0_CRASH_AT === label) process.kill(process.pid, 'SIGKILL');
}
