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
 * - `resume`: an archived session resumed by a new worker's create, then a restart (resume-scenario.ts).
 * - `grants`: the owner's grant command registers two grants with bearer files and revokes one (grants-scenario.ts).
 * - `interactions`: answers, cancels, tool releases, a navigation and a lost acknowledgement (interactions-scenario.ts).
 * - `children`: a typed child with an FD report and a stop, an untyped child launched from a queue (children-scenario.ts).
 * - `matrix`: A0's crash-matrix scenario (prompt, moves, observed, keep and abandon with a follow-up and a child launch,
 *   cancel, interrupt, reports, stop, a grant), with no restart (matrix-scenario.ts); `matrix-recover` is its recovery.
 * - `compaction`: tight retention evicting delivered receipts across count- and byte-triggered compactions while a
 *   fenced unknown, a resolved one, controls and an unreported child stay retained (compaction-scenario.ts).
 * - `features`: session.configure delivered, refused before any change, and with a lost reply (features-scenario.ts).
 */
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { openState } from '../../../src/journal/state.js';
import { receiptScenario } from '../receipt-scenario.js';
import { lifecycleScenario } from '../lifecycle-scenario.js';
import { inputScenario } from '../input-scenario.js';
import { fenceScenario } from '../fence-scenario.js';
import { bindingScenario } from '../binding-scenario.js';
import { resumeScenario } from '../resume-scenario.js';
import { grantsScenario } from '../grants-scenario.js';
import { interactionsScenario } from '../interactions-scenario.js';
import { childrenScenario } from '../children-scenario.js';
import { compactionScenario } from '../compaction-scenario.js';
import { featuresScenario } from '../features-scenario.js';
import { matrixRecover, matrixScenario } from '../matrix-scenario.js';

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
} else if (mode === 'resume') {
  await resumeScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'matrix') {
  await matrixScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'matrix-recover') {
  await matrixRecover(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'compaction') {
  await compactionScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'features') {
  await featuresScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'children') {
  await childrenScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'interactions') {
  await interactionsScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'grants') {
  await grantsScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else if (mode === 'receipts') {
  await receiptScenario(root);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
  process.exit(0);
} else {
  throw new Error(`unknown scenario mode ${mode}`);
}
