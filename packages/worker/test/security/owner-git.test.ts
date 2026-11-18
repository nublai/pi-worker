/**
 * Owner Git (P2-6), ported from A0 `src/test/owner-git.test.ts`, `gate1-artifact.test.ts` and the `security-fix.test.ts`
 * M1 owner-Git cases, plus the two slice 7 regressions (a snapshot made through a symlinked `TMPDIR`, a pinned
 * `protocol.ext.allow`) and the new guards: the snapshot's real path, the typed API (no raw argv; values validated),
 * `credential.helper` and the other program-running keys, replacement objects off, split index refused, submodules
 * ignored on the command line.
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
import { createHash } from 'node:crypto';
import * as ownerGitApi from '../../src/owner-git/git-safe.js';
import {
  gitCatFile,
  gitDiff,
  gitForEachRef,
  gitLog,
  gitLsFiles,
  gitMergeBase,
  gitRevParse,
  gitShow,
  gitStatus,
  readGitPin,
  SAFE_GIT_CONFIG,
  type DiffFormat,
  type DiffOf,
  type GitCheckout,
  type GitPin,
  type OwnerGit,
} from '../../src/owner-git/git-safe.js';
import { locateBwrap, sandboxEnv, sandboxLaunch } from '../../src/sandbox/sandbox.js';
import { forgeStat, readIndex, writeIndex } from '../git-index.js';
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
function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const tmp = privateTmp();
  const stateTmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const repo = join(base, 'repo');
  const wt = join(base, 'wt');
  mkdirSync(repo);
  const env = gitEnv(base);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', `--object-format=${objectFormat}`);
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
/** A0's three owner commands (`diff --binary BASE HEAD`, `diff -- note`, `status --porcelain`), as typed calls. */
const CALLS = (f: Fixture): ((at: GitCheckout) => unknown)[] => [
  at => gitDiff(at, { kind: 'revisions', from: f.baseId, to: f.headId }),
  at => gitDiff(at, { kind: 'worktree' }, { paths: ['note'] }),
  at => gitStatus(at),
];
/** The checkout `root` (default the fixture's worktree) with `pin`, inspected by `owner` (default the fixture's). */
const on = (f: Fixture, pin: GitPin | null | undefined, owner: OwnerGit = f.owner, root: string = f.wt): GitCheckout => ({ owner, root, pin });
const snapshots = (f: Fixture) => join(f.state, 'git-snapshots');
const leftovers = (f: Fixture) => (existsSync(snapshots(f)) ? readdirSync(snapshots(f)) : []);

/** Run each owner command `n` times while `writer` flips the pointer files. */
async function race(f: Fixture, root: string, pin: GitPin, writer: ChildProcess, n: number) {
  const tally = { passed: 0, refused: 0, other: [] as string[] };
  await new Promise(r => setTimeout(r, 150)); // let the writer start flipping
  try {
    for (const call of CALLS(f))
      for (let i = 0; i < n; i++) {
        const t = new Date(Date.now() + i * 1000);
        utimesSync(join(root, 'note'), t, t); // stat-dirty every time
        try {
          call(on(f, pin, f.owner, root));
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
    assert.equal(gitStatus(on(f, pin)), ' M note\n');
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
      for (const [i, call] of CALLS(f).entries()) assert.throws(() => call(on(f, pin)), typed(/^git_config_executes_code: /), `${key}, command ${i}`);
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
      for (const call of CALLS(f)) call(on(f, pin, { stateDir: f.state, env }));
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
    const at = on(f, pin);
    // A0's argv cases, each as the typed call that runs it; each still compared with plain Git's output for that argv.
    // A0's `symbolic-ref HEAD` is `rev-parse --symbolic-full-name HEAD` (symbolic-ref is not in the typed API).
    const cases: [() => string, string[]][] = [
      [() => gitStatus(at, { branch: true }).trim(), ['status', '--porcelain', '--branch']],
      [() => ['HEAD', 'v1', 'loose', 'a0-child/task'].map(rev => gitRevParse(at, rev)).join('\n'), ['rev-parse', 'HEAD', 'v1', 'loose', 'a0-child/task']],
      [() => gitForEachRef(at, 'refs/').map(r => `${r.ref} ${r.object}`).join('\n'), ['for-each-ref', '--format=%(refname) %(objectname)']],
      [() => gitDiff(at, { kind: 'revisions', from: f.baseId, to: f.headId }).toString('utf8').trim(), ['diff', '--binary', f.baseId, f.headId]],
      [() => gitLog(at, 'HEAD', 3).map(e => `${e.commit} ${e.subject}`).join('\n'), ['log', '--format=%H %s', '-3']],
      [() => gitRevParse(at, 'HEAD', { symbolicFullName: true }), ['rev-parse', '--symbolic-full-name', 'HEAD']],
      [() => gitLsFiles(at, { untracked: true }).join('\n'), ['ls-files', '--others', '--exclude-standard']],
      [() => gitMergeBase(at, f.baseId, f.headId), ['merge-base', f.baseId, f.headId]],
    ];
    for (const [i, [call, args]] of cases.entries()) assert.equal(call(), plain(f.wt, ...args), `case ${i}`);
    // A0 also ran `fsck` and `config --get credential.helper` through owner Git: the typed API has neither (nor any raw
    // argv function to name them): the export test below asserts the exported surface.
  } finally {
    f.cleanup();
  }
});

test('owner Git: a racily-clean same-second, same-size edit is reported modified, as plain Git does (no entry\'s stat data is trusted)', () => {
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
    assert.equal(gitStatus({ owner, root: wt, pin }), ' M note\n', 'owner Git must not trust stat data of a racily-clean entry');
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

test('evidence: with a replacement ref for the commit, the artifact tree is still its native tree', () => {
  const f = fixture();
  try {
    const root = f.wt;
    const a = f.headId;
    // Captured before any replacement exists: the commit object's own tree line.
    const nativeTree = /^tree ([a-f0-9]+)$/m.exec(f.git(root, 'cat-file', 'commit', a))![1]!;
    writeFileSync(join(root, 'other'), 'other\n');
    f.git(root, 'add', 'other');
    f.git(root, 'commit', '-qm', 'replacement');
    const b = f.git(root, 'rev-parse', 'HEAD');
    const otherTree = f.git(root, 'rev-parse', 'HEAD^{tree}');
    assert.notEqual(otherTree, nativeTree);
    f.git(root, 'replace', a, b);
    f.git(root, 'reset', '-q', '--hard', a);
    // Control: Git honours the replacement by default and peels A to B's tree.
    assert.equal(f.git(root, 'rev-parse', `${a}^{tree}`), otherTree, 'fixture must be live: plain Git uses the replacement');
    const pin = readGitPin(root);
    const subject = artifactSubject(f.owner, root, a, f.baseId, pin);
    assert.equal(subject.commit_id, a);
    assert.equal(subject.tree_id, nativeTree, 'the artifact tree is the native tree');
    const at = on(f, pin);
    assert.match(gitCatFile(at, 'contents', a).toString('utf8'), new RegExp(`^tree ${nativeTree}\n`), 'cat-file reads the native commit');
    // The advisory diff is of the native objects too.
    const native = execFileSync('git', ['-C', root, '--no-replace-objects', 'diff', '--binary', f.baseId, a], { env: f.env });
    assert.equal(subject.diff_digest?.value, createHash('sha256').update(native).digest('hex'));
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
    assert.throws(() => gitStatus(on(r, pin)), typed(/^git_metadata_changed_since_launch/));
    writeFileSync(join(r.admin, 'commondir'), original);
    // Plant 2: rewrite the worktree .git gitfile to point at a decoy gitdir.
    const gitfile = readFileSync(join(r.wt, '.git'), 'utf8');
    const fake = fsmonitorDecoy(join(r.wt, 'decoy2'));
    writeFileSync(join(r.wt, '.git'), `gitdir: ${fake}\n`);
    assert.throws(() => gitStatus(on(r, pin)), typed(/^git_metadata_changed_since_launch/));
    writeFileSync(join(r.wt, '.git'), gitfile);
    // A config the pin cannot catch (set before pinning) still never executes.
    r.git(r.repo, 'config', 'core.fsmonitor', payload);
    const repin = readGitPin(r.wt);
    gitStatus(on(r, repin));
    gitDiff(on(r, repin), { kind: 'revisions', from: base, to: 'HEAD' }, { format: 'stat' });
    // A0 also ran `fsck` on the ordinary repository; an ordinary root refuses now, and fsck is not an inspection command.
    assert.throws(() => readGitPin(r.repo), typed(/^sandbox_git_ordinary_checkout_refused$/));
    artifactSubject(r.owner, r.wt, 'HEAD', base, repin);
    assert.equal(existsSync(r.marker), false, 'fsmonitor payload ran from an owner-side Git command');
    // The fixture is live: plain Git with that config runs the fsmonitor.
    spawnSync('git', ['-C', r.wt, 'status', '--porcelain'], { env: r.env, stdio: 'ignore' });
    assert.equal(existsSync(r.marker), true, 'fixture must be live: plain Git runs core.fsmonitor');
    rmSync(r.marker);
    // Missing pin refuses rather than trusting current bytes.
    assert.throws(() => gitStatus(on(r, undefined)), typed(/^git_launch_pin_required$/));
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
    for (const call of CALLS(r)) assert.throws(() => call(on(r, pin)), typed(/^git_metadata_changed_since_launch: sandbox_git_config_include_refused$/));
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
    for (const call of CALLS(f)) call(on(f, pin, owner));
    const dirs = gitDirs().slice(before);
    assert.equal(dirs.length, CALLS(f).length, 'every call ran Git on a snapshot');
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
      for (const call of CALLS(f)) assert.throws(() => call(on(f, pin, { stateDir: linked, env: owner.env })), typed(/^git_snapshot_dir_inside_checkout$/));
    }
    for (const call of CALLS(f)) assert.throws(() => call(on(f, pin, { stateDir: link, env: owner.env })), typed(/^git_snapshot_dir_inside_checkout$/));
    assert.deepEqual(gitDirs(), [], 'no Git ran on a snapshot inside the checkout');
    assert.equal(runs(f), 'none');
    assert.deepEqual(readdirSync(join(f.wt, 'state', 'git-snapshots')), [], 'the refused snapshot is removed');
    // A relative or non-canonical state directory refuses before anything is made.
    for (const stateDir of ['state', `${f.state}/../x`]) assert.throws(() => gitStatus(on(f, pin, { stateDir, env: owner.env })), typed(/^git_snapshot_state_dir_invalid$/));
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
    assert.throws(() => gitStatus(on(f, pin)), typed(/^git_snapshot_dir_not_private$/));
    assert.deepEqual(leftovers(f), [], 'nothing was made in a directory that is not private');
    chmodSync(snapshots(f), 0o700);
    assert.equal(gitStatus(on(f, pin)), ' M note\n');
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
    for (const call of CALLS(f)) {
      call(on(f, pin, owner));
      writeFileSync(commondir, original);
    }
    assert.equal(runs(f), 'none', 'owner Git followed a commondir planted after its checks');
  } finally {
    f.cleanup();
  }
});

test('owner Git: metadata changed since the pin refuses (HEAD retargeted, config or alternates changed), whatever Git would do with it', () => {
  const f = fixture();
  try {
    f.git(f.repo, 'branch', 'a0-child/other', f.baseId);
    const pin = readGitPin(f.wt);
    const changes: [string, string, string][] = [
      [join(f.admin, 'HEAD'), 'ref: refs/heads/a0-child/other\n', 'HEAD retargeted'],
      [join(f.repo, '.git', 'config'), `${readFileSync(join(f.repo, '.git', 'config'), 'utf8')}[user]\n\tname = changed\n`, 'config changed'],
      [join(f.repo, '.git', 'objects', 'info', 'alternates'), `${join(f.base, 'elsewhere')}\n`, 'alternates added'],
    ];
    for (const [file, content, label] of changes) {
      const before = existsSync(file) ? readFileSync(file) : null;
      writeFileSync(file, content);
      for (const call of CALLS(f)) assert.throws(() => call(on(f, pin)), typed(/^git_metadata_changed_since_launch$/), label);
      if (before === null) rmSync(file);
      else writeFileSync(file, before);
    }
    assert.equal(gitStatus(on(f, pin)), ' M note\n', 'the restored metadata equals the pin again');
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
    // A0 refused `safeGitRun(…, ['ls-remote', …])`; the typed API has no transport function and no raw argv entry.
    assert.deepEqual(Object.keys(ownerGitApi).filter(k => /remote|fetch|push|clone|run|raw|argv/i.test(k)), [], 'no transport or raw argv function');
    for (const call of CALLS(f)) assert.throws(() => call(on(f, pin)), typed(/^git_config_allows_protocol: protocol\.ext\.allow$/));
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
      assert.throws(() => gitStatus(on(f, repin)), typed(/^git_config_allows_protocol: /), `${key}=${value}`);
      f.git(f.repo, 'config', '--unset', key);
    }
    // `never` (in any case) is what owner Git sets anyway.
    f.git(f.repo, 'config', 'protocol.ext.allow', 'NEVER');
    f.git(f.repo, 'config', 'protocol.allow', 'never');
    assert.equal(gitStatus(on(f, readGitPin(f.wt))), ' M note\n');
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
      for (const call of CALLS(f)) assert.throws(() => call(on(f, pin)), typed(/^git_config_executes_code: credential\./), key);
      f.git(f.repo, 'config', '--unset', key);
    }
    assert.equal(runs(f), 'none');
  } finally {
    f.cleanup();
  }
});

/** A typed refusal of a caller value: `git_argument_refused: <what>`. */
const argRefused = typed(/^git_argument_refused: /);

test('owner Git: the API is typed (no raw argv export); every inspection matches plain Git; an option, pathspec magic or a bad value refuses before anything is made', () => {
  const f = fixture();
  try {
    const pin = readGitPin(f.wt);
    const at = on(f, pin);
    // Rule 6: the exported surface. Adding a function needs the security review; a raw argv function is never added.
    assert.deepEqual(Object.keys(ownerGitApi).sort(), ['SAFE_GIT_CONFIG', 'gitCatFile', 'gitDiff', 'gitForEachRef', 'gitLog', 'gitLsFiles', 'gitMergeBase', 'gitRevParse', 'gitShow', 'gitStatus', 'gitVersion', 'readGitPin']);
    const target = join(f.wt, 'written-by-git');
    const plain = (...args: string[]) => execFileSync('git', ['-C', f.wt, '-c', 'core.fsmonitor=false', ...args], { env: f.env });
    // Control: Git honours the option values tried below (`--output` writes the file).
    plain('diff', `--output=${target}`, 'HEAD');
    assert.equal(existsSync(target), true, 'fixture must be live: git diff --output writes its target');
    rmSync(target);
    const revisions = ['--help', `--output=${target}`, '--ext-diff', '--textconv', '--ignore-submodules=none', '--recurse-submodules', '-c', '--exec-path=/', '-p', '', 'HEAD\nx', 'a\0b', 'x'.repeat(5000)];
    const byRevision: ((v: string) => unknown)[] = [
      v => gitRevParse(at, v),
      v => gitRevParse(at, v, { symbolicFullName: true }),
      v => gitDiff(at, { kind: 'revisions', from: v, to: 'HEAD' }),
      v => gitDiff(at, { kind: 'revisions', from: 'HEAD', to: v }),
      v => gitDiff(at, { kind: 'index', from: v }),
      v => gitLog(at, v, 1),
      v => gitShow(at, v),
      v => gitCatFile(at, 'type', v),
      v => gitCatFile(at, 'contents', v),
      v => gitMergeBase(at, v, 'HEAD'),
      v => gitMergeBase(at, 'HEAD', v),
    ];
    for (const [i, call] of byRevision.entries()) for (const [j, v] of revisions.entries()) assert.throws(() => call(v), argRefused, `revision call ${i}, value ${j}`);
    const paths = [':(top)note', ':!note', ':/note', ':(attr:x)note', '--output=x', '-p', '/etc', '../x', 'a/../../x', '..', '', 'a\nb'];
    const byPath: ((v: string) => unknown)[] = [v => gitStatus(at, { paths: [v] }), v => gitDiff(at, { kind: 'worktree' }, { paths: ['note', v] }), v => gitLsFiles(at, { paths: [v] })];
    for (const [i, call] of byPath.entries()) for (const [j, v] of paths.entries()) assert.throws(() => call(v), argRefused, `path call ${i}, value ${j}`);
    for (const [j, v] of ['refs/heads/*', 'refs/[ab]', 'refs/a?', 'heads/', '--format=%(refname)', 'refs/../x', 'refs/a b', 'refs/a\\b', ''].entries()) assert.throws(() => gitForEachRef(at, v), argRefused, `ref prefix ${j}`);
    for (const [j, v] of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000].entries()) assert.throws(() => gitLog(at, 'HEAD', v), argRefused, `count ${j}`);
    assert.throws(() => gitDiff(at, { kind: 'revisions', from: 'HEAD', to: 'HEAD' }, { format: 'raw' as DiffFormat }), argRefused, 'format');
    assert.throws(() => gitDiff(at, { kind: 'tree' } as unknown as DiffOf), argRefused, 'diff kind');
    assert.throws(() => gitCatFile(at, 'batch' as 'type', 'HEAD'), argRefused, 'cat-file mode');
    assert.equal(existsSync(target), false, 'no option reached Git');
    assert.equal(existsSync(snapshots(f)), false, 'a refused value made no snapshot');
    // Every typed function runs; each equals plain Git's output for the argv it stands for.
    const text = (b: Buffer) => b.toString('utf8');
    assert.equal(gitStatus(at), text(plain('status', '--porcelain')));
    assert.equal(gitStatus(at, { paths: ['note'] }), text(plain('status', '--porcelain', '--', 'note')));
    for (const fmt of ['patch', 'stat', 'name-only', 'name-status'] as const) {
      const flags = { patch: ['--binary'], stat: ['--stat'], 'name-only': ['--name-only', '-z'], 'name-status': ['--name-status', '-z'] }[fmt];
      assert.deepEqual(gitDiff(at, { kind: 'revisions', from: f.baseId, to: f.headId }, { format: fmt }), plain('diff', ...flags, f.baseId, f.headId), `diff revisions ${fmt}`);
      assert.deepEqual(gitDiff(at, { kind: 'worktree' }, { format: fmt }), plain('diff', ...flags), `diff worktree ${fmt}`);
      assert.deepEqual(gitDiff(at, { kind: 'index', from: f.baseId }, { format: fmt }), plain('diff', '--cached', ...flags, f.baseId), `diff index ${fmt}`);
    }
    assert.deepEqual(gitLog(at, `${f.baseId}..HEAD`, 5), [{ commit: f.headId, subject: 'head' }]);
    assert.deepEqual(gitShow(at, 'HEAD', { format: 'stat' }), plain('show', '--stat', 'HEAD'));
    assert.deepEqual(gitShow(at, `${f.baseId}:note`), plain('show', `${f.baseId}:note`));
    assert.equal(gitCatFile(at, 'type', 'HEAD'), 'commit');
    assert.equal(gitCatFile(at, 'size', 'HEAD:note'), 5);
    assert.deepEqual(gitCatFile(at, 'contents', 'HEAD'), plain('cat-file', '-p', 'HEAD'));
    assert.deepEqual(gitLsFiles(at), ['.gitattributes', 'note']);
    assert.deepEqual(gitForEachRef(at, 'refs/heads/a0-child'), [{ ref: 'refs/heads/a0-child/task', object: f.headId, type: 'commit' }]);
    assert.equal(gitMergeBase(at, f.baseId, f.headId), f.baseId);
    assert.equal(runs(f), 'none');
    assert.deepEqual(leftovers(f), []);
  } finally {
    f.cleanup();
  }
});

test('owner Git: help dispatch never runs a configured man or browser program (the key refuses; --help is never an argument)', () => {
  const f = fixture();
  try {
    const marker = join(f.base, 'help-ran');
    const viewer = join(f.base, 'viewer.sh');
    writeFileSync(viewer, `#!/bin/sh\necho RAN >> ${marker}\n`, { mode: 0o755 });
    // Astra F1: pinned before the call, so the pin cannot catch it.
    f.git(f.repo, 'config', 'man.viewer', 'piwview');
    f.git(f.repo, 'config', 'man.piwview.cmd', viewer);
    // Control: Git rewrites `<command> --help` to `git help`, which runs the configured viewer.
    spawnSync('git', ['-C', f.wt, 'status', '--help'], { env: f.env, stdio: 'ignore', timeout: 20_000 });
    assert.equal(existsSync(marker), true, 'fixture must be live: plain Git runs man.<tool>.cmd for --help');
    rmSync(marker);
    const pin = readGitPin(f.wt);
    const at = on(f, pin);
    for (const call of CALLS(f)) assert.throws(() => call(at), typed(/^git_config_executes_code: man\./));
    for (const [i, call] of [() => gitMergeBase(at, '--help', 'HEAD'), () => gitRevParse(at, '--help'), () => gitCatFile(at, 'type', '--help'), () => gitLog(at, '--help', 1)].entries()) assert.throws(call, argRefused, `call ${i}`);
    assert.equal(existsSync(marker), false, 'owner Git ran the help viewer');
  } finally {
    f.cleanup();
  }
});

test('owner Git: every documented program-running config key refuses (help, man, browser, tools, remote programs, trailers, send-email, tar, submodule !update)', () => {
  const f = fixture();
  try {
    const value = f.payload;
    const keys: [string, string][] = [
      ['man.piwview.cmd', value],
      ['man.piwview.path', value],
      ['man.viewer', 'piwview'],
      ['help.browser', 'piwview'],
      ['help.format', 'web'],
      ['web.browser', 'piwview'],
      ['browser.piwview.cmd', value],
      ['browser.piwview.path', value],
      ['interactive.diffFilter', value],
      ['gpg.ssh.defaultKeyCommand', value],
      ['gc.recentObjectsHook', value],
      ['difftool.piw.cmd', value],
      ['difftool.piw.path', value],
      ['mergetool.piw.cmd', value],
      ['mergetool.piw.path', value],
      ['guitool.piw.cmd', value],
      ['imap.tunnel', value],
      ['instaweb.httpd', value],
      ['instaweb.browser', value],
      ['remote.origin.receivepack', value],
      ['remote.origin.uploadpack', value],
      ['trailer.piw.command', value],
      ['trailer.piw.cmd', value],
      ['sendemail.ccCmd', value],
      ['sendemail.toCmd', value],
      ['sendemail.headerCmd', value],
      ['sendemail.smtpServer', value],
      ['sendemail.sendmailCmd', value],
      ['sendemail.work.sendmailCmd', value],
      ['sendemail.work.ccCmd', value],
      ['tar.tgz.command', value],
      ['submodule.piw.update', `!${value}`],
    ];
    for (const [key, v] of keys) {
      f.git(f.repo, 'config', key, v);
      const pin = readGitPin(f.wt);
      assert.throws(() => gitStatus(on(f, pin)), typed(/^git_config_executes_code: /), key);
      f.git(f.repo, 'config', '--unset', key);
    }
    // A submodule update mode that is not a command does not refuse.
    f.git(f.repo, 'config', 'submodule.piw.update', 'rebase');
    assert.equal(gitStatus(on(f, readGitPin(f.wt))), ' M note\n');
    assert.equal(runs(f), 'none');
  } finally {
    f.cleanup();
  }
});

test("owner Git: an agent's .gitmodules ignore = none never makes owner Git run Git in a nested repository", () => {
  const f = fixture();
  try {
    // The agent: a nested repository committed as a gitlink, `.gitmodules` saying `ignore = none`, a filter defined in the
    // nested repository's own config and selected by its attributes, and a dirty file there.
    const sub = join(f.wt, 'sub');
    mkdirSync(sub);
    f.git(sub, 'init', '-q');
    f.git(sub, 'config', 'user.name', 'A0 fixture');
    f.git(sub, 'config', 'user.email', 'a0@example.invalid');
    writeFileSync(join(sub, 'f'), 'x\n');
    f.git(sub, 'add', '.');
    f.git(sub, 'commit', '-qm', 'sub');
    f.git(sub, 'config', 'filter.evil.clean', f.payload);
    writeFileSync(join(sub, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(f.wt, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
    f.git(f.wt, 'add', '.gitmodules', 'sub');
    f.git(f.wt, 'commit', '-qm', 'gitlink');
    writeFileSync(join(sub, 'f'), 'y\n');
    const pin = readGitPin(f.wt);
    // Control: even with owner Git's `-c diff.ignoreSubmodules=all`, the .gitmodules setting wins and the filter runs.
    spawnSync('git', ['-C', f.wt, ...SAFE_GIT_CONFIG, 'status', '--porcelain'], { env: f.env, stdio: 'ignore' });
    assert.notDeepEqual(ran(f), [], 'fixture must be live: .gitmodules ignore = none overrides the -c setting');
    rmSync(f.marker);
    const at = on(f, pin);
    for (const call of CALLS(f)) call(at);
    gitDiff(at, { kind: 'index', from: f.baseId });
    gitShow(at, 'HEAD');
    gitLog(at, 'HEAD', 2);
    assert.equal(runs(f), 'none', 'owner Git ran Git in the nested repository');
  } finally {
    f.cleanup();
  }
});

test('owner Git: a split index refuses (a shared index in the linked admin dir, or core.splitIndex)', () => {
  const f = fixture();
  try {
    // The config alone, before any index is split.
    f.git(f.repo, 'config', 'core.splitIndex', 'true');
    assert.throws(() => gitStatus(on(f, readGitPin(f.wt))), typed(/^git_split_index_refused$/), 'core.splitIndex=true');
    f.git(f.repo, 'config', 'core.splitIndex', 'false');
    assert.equal(gitStatus(on(f, readGitPin(f.wt))), ' M note\n', 'core.splitIndex=false is not a split index');
    f.git(f.repo, 'config', '--unset', 'core.splitIndex');
    // A linked worktree whose index is already split: its entries are in sharedindex.<id> in the admin dir.
    f.git(f.wt, 'update-index', '--split-index');
    assert.ok(readdirSync(f.admin).some(n => n.startsWith('sharedindex.')), 'fixture: the shared index is in the admin dir');
    assert.equal(execFileSync('git', ['-C', f.wt, 'status', '--porcelain'], { encoding: 'utf8', env: f.env }), ' M note\n', 'fixture: plain Git reads the split index');
    const pin = readGitPin(f.wt);
    for (const call of CALLS(f)) assert.throws(() => call(on(f, pin)), typed(/^git_split_index_refused$/));
    assert.deepEqual(leftovers(f), [], 'a refused call removes its snapshot');
  } finally {
    f.cleanup();
  }
});

test('owner Git: a tracked change hidden by assume-unchanged or skip-worktree refuses status and a worktree diff (git_index_hides_changes), never reads as clean', () => {
  const f = fixture();
  try {
    const at = () => on(f, readGitPin(f.wt));
    assert.equal(gitStatus(at()), ' M note\n', 'control: the same-size edit is seen');
    // Index formats 2 (3 once an extended flag is set) and 4 (paths prefix-compressed).
    for (const [version, flag] of [['2', 'assume-unchanged'], ['2', 'skip-worktree'], ['4', 'assume-unchanged'], ['4', 'skip-worktree']] as const) {
      f.git(f.wt, 'update-index', '--index-version', version);
      f.git(f.wt, 'update-index', `--${flag}`, 'note');
      assert.equal(f.git(f.wt, 'status', '--porcelain'), '', `fixture: plain Git reports clean with ${flag}`);
      assert.throws(() => gitStatus(at()), typed(/^git_index_hides_changes$/), `status, ${flag}`);
      assert.throws(() => gitDiff(at(), { kind: 'worktree' }), typed(/^git_index_hides_changes$/), `worktree diff, ${flag}`);
      // What does not compare the working tree still answers.
      assert.equal(gitRevParse(at(), 'HEAD'), f.headId);
      assert.ok(gitDiff(at(), { kind: 'revisions', from: f.baseId, to: f.headId }).length > 0);
      f.git(f.wt, 'update-index', `--no-${flag}`, 'note');
      assert.equal(gitStatus(at()), ' M note\n', `${flag} cleared (index v${version}): the edit is seen`);
    }
    assert.deepEqual(leftovers(f), [], 'a refused call removes its snapshot');
  } finally {
    f.cleanup();
  }
});

test('owner Git: a pinned core.ignoreStat, core.sparseCheckout or index.sparse refuses the worktree reads (git_config_trusts_stat); core.checkStat and core.trustctime are overridden to full stat checks, and the untracked cache is off', async () => {
  const f = fixture();
  try {
    for (const key of ['core.ignoreStat', 'core.sparseCheckout', 'index.sparse']) {
      f.git(f.repo, 'config', key, 'true');
      const pin = readGitPin(f.wt);
      assert.throws(() => gitStatus(on(f, pin)), typed(new RegExp(`^git_config_trusts_stat: ${key.toLowerCase().replace('.', '\\.')}$`)), key);
      assert.throws(() => gitDiff(on(f, pin), { kind: 'worktree' }), typed(/^git_config_trusts_stat: /), key);
      assert.equal(gitLog(on(f, pin), 'HEAD', 1)[0]?.commit, f.headId, `${key}: reads that do not compare the working tree still answer`);
      f.git(f.repo, 'config', key, 'false');
      assert.equal(gitStatus(on(f, readGitPin(f.wt))), ' M note\n', `${key}=false is not refused`);
      f.git(f.repo, 'config', '--unset', key);
    }
    // A same-size edit with its old mtime restored, the index written well after that mtime (not racily clean): only
    // the ctime tells. With minimal stat checks and ctime untrusted, plain Git reports it clean.
    const note = join(f.wt, 'note');
    const T = 1_000_000_000;
    writeFileSync(note, 'head\n');
    utimesSync(note, T, T);
    f.git(f.wt, 'update-index', '--refresh');
    assert.equal(f.git(f.wt, 'status', '--porcelain'), '', 'fixture: clean at the committed bytes');
    await new Promise(r => setTimeout(r, 1_100)); // a later ctime second
    writeFileSync(note, 'dirt\n');
    utimesSync(note, T, T);
    f.git(f.repo, 'config', 'core.checkStat', 'minimal');
    f.git(f.repo, 'config', 'core.trustctime', 'false');
    assert.equal(f.git(f.wt, 'status', '--porcelain'), '', 'fixture: plain Git trusts the stale stat data');
    assert.equal(gitStatus(on(f, readGitPin(f.wt))), ' M note\n', 'owner Git checks the full stat data, so it compares the content');
    // An untracked cache the child primed: the root directory's mtime set back after a new file, so a pinned
    // core.untrackedCache=true trusts the cached (empty) list. Owner Git turns the cache off on the command line.
    f.git(f.repo, 'config', 'core.untrackedCache', 'true');
    f.git(f.wt, 'update-index', '--untracked-cache');
    utimesSync(f.wt, T, T);
    f.git(f.wt, 'status', '--porcelain');
    writeFileSync(join(f.wt, 'sneaky'), 'x\n');
    utimesSync(f.wt, T, T);
    assert.doesNotMatch(f.git(f.wt, 'status', '--porcelain'), /sneaky/, 'fixture: plain Git trusts the primed untracked cache');
    assert.match(gitStatus(on(f, readGitPin(f.wt))), /^\?\? sneaky$/m, 'owner Git never uses the untracked cache');
  } finally {
    f.cleanup();
  }
});

/** The edit a child hides by forging stat data: same-size new bytes, an old mtime, the entry rewritten to the new stat. */
function forgeEdit(f: Fixture, oidBytes: number): void {
  const note = join(f.wt, 'note');
  writeFileSync(note, 'dirt\n');
  utimesSync(note, 1_000_000_000, 1_000_000_000);
  forgeStat(join(f.admin, 'index'), 'note', note, oidBytes);
}

test("owner Git: a tracked edit whose index entry the child forged to the edited file's stat data is modified for status and a worktree diff (index v2, v3, v4; SHA-1 and SHA-256); the checkout's own index is never written", () => {
  const cases = [
    ['sha1', '2'],
    ['sha1', '3'],
    ['sha1', '4'],
    ['sha256', '2'],
  ] as const;
  for (const [format, version] of cases) {
    const f = fixture(format);
    try {
      const oidBytes = format === 'sha256' ? 32 : 20;
      const index = join(f.admin, 'index');
      // Version 3 is written only when an entry has extended flags: an intent-to-add entry has one.
      if (version === '3') {
        writeFileSync(join(f.wt, 'extra'), 'extra\n');
        f.git(f.wt, 'add', '-N', 'extra');
      }
      forgeEdit(f, oidBytes);
      if (version === '4') f.git(f.wt, 'update-index', '--index-version', '4');
      const expected = version === '3' ? ' A extra\n M note\n' : ' M note\n';
      assert.equal(readFileSync(index).readUInt32BE(4), Number(version), `fixture: index v${version}`);
      assert.equal(f.git(f.wt, 'status', '--porcelain'), version === '3' ? 'A extra' : '', `fixture: plain Git trusts the forged entry (${format}, v${version})`);
      const before = readFileSync(index);
      const pin = readGitPin(f.wt);
      assert.equal(gitStatus(on(f, pin)), expected, `status (${format}, v${version})`);
      assert.equal(gitDiff(on(f, pin), { kind: 'worktree' }, { format: 'name-only', paths: ['note'] }).toString('utf8'), 'note\0', `worktree diff (${format}, v${version})`);
      assert.ok(readFileSync(index).equals(before), `the checkout's own index is unchanged (${format}, v${version})`);
      // The honest worktree: the committed bytes, the entry refreshed (a checkout would trust the forged entry). Clean.
      writeFileSync(join(f.wt, 'note'), 'head\n');
      f.git(f.wt, 'update-index', '-q', '--refresh');
      if (version === '3') {
        f.git(f.wt, 'rm', '-q', '--cached', 'extra');
        rmSync(join(f.wt, 'extra'));
      }
      assert.equal(f.git(f.wt, 'status', '--porcelain'), '', `fixture: honest and clean (${format}, v${version})`);
      assert.equal(gitStatus(on(f, readGitPin(f.wt))), '', `an honest clean worktree is clean (${format}, v${version})`);
      assert.deepEqual(leftovers(f), [], 'every call removes its snapshot');
    } finally {
      f.cleanup();
    }
  }
});

test('owner Git: a cache tree (TREE) the child forged to vouch for a staged subdirectory never hides the staged change', () => {
  const f = fixture();
  try {
    const index = join(f.admin, 'index');
    f.git(f.wt, 'checkout', '--', 'note');
    mkdirSync(join(f.wt, 'd'));
    writeFileSync(join(f.wt, 'd', 'f'), 'dee\n');
    f.git(f.wt, 'add', 'd/f');
    f.git(f.wt, 'commit', '-qm', 'dir');
    f.git(f.wt, 'read-tree', 'HEAD');
    f.git(f.wt, 'update-index', '-q', '--refresh');
    const tree = readIndex(index).extensions.find(e => e.signature === 'TREE');
    assert.ok(tree, 'fixture: a complete cache tree for HEAD');
    writeFileSync(join(f.wt, 'd', 'f'), 'evil\n');
    f.git(f.wt, 'add', 'd/f');
    assert.equal(f.git(f.wt, 'status', '--porcelain'), 'M  d/f', 'fixture: the change is staged');
    const staged = readIndex(index);
    writeIndex(index, staged.head, [tree.bytes, ...staged.extensions.filter(e => e.signature !== 'TREE').map(e => e.bytes)]);
    assert.equal(f.git(f.wt, 'status', '--porcelain'), '', 'fixture: plain Git trusts the forged cache tree');
    const pin = readGitPin(f.wt);
    assert.equal(gitStatus(on(f, pin)), 'M  d/f\n');
  } finally {
    f.cleanup();
  }
});

test('owner Git: the snapshot index is checksummed anew whatever checksum the child wrote (Git does not check it on read); an index Git itself cannot read refuses git_index_unreadable', () => {
  const f = fixture();
  try {
    const index = join(f.admin, 'index');
    const parts = readIndex(index);
    const extensions = parts.extensions.map(e => e.bytes);
    const at = () => on(f, readGitPin(f.wt));
    const plainFails = () => spawnSync('git', ['-C', f.wt, 'status', '--porcelain'], { env: f.env, stdio: 'ignore' }).status !== 0;
    for (const checksum of [Buffer.alloc(20, 0xab), Buffer.alloc(20)]) {
      writeIndex(index, parts.head, extensions, 20, checksum);
      assert.equal(f.git(f.wt, 'status', '--porcelain'), 'M note', 'fixture: plain Git reads the index');
      assert.equal(gitStatus(at()), ' M note\n', 'owner Git reads it too');
    }
    // A required extension (lower-case signature) Git does not know: framed and checksummed, so only Git refuses it.
    const unknown = Buffer.concat([Buffer.from('zzzz', 'latin1'), Buffer.from([0, 0, 0, 4]), Buffer.alloc(4)]);
    writeIndex(index, parts.head, [...extensions, unknown]);
    assert.ok(plainFails(), 'fixture: plain Git refuses the extension');
    assert.throws(() => gitStatus(at()), typed(/^git_index_unreadable$/), 'status, unknown required extension');
    assert.throws(() => gitDiff(at(), { kind: 'worktree' }), typed(/^git_index_unreadable$/), 'worktree diff, unknown required extension');
    assert.equal(gitRevParse(at(), 'HEAD'), f.headId, 'reads that do not compare the working tree still answer');
    assert.deepEqual(leftovers(f), [], 'a refused call removes its snapshot');
  } finally {
    f.cleanup();
  }
});

test('owner Git: a pinned log.showSignature never runs gpg from the supervisor PATH or mixes it into log and show output', () => {
  const f = fixture();
  try {
    // A fake gpg first on owner Git's PATH: if Git runs it, it leaves a marker and prints into the output.
    const dir = join(f.base, 'fakegpg');
    const gpgRan = join(f.base, 'gpg-ran');
    mkdirSync(dir);
    writeFileSync(join(dir, 'gpg'), `#!/bin/sh\necho RAN >> ${gpgRan}\necho 'gpg: Signature made by fake'\necho 'gpg: Good signature from fake' >&2\nexit 0\n`, { mode: 0o755 });
    const owner: OwnerGit = { stateDir: f.owner.stateDir, env: { PATH: `${dir}:${SYS_PATH}`, LANG: 'C' } };
    // A signed-looking commit: a gpgsig header Git hands to gpg when log.showSignature is on.
    const tree = f.git(f.repo, 'rev-parse', `${f.headId}^{tree}`);
    const raw =
      `tree ${tree}\nparent ${f.headId}\nauthor A <a@example.invalid> 1700000000 +0000\ncommitter A <a@example.invalid> 1700000000 +0000\n` +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\nsigned\n';
    const signed = execFileSync('git', ['-C', f.repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { encoding: 'utf8', env: f.env, input: raw }).trim();
    f.git(f.repo, 'config', 'log.showSignature', 'true');
    // Fixture: plain Git with that config does run the fake gpg.
    execFileSync('git', ['-C', f.repo, 'log', '-1', signed], { encoding: 'utf8', env: { ...f.env, PATH: `${dir}:${SYS_PATH}` }, stdio: 'pipe' });
    assert.ok(existsSync(gpgRan), 'fixture: plain Git runs gpg under log.showSignature');
    rmSync(gpgRan);

    const pin = readGitPin(f.wt);
    assert.deepEqual(
      gitLog(on(f, pin, owner), signed, 3),
      [
        { commit: signed, subject: 'signed' },
        { commit: f.headId, subject: 'head' },
        { commit: f.baseId, subject: 'base' },
      ],
      'log is exactly the unsigned records',
    );
    const shown = gitShow(on(f, pin, owner), signed).toString('utf8');
    const plain = execFileSync('git', ['-C', f.repo, 'show', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--binary', signed], { encoding: 'utf8', env: f.env });
    assert.equal(shown, plain, 'show is exactly the unsigned record');
    assert.ok(!shown.includes('gpg:'), 'no gpg output in show');
    assert.equal(existsSync(gpgRan), false, 'gpg never ran');
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
