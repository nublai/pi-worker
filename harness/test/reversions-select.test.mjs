// Tests for `harness/lib/reversions.mjs --changed <base> --list`, the selection CI's reversion-groups job uses. Runs
// in a throwaway git repo holding a copy of the runner and the real manifest and diffs; no reversion runs.
//   node --test harness/test/reversions-select.test.mjs
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
const target = name =>
  manifest.groups[name].diffs
    .flatMap(d => readFileSync(join(repo, relDir, d), 'utf8').split('\n').filter(l => l.startsWith('+++ b/')))
    .map(l => l.slice(6))[0];

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-select-'));
  const sh = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, 'git failed');
    return r.stdout;
  };
  mkdirSync(join(dir, 'harness', 'lib'), { recursive: true });
  cpSync(join(repo, 'harness', 'lib', 'reversions.mjs'), join(dir, 'harness', 'lib', 'reversions.mjs'));
  cpSync(join(repo, relDir), join(dir, relDir), { recursive: true });
  for (const f of ['package.json', 'tools/node-test.mjs']) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '{}\n');
  }
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'a@b.c');
  sh('config', 'user.name', 'x');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  const change = (file, text = 'x\n') => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    sh('add', '-A');
    sh('commit', '-q', '-m', `change ${file}`);
  };
  const list = (...extra) => {
    const r = spawnSync(process.execPath, [join(dir, 'harness', 'lib', 'reversions.mjs'), '--changed', 'main', '--list', ...extra], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status: r.status, lines: r.stdout.split('\n').filter(Boolean), stderr: r.stderr };
  };
  sh('checkout', '-q', '-b', 'work');
  return { dir, change, list, sh };
};

test('--changed --list: no change selects nothing and prints nothing', () => {
  const f = fixture();
  try {
    const r = f.list();
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, []);
    assert.match(r.stderr, /groups: none/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--changed --list: a file a group patches selects that group only', () => {
  const f = fixture();
  try {
    const name = names[0];
    const file = target(name);
    f.change(file, `${readFileSync(join(repo, file), 'utf8')}\n// touched\n`);
    const r = f.list();
    assert.equal(r.status, 0);
    assert.ok(r.lines.includes(name), 'the owning group is selected');
    assert.ok(r.lines.every(g => names.includes(g)));
    assert.ok(r.lines.length < names.length, 'not every group');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--changed --list: the manifest, the runner and package.json select every group', () => {
  for (const file of [join(relDir, 'manifest.json'), 'harness/lib/reversions.mjs', 'package.json']) {
    const f = fixture();
    try {
      const text = file.endsWith('.json') ? readFileSync(join(f.dir, file), 'utf8').replace(/\s*$/, '\n\n') : `${readFileSync(join(f.dir, file), 'utf8')}\n//\n`;
      f.change(file, text);
      assert.deepEqual(f.list().lines, names, file);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test('--changed --list: an unrelated file selects nothing', () => {
  const f = fixture();
  try {
    f.change('docs/unrelated.md', 'hello\n');
    const r = f.list();
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--changed --list: an unknown base is an error, not an empty selection', () => {
  const f = fixture();
  try {
    const r = spawnSync(process.execPath, [join(f.dir, 'harness', 'lib', 'reversions.mjs'), '--changed', 'nope', '--list'], { cwd: f.dir, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--list alone still prints every group', () => {
  const r = spawnSync(process.execPath, [join(repo, 'harness', 'lib', 'reversions.mjs'), '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.split('\n').filter(Boolean), names);
});
