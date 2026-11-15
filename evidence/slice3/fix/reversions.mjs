// Authored fix-round regressions. All edits/builds occur in owned disposable copies.
// Reviewer scratch is read-only; its source and probes are copied, never executed there.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync('/tmp/a0s3fix/reversions-'), repo = process.cwd();
const reviewer = process.argv[2] ?? '/tmp/a0/review6';
const rows = [];
function copy(name, source = repo) {
  const dest = join(root, name); mkdirSync(dest);
  for (const path of ['src', 'package.json', 'tsconfig.json', 'openapi.json']) cpSync(join(source, path), join(dest, path), { recursive: true });
  symlinkSync(resolve(repo, 'node_modules'), join(dest, 'node_modules'), 'dir');
  return dest;
}
function replace(dest, file, old, replacement) {
  const path = join(dest, file), before = readFileSync(path, 'utf8');
  assert.equal(before.split(old).length, 2, 'unique mutation site: ' + file);
  writeFileSync(path, before.replace(old, replacement));
}
function run(dest, files, fails, pattern) {
  const built = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', dest], { encoding: 'utf8', timeout: 60000 });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const tested = spawnSync(process.execPath, ['--test', ...files.map(f => join(dest, 'dist/test', f + '.test.js'))], { encoding: 'utf8', timeout: 180000 });
  const output = tested.stdout + tested.stderr; writeFileSync(join(dest, 'test-output.txt'), output);
  assert.equal(tested.signal, null, 'must fail by assertion, not timeout/signal');
  assert.equal(tested.status, fails ? 1 : 0, output);
  if (pattern) assert.match(output, pattern);
  const row = { name: dest.split('/').at(-1), builds: true, expected_failure: fails, assertion_observed: fails, exit: tested.status, output: join(dest, 'test-output.txt') }; rows.push(row);
}
// Reproduce the review on copies of exactly its baseline and N1 mutant, with
// only the new regression tests overlaid. Neither reviewer directory is edited.
const old = copy('review-baseline', join(reviewer, 'repo'));
cpSync(join(repo, 'src/test/binding-answer-race.test.ts'), join(old, 'src/test/binding-answer-race.test.ts'));
run(old, ['binding-answer-race'], true, /cancelUI must include accepted|outcome_unknown/);
const n1 = copy('review-n1', join(reviewer, 'n1'));
for (const path of ['src/test/crash-matrix.test.ts', 'src/test/fixtures/crash-child.ts']) cpSync(join(repo, path), join(n1, path));
run(n1, ['crash-matrix', 'interaction-crash', 'invariants', 'fix-round'], true, /native effect (clear_queue|abort|stop):.*no_effect/);
// Re-run both reviewer probes from owned copies against the fixed runtime.
const fixed = copy('fixed'); run(fixed, ['binding-answer-race', 'interactions'], false);
for (const name of ['race', 'gate-race']) {
  const path = join(root, name + '.mjs');
  const source = readFileSync(join(reviewer, name + '.mjs'), 'utf8').replaceAll('/tmp/a0/review6/repo/', fixed + '/');
  writeFileSync(path, source);
  const result = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 30000 }); assert.equal(result.status, 0, result.stderr);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('review probe did not produce valid JSON'); }
  writeFileSync(join(root, name + '-result.json'), JSON.stringify(value, null, 2));
  if (name === 'race') { assert.equal(value.answer_state, 'outcome_unknown'); assert.ok(value.answer_stage < 3); assert.deepEqual(value.cancelled_during_rebind, ['native-q']); }
  else { assert.equal(value.gate_error, false); assert.equal(value.worker_status, 'ready'); assert.deepEqual(value.cancelled, ['appr']); }
  rows.push({ name: 'review-' + name + '-probe', result: 'pass', value });
}
const check = copy('missing-answer-recheck');
const file = 'src/interactions.ts', body = readFileSync(join(check, file), 'utf8');
const start = body.indexOf('      const fenceGeneration ='), end = body.indexOf('      if (response.stage === 3 && !response.consumed)', start);
assert.ok(start > 0 && end > start);
writeFileSync(join(check, file), body.slice(0, start) + '      const response = await l.host.answerUI(l.record.native_id, a, l.options);\n' + body.slice(end));
run(check, ['binding-answer-race'], true, /outcome_unknown|rejected/);
const cancel = copy('missing-accepted-cancellation');
replace(cancel, file, 'const ids = new Set([...legacy.map(r => r.native_id), ...[...this.live.values()].filter(l => l.record.worker_id === workerId).map(l => l.record.native_id)]);', 'const ids = new Set(legacy.map(r => r.native_id));');
run(cancel, ['binding-answer-race'], true, /cancelUI must include accepted/);
const fenced = copy('fenced-release-dispatched');
replace(fenced, file, '      writable();\n      let allowed = true;\n      try {\n        l.guard!();', '      let allowed = true;\n      try {\n        writable(); l.guard!();');
run(fenced, ['interactions'], true, /rejected/);
// Kill each control marker displacement independently, including the narrower
// move after clear_queue but before abort that the combined reviewer mutant masks.
for (const point of ['clear_queue', 'abort', 'stop']) {
  const dest = copy('dispatch-after-' + point), path = 'src/supervisor.ts';
  if (point === 'stop') {
    const effect = "      const gone = live.host ? await live.host.stop() : live.pid !== null ? await killGroup(live.pid, live.token) : live.worker.status !== 'cleanup_pending';";
    replace(dest, path, '      this.dispatchGuard();\n      this.receipts.dispatch(b.command_id, { worker_id: id });\n' + effect, effect + '\n      this.dispatchGuard();\n      this.receipts.dispatch(b.command_id, { worker_id: id });');
  } else {
    replace(dest, path, "      this.dispatchGuard(); this.receipts.dispatch(b.command_id, { worker_id: id });\n      this.dropPending(live, interrupt ? 'interrupt' : 'cancel');", "      this.dropPending(live, interrupt ? 'interrupt' : 'cancel');");
    const effect = point === 'abort' ? "      const result = await live.host.request({ type: 'abort' });" : "      await live.host.request({ type: 'clear_queue' }); // abort alone may continue Pi-owned queued input";
    replace(dest, path, effect, effect + '\n      this.dispatchGuard(); this.receipts.dispatch(b.command_id, { worker_id: id });');
  }
  run(dest, ['crash-matrix'], true, /native effect (clear_queue|abort|stop):.*no_effect/);
}
writeFileSync(join(root, 'summary.json'), JSON.stringify({ root, rows }, null, 2));
console.log(JSON.stringify({ root, rows }, null, 2));
