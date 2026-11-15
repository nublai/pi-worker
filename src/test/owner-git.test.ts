/** Owner-side Git (src/git-safe.ts) against a concurrent writer of the Git
 * pointers, and against global/system configuration. A sandboxed parent can
 * write its own `.git` (ordinary clone) and its children's admin dirs under
 * `.git/worktrees/`; these tests play that parent. Portable unless marked kernel. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, utimesSync } from 'node:fs';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGitPin, safeGit, safeGitRun, SAFE_GIT_CONFIG, type GitPin } from '../git-safe.js';
import { sandboxLaunch } from '../sandbox.js';

const cleanEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/** A repo, a linked worktree whose .gitattributes selects an `evil` filter and
 * diff driver (defined nowhere yet), a committed change and a dirty file. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0og-'))), repo = join(base, 'repo'), wt = join(base, 'wt'); mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv }).trim();
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'A0 fixture'); git(repo, 'config', 'user.email', 'a0@example.invalid');
  writeFileSync(join(repo, 'note'), 'base\n'); writeFileSync(join(repo, '.gitattributes'), '* diff=evil filter=evil\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'worktree', 'add', '-qb', 'a0-child/task', wt, 'HEAD');
  writeFileSync(join(wt, 'note'), 'head\n'); git(wt, 'commit', '-qam', 'head');
  const baseId = git(repo, 'rev-parse', 'HEAD'), headId = git(wt, 'rev-parse', 'HEAD');
  // Same size as the committed bytes, so status must compare content (clean filter).
  writeFileSync(join(wt, 'note'), 'dirt\n'); writeFileSync(join(repo, 'note'), 'dirt\n');
  const marker = join(base, 'payload-ran'), payload = join(base, 'payload.sh');
  writeFileSync(payload, `#!/bin/sh\necho "RAN $*" >> ${marker}\ncat\n`, { mode: 0o755 });
  const evil = `[filter "evil"]\n\tclean = ${payload}\n\tsmudge = ${payload}\n[diff "evil"]\n\tcommand = ${payload}\n\ttextconv = ${payload}\n`;
  return { base, repo, wt, git, baseId, headId, marker, payload, evil, admin: join(repo, '.git', 'worktrees', 'wt') };
}
type Fixture = ReturnType<typeof fixture>;
/** A decoy common dir: a copy of the real one whose config defines the drivers. */
function decoy(f: Fixture, where: string): string {
  execFileSync('cp', ['-a', join(f.repo, '.git'), where]);
  writeFileSync(join(where, 'config'), readFileSync(join(where, 'config'), 'utf8') + f.evil);
  return where;
}
const ran = (f: Fixture) => existsSync(f.marker) ? readFileSync(f.marker, 'utf8').trim().split('\n') : [];
/** Payload runs, summarised (count and first line) so a failure stays readable. */
const runs = (f: Fixture) => { const r = ran(f); return r.length ? `${r.length} run(s), first: ${r[0]}` : 'none'; };
/** The pre-fix owner argv, run once against a static plant: proves the fixture's payload is live. */
function oldHelperRuns(f: Fixture, gitDir: string, root: string, args: string[]): boolean {
  rmSync(f.marker, { force: true });
  spawnSync('git', ['-C', root, `--git-dir=${gitDir}`, `--work-tree=${root}`, ...SAFE_GIT_CONFIG, ...args], { env: cleanEnv });
  const live = existsSync(f.marker); rmSync(f.marker, { force: true }); return live;
}
const COMMANDS = (f: Fixture) => [['diff', '--binary', f.baseId, f.headId], ['diff', '--', 'note'], ['status', '--porcelain']];
/** Run each owner command `n` times while `writer` flips the pointer files. */
async function race(f: Fixture, root: string, pin: GitPin, writer: ChildProcess, n: number) {
  const tally = { passed: 0, refused: 0, other: [] as string[] };
  await new Promise(r => setTimeout(r, 150)); // let the writer start flipping
  try {
    for (const args of COMMANDS(f)) for (let i = 0; i < n; i++) {
      const t = new Date(Date.now() + i * 1000); utimesSync(join(root, 'note'), t, t); // stat-dirty every time
      try { safeGitRun(root, pin, args); tally.passed++; }
      catch (error) { const m = error instanceof Error ? error.message : String(error); if (/git_metadata_changed_since_launch|sandbox_git_/.test(m)) tally.refused++; else tally.other.push(m); }
    }
  } finally { writer.kill('SIGKILL'); await new Promise(r => writer.exitCode !== null || writer.signalCode !== null ? r(null) : writer.once('exit', r)); }
  return tally;
}
/** A same-UID writer that atomically flips `file` between two contents (or absent). */
const flipper = (file: string, a: string | null, b: string | null) => spawn(process.execPath, ['-e', `
const fs=require('fs');const [f,a,b]=JSON.parse(process.argv[1]);
for(let i=0;;i++){const v=i&1?a:b;if(v===null){try{fs.unlinkSync(f);}catch{}}else{fs.writeFileSync(f+'.flip',v);fs.renameSync(f+'.flip',f);}}`, JSON.stringify([file, a, b])], { stdio: 'ignore' });
const N = Number(process.env.A0_OWNER_GIT_RACE_N ?? 300);

test('owner Git: racing a child admin commondir against safeGit diff/status never runs a planted driver or filter', { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt); // launch time
    const original = readFileSync(join(f.admin, 'commondir'), 'utf8'), fake = decoy(f, join(f.repo, 'decoy')) + '\n';
    // Control: with the decoy planted statically, the pre-fix argv runs the payload.
    writeFileSync(join(f.admin, 'commondir'), fake);
    assert.equal(oldHelperRuns(f, f.admin, f.wt, ['diff', '--binary', f.baseId, f.headId]), true, 'fixture must be live: decoy driver runs under the old argv');
    writeFileSync(join(f.admin, 'commondir'), original);
    const tally = await race(f, f.wt, pin, flipper(join(f.admin, 'commondir'), original, fake), N);
    writeFileSync(join(f.admin, 'commondir'), original);
    assert.equal(runs(f), 'none', `owner ran the planted payload; tally ${JSON.stringify(tally)}`);
    assert.deepEqual(tally.other, []);
    // Non-vacuous: the writer really interleaved with the checks.
    assert.ok(tally.passed > 0 && tally.refused > 0, JSON.stringify(tally));
    assert.equal(safeGit(f.wt, pin, ['status', '--porcelain']), 'M note');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('owner Git: racing a planted commondir in an ordinary .git against safeGit diff/status never runs a planted driver or filter', { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.repo);
    const fake = decoy(f, join(f.base, 'decoy')) + '\n', commondir = join(f.repo, '.git', 'commondir');
    writeFileSync(commondir, fake);
    assert.equal(oldHelperRuns(f, join(f.repo, '.git'), f.repo, ['diff', '--', 'note']), true, 'fixture must be live');
    rmSync(commondir);
    const tally = await race(f, f.repo, pin, flipper(commondir, null, fake), N);
    rmSync(commondir, { force: true });
    assert.equal(runs(f), 'none', `owner ran the planted payload; tally ${JSON.stringify(tally)}`);
    assert.deepEqual(tally.other, []);
    assert.ok(tally.passed > 0 && tally.refused > 0, JSON.stringify(tally));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('owner Git: a repository config that defines a filter, diff driver, textconv or include is refused, not run', () => {
  const f = fixture();
  try {
    for (const [key, value] of [['filter.evil.clean', f.payload], ['filter.evil.process', f.payload], ['diff.evil.command', f.payload], ['diff.evil.textconv', f.payload], ['diff.external', f.payload], ['merge.evil.driver', f.payload], ['gpg.program', f.payload], ['alias.st', '!' + f.payload]] as const) {
      f.git(f.repo, 'config', key, value);
      for (const root of [f.wt, f.repo]) {
        const pin = readGitPin(root); // set before the pin: the pin alone cannot catch it
        for (const args of COMMANDS(f)) assert.throws(() => safeGitRun(root, pin, args), /git_config_executes_code/, `${key} via ${args[0]}`);
      }
      f.git(f.repo, 'config', '--unset', key);
    }
    assert.deepEqual(ran(f), []);
    // The fixture is live: plain Git with the same config runs the payload.
    f.git(f.repo, 'config', 'filter.evil.clean', f.payload);
    spawnSync('git', ['-C', f.wt, 'status', '--porcelain'], { env: cleanEnv });
    assert.notDeepEqual(ran(f), []);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('owner Git: ~/.gitconfig includes, XDG config/attributes and GIT_CONFIG_GLOBAL/SYSTEM are not honoured', () => {
  const f = fixture(), home = join(f.base, 'home'), keys = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_NOSYSTEM', 'GIT_EXTERNAL_DIFF'] as const;
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  writeFileSync(join(home, 'evil.cfg'), f.evil);
  writeFileSync(join(home, '.gitconfig'), `[include]\n\tpath = ${join(home, 'evil.cfg')}\n`);
  writeFileSync(join(home, '.config', 'git', 'config'), f.evil);
  writeFileSync(join(home, '.config', 'git', 'attributes'), '* diff=evil filter=evil\n');
  const pins = new Map([f.wt, f.repo].map(root => [root, readGitPin(root)]));
  const owner = () => { for (const [root, pin] of pins) for (const args of COMMANDS(f)) safeGitRun(root, pin, args); };
  const plain = () => { rmSync(f.marker, { force: true }); spawnSync('git', ['-C', f.wt, 'diff', '--', 'note'], { env: process.env }); const live = existsSync(f.marker); rmSync(f.marker, { force: true }); return live; };
  try {
    for (const k of keys) delete process.env[k];
    process.env.HOME = home; // ~/.gitconfig with an include, and ~/.config/git
    assert.equal(plain(), true, 'fixture must be live: plain Git honours ~/.gitconfig');
    owner(); assert.equal(runs(f), 'none', 'owner Git honoured ~/.gitconfig or XDG config');
    process.env.XDG_CONFIG_HOME = join(home, '.config'); process.env.GIT_CONFIG_GLOBAL = join(home, 'evil.cfg'); process.env.GIT_CONFIG_SYSTEM = join(home, 'evil.cfg');
    process.env.GIT_EXTERNAL_DIFF = f.payload;
    assert.equal(plain(), true);
    owner(); assert.equal(runs(f), 'none', 'owner Git honoured GIT_CONFIG_GLOBAL/SYSTEM or GIT_EXTERNAL_DIFF');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('owner Git: results match plain Git on an untouched checkout (snapshot is faithful)', () => {
  const f = fixture();
  try {
    const plain = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', env: cleanEnv }).trim();
    f.git(f.repo, 'tag', 'v1', f.baseId); f.git(f.repo, 'pack-refs', '--all'); f.git(f.repo, 'branch', 'loose', f.baseId);
    writeFileSync(join(f.repo, '.git', 'info', 'exclude'), 'ignored-*\n'); writeFileSync(join(f.wt, 'ignored-x'), 'x'); writeFileSync(join(f.wt, 'untracked'), 'u');
    for (const root of [f.wt, f.repo]) {
      const pin = readGitPin(root);
      for (const args of [['status', '--porcelain', '--branch'], ['rev-parse', 'HEAD', 'v1', 'loose', 'a0-child/task'], ['for-each-ref', '--format=%(refname) %(objectname)'], ['diff', '--binary', f.baseId, f.headId], ['log', '--format=%H %s', '-3'], ['symbolic-ref', 'HEAD']])
        assert.equal(safeGit(root, pin, args), plain(root, ...args), `${root} ${args.join(' ')}`);
      assert.equal(safeGitRun(root, pin, ['fsck', '--full', '--strict']).status, 0);
      assert.equal(safeGitRun(root, pin, ['config', '--get', 'credential.helper']).status, 1);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('owner Git: a racily-clean same-second, same-size edit is reported modified, as plain Git does (snapshot keeps the index mtime)', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a0og-racy-'))), repo = join(base, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...cleanEnv, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'A0 fixture'); git('config', 'user.email', 'a0@example.invalid');
    // Deterministic same-second case: compare only whole-second mtime and size
    // (no ctime, inode or nsec), and pin the file and index mtimes to one second.
    git('config', 'core.trustctime', 'false'); git('config', 'core.checkStat', 'minimal');
    const note = join(repo, 'note'), index = join(repo, '.git', 'index'), T = 1_000_000_000;
    writeFileSync(note, 'base\n'); utimesSync(note, T, T);
    git('add', 'note'); git('commit', '-qm', 'base');
    writeFileSync(note, 'dirt\n'); utimesSync(note, T, T); // same size, same recorded mtime
    utimesSync(index, T, T); // index written in the same second: the entry is racily clean
    const pin = readGitPin(repo);
    assert.equal(safeGit(repo, pin, ['status', '--porcelain']), 'M note', 'owner Git must not trust stat data of a racily-clean entry');
    assert.equal(git('status', '--porcelain'), 'M note', 'fixture: plain Git sees the racy edit');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- kernel (real bwrap): the writer is a sandboxed parent ----
const kernel = { skip: process.env.A0_TEST_BWRAP !== '1' };
const parent = { worker_id: 'p', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'gen' };

test('kernel owner Git: a bwrap parent racing its child admin commondir cannot make owner safeGit run a planted driver', { ...kernel, timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt);
    const original = readFileSync(join(f.admin, 'commondir'), 'utf8').trim(), fake = decoy(f, join(f.repo, 'decoy'));
    const c = join(f.admin, 'commondir');
    // Runs in the parent's own sandbox (root = its ordinary clone), for at most 120 s.
    const script = `end=$(( $(date +%s) + 120 ))
      while [ "$(date +%s)" -lt "$end" ]; do
        printf '%s\\n' '${fake}' > ${c}.flip && mv -f ${c}.flip ${c} || exit 70
        printf '%s\\n' '${original}' > ${c}.flip && mv -f ${c}.flip ${c} || exit 71
      done`;
    const launch = sandboxLaunch(f.repo, '/bin/sh', ['-c', script], parent, 'child');
    const writer = spawn(launch.command, launch.args, { env: launch.env, stdio: ['ignore', 'ignore', 'ignore', 'ignore', ...launch.fds] });
    launch.close();
    const tally = await race(f, f.wt, pin, writer, Math.max(50, Math.floor(N / 3)));
    writeFileSync(c, original + '\n');
    assert.equal(runs(f), 'none', `owner ran the planted payload; tally ${JSON.stringify(tally)}`);
    assert.deepEqual(tally.other, []);
    assert.ok(tally.passed > 0 && tally.refused > 0, `sandboxed writer must interleave: ${JSON.stringify(tally)}`);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
