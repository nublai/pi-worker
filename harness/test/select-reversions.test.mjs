// Tests for harness/ci/select-reversions.sh, the selection ci.yml's reversion-groups job runs, in throwaway git
// repos with a copy of the runner, the real manifest and diffs. No reversion runs.
//   node --test harness/test/select-reversions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const relDir = join('packages', 'worker', 'test', 'reversions');
const manifest = JSON.parse(readFileSync(join(repo, relDir, 'manifest.json'), 'utf8'));
const names = Object.keys(manifest.groups);
const owned = names[0];
const ownedFile = manifest.groups[owned].diffs
  .flatMap(d => readFileSync(join(repo, relDir, d), 'utf8').split('\n').filter(l => l.startsWith('+++ b/')))
  .map(l => l.slice(6))[0];

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sel-rev-'));
  const sh = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, 'git failed');
    return r.stdout.trim();
  };
  mkdirSync(join(dir, 'harness', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'harness', 'ci'), { recursive: true });
  cpSync(join(repo, 'harness', 'lib', 'reversions.mjs'), join(dir, 'harness', 'lib', 'reversions.mjs'));
  cpSync(join(repo, 'harness', 'ci', 'select-reversions.sh'), join(dir, 'harness', 'ci', 'select-reversions.sh'));
  cpSync(join(repo, relDir), join(dir, relDir), { recursive: true });
  for (const f of ['package.json', 'tools/node-test.mjs']) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '{}\n');
  }
  mkdirSync(dirname(join(dir, ownedFile)), { recursive: true });
  writeFileSync(join(dir, ownedFile), 'one\n');
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'a@b.c');
  sh('config', 'user.name', 'x');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  const commit = (text, msg) => {
    writeFileSync(join(dir, ownedFile), text);
    sh('commit', '-q', '-am', msg);
    return sh('rev-parse', 'HEAD');
  };
  const select = env => {
    const r = spawnSync('bash', [join(dir, 'harness', 'ci', 'select-reversions.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, EVENT: 'push', BASE_REF: 'main', FULL_LABEL: 'false', ...env },
    });
    assert.equal(r.status, 0, 'selection script failed');
    const out = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { groups: JSON.parse(out.groups), mode: out.mode };
  };
  return { dir, sh, commit, select };
};
const withFixture = fn => () => {
  const f = fixture();
  try {
    fn(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
};

test('push: a fast-forward selects only the changed groups; an untouched one selects none', withFixture(f => {
  const before = f.sh('rev-parse', 'HEAD');
  f.commit('two\n', 'edit patched');
  const r = f.select({ BEFORE: before });
  assert.ok(r.groups.includes(owned) && r.groups.length < names.length);
  assert.match(r.mode, /changed since/);
  const mid = f.sh('rev-parse', 'HEAD');
  writeFileSync(join(f.dir, 'note.md'), 'x\n');
  f.sh('add', '-A');
  f.sh('commit', '-q', '-m', 'unrelated');
  assert.deepEqual(f.select({ BEFORE: mid }).groups, []);
}));

test('push: a new ref (zero before), an empty before, or an unknown commit selects every group', withFixture(f => {
  for (const BEFORE of ['0000000000000000000000000000000000000000', '', '1234567890123456789012345678901234567890']) {
    const r = f.select({ BEFORE });
    assert.deepEqual(r.groups, names, `before ${BEFORE || '(empty)'}`);
    assert.match(r.mode, /^all/);
  }
}));

test('push: a rewind whose old head is still reachable selects every group', withFixture(f => {
  const parent = f.sh('rev-parse', 'HEAD');
  const old = f.commit('two\n', 'edit patched');
  f.sh('branch', 'keep', old);
  f.sh('checkout', '-q', '--detach', parent);
  assert.deepEqual(f.select({ BEFORE: old }).groups, names);
}));

test('push: a divergent force push selects every group', withFixture(f => {
  const base = f.sh('rev-parse', 'HEAD');
  const old = f.commit('two\n', 'edit patched');
  f.sh('branch', 'keep', old);
  f.sh('checkout', '-q', '--detach', base);
  writeFileSync(join(f.dir, 'other.md'), 'y\n');
  f.sh('add', '-A');
  f.sh('commit', '-q', '-m', 'other');
  assert.deepEqual(f.select({ BEFORE: old }).groups, names);
}));

test('pull_request, schedule and dispatch: label and event pick every group, otherwise the diff against origin/<base>', withFixture(f => {
  f.sh('update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.sh('checkout', '-q', '-b', 'pr');
  assert.deepEqual(f.select({ EVENT: 'pull_request' }).groups, []);
  assert.deepEqual(f.select({ EVENT: 'pull_request', FULL_LABEL: 'true' }).groups, names);
  assert.deepEqual(f.select({ EVENT: 'schedule' }).groups, names);
  assert.deepEqual(f.select({ EVENT: 'workflow_dispatch' }).groups, names);
  f.commit('three\n', 'edit patched');
  const r = f.select({ EVENT: 'pull_request' });
  assert.ok(r.groups.includes(owned) && r.groups.length < names.length);
}));
