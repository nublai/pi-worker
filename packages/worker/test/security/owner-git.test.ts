/**
 * Owner Git (P2-6), ported from A0 `src/test/owner-git.test.ts`, `gate1-artifact.test.ts` and the `security-fix.test.ts`
 * M1 owner-Git cases, plus the two slice 7 regressions (a snapshot made through a symlinked `TMPDIR`, a pinned
 * `protocol.ext.allow`) and the new guards: the snapshot's real path, the command allowlist and `credential.helper`.
 *
 * A same-UID writer of the Git pointers plays the sandboxed agent; the cases named `kernel` run it in real bwrap
 * (`harness/ci/kernel.sh -- owner-git`, PIW_TEST_KERNEL=1); elsewhere they skip. Where a writer must act at the worst
 * moment (after the owner's checks, before Git reads), a `git` wrapper first on owner Git's PATH plants it, so the case
 * is deterministic, not a race.
 *
 * Every Git command and every environment here is synthetic (never process.env), so no credential can reach Git, an
 * argv or a message; assertion messages name cases, never argv or environment values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../../src/b2/errors.js';
import { childEnv } from '../../src/host/host.js';
import { artifactSubject } from '../../src/owner-git/artifact.js';
import { OWNER_GIT_COMMANDS, readGitPin, SAFE_GIT_CONFIG, safeGit, safeGitRun, type GitPin, type OwnerGit } from '../../src/owner-git/git-safe.js';
import { locateBwrap, sandboxEnv, sandboxLaunch } from '../../src/sandbox/sandbox.js';
import { privateTmp } from '../helpers.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 in a delegated user service with bwrap (harness/ci/kernel.sh)';
const SYS_PATH = '/usr/bin:/bin';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: { PATH: SYS_PATH } }).trim();
const N = Number(process.env.PIW_OWNER_GIT_RACE_N ?? 300);

/** Git with no global or system configuration and a synthetic environment. */
const gitEnv = (home: string) => ({ PATH: SYS_PATH, HOME: home, LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
/** `path` is `dir` or below it. */
const within = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * A0's fixture: a repo, a linked worktree whose .gitattributes selects an `evil` filter and diff driver (defined nowhere
 * yet), a committed change and a dirty file. The owner's state (snapshots) is its own private directory.
 */
function fixture() {
  const tmp = privateTmp();
  const stateTmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const repo = join(base, 'repo');
  const wt = join(base, 'wt');
  mkdirSync(repo);
  const env = gitEnv(base);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'A0 fixture');
  git(repo, 'config', 'user.email', 'a0@example.invalid');
  writeFileSync(join(repo, 'note'), 'base\n');
  writeFileSync(join(repo, '.gitattributes'), '* diff=evil filter=evil\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'worktree', 'add', '-qb', 'a0-child/task', wt, 'HEAD');
  writeFileSync(join(wt, 'note'), 'head\n');
  git(wt, 'commit', '-qam', 'head');
  const baseId = git(repo, 'rev-parse', 'HEAD');
  const headId = git(wt, 'rev-parse', 'HEAD');
  // Same size as the committed bytes, so status must compare content (clean filter).
  writeFileSync(join(wt, 'note'), 'dirt\n');
  writeFileSync(join(repo, 'note'), 'dirt\n');
  const marker = join(base, 'payload-ran');
  const payload = join(base, 'payload.sh');
  writeFileSync(payload, `#!/bin/sh\necho RAN >> ${marker}\ncat\n`, { mode: 0o755 });
  const evil = `[filter "evil"]\n\tclean = ${payload}\n\tsmudge = ${payload}\n[diff "evil"]\n\tcommand = ${payload}\n\ttextconv = ${payload}\n`;
  const state = realpathSync(stateTmp.dir);
  const owner: OwnerGit = { stateDir: state, env: { PATH: SYS_PATH, LANG: 'C' } };
  const cleanup = () => {
    tmp.cleanup();
    stateTmp.cleanup();
  };
  return { base, repo, wt, git, env, baseId, headId, marker, payload, evil, state, owner, admin: join(repo, '.git', 'worktrees', 'wt'), cleanup };
}
type Fixture = ReturnType<typeof fixture>;

/** A decoy common dir: a copy of the real one whose config defines the drivers. */
function decoy(f: Fixture, where: string): string {
  execFileSync('cp', ['-a', join(f.repo, '.git'), where], { env: { PATH: SYS_PATH } });
  writeFileSync(join(where, 'config'), readFileSync(join(where, 'config'), 'utf8') + f.evil);
  return where;
}
const ran = (f: Fixture) => (existsSync(f.marker) ? readFileSync(f.marker, 'utf8').trim().split('\n') : []);
/** Payload runs, counted. */
const runs = (f: Fixture) => {
  const r = ran(f);
  return r.length ? `${r.length} run(s)` : 'none';
};
/** The pre-fix owner argv, run once against a static plant: proves the fixture's payload is live. */
function oldHelperRuns(f: Fixture, gitDir: string, root: string, args: string[]): boolean {
  rmSync(f.marker, { force: true });
  spawnSync('git', ['-C', root, `--git-dir=${gitDir}`, `--work-tree=${root}`, ...SAFE_GIT_CONFIG, ...args], { env: f.env, stdio: 'ignore' });
  const live = existsSync(f.marker);
  rmSync(f.marker, { force: true });
  return live;
}
const COMMANDS = (f: Fixture) => [
  ['diff', '--binary', f.baseId, f.headId],
  ['diff', '--', 'note'],
  ['status', '--porcelain'],
];
const snapshots = (f: Fixture) => join(f.state, 'git-snapshots');
const leftovers = (f: Fixture) => (existsSync(snapshots(f)) ? readdirSync(snapshots(f)) : []);

/** Run each owner command `n` times while `writer` flips the pointer files. */
async function race(f: Fixture, root: string, pin: GitPin, writer: ChildProcess, n: number) {
  const tally = { passed: 0, refused: 0, other: [] as string[] };
  await new Promise(r => setTimeout(r, 150)); // let the writer start flipping
  try {
    for (const args of COMMANDS(f))
      for (let i = 0; i < n; i++) {
        const t = new Date(Date.now() + i * 1000);
        utimesSync(join(root, 'note'), t, t); // stat-dirty every time
        try {
          safeGitRun(f.owner, root, pin, args);
          tally.passed++;
        } catch (error) {
          const m = error instanceof Error ? error.message : String(error);
          if (/git_metadata_changed_since_launch|sandbox_git_/.test(m)) tally.refused++;
          else tally.other.push(m);
        }
      }
  } finally {
    writer.kill('SIGKILL');
    await new Promise(r => (writer.exitCode !== null || writer.signalCode !== null ? r(null) : writer.once('exit', r)));
  }
  return tally;
}
/** A same-UID writer that atomically flips `file` between two contents (or absent). */
const flipper = (file: string, a: string | null, b: string | null) =>
  spawn(
    process.execPath,
    [
      '-e',
      `
const fs=require('fs');const [f,a,b]=JSON.parse(process.argv[1]);
for(let i=0;;i++){const v=i&1?a:b;if(v===null){try{fs.unlinkSync(f);}catch{}}else{fs.writeFileSync(f+'.flip',v);fs.renameSync(f+'.flip',f);}}`,
      JSON.stringify([file, a, b]),
    ],
    { stdio: 'ignore', env: { PATH: SYS_PATH } },
  );

/**
 * A `git` first on owner Git's PATH that runs `plant` (sh, with `$d` the `--git-dir` it was given) just before the real
 * Git: a writer acting after every owner check. Returns the owner with that PATH.
 */
function wrapGit(f: Fixture, plant: string): OwnerGit {
  const dir = join(f.base, 'wrap');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nd=\nfor a in "$@"; do case "$a" in --git-dir=*) d="\${a#--git-dir=}" ;; esac; done\nif [ -n "$d" ]; then\n${plant}\nfi\nexec ${REAL_GIT} "$@"\n`, { mode: 0o755 });
  return { stateDir: f.owner.stateDir, env: { PATH: `${dir}:${SYS_PATH}`, LANG: 'C' } };
}

/**
 * The agent's write where it can: records the real path of each `--git-dir` Git is given, and when that lies in the
 * worktree (agent-writable), appends the evil drivers to its config.
 */
function plantInCheckout(f: Fixture): { owner: OwnerGit; gitDirs: () => string[] } {
  const log = join(f.base, 'git-dirs.log');
  const evil = join(f.base, 'evil.cfg');
  writeFileSync(evil, f.evil);
  const owner = wrapGit(f, `r=$(realpath "$d"); echo "$r" >> ${log}\ncase "$r" in ${f.wt}/*) cat ${evil} >> "$d/config" ;; esac`);
  return { owner, gitDirs: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

/** A typed refusal before any effect: `code` (a prefix for `code: detail`), HTTP 409, `no_effect`. */
const typed = (code: RegExp) => (error: unknown) => error instanceof Refusal && code.test(error.message) && error.status === 409 && error.effect === 'no_effect';

// ---- ported from A0 owner-git.test.ts ----

test('owner Git: racing a child admin commondir against safeGit diff/status never runs a planted driver or filter', { timeout: 300_000 }, async () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt); // launch time
    const original = readFileSync(join(f.admin, 'commondir'), 'utf8');
    const fake = `${decoy(f, join(f.repo, 'decoy'))}\n`;
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
    assert.equal(safeGit(f.owner, f.wt, pin, ['status', '--porcelain']), 'M note');
    assert.deepEqual(leftovers(f), [], 'every snapshot is removed');
  } finally {
    f.cleanup();
  }
});

test('owner Git: an ordinary checkout root refuses; a commondir planted in the repository .git never redirects a linked worktree', { timeout: 300_000 }, async () => {
  const f = fixture();
  try {
    // A0 pinned and ran owner Git on the ordinary root; an ordinary root refuses now (P2-5), before any Git runs.
    assert.throws(() => readGitPin(f.repo), typed(/^sandbox_git_ordinary_checkout_refused$/));
    const pin = readGitPin(f.wt);
    const fake = `${decoy(f, join(f.base, 'decoy'))}\n`;
    const commondir = join(f.repo, '.git', 'commondir');
    writeFileSync(commondir, fake);
    assert.equal(oldHelperRuns(f, join(f.repo, '.git'), f.repo, ['diff', '--', 'note']), true, 'fixture must be live');
    rmSync(commondir);
    const tally = await race(f, f.wt, pin, flipper(commondir, null, fake), N);
    rmSync(commondir, { force: true });
    assert.equal(runs(f), 'none', `owner ran the planted payload; tally ${JSON.stringify(tally)}`);
    assert.deepEqual(tally.other, []);
    assert.ok(tally.passed > 0, JSON.stringify(tally));
  } finally {
    f.cleanup();
  }
});

test('owner Git: a repository config that defines a filter, diff driver, textconv or include is refused, not run', () => {
  const f = fixture();
  try {
    for (const [key, value] of [
      ['filter.evil.clean', f.payload],
      ['filter.evil.process', f.payload],
      ['diff.evil.command', f.payload],
      ['diff.evil.textconv', f.payload],
      ['diff.external', f.payload],
      ['merge.evil.driver', f.payload],
      ['gpg.program', f.payload],
      ['alias.st', `!${f.payload}`],
    ] as const) {
      f.git(f.repo, 'config', key, value);
      const pin = readGitPin(f.wt); // set before the pin: the pin alone cannot catch it
      for (const [i, args] of COMMANDS(f).entries()) assert.throws(() => safeGitRun(f.owner, f.wt, pin, args), typed(/^git_config_executes_code: /), `${key}, command ${i}`);
      f.git(f.repo, 'config', '--unset', key);
    }
    assert.deepEqual(ran(f), []);
    assert.deepEqual(leftovers(f), [], 'a refused call removes its snapshot');
    // The fixture is live: plain Git with the same config runs the payload.
    f.git(f.repo, 'config', 'filter.evil.clean', f.payload);
    spawnSync('git', ['-C', f.wt, 'status', '--porcelain'], { env: f.env, stdio: 'ignore' });
    assert.notDeepEqual(ran(f), []);
  } finally {
    f.cleanup();
  }
});

test('owner Git: ~/.gitconfig includes, XDG config/attributes, GIT_CONFIG_* and GIT_EXTERNAL_DIFF in its environment are not honoured', () => {
  const f = fixture();
  const home = join(f.base, 'home');
  try {
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    writeFileSync(join(home, 'evil.cfg'), f.evil);
    writeFileSync(join(home, '.gitconfig'), `[include]\n\tpath = ${join(home, 'evil.cfg')}\n`);
    writeFileSync(join(home, '.config', 'git', 'config'), f.evil);
    writeFileSync(join(home, '.config', 'git', 'attributes'), '* diff=evil filter=evil\n');
    const pin = readGitPin(f.wt);
    const ownerRuns = (env: Record<string, string>) => {
      for (const args of COMMANDS(f)) safeGitRun({ stateDir: f.state, env }, f.wt, pin, args);
    };
    const plain = (env: Record<string, string>) => {
      rmSync(f.marker, { force: true });
      spawnSync('git', ['-C', f.wt, 'diff', '--', 'note'], { env, stdio: 'ignore' });
      const live = existsSync(f.marker);
      rmSync(f.marker, { force: true });
      return live;
    };
    // A0 set these on process.env; owner Git takes its environment from OwnerGit.env, so the hostile one is that.
    const withHome = { PATH: SYS_PATH, HOME: home }; // ~/.gitconfig with an include, and ~/.config/git
    assert.equal(plain(withHome), true, 'fixture must be live: plain Git honours ~/.gitconfig');
    ownerRuns(withHome);
    assert.equal(runs(f), 'none', 'owner Git honoured ~/.gitconfig or XDG config');
    const hostile = {
      ...withHome,
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_GLOBAL: join(home, 'evil.cfg'),
      GIT_CONFIG_SYSTEM: join(home, 'evil.cfg'),
      GIT_EXTERNAL_DIFF: f.payload,
    };
    assert.equal(plain(hostile), true);
    ownerRuns(hostile);
    assert.equal(runs(f), 'none', 'owner Git honoured GIT_CONFIG_GLOBAL/SYSTEM or GIT_EXTERNAL_DIFF');
    // Added: configuration through the environment (GIT_CONFIG_COUNT/KEY/VALUE).
    const counted = { PATH: SYS_PATH, HOME: join(f.base, 'nohome'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.evil.clean', GIT_CONFIG_VALUE_0: f.payload };
    assert.equal(plain(counted), true, 'fixture must be live: plain Git honours GIT_CONFIG_COUNT');
    ownerRuns(counted);
    assert.equal(runs(f), 'none', 'owner Git honoured GIT_CONFIG_COUNT');
  } finally {
    f.cleanup();
  }
});

test('owner Git: results match plain Git on an untouched checkout (snapshot is faithful)', () => {
  const f = fixture();
  try {
    const plain = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', env: f.env }).trim();
    f.git(f.repo, 'tag', 'v1', f.baseId);
    f.git(f.repo, 'pack-refs', '--all');
    f.git(f.repo, 'branch', 'loose', f.baseId);
    writeFileSync(join(f.repo, '.git', 'info', 'exclude'), 'ignored-*\n');
    writeFileSync(join(f.wt, 'ignored-x'), 'x');
    writeFileSync(join(f.wt, 'untracked'), 'u');
    const pin = readGitPin(f.wt);
    // A0's `symbolic-ref HEAD` is `rev-parse --symbolic-full-name HEAD` (symbolic-ref is not an inspection command here).
    for (const [i, args] of [
      ['status', '--porcelain', '--branch'],
      ['rev-parse', 'HEAD', 'v1', 'loose', 'a0-child/task'],
      ['for-each-ref', '--format=%(refname) %(objectname)'],
      ['diff', '--binary', f.baseId, f.headId],
      ['log', '--format=%H %s', '-3'],
      ['rev-parse', '--symbolic-full-name', 'HEAD'],
      ['ls-files', '--others', '--exclude-standard'],
      ['merge-base', f.baseId, f.headId],
    ].entries())
      assert.equal(safeGit(f.owner, f.wt, pin, args), plain(f.wt, ...args), `case ${i}`);
    // A0 also ran `fsck` and `config --get credential.helper` through owner Git: neither is an inspection command now.
    for (const args of [['fsck', '--full', '--strict'], ['config', '--get', 'credential.helper'], ['symbolic-ref', 'HEAD']]) assert.throws(() => safeGitRun(f.owner, f.wt, pin, args), typed(/^git_command_not_allowed$/));
  } finally {
    f.cleanup();
  }
});

test('owner Git: a racily-clean same-second, same-size edit is reported modified, as plain Git does (snapshot keeps the index mtime)', () => {
  const tmp = privateTmp();
  const stateTmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const repo = join(base, 'repo');
  const wt = join(base, 'wt');
  mkdirSync(repo);
  const env = { ...gitEnv(base), GIT_OPTIONAL_LOCKS: '0' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'A0 fixture');
    git(repo, 'config', 'user.email', 'a0@example.invalid');
    // Deterministic same-second case: compare only whole-second mtime and size (no ctime, inode or nsec), and pin the
    // file and index mtimes to one second.
    git(repo, 'config', 'core.trustctime', 'false');
    git(repo, 'config', 'core.checkStat', 'minimal');
    writeFileSync(join(repo, 'note'), 'base\n');
    git(repo, 'add', 'note');
    git(repo, 'commit', '-qm', 'base');
    // A0 used an ordinary checkout; owner Git runs in a linked worktree, whose index lives in its admin dir.
    git(repo, 'worktree', 'add', '-qb', 'a0-child/task', wt, 'HEAD');
    const note = join(wt, 'note');
    const index = join(repo, '.git', 'worktrees', 'wt', 'index');
    const T = 1_000_000_000;
    utimesSync(note, T, T);
    git(wt, 'add', 'note'); // the entry records mtime T
    writeFileSync(note, 'dirt\n');
    utimesSync(note, T, T); // same size, same recorded mtime
    utimesSync(index, T, T); // index written in the same second: the entry is racily clean
    const pin = readGitPin(wt);
    const owner: OwnerGit = { stateDir: realpathSync(stateTmp.dir), env: { PATH: SYS_PATH, LANG: 'C' } };
    assert.equal(safeGit(owner, wt, pin, ['status', '--porcelain']), 'M note', 'owner Git must not trust stat data of a racily-clean entry');
    assert.equal(git(wt, 'status', '--porcelain'), 'M note', 'fixture: plain Git sees the racy edit');
  } finally {
    tmp.cleanup();
    stateTmp.cleanup();
  }
});

// ---- ported from A0 gate1-artifact.test.ts ----

test('evidence binds commit AND native tree; diff bytes are advisory with producing Git version', () => {
  const f = fixture();
  try {
    // A0 used an owner-made ordinary checkout; owner Git runs in a linked worktree (an ordinary root refuses).
    const root = f.wt;
    rmSync(join(root, '.gitattributes'));
    f.git(root, 'commit', '-qam', 'no drivers');
    const base = f.git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'note'), 'two\n');
    f.git(root, 'commit', '-qam', 'two');
    const pin = readGitPin(root); // owner-made worktree: this IS its launch-time pin
    const first = artifactSubject(f.owner, root, 'HEAD', base, pin);
    assert.equal(first.commit_id, f.git(root, 'rev-parse', 'HEAD'));
    assert.equal(first.tree_id, f.git(root, 'rev-parse', 'HEAD^{tree}'));
    assert.notEqual(first.tree_id, first.commit_id);
    assert.equal(first.diff_digest?.advisory, true);
    assert.equal(first.diff_digest?.git_version, f.git(root, '--version'));
    assert.match(first.diff_digest!.value, /^[a-f0-9]{64}$/);
    f.git(root, 'commit', '--allow-empty', '-qm', 'same tree different commit');
    const second = artifactSubject(f.owner, root, 'HEAD', undefined, pin);
    assert.notEqual(second.commit_id, first.commit_id);
    assert.equal(second.tree_id, first.tree_id);
  } finally {
    f.cleanup();
  }
});

// ---- ported from A0 security-fix.test.ts (M1, owner Git) ----

test('M1: a planted core.fsmonitor never runs from the owner checks (pin compare, then safe config)', () => {
  const r = fixture();
  const payload = join(r.base, 'fsmonitor.sh');
  writeFileSync(payload, `#!/bin/sh\necho RAN >> ${r.marker}\n`, { mode: 0o755 });
  /** A0's decoy: a common dir with a core.fsmonitor payload, as a sandboxed child could write. */
  const fsmonitorDecoy = (where: string) => {
    execFileSync('cp', ['-a', join(r.repo, '.git'), where], { env: { PATH: SYS_PATH } });
    execFileSync('git', ['--git-dir', where, 'config', 'core.fsmonitor', payload], { env: r.env });
    return where;
  };
  try {
    rmSync(join(r.wt, '.gitattributes')); // A0's linkedRepo had no drivers attribute
    r.git(r.wt, 'commit', '-qam', 'plain');
    const pin = readGitPin(r.wt); // launch time
    const base = r.git(r.repo, 'rev-parse', 'HEAD');
    // Plant 1: rewrite the admin commondir to a decoy common dir.
    const original = readFileSync(join(r.admin, 'commondir'), 'utf8');
    writeFileSync(join(r.admin, 'commondir'), `${fsmonitorDecoy(join(r.wt, 'decoy'))}\n`);
    assert.throws(() => artifactSubject(r.owner, r.wt, 'HEAD', base, pin), typed(/^git_metadata_changed_since_launch/));
    assert.throws(() => safeGit(r.owner, r.wt, pin, ['status', '--porcelain']), typed(/^git_metadata_changed_since_launch/));
    writeFileSync(join(r.admin, 'commondir'), original);
    // Plant 2: rewrite the worktree .git gitfile to point at a decoy gitdir.
    const gitfile = readFileSync(join(r.wt, '.git'), 'utf8');
    const fake = fsmonitorDecoy(join(r.wt, 'decoy2'));
    writeFileSync(join(r.wt, '.git'), `gitdir: ${fake}\n`);
    assert.throws(() => safeGit(r.owner, r.wt, pin, ['status', '--porcelain']), typed(/^git_metadata_changed_since_launch/));
    writeFileSync(join(r.wt, '.git'), gitfile);
    // A config the pin cannot catch (set before pinning) still never executes.
    r.git(r.repo, 'config', 'core.fsmonitor', payload);
    const repin = readGitPin(r.wt);
    safeGit(r.owner, r.wt, repin, ['status', '--porcelain']);
    safeGit(r.owner, r.wt, repin, ['diff', '--stat', base, 'HEAD']);
    // A0 also ran `fsck` on the ordinary repository; an ordinary root refuses now, and fsck is not an inspection command.
    assert.throws(() => readGitPin(r.repo), typed(/^sandbox_git_ordinary_checkout_refused$/));
    artifactSubject(r.owner, r.wt, 'HEAD', base, repin);
    assert.equal(existsSync(r.marker), false, 'fsmonitor payload ran from an owner-side Git command');
    // The fixture is live: plain Git with that config runs the fsmonitor.
    spawnSync('git', ['-C', r.wt, 'status', '--porcelain'], { env: r.env, stdio: 'ignore' });
    assert.equal(existsSync(r.marker), true, 'fixture must be live: plain Git runs core.fsmonitor');
    rmSync(r.marker);
    // Missing pin refuses rather than trusting current bytes.
    assert.throws(() => safeGit(r.owner, r.wt, undefined, ['status']), typed(/^git_launch_pin_required$/));
  } finally {
    r.cleanup();
  }
});

test('M1: ordinary checkouts refuse; a config include refuses the pin and fails a call made with an older pin', () => {
  const r = fixture();
  try {
    // A0: an ordinary .git with a planted commondir refused `ordinary_checkout_redirected`. An ordinary root now refuses
    // before any Git runs, planted or not.
    writeFileSync(join(r.repo, '.git', 'commondir'), `${decoy(r, join(r.base, 'decoy'))}\n`);
    assert.throws(() => readGitPin(r.repo), typed(/^sandbox_git_ordinary_checkout_refused$/));
    rmSync(join(r.repo, '.git', 'commondir'));
    assert.throws(() => readGitPin(r.repo), typed(/^sandbox_git_ordinary_checkout_refused$/));
    const pin = readGitPin(r.wt);
    writeFileSync(join(r.base, 'evil.cfg'), r.evil);
    r.git(r.repo, 'config', 'include.path', join(r.base, 'evil.cfg'));
    assert.throws(() => readGitPin(r.wt), typed(/include_refused/));
    for (const args of COMMANDS(r)) assert.throws(() => safeGitRun(r.owner, r.wt, pin, args), typed(/^git_metadata_changed_since_launch: sandbox_git_config_include_refused$/));
    // A0's sandbox assertion (an include refuses sandboxLaunch) is git-sandbox.test.ts "git: config is judged by Git's own parser …".
    assert.equal(existsSync(r.marker), false);
  } finally {
    r.cleanup();
  }
});

// ---- new in P2-6: the slice 7 findings and the new guards ----

test('owner Git: with TMPDIR a symlink into the checkout, a planted diff.<x>.command never runs and the snapshot is outside the checkout', () => {
  const f = fixture();
  const saved = process.env.TMPDIR;
  try {
    const pin = readGitPin(f.wt);
    const { owner, gitDirs } = plantInCheckout(f);
    // Control: a Git dir inside the checkout is planted, and the payload runs from there.
    const control = join(f.wt, 'scratch', 'control');
    mkdirSync(join(f.wt, 'scratch'));
    execFileSync('cp', ['-a', join(f.repo, '.git'), control], { env: { PATH: SYS_PATH } });
    spawnSync('git', ['-C', f.wt, `--git-dir=${control}`, `--work-tree=${f.wt}`, ...SAFE_GIT_CONFIG, 'diff', '--no-ext-diff', '--no-textconv', '--', 'note'], { env: { ...owner.env }, stdio: 'ignore' });
    assert.notDeepEqual(ran(f), [], 'fixture must be live: a Git dir in the checkout runs the planted payload');
    rmSync(f.marker);
    rmSync(control, { recursive: true });
    const before = gitDirs().length;
    // The slice 7 probe: TMPDIR names a link into the agent-writable checkout.
    const link = join(f.base, 'tmp-link');
    symlinkSync(join(f.wt, 'scratch'), link);
    process.env.TMPDIR = link;
    for (const args of COMMANDS(f)) safeGitRun(owner, f.wt, pin, args);
    const dirs = gitDirs().slice(before);
    assert.equal(dirs.length, COMMANDS(f).length, 'every call ran Git on a snapshot');
    for (const [i, dir] of dirs.entries()) {
      assert.ok(within(join(f.state, 'git-snapshots'), dir), `call ${i}: the snapshot is in the state's git-snapshots`);
      assert.ok(![f.wt, f.repo].some(p => within(p, dir)), `call ${i}: the snapshot is outside the checkout`);
    }
    assert.equal(runs(f), 'none', 'owner Git ran a payload planted in its snapshot');
    assert.deepEqual(readdirSync(join(f.wt, 'scratch')), [], 'nothing was made under TMPDIR');
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    f.cleanup();
  }
});

test('owner Git: a state directory reached through a link into the checkout refuses (the real path is read back from the descriptor)', () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt);
    const { owner, gitDirs } = plantInCheckout(f);
    mkdirSync(join(f.wt, 'state'));
    const link = join(f.base, 'state-link');
    symlinkSync(join(f.wt, 'state'), link);
    for (const target of [f.wt, f.admin, join(f.repo, '.git')]) {
      const linked = join(f.base, `link-${target === f.wt ? 'root' : target === f.admin ? 'admin' : 'common'}`);
      symlinkSync(target === f.wt ? join(f.wt, 'state') : target, linked);
      for (const args of COMMANDS(f)) assert.throws(() => safeGitRun({ stateDir: linked, env: owner.env }, f.wt, pin, args), typed(/^git_snapshot_dir_inside_checkout$/));
    }
    for (const args of COMMANDS(f)) assert.throws(() => safeGitRun({ stateDir: link, env: owner.env }, f.wt, pin, args), typed(/^git_snapshot_dir_inside_checkout$/));
    assert.deepEqual(gitDirs(), [], 'no Git ran on a snapshot inside the checkout');
    assert.equal(runs(f), 'none');
    assert.deepEqual(readdirSync(join(f.wt, 'state', 'git-snapshots')), [], 'the refused snapshot is removed');
    // A relative or non-canonical state directory refuses before anything is made.
    for (const stateDir of ['state', `${f.state}/../x`]) assert.throws(() => safeGitRun({ stateDir, env: owner.env }, f.wt, pin, ['status']), typed(/^git_snapshot_state_dir_invalid$/));
  } finally {
    f.cleanup();
  }
});

test('owner Git: the snapshot directory must be private (owned, mode 0700)', () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt);
    mkdirSync(snapshots(f), { mode: 0o755 });
    chmodSync(snapshots(f), 0o755);
    assert.throws(() => safeGitRun(f.owner, f.wt, pin, ['status']), typed(/^git_snapshot_dir_not_private$/));
    assert.deepEqual(leftovers(f), [], 'nothing was made in a directory that is not private');
    chmodSync(snapshots(f), 0o700);
    assert.equal(safeGit(f.owner, f.wt, pin, ['status', '--porcelain']), 'M note');
    assert.deepEqual(leftovers(f), []);
  } finally {
    f.cleanup();
  }
});

test('owner Git: a commondir planted after the owner checks, before Git starts, is never followed (Git reads the snapshot)', () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt);
    const commondir = join(f.admin, 'commondir');
    const original = readFileSync(commondir, 'utf8');
    const fake = decoy(f, join(f.repo, 'decoy'));
    writeFileSync(commondir, `${fake}\n`);
    assert.equal(oldHelperRuns(f, f.admin, f.wt, ['diff', '--', 'note']), true, 'fixture must be live: the decoy runs under the live admin dir');
    writeFileSync(commondir, original);
    const owner = wrapGit(f, `printf '%s\\n' '${fake}' > ${commondir}`);
    for (const args of COMMANDS(f)) {
      safeGitRun(owner, f.wt, pin, args);
      writeFileSync(commondir, original);
    }
    assert.equal(runs(f), 'none', 'owner Git followed a commondir planted after its checks');
  } finally {
    f.cleanup();
  }
});

test('owner Git: pinned protocol.<name>.allow other than never refuses; ls-remote ext:: is refused and its payload never runs', () => {
  const f = fixture();
  try {
    const marker = join(f.base, 'ext-ran');
    const ext = join(f.base, 'ext.sh');
    writeFileSync(ext, `#!/bin/sh\necho RAN >> ${marker}\n`, { mode: 0o755 });
    const lsRemote = ['ls-remote', `ext::${ext}`];
    f.git(f.repo, 'config', 'protocol.ext.allow', 'always');
    // Control: plain Git with that config runs the ext:: command.
    spawnSync('git', ['-C', f.wt, ...lsRemote], { env: f.env, stdio: 'ignore', timeout: 20_000 });
    assert.equal(existsSync(marker), true, 'fixture must be live: plain Git runs ext:: with protocol.ext.allow=always');
    rmSync(marker);
    // The slice 7 probe: `-c protocol.allow=never` alone did not override the specific key. Owner Git's overrides do.
    const raw = spawnSync('git', ['-C', f.wt, ...SAFE_GIT_CONFIG, ...lsRemote], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000 });
    assert.notEqual(raw.status, 0);
    assert.equal(existsSync(marker), false, 'owner Git config overrides let ext:: run');
    const pin = readGitPin(f.wt);
    assert.throws(() => safeGitRun(f.owner, f.wt, pin, lsRemote), typed(/^git_command_not_allowed$/));
    for (const args of COMMANDS(f)) assert.throws(() => safeGitRun(f.owner, f.wt, pin, args), typed(/^git_config_allows_protocol: protocol\.ext\.allow$/));
    f.git(f.repo, 'config', '--unset', 'protocol.ext.allow');
    for (const [key, value] of [
      ['protocol.file.allow', 'always'],
      ['protocol.ext.allow', 'user'],
      ['protocol.https.allow', 'always'],
      ['protocol.allow', 'always'],
      ['protocol.ext.allow', 'Always'],
    ] as const) {
      f.git(f.repo, 'config', key, value);
      const repin = readGitPin(f.wt);
      assert.throws(() => safeGitRun(f.owner, f.wt, repin, ['status']), typed(/^git_config_allows_protocol: /), `${key}=${value}`);
      f.git(f.repo, 'config', '--unset', key);
    }
    // `never` (in any case) is what owner Git sets anyway.
    f.git(f.repo, 'config', 'protocol.ext.allow', 'NEVER');
    f.git(f.repo, 'config', 'protocol.allow', 'never');
    assert.equal(safeGit(f.owner, f.wt, readGitPin(f.wt), ['status', '--porcelain']), 'M note');
    assert.equal(existsSync(marker), false);
  } finally {
    f.cleanup();
  }
});

test('owner Git: a pinned credential.helper (also URL-scoped) refuses as executing config', () => {
  const f = fixture();
  try {
    for (const key of ['credential.helper', 'credential.https://example.invalid.helper']) {
      f.git(f.repo, 'config', key, `!${f.payload}`);
      const pin = readGitPin(f.wt);
      for (const args of COMMANDS(f)) assert.throws(() => safeGitRun(f.owner, f.wt, pin, args), typed(/^git_config_executes_code: credential\./), key);
      f.git(f.repo, 'config', '--unset', key);
    }
    assert.equal(runs(f), 'none');
  } finally {
    f.cleanup();
  }
});

test('owner Git: only local inspection commands run; transport and every other command refuses before anything is made', () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt);
    assert.deepEqual([...OWNER_GIT_COMMANDS].sort(), ['cat-file', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref', 'log', 'ls-files', 'merge-base', 'rev-parse', 'show', 'status']);
    for (const [i, args] of [
      ['fetch', f.repo],
      ['ls-remote', f.repo],
      ['push', f.repo, 'HEAD'],
      ['pull', f.repo],
      ['clone', f.repo, join(f.base, 'clone')],
      ['fetch-pack', f.repo],
      ['upload-pack', f.repo],
      ['archive', `--remote=${f.repo}`, 'HEAD'],
      ['remote', 'add', 'x', f.repo],
      ['submodule', 'update', '--init'],
      ['fsck'],
      ['gc'],
      ['config', '--list'],
      ['symbolic-ref', 'HEAD'],
      ['credential', 'fill'],
      ['-c', 'protocol.ext.allow=always', 'status'],
      ['--git-dir=/', 'status'],
      ['whatchanged'],
      [''],
      [],
    ].entries())
      assert.throws(() => safeGitRun(f.owner, f.wt, pin, args), typed(/^git_command_not_allowed$/), `case ${i}`);
    assert.equal(existsSync(snapshots(f)), false, 'a refused command made no snapshot');
    for (const [i, args] of [
      ['status', '--porcelain'],
      ['diff', '--stat', f.baseId, f.headId],
      ['diff-tree', '-r', f.baseId, f.headId],
      ['diff-index', '--cached', 'HEAD'],
      ['diff-files'],
      ['log', '-1', '--format=%H'],
      ['show', '--stat', 'HEAD'],
      ['rev-parse', 'HEAD'],
      ['cat-file', '-t', 'HEAD'],
      ['ls-files'],
      ['for-each-ref'],
      ['merge-base', f.baseId, f.headId],
    ].entries()) {
      const result = safeGitRun(f.owner, f.wt, pin, args);
      assert.equal(result.status, 0, `inspection case ${i} ran`);
    }
    assert.equal(runs(f), 'none');
    assert.deepEqual(leftovers(f), []);
  } finally {
    f.cleanup();
  }
});

// ---- kernel (real bwrap): the writer is a sandboxed parent ----

test('kernel owner Git: a bwrap parent racing its child admin commondir cannot make owner safeGit run a planted driver', { skip, timeout: 300_000 }, async () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt);
    const original = readFileSync(join(f.admin, 'commondir'), 'utf8').trim();
    const fake = decoy(f, join(f.repo, 'decoy'));
    const c = join(f.admin, 'commondir');
    // A0's parent was sandboxed in its ordinary clone, which refuses now (P2-5). The parent here is sandboxed in the
    // directory holding the repository and its child worktree (no Git metadata at its root, so all of it writable):
    // it can write the child's admin dir. It runs for at most 120 s.
    const script = `end=$(( $(date +%s) + 120 ))
      while [ "$(date +%s)" -lt "$end" ]; do
        printf '%s\\n' '${fake}' > ${c}.flip && mv -f ${c}.flip ${c} || exit 70
        printf '%s\\n' '${original}' > ${c}.flip && mv -f ${c}.flip ${c} || exit 71
      done`;
    const launch = sandboxLaunch(f.base, '/bin/sh', ['-c', script], { env: sandboxEnv(childEnv({ PATH: SYS_PATH, LANG: 'C' }, 'task'), f.base), bwrap: locateBwrap() });
    assert.equal(launch.gitPin, null, 'the parent root has no Git metadata of its own');
    const writer = spawn(launch.command, launch.args, { env: launch.env, stdio: ['ignore', 'ignore', 'ignore', 'ignore', ...launch.fds] });
    launch.close();
    const tally = await race(f, f.wt, pin, writer, Math.max(50, Math.floor(N / 3)));
    writeFileSync(c, `${original}\n`);
    assert.equal(runs(f), 'none', `owner ran the planted payload; tally ${JSON.stringify(tally)}`);
    assert.deepEqual(tally.other, []);
    assert.ok(tally.passed > 0 && tally.refused > 0, `sandboxed writer must interleave: ${JSON.stringify(tally)}`);
  } finally {
    f.cleanup();
  }
});
