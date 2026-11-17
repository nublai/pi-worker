/**
 * State format (P2-1 fix round, nubl decision 2026-11-17, GPT PR #21 finding 1): the supervisor opens only state
 * written in its own format, with no migration and no compatibility. `fixtures/p1-state/journal.jsonl` is a journal the
 * P1 base (`9c5a40bc`) wrote with its own lifecycle and test host: one worker created, then stopped, so its terminal
 * row claims a cleanup a process-group kill could not prove (`escaped_descendants_unproven`). Opened by this version,
 * that row would release its session and cwd with no domain to clean; it must be refused before anything runs.
 *
 * `fixtures/p2-1-state/journal.jsonl` is a journal the P2-1 base (`c1b1060`) wrote with its own supervisor, its
 * `CgroupContainment` over a plain directory and the test host: a ready worker holding a `w-<epoch>` domain and an
 * inventory probe whose cleanup is unconfirmed (`w-inventory-<id>`). P2-2 cleans only `w-<installation>-…` domains, so
 * opened by this version neither recorded domain would ever be killed while the daemon listens (PR #23 GPT 1, Grok 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseJournal } from '../src/journal/journal.js';
import { journalPath, openState, STATE_VERSION, StateVersionRefused } from '../src/journal/state.js';
import type { Worker } from '../src/supervisor/state.js';
import { privateTmp } from './helpers.js';

const p1Journal = fileURLToPath(new URL('../../test/fixtures/p1-state/journal.jsonl', import.meta.url));
const p21Journal = fileURLToPath(new URL('../../test/fixtures/p2-1-state/journal.jsonl', import.meta.url));
const testDaemon = fileURLToPath(new URL('./fixtures/daemon.js', import.meta.url));

/** A state directory holding the P1 base's journal (or another base's). */
function p1State(dir: string, journal = p1Journal): string {
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o700 });
  copyFileSync(journal, journalPath(state));
  return state;
}

/**
 * A journal cut mid-append (a torn final record, no newline) beside a compaction cut before its rename (a stray
 * `.compact` copy): the two things opening a journal repairs. Returns both files' bytes.
 */
function interrupted(state: string): { journal: Buffer; compact: Buffer } {
  appendFileSync(journalPath(state), '{"record":{"seq":99,"kind":"worker",');
  writeFileSync(`${journalPath(state)}.compact`, 'a compaction cut before its rename\n', { mode: 0o600 });
  return { journal: readFileSync(journalPath(state)), compact: readFileSync(`${journalPath(state)}.compact`) };
}

/** A state directory whose one start record says it was written in `version` (checksummed as the journal writes it). */
function stateInFormat(dir: string, version: number): string {
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o700 });
  const record = { seq: 1, kind: 'supervisor', value: { supervisor_id: 'sup-recorded', supervisor_epoch: 'epoch-recorded', installation_id: '0123456789abcdef0123', state_version: version, started_at: '2026-11-17T00:00:00.000Z' } };
  const checksum = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  writeFileSync(journalPath(state), `${JSON.stringify({ record, checksum })}\n`, { mode: 0o600 });
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

test('state: an older state cut mid-append and mid-compaction is refused with its torn tail and .compact copy byte for byte unchanged (GPT PR #21 delta 3)', () => {
  const tmp = privateTmp();
  try {
    const state = p1State(tmp.dir);
    const before = interrupted(state);
    assert.throws(() => openState(state), refusedOlder, 'an older state is refused');
    assert.deepEqual(readFileSync(journalPath(state)), before.journal, 'the torn final record was not truncated');
    assert.deepEqual(readFileSync(`${journalPath(state)}.compact`), before.compact, 'the .compact copy was not removed');
    assert.throws(() => openState(state), refusedOlder);
  } finally {
    tmp.cleanup();
  }
});

test('state: a newer state cut mid-append and mid-compaction is refused state_from_newer_version, byte for byte unchanged (GPT PR #21 delta 3)', () => {
  const tmp = privateTmp();
  try {
    const state = stateInFormat(tmp.dir, STATE_VERSION + 1);
    const before = interrupted(state);
    const refusedNewer = (e: unknown) => e instanceof StateVersionRefused && e.code === 'state_from_newer_version' && e.found === STATE_VERSION + 1 && e.required === STATE_VERSION;
    assert.throws(() => openState(state), refusedNewer, 'a newer state is refused');
    assert.deepEqual(readFileSync(journalPath(state)), before.journal, 'the torn final record was not truncated');
    assert.deepEqual(readFileSync(`${journalPath(state)}.compact`), before.compact, 'the .compact copy was not removed');
  } finally {
    tmp.cleanup();
  }
});

test('state: a state in this format cut mid-append and mid-compaction still opens: the torn tail is dropped and .compact removed', () => {
  const tmp = privateTmp();
  try {
    const state = stateInFormat(tmp.dir, STATE_VERSION);
    const whole = readFileSync(journalPath(state));
    interrupted(state);
    const opened = openState(state);
    try {
      assert.deepEqual(opened.journal.records.map(r => r.value.state_version), [STATE_VERSION, STATE_VERSION], 'the complete record kept, the torn one dropped, a new start appended');
      assert.equal(opened.supervisorId, 'sup-recorded', 'the first start record names the supervisor');
    } finally {
      opened.close();
    }
    assert.deepEqual(readFileSync(journalPath(state)).subarray(0, whole.length), whole);
    assert.equal(parseJournal(readFileSync(journalPath(state))).records.length, 2, 'no torn bytes survive');
    assert.equal(existsSync(`${journalPath(state)}.compact`), false, 'the half-made copy is removed');
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

test('state: a state in this format that records no valid installation id is refused, never started as another installation', () => {
  const tmp = privateTmp();
  try {
    const state = stateInFormat(tmp.dir, STATE_VERSION);
    const record = { seq: 1, kind: 'supervisor', value: { supervisor_id: 'sup-recorded', supervisor_epoch: 'epoch-recorded', installation_id: '../../escape', state_version: STATE_VERSION, started_at: '2026-11-17T00:00:00.000Z' } };
    writeFileSync(journalPath(state), `${JSON.stringify({ record, checksum: createHash('sha256').update(JSON.stringify(record)).digest('hex') })}\n`, { mode: 0o600 });
    const before = readFileSync(journalPath(state));
    assert.throws(() => openState(state), /no valid installation id/);
    assert.deepEqual(readFileSync(journalPath(state)), before, 'no start record was appended');
  } finally {
    tmp.cleanup();
  }
});

const refusedP21 = (e: unknown) => e instanceof StateVersionRefused && e.code === 'state_from_older_version' && e.found === 2 && e.required === STATE_VERSION;

test('state: a state written by P2-1 (w-<epoch> domain names) is refused at open with state_from_older_version, before repair or compaction, and is left unchanged', () => {
  const tmp = privateTmp();
  try {
    const state = p1State(tmp.dir, p21Journal);
    // The fixture is what P2-1 really wrote: format 2, a holding worker's and an unconfirmed probe's domain, both
    // named without an installation id.
    const records = parseJournal(readFileSync(journalPath(state))).records;
    assert.equal(records.find(r => r.kind === 'supervisor')!.value.state_version, 2);
    const row = records.filter(r => r.kind === 'worker').at(-1)!.value.worker as Worker;
    assert.equal(row.status, 'ready');
    const names = [...records.filter(r => r.kind === 'worker').map(r => (r.value.domain as { name: string } | undefined)?.name), ...records.filter(r => r.kind === 'inventory').map(r => (r.value.domain as { name: string }).name)].filter(Boolean);
    assert.ok(names.some(n => /^w-[0-9a-f]{8}-[0-9a-f]{4}-/.test(n!)) && names.some(n => n!.startsWith('w-inventory-')), `P2-1 names: ${names.join(' ')}`);
    const before = interrupted(state);
    assert.throws(() => openState(state), refusedP21, 'a P2-1 state is refused');
    assert.deepEqual(readFileSync(journalPath(state)), before.journal, 'the torn final record was not truncated');
    assert.deepEqual(readFileSync(`${journalPath(state)}.compact`), before.compact, 'the .compact copy was not removed');
    assert.throws(() => openState(state), refusedP21);
  } finally {
    tmp.cleanup();
  }
});

test('state: the daemon refuses to start on a P2-1 state before recovery or the sweep, and never listens', { timeout: 30_000 }, async () => {
  const tmp = privateTmp();
  const state = p1State(tmp.dir, p21Journal);
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
    assert.deepEqual([refusal.reason, refusal.found, refusal.required], ['state_from_older_version', 2, STATE_VERSION]);
    assert.equal(existsSync(socket), false, 'no socket');
    assert.deepEqual(readFileSync(journalPath(state)), before, 'nothing was recorded, recovered or released');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    tmp.cleanup();
  }
});
