import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxLaunch } from '../sandbox.js';

const parent = { worker_id: 'p', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'gen' };
test('bwrap linked worktree status/add/commit writes only its branch namespace and shared objects', { skip: process.env.A0_TEST_BWRAP !== '1' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'a0s7-git-')), repo = join(base, 'repo'), root = join(base, 'child'); mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  try {
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'A0 fixture'); git(repo, 'config', 'user.email', 'a0@example.invalid');
    writeFileSync(join(repo, 'note'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const original = git(repo, 'rev-parse', 'HEAD'); git(repo, 'branch', 'unrelated'); git(repo, 'branch', 'a0-sibling/task');
    git(repo, 'worktree', 'add', '--lock', '-qb', 'a0-child/task', root, 'HEAD');
    writeFileSync(join(repo, 'outside'), 'NOT_VISIBLE');
    const script = `set -eu
      git status --porcelain
      printf 'child\\n' > note
      git add note
      git -c user.name='A0 fixture' -c user.email=a0@example.invalid commit -qm child
      git status --porcelain
      if git update-ref refs/heads/unrelated HEAD 2>/dev/null; then exit 81; fi
      if git update-ref refs/heads/a0-sibling/task HEAD 2>/dev/null; then exit 82; fi
      test ! -e ${join(repo, 'outside')}
      git rev-parse HEAD
    `;
    const launch = sandboxLaunch(root, '/bin/sh', ['-c', script], parent, 'child');
    const result = spawnSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'note'), 'utf8'), 'child\n');
    assert.equal(git(repo, 'rev-parse', 'unrelated'), original);
    assert.notEqual(git(root, 'rev-parse', 'HEAD'), original);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.deepEqual(git(repo, 'for-each-ref', '--format=%(refname)').split('\n').filter(x => x.startsWith('refs/heads/a0-child/')), ['refs/heads/a0-child/task']);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
