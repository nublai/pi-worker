// Reversion runner by guard group (plan sections 10 and 11): reads packages/worker/test/reversions/manifest.json and
// runs tools/reversions.mjs for each named group, which applies each diff, requires a named test to FAIL by
// assertion, and reverts it. Run on a tree with no tracked changes.
//   node harness/lib/reversions.mjs <group>... | --group <name> ...   named groups (CI runs one per matrix job)
//   node harness/lib/reversions.mjs --all                             every group (the full set)
//   node harness/lib/reversions.mjs --changed <base>                  only groups a diff against <base> touches
//   node harness/lib/reversions.mjs --list                            every group name, one per line
//   node harness/lib/reversions.mjs --changed <base> --list           the selected group names, one per line (empty
//                                                                     when none), nothing is run; for CI's matrix
// --changed selects a group when a file changed since the merge base with <base> (commits, plus any uncommitted or
// untracked files, though the runner itself needs those committed first) is a
// file one of the group's diffs patches, or is one of the group's diff files. A change to the runner, the manifest,
// tools/node-test.mjs, package manifests, lockfile, tsconfig or .node-version selects every group. It does not
// follow imports, so a file no reversion patches selects nothing: CI runs the full set
// on the `full-reversions` label and nightly.
// Exit 0 only when every selected diff is caught by a named failing test; each group's caught/total goes to stderr.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const rel = ['packages', 'worker', 'test', 'reversions'];
const dir = join(root, ...rel);
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const all = Object.keys(manifest.groups);
const args = process.argv.slice(2);
const usage = msg => {
  console.error(`${msg ? `${msg}\n` : ''}usage: reversions.mjs <group>... | --group <name>... | --all | --changed <base> [--list] | --list (groups: ${all.join(', ')})`);
  process.exit(2);
};
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
const diffTargets = group =>
  group.diffs.flatMap(d =>
    readFileSync(join(dir, d), 'utf8')
      .split('\n')
      .filter(l => l.startsWith('+++ b/'))
      .map(l => l.slice(6)),
  );

let groups = [];
let all_ = false;
let changedBase;
let listOnly = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--list') listOnly = true;
  else if (a === '--all') all_ = true;
  else if (a === '--group') {
    if (!args[i + 1]) usage('--group needs a name');
    groups.push(args[++i]);
  } else if (a === '--changed') {
    if (!args[i + 1]) usage('--changed needs a base ref');
    changedBase = args[++i];
  } else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else groups.push(a);
}
if (listOnly && changedBase === undefined) {
  console.log(all.join('\n'));
  process.exit(0);
}
if (all_) groups = all;
if (changedBase !== undefined) {
  const mb = git('merge-base', changedBase, 'HEAD');
  if (mb.status !== 0) usage(`no merge base with ${changedBase}`);
  const tracked = git('diff', '--name-only', mb.stdout.trim());
  const untracked = git('ls-files', '--others', '--exclude-standard');
  if (tracked.status !== 0 || untracked.status !== 0) usage('git diff failed');
  const files = new Set([...tracked.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean));
  const infra = f =>
    /^(tools\/(reversions|node-test)\.mjs|harness\/lib\/reversions\.mjs|package(-lock)?\.json|\.node-version|tsconfig[^/]*\.json)$/.test(f) ||
    /^packages\/[^/]+\/(package\.json|tsconfig[^/]*\.json)$/.test(f) ||
    f === [...rel, 'manifest.json'].join('/');
  const everything = [...files].some(infra);
  const picked = all.filter(name => {
    const group = manifest.groups[name];
    const own = new Set([...diffTargets(group), ...group.diffs.map(d => [...rel, d].join('/'))]);
    return everything || [...files].some(f => own.has(f));
  });
  console.error(`changed vs ${changedBase}: ${files.size} files${everything ? ' (runner/manifest/toolchain change: all groups)' : ''}; groups: ${picked.join(', ') || 'none'}`);
  if (listOnly) {
    if (picked.length) console.log(picked.join('\n'));
    process.exit(0);
  }
  groups = [...new Set([...groups, ...picked])];
  if (groups.length === 0) {
    console.error('no affected reversion groups; CI runs the full set');
    process.exit(0);
  }
}
const unknown = groups.filter(g => !manifest.groups[g]);
if (groups.length === 0 || unknown.length) usage(unknown.length ? `unknown: ${unknown.join(', ')}` : 'no group given');
const report = [];
let ok = true;
for (const name of groups) {
  const group = manifest.groups[name];
  const diffs = group.diffs.map(d => join('packages', 'worker', 'test', 'reversions', d));
  const out = spawnSync(process.execPath, [join(root, 'tools', 'reversions.mjs'), '--command', group.command, ...diffs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) ok = false;
  let result;
  try {
    result = JSON.parse(out.stdout);
  } catch {
    result = { error: 'runner_failed', status: out.status, stderr: out.stderr.slice(-2000) };
  }
  report.push({ group: name, ...result });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
let caught = 0;
let total = 0;
for (const r of report) {
  const rs = r.results ?? [];
  const c = rs.filter(x => x.result === 'caught').length;
  caught += c;
  total += rs.length || 1;
  const bad = rs.filter(x => x.result !== 'caught').map(x => `${x.diff} ${x.result}`);
  console.error(`${r.group}: ${c}/${rs.length} caught${r.error ? ` (${r.error})` : ''}${bad.length ? `; NOT OK: ${bad.join('; ')}` : ''}`);
}
console.error(`reversions: ${caught}/${total} caught${ok ? '' : ' - FAILED'}`);
process.exit(ok ? 0 : 1);
