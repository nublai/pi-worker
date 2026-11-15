// Independent one-at-a-time mutants in disposable scratch; never edit the checkout.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync('/tmp/a0s3/mutations-'); const source = process.cwd(); const rows = [];
const mutants = [
  { id: 'deadline', file: 'src/interactions.ts', tests: ['interactions'], changes: [["if (this.now() >= r.deadline) throw new Refusal('interaction_deadline_passed');", '/* mutant: no validation deadline */'], ["if (this.now() >= l.record.deadline) throw new Refusal('interaction_deadline_passed');", '/* mutant: no dispatch deadline */']] },
  { id: 'dispatch_order', file: 'src/interactions.ts', tests: ['interaction-crash'], changes: [["this.receipts.dispatch(a.command_id, { answer_stage: 1 });", '/* mutant: effect without dispatch marker */']] },
  { id: 'answer_hash_privacy', file: 'src/interactions.ts', tests: ['interactions'], changes: [["'interactions.answer_if_current', { ...metadata, worker_id: worker.worker_id }", "'interactions.answer_if_current', { ...a, worker_id: worker.worker_id }"]] },
  { id: 'first_answer_wins', file: 'src/interactions.ts', tests: ['interactions'], changes: [["if (r.status !== 'pending') throw new Refusal('interaction_already_answered');", '/* mutant: allow second winner */']] },
  { id: 'rpc_false_stage3', file: 'src/host.ts', tests: ['host'], changes: [["return { stage: 2 };", 'return { stage: 3, consumed: true };']] },
  { id: 'release_grant_check', file: 'src/interactions.ts', tests: ['interactions'], changes: [["writable(); l.guard!();", 'writable(); /* mutant: no release grant check */']] },
];
for (const mutant of mutants) {
  const dir = join(root, mutant.id); mkdirSync(dir);
  for (const path of ['src', 'openapi.json', 'tsconfig.json', 'package.json']) cpSync(join(source, path), join(dir, path), { recursive: true });
  symlinkSync(join(source, 'node_modules'), join(dir, 'node_modules'));
  const file = join(dir, mutant.file); let text = readFileSync(file, 'utf8');
  for (const [before, after] of mutant.changes) { assert.equal(text.split(before).length - 1, 1, mutant.id + ' mutation site must be unique'); text = text.replace(before, after); }
  writeFileSync(file, text);
  const build = spawnSync(process.execPath, [join(source, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: dir, encoding: 'utf8', timeout: 60000 }); assert.equal(build.status, 0, build.stdout + build.stderr);
  const test = spawnSync(process.execPath, ['--test', ...mutant.tests.map(t => 'dist/test/' + t + '.test.js')], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, TMPDIR: '/tmp/a0s3', A0_CRASH_AT: '', A0_CRASH_INDEX: '', A0_CRASH_EFFECT: '' } });
  writeFileSync(join(dir, 'test.txt'), test.stdout + test.stderr); assert.notEqual(test.status, 0, mutant.id + ' SURVIVED'); assert.equal(test.signal, null, 'a timeout/signal is not a killing assertion');
  const row = { mutant: mutant.id, result: 'killed_by_assertion', test_exit: test.status }; rows.push(row); console.log(JSON.stringify(row));
}
writeFileSync(join(root, 'summary.json'), JSON.stringify({ root, rows }, null, 2) + '\n'); console.log(JSON.stringify({ complete: true, root }));
