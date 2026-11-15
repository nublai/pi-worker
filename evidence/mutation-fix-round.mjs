// Authored fix-round driver. Recreates the review's nine semantic mutations on
// isolated copies of THIS checkout; never runs or modifies /tmp/a0/mut scripts.
// Run from repo root: node evidence/mutation-fix-round.mjs
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const source = process.cwd();
mkdirSync('/tmp/a0', { recursive: true });
const root = mkdtempSync('/tmp/a0/fix-mutations-');
const mutations = [
  ['M1', 'src/supervisor.ts', "    if (receipt.state === 'outcome_unknown' && receipt.worker_id) this.fence(this.require(id), p.command_id);", ''],
  ['M2', 'src/supervisor.ts', "      this.receipts.dispatch(p.command_id, { worker_id: id, execution_id: w.execution.execution_id });\n      const response = await live.host!.request({ type: 'prompt', message: p.message });", "      const response = await live.host!.request({ type: 'prompt', message: p.message });\n      this.receipts.dispatch(p.command_id, { worker_id: id, execution_id: w.execution.execution_id });"],
  ['M3', 'src/journal.ts', '      fsyncSync(this.fd);\n      this.records.push(record);', '      this.records.push(record);'],
  ['M4', 'src/server.ts', '          if (res.writableLength > 1048576) res.destroy();', ''],
  ['M5', 'src/server.ts', "  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) throw new Error('socket directory must be owned, non-symlink 0700');", ''],
  ['M6', 'src/supervisor.ts', '    if (JSON.stringify([live.worker.fence, live.worker.execution, live.worker.foreground]) !== before) this.persist(live); // Fence before any unknown reply.', '    // MUTATION: fence is memory-only.'],
  ['M7', 'src/supervisor.ts', "    if (event.type === 'agent_settled') {", "    if (event.type === 'agent_end') {"],
  ['M8', 'src/supervisor.ts', "    if (w.worker_epoch !== b.worker_epoch || w.session_id !== b.session_id || w.binding_revision !== b.binding_revision) throw new Refusal('stale_binding');", ''],
  ['M9', 'src/supervisor.ts', '      this.receipts.unknown(id); this.fence(live, id);', ''],
];
const results = [];
for (const [id, file, before, after] of [['baseline', '', '', ''], ...mutations]) {
  const dir = join(root, id); mkdirSync(dir);
  for (const file of ['src', 'package.json', 'package-lock.json', 'tsconfig.json', 'openapi.json']) cpSync(join(source, file), join(dir, file), { recursive: true });
  symlinkSync(resolve(source, 'node_modules'), join(dir, 'node_modules'));
  if (id !== 'baseline') {
    const path = join(dir, file), content = readFileSync(path, 'utf8');
    if (content.split(before).length !== 2) throw new Error(`${id}: expected exactly one mutation site`);
    writeFileSync(path, content.replace(before, after));
    writeFileSync(join(dir, 'mutation.json'), JSON.stringify({ id, file, before, after }, null, 2) + '\n');
  }
  const run = spawnSync('npm', ['test', '--cache', '/tmp/a0/npm-cache'], { cwd: dir, env: { ...process.env, TMPDIR: '/tmp/a0', NO_COLOR: '1' }, encoding: 'utf8', timeout: 60000 });
  const output = (run.stdout ?? '') + (run.stderr ?? ''); writeFileSync(join(dir, 'result.txt'), output);
  const failures = [...new Set(output.split('\n').filter(line => /^(?:✖|not ok)/.test(line)))];
  const result = { id, result: run.error ? 'runner_error' : run.status === 0 ? (id === 'baseline' ? 'pass' : 'survives') : 'killed', status: run.status, failures };
  results.push(result); console.log(JSON.stringify(result));
}
writeFileSync(join(root, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
console.log('artifacts=' + root);
if (results[0].result !== 'pass' || results.some(r => r.result === 'runner_error') || results.filter(r => !['baseline', 'M3'].includes(r.id)).some(r => r.result !== 'killed')) process.exitCode = 1;
