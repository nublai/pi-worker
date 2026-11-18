#!/usr/bin/env node
// Reversion runner: applies each diff to the working tree, runs the guard's test command and requires a named test
// to FAIL (an assertion, not a build error), then reverts the diff. A guard whose reversion still passes has no test. Run on a tree with no tracked changes.
//   node tools/reversions.mjs --command '<shell command>' <diff>...
// Each run has a timeout (PIW_REVERSION_TIMEOUT_S seconds, default 600). On timeout the whole process group (sh, npm and
// every node test child) is killed and the diff is `timed_out`: a hang is a failure, never "caught", and the run exits 1.
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const at = args.indexOf('--command');
if (at < 0 || !args[at + 1]) {
  console.error("usage: node tools/reversions.mjs --command '<cmd>' <diff>...");
  process.exit(2);
}
const command = args[at + 1];
const diffs = args.filter((_, i) => i !== at && i !== at + 1);
const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
if (git('status', '--porcelain', '--untracked-files=no').stdout.trim()) {
  console.error('working tree has uncommitted changes; commit or stash first');
  process.exit(2);
}
const timeoutS = Number(process.env.PIW_REVERSION_TIMEOUT_S ?? 600);
if (!(timeoutS > 0)) {
  console.error('PIW_REVERSION_TIMEOUT_S must be a positive number of seconds');
  process.exit(2);
}
const MAX_OUTPUT = 64 * 1024 * 1024;
// Runs the command in its own process group; resolves { status, output, timedOut }.
const runCommand = () =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // group already gone
      }
    };
    const collect = chunk => {
      if (output.length < MAX_OUTPUT) output += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutS * 1000);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', status => {
      clearTimeout(timer);
      killGroup(); // leftovers of a finished run (a test that left a server behind) must not outlive it
      resolve({ status, output, timedOut });
    });
  });
const results = [];
for (const diff of diffs) {
  const apply = git('apply', diff);
  if (apply.status !== 0) {
    results.push({ diff, result: 'diff_does_not_apply', detail: apply.stderr.trim() });
    continue;
  }
  try {
    const run = await runCommand();
    const { output } = run;
    const failing = [
      ...new Set(
        output
          .split('\n')
          .filter(l => l.startsWith('✖ ') && l !== '✖ failing tests:')
          .map(l => l.slice(2).replace(/ \([\d.]+ms\)$/, '')),
      ),
    ];
    // Caught means a named test failed. A build error or crash is not a test catching the reversion.
    // A timeout is its own failure: whatever the killed run printed before the kill proves nothing.
    if (run.timedOut) {
      results.push({ diff, exit: run.status, result: 'timed_out', timeout_s: timeoutS, failing });
      continue;
    }
    const result = run.status === 0 ? 'NOT_CAUGHT' : failing.length ? 'caught' : 'failed_without_assertion';
    results.push({ diff, exit: run.status, result, failing });
  } finally {
    const revert = git('apply', '-R', diff);
    if (revert.status !== 0) {
      console.error(`could not revert ${diff}: ${revert.stderr}`);
      process.exit(3);
    }
  }
}
const head = git('rev-parse', 'HEAD').stdout.trim();
const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
process.stdout.write(`${JSON.stringify({ command, head, tree, results }, null, 2)}\n`);
process.exit(results.every(r => r.result === 'caught') ? 0 : 1);
