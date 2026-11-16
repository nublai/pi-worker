/**
 * Crash harness: runs a scenario fixture in a child process with real fsyncs, optionally SIGKILLed right after a
 * labelled fsync (`PIW_CRASH_AT`), and reads its fsync trace (`PIW_TRACE_FSYNC`). Ported pattern from A0
 * `src/test/crash-matrix.test.ts`. The oracle is always the recovered state plus independent native artifacts that
 * the fixture writes, never the receipts alone.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scenarioFixture = fileURLToPath(new URL('./fixtures/scenario.js', import.meta.url));

export type FsyncPoint = { index: number; label: string; occurrence: number };
export type Run = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; points: FsyncPoint[] };

/** Runs `scenario.js <mode> <root>`; `crashAt` is a PIW_CRASH_AT value. */
export function run(mode: string, root: string, crashAt?: string, extraEnv: Record<string, string> = {}): Run {
  const out = spawnSync(process.execPath, [scenarioFixture, mode, root], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PIW_TRACE_FSYNC: '1', PIW_CRASH_AT: crashAt ?? '', ...extraEnv },
  });
  if (out.error) throw out.error;
  const points = out.stderr
    .split('\n')
    .filter(l => l.startsWith('{"fsync"'))
    .map(l => (JSON.parse(l) as { fsync: FsyncPoint }).fsync);
  return { status: out.status, signal: out.signal, stdout: out.stdout, stderr: out.stderr, points };
}

/** The last JSON line a fixture printed on stdout. */
export function lastJson<T>(stdout: string): T {
  const line = stdout.trim().split('\n').at(-1);
  if (!line) throw new Error('fixture printed nothing');
  return JSON.parse(line) as T;
}

export function tempRoot(name: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `piw-crash-${name}-`));
  chmodSync(root, 0o700);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs `scenario` cut at `point` and requires that the process died by SIGKILL right after that fsync. */
export function cutAt(scenario: string, root: string, point: FsyncPoint): Run {
  const at = `${point.label}@${point.occurrence}`;
  const killed = run(scenario, root, at);
  if (killed.signal !== 'SIGKILL') throw new Error(`cut ${at} of ${scenario} did not SIGKILL (status ${killed.status}): ${killed.stderr.slice(-2000)}`);
  const last = killed.points.at(-1);
  if (!last || last.label !== point.label || last.occurrence !== point.occurrence) throw new Error(`cut ${at}: last fsync was ${JSON.stringify(last)}`);
  return killed;
}
