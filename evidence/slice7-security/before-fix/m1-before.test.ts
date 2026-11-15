/** Cross-version probe: planted core.fsmonitor vs the PRE-FIX owner check (artifactSubject). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactSubject } from '../artifact.js';
function linkedRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0sf-git-'))), repo = join(base, 'repo'), wt = join(base, 'wt'); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'A0 fixture'); git(repo, 'config', 'user.email', 'a0@example.invalid');
  writeFileSync(join(repo, 'note'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'worktree', 'add', '-qb', 'a0-child/task', wt, 'HEAD');
  const marker = join(base, 'fsmonitor-ran'), payload = join(base, 'payload.sh');
  writeFileSync(payload, `#!/bin/sh\necho RAN >> ${marker}\n`, { mode: 0o755 });
  return { base, repo, wt, git, marker, payload, admin: join(repo, '.git', 'worktrees', 'wt') };
}
/** A decoy common dir with a core.fsmonitor payload, as a sandboxed child could write. */
function decoy(r: ReturnType<typeof linkedRepo>, where: string): string {
  execFileSync('cp', ['-a', join(r.repo, '.git'), where]);
  execFileSync('git', ['--git-dir', where, 'config', 'core.fsmonitor', r.payload]);
  return where;
}

test('M1 before: a planted core.fsmonitor never runs from the owner checks', () => {
  const r = linkedRepo();
  try {
    const base = r.git(r.repo, 'rev-parse', 'HEAD');
    void readFileSync;
    writeFileSync(join(r.admin, 'commondir'), decoy(r, join(r.wt, 'decoy')) + '\n');
    try { artifactSubject(r.wt, 'HEAD', base); } catch { /* refusal is fine; execution is not */ }
    // The pre-fix owner audit's exact call (evidence/slice7/audit.mjs:32).
    try { execFileSync('git', ['-C', r.wt, 'status', '--porcelain'], { encoding: 'utf8' }); } catch { /* ditto */ }
    assert.equal(existsSync(r.marker), false, 'fsmonitor payload ran from an owner-side Git command');
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});
