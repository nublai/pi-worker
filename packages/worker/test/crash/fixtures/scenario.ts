/**
 * Crash scenario fixture: real fsyncs, deterministic seams, never live pi. Run as `scenario.js <mode> <root>`; the
 * parent cuts it with PIW_CRASH_AT and checks recovery with its own oracle (test/crash/*.test.ts).
 *
 * Modes:
 * - `journal`: two supervisor starts on one state directory (open, truncate, directory fsync, start record each).
 * - `receipts`: every receipt transition (receipt-scenario.ts), a restart, owner keep and one dispatch after it.
 * - `binding`: B2 moves, native moves bound and reconciled, a post-write collision (binding-scenario.ts).
 * - `fence`: fence latch, pause, keep, abandon, observed and a restart fence (fence-scenario.ts).
 * - `input`: prompts, if_busy, steer, follow-ups, cancel, interrupt, a lost reply, a stop and a restart.
 * - `lifecycle`: creates, a failed launch, a pi exit, a stop, a fault and a restart (lifecycle-scenario.ts).
 */
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { openState } from '../../../src/journal/state.js';
import { receiptScenario } from '../receipt-scenario.js';
import { lifecycleScenario } from '../lifecycle-scenario.js';
import { inputScenario } from '../input-scenario.js';
import { fenceScenario } from '../fence-scenario.js';
import { bindingScenario } from '../binding-scenario.js';

const [mode, root] = process.argv.slice(2);
assert.ok(root && isAbsolute(root), 'the parent supplies a per-run temporary directory');

if (mode === 'journal') {
  const ids: string[] = [];
  for (let start = 0; start < 2; start++) {
    const state = openState(root);
    ids.push(state.supervisorId);
    state.close();
  }
  process.stdout.write(`${JSON.stringify({ supervisor_ids: ids })}\n`);
} else if (mode === 'binding') {
  await bindingScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'fence') {
  await fenceScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'input') {
  await inputScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'lifecycle') {
  await lifecycleScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'receipts') {
  await receiptScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else {
  throw new Error(`unknown scenario mode ${mode}`);
}
