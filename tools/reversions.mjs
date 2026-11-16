#!/usr/bin/env node
// Reversion runner: applies each diff to the working tree, runs the guard's test command and requires a named test
// to FAIL (an assertion, not a build error), then reverts the diff. A guard whose reversion still passes has no test. Run on a tree with no tracked changes.
//   node tools/reversions.mjs --command '<shell command>' <diff>...
import { spawnSync } from 'node:child_process';

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
const results = [];
for (const diff of diffs) {
  const apply = git('apply', diff);
  if (apply.status !== 0) {
    results.push({ diff, result: 'diff_does_not_apply', detail: apply.stderr.trim() });
    continue;
  }
  try {
    const run = spawnSync('sh', ['-c', command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${run.stdout}${run.stderr}`;
    const failing = [
      ...new Set(
        output
          .split('\n')
          .filter(l => l.startsWith('✖ ') && l !== '✖ failing tests:')
          .map(l => l.slice(2).replace(/ \([\d.]+ms\)$/, '')),
      ),
    ];
    // Caught means a named test failed. A build error or crash is not a test catching the reversion.
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
