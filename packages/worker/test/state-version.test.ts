/**
 * State format (P2-1 fix round, nubl decision 2026-11-17, GPT PR #21 finding 1): the supervisor opens only state
 * written in its own format, with no migration and no compatibility. `fixtures/p1-state/journal.jsonl` is a journal the
 * P1 base (`9c5a40bc`) wrote with its own lifecycle and test host: one worker created, then stopped, so its terminal
 * row claims a cleanup a process-group kill could not prove (`escaped_descendants_unproven`). Opened by this version,
 * that row would release its session and cwd with no domain to clean; it must be refused before anything runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseJournal } from '../src/journal/journal.js';
import { journalPath, openState, STATE_VERSION, StateVersionRefused } from '../src/journal/state.js';
import type { Worker } from '../src/supervisor/state.js';
import { privateTmp } from './helpers.js';

const p1Journal = fileURLToPath(new URL('../../test/fixtures/p1-state/journal.jsonl', import.meta.url));
const testDaemon = fileURLToPath(new URL('./fixtures/daemon.js', import.meta.url));

/** A state directory holding the P1 base's journal. */
function p1State(dir: string): string {
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o700 });
  copyFileSync(p1Journal, journalPath(state));
  return state;
}

const refusedOlder = (e: unknown) => e instanceof StateVersionRefused && e.code === 'state_from_older_version' && e.found === 1 && e.required === STATE_VERSION;

test('state: a state written by P1 is refused at open with state_from_older_version naming both versions, and is left unchanged', () => {
  const tmp = privateTmp();
  try {
    const state = p1State(tmp.dir);
    const before = readFileSync(journalPath(state));
    // The fixture is what P1 really wrote: a stopped worker whose cleanup is unproven, and no state version.
    const records = parseJournal(before).records;
    assert.equal(records.find(r => r.kind === 'supervisor')!.value.state_version, undefined);
    const row = records.filter(r => r.kind === 'worker').at(-1)!.value.worker as Worker;
    assert.deepEqual([row.status, row.cleanup], ['stopped', 'process_group_observed_gone; escaped_descendants_unproven']);
    assert.throws(() => openState(state), refusedOlder, 'an older state is refused');
    assert.deepEqual(readFileSync(journalPath(state)), before, 'nothing was compacted, appended or recovered');
    // The lock was released: the refusal repeats rather than becoming a lock conflict.
    assert.throws(() => openState(state), refusedOlder);
  } finally {
    tmp.cleanup();
  }
});

test('state: a state this version wrote reopens, and its start records carry the state version', () => {
  const tmp = privateTmp();
  try {
    openState(tmp.dir).close();
    openState(tmp.dir).close();
    const starts = parseJournal(readFileSync(journalPath(tmp.dir))).records.filter(r => r.kind === 'supervisor');
    assert.deepEqual(starts.map(r => r.value.state_version), [STATE_VERSION, STATE_VERSION]);
  } finally {
    tmp.cleanup();
  }
});

test('state: the daemon refuses to start on a P1 state before it releases or launches anything, and never listens', { timeout: 30_000 }, async () => {
  const tmp = privateTmp();
  const state = p1State(tmp.dir);
  const socket = join(tmp.dir, 'run', 'b2.sock');
  const before = readFileSync(journalPath(state));
  const child = spawn(process.execPath, [testDaemon], { env: { PATH: process.env.PATH, PIW_SOCKET: socket, PIW_STATE_DIR: state }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => (stderr += chunk));
    const outcome = await Promise.race([
      once(child, 'exit').then(([code]) => ({ code: code as number | null | 'listening' | 'timeout' })),
      new Promise<{ code: 'listening' }>(resolve => child.stderr!.on('data', () => stderr.includes('"listening"') && resolve({ code: 'listening' }))),
      delay(20_000).then(() => ({ code: 'timeout' as const })),
    ]);
    assert.equal(outcome.code, 1, `the daemon must exit 1: ${stderr}`);
    const refusal = JSON.parse(stderr.split('\n').find(l => l.includes('"refused"'))!) as { reason: string; found: number; required: number };
    assert.deepEqual([refusal.reason, refusal.found, refusal.required], ['state_from_older_version', 1, STATE_VERSION]);
    assert.equal(existsSync(socket), false, 'no socket');
    assert.deepEqual(readFileSync(journalPath(state)), before, 'no lease was released and no record was written');
    assert.equal(existsSync(join(state, 'grants')), false, 'nothing else in the state directory was touched');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    tmp.cleanup();
  }
});
