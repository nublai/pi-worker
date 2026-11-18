/**
 * Git mounts in a sandbox root (P2-5), ported from A0 `src/test/gate1-git.test.ts` and the `security-fix.test.ts` M1
 * mount cases and m2, plus new cases: config and pointer refusals, a packed or reflog sibling in the branch namespace,
 * Git mounts overlapping a control path, and the pin a create's validation accepted reaching the spawn. PR #30 fix
 * round: an ordinary checkout root and a repository inside (or around) the root refuse, config is judged by Git's own
 * parser, and a kernel matrix shows what a linked child cannot move. Cases named `kernel` run real bwrap and Git:
 * `harness/ci/kernel.sh -- git` (PIW_TEST_KERNEL=1); elsewhere they skip.
 *
 * Every Git command and every sandbox environment here is synthetic (never process.env), so no credential can reach an
 * argv or a message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../../src/b2/errors.js';
import { productionHosts } from '../../src/daemon.js';
import { childEnv, SdkHost } from '../../src/host/host.js';
import { locateBwrap, sandboxEnv, sandboxLaunch, sandboxRoot, type SandboxLaunch } from '../../src/sandbox/sandbox.js';
import type { GitPin } from '../../src/sandbox/git-sandbox.js';
import type { Create, HostLaunch } from '../../src/supervisor/state.js';
import { privateTmp } from '../helpers.js';
import { bind, fixture } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 in a delegated user service with bwrap (harness/ci/kernel.sh)';

type Spec = NonNullable<Create['launch_spec']>;
/** A synthetic supervisor environment: never process.env. */
const SYNTHETIC_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/home/synthetic', LANG: 'C', SYNTHETIC_API_KEY: 'synthetic-credential-value-7d21e4' };
const launchIn = (root: string, command: string, args: string[], options: { bwrap?: string; gitPin?: GitPin | null } = {}): SandboxLaunch =>
  sandboxLaunch(root, command, args, { env: sandboxEnv(childEnv(SYNTHETIC_ENV, 'task'), root), ...options });
const parentBinding = { worker_id: 'p', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'gen' };
const childCreate = (root: string): Create => ({
  command_id: 'root',
  cwd: root,
  host: 'sdk',
  provider: 'p',
  model: 'm',
  thinking: 'off',
  parent: parentBinding,
  launch_spec: { environment: { id: 'root', revision: 1, allowed_methods: [], filesystem: 'bwrap', root }, role: 'child', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' },
});

/** Git with no global or system configuration and a synthetic environment. */
function gitIn(home: string) {
  const env = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  return (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** An ordinary repository with one commit (A0's fixture identity). */
function initRepo(git: ReturnType<typeof gitIn>, repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'A0 fixture');
  git(repo, 'config', 'user.email', 'a0@example.invalid');
  writeFileSync(join(repo, 'note'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
}

/** A0 security-fix `linkedRepo`: a repository and a linked worktree on the private branch `a0-child/task`. */
function linkedRepo() {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const repo = join(base, 'repo');
  const wt = join(base, 'wt');
  const git = gitIn(base);
  initRepo(git, repo);
  git(repo, 'worktree', 'add', '-qb', 'a0-child/task', wt, 'HEAD');
  return { base, repo, wt, git, admin: join(repo, '.git', 'worktrees', 'wt'), cleanup: tmp.cleanup };
}

/** A typed refusal before any effect: `code`, HTTP 409, `no_effect`. */
const typed = (code: string) => (error: unknown) => error instanceof Refusal && error.message === code && error.status === 409 && error.effect === 'no_effect';

/**
 * Grok's PR #30 layout: a linked worktree `wt` whose repository was moved inside it (`wt/inner`) and repaired, so the
 * common dir, its hooks and every admin dir lie in the root.
 */
function nestedRepo(git: ReturnType<typeof gitIn>, base: string, name: string) {
  const repo = join(base, `${name}-repo`);
  const wt = join(base, name);
  initRepo(git, repo);
  git(repo, 'worktree', 'add', '-qb', `${name}/task`, wt, 'HEAD');
  const inner = join(wt, 'inner');
  renameSync(repo, inner);
  git(inner, 'worktree', 'repair');
  return { wt, inner };
}

const fdMounts = (args: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--ro-bind-fd' || args[i] === '--bind-fd') out.push(`${args[i] === '--ro-bind-fd' ? 'ro' : 'rw'} ${args[i + 2]}`);
  return out;
};

const spawnLaunch = (launch: SandboxLaunch) =>
  new Promise<{ status: number | null; out: string; err: string }>(resolve => {
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['ignore', 'pipe', 'pipe', 'ignore', ...launch.fds] });
    launch.close();
    let out = '';
    let err = '';
    child.stdout!.on('data', d => (out += d));
    child.stderr!.on('data', d => (err += d));
    child.on('close', status => resolve({ status, out, err }));
  });

// ---- ported from A0 gate1-git.test.ts ----

test('linked-worktree sandbox refuses flat or shared branch write namespaces before spawn', () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const repo = join(base, 'repo');
  const git = gitIn(base);
  try {
    initRepo(git, repo);
    const flat = join(base, 'flat');
    const shared = join(base, 'shared');
    git(repo, 'worktree', 'add', '-qb', 'flat', flat, 'HEAD');
    assert.throws(() => launchIn(flat, '/bin/true', []), /requires_private_namespace/);
    git(repo, 'worktree', 'add', '-qb', 'shared/task', shared, 'HEAD');
    git(repo, 'branch', 'shared/sibling');
    assert.throws(() => launchIn(shared, '/bin/true', []), /sandbox_git_branch_namespace_not_private/);
    // New in P2-5: a packed sibling shares the namespace too (a loose ref written there would shadow it), while a
    // packed own branch alone is private.
    const packed = join(base, 'packed');
    const own = join(base, 'own');
    git(repo, 'worktree', 'add', '-qb', 'pk/task', packed, 'HEAD');
    git(repo, 'worktree', 'add', '-qb', 'solo/task', own, 'HEAD');
    git(repo, 'branch', 'pk/sibling');
    git(repo, 'pack-refs', '--all');
    assert.equal(existsSync(join(repo, '.git', 'refs', 'heads', 'pk', 'sibling')), false, 'the sibling is packed only');
    assert.throws(() => launchIn(packed, '/bin/true', []), /sandbox_git_branch_namespace_not_private/);
    launchIn(own, '/bin/true', []).close();
    // A reflog of another branch in the namespace refuses as well.
    const logged = join(base, 'logged');
    git(repo, 'worktree', 'add', '-qb', 'rl/task', logged, 'HEAD');
    writeFileSync(join(repo, '.git', 'logs', 'refs', 'heads', 'rl', 'other'), '');
    assert.throws(() => launchIn(logged, '/bin/true', []), /sandbox_git_reflog_namespace_not_private/);
  } finally {
    tmp.cleanup();
  }
});

test('kernel: bwrap linked worktree status/add/commit writes only its branch namespace and shared objects', { skip, timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const repo = join(base, 'repo');
  const root = join(base, 'child');
  const git = gitIn(base);
  try {
    initRepo(git, repo);
    const original = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', 'unrelated');
    git(repo, 'branch', 'a0-sibling/task');
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
    // Mount sources are descriptors from FD 4 (FD 3 is the child report slot).
    const result = await spawnLaunch(launchIn(root, '/bin/sh', ['-c', script], { bwrap: locateBwrap() }));
    assert.equal(result.status, 0, result.err);
    assert.equal(readFileSync(join(root, 'note'), 'utf8'), 'child\n');
    assert.equal(git(repo, 'rev-parse', 'unrelated'), original);
    assert.notEqual(git(root, 'rev-parse', 'HEAD'), original);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.deepEqual(
      git(repo, 'for-each-ref', '--format=%(refname)')
        .split('\n')
        .filter(x => x.startsWith('refs/heads/a0-child/')),
      ['refs/heads/a0-child/task'],
    );
  } finally {
    tmp.cleanup();
  }
});

// ---- ported from A0 security-fix.test.ts (the M1 mount cases and m2) ----

test('M1: sandbox mounts make Git pointers, HEAD, config, hooks and alternates read-only; sources are descriptors', () => {
  const r = linkedRepo();
  try {
    // New in P2-5: the admin dir is writable, so a `config`, `config.worktree` or `hooks` already in it is bound
    // read-only too.
    writeFileSync(join(r.admin, 'config'), '');
    writeFileSync(join(r.admin, 'config.worktree'), '');
    mkdirSync(join(r.admin, 'hooks'));
    const launch = launchIn(r.wt, '/bin/true', []);
    try {
      const mounts = fdMounts(launch.args);
      const c = join(r.repo, '.git');
      for (const ro of [join(r.wt, '.git'), join(r.admin, 'gitdir'), join(r.admin, 'commondir'), join(r.admin, 'HEAD'), join(c, 'config'), join(c, 'refs'), join(c, 'objects', 'info')]) assert.ok(mounts.includes(`ro ${ro}`), ro);
      for (const ro of ['config', 'config.worktree', 'hooks']) assert.ok(mounts.includes(`ro ${join(r.admin, ro)}`), ro);
      for (const rw of [r.wt, r.admin, join(c, 'objects'), join(c, 'refs', 'heads', 'a0-child')]) assert.ok(mounts.includes(`rw ${rw}`), rw);
      assert.ok(!launch.args.some((a, i) => (a === '--bind' || a === '--ro-bind') && launch.args[i + 1]!.startsWith(r.base)), 'no path-based bind into the sandbox-writable tree');
      assert.equal(launch.fds.length, mounts.length);
      assert.equal(launch.gitPin?.kind, 'linked');
    } finally {
      launch.close();
    }
    // PR #30: the repository's own (ordinary) checkout refuses. Its `.git` must stay writable for Git's locks, so no
    // overlay could keep a planted `commondir` out.
    assert.throws(() => launchIn(r.repo, '/bin/true', []), typed('sandbox_git_ordinary_checkout_refused'));
  } finally {
    r.cleanup();
  }
});

test('m2: relaunch refuses a retargeted HEAD instead of mounting a sibling namespace', () => {
  const r = linkedRepo();
  try {
    const first = launchIn(r.wt, '/bin/true', []);
    first.close();
    r.git(r.repo, 'branch', 'a0-sibling/task');
    writeFileSync(join(r.admin, 'HEAD'), 'ref: refs/heads/a0-sibling/task\n');
    assert.throws(() => launchIn(r.wt, '/bin/true', [], { gitPin: first.gitPin }), /git_metadata_changed_since_launch/);
  } finally {
    r.cleanup();
  }
});

test('kernel M1: child cannot rewrite .git, gitdir, commondir, HEAD or alternates; commit still works', { skip, timeout: 60_000 }, async () => {
  const r = linkedRepo();
  try {
    const c = join(r.repo, '.git');
    const script = `set -u
      echo x > f && git add f && git -c user.name=A -c user.email=a@example.invalid commit -qm child || exit 70
      for t in .git ${r.admin}/gitdir ${r.admin}/commondir ${r.admin}/HEAD ${c}/objects/info/alternates ${c}/config; do
        if ( echo planted > "$t" ) 2>/dev/null; then echo "WROTE $t"; exit 71; fi
      done
      if rm -f .git 2>/dev/null || mv .git .g 2>/dev/null; then exit 72; fi
      echo OK`;
    const result = await spawnLaunch(launchIn(r.wt, '/bin/sh', ['-c', script], { bwrap: locateBwrap() }));
    assert.equal(result.status, 0, result.out + result.err);
    assert.notEqual(r.git(r.wt, 'rev-parse', 'HEAD'), r.git(r.repo, 'rev-parse', 'HEAD'));
  } finally {
    r.cleanup();
  }
});

test('git: an ordinary checkout root refuses (409 no_effect) in validation and at spawn, whatever its refs, HEAD or worktrees', () => {
  const r = linkedRepo();
  try {
    const g = join(r.repo, '.git');
    const state = join(r.base, 'state');
    const refused = (label: string) => {
      assert.throws(() => sandboxRoot(childCreate(r.repo), { stateDir: state, paths: [] }), typed('sandbox_git_ordinary_checkout_refused'), label);
      assert.throws(() => launchIn(r.repo, '/bin/true', []), typed('sandbox_git_ordinary_checkout_refused'), label);
    };
    // The matrix PR #30's reviews probed; every layout refuses before any mount, so none of these can be moved.
    refused('flat branch, a linked worktree admin dir (worktrees/wt/commondir) present');
    r.git(r.repo, 'branch', 'unrelated');
    r.git(r.repo, 'checkout', '-qb', 'ns/task');
    refused('a private-looking symbolic HEAD beside an unrelated branch');
    r.git(r.repo, 'symbolic-ref', 'refs/heads/ns/link', 'refs/heads/unrelated');
    refused('a symbolic ref in the namespace');
    r.git(r.repo, 'pack-refs', '--all');
    refused('packed refs');
    writeFileSync(join(g, 'logs', 'refs', 'heads', 'ns', 'other'), '');
    refused('a reflog sibling');
    writeFileSync(join(g, 'HEAD'), 'ref: refs/heads/unrelated\n');
    refused('a retargeted HEAD');
    r.git(r.repo, 'checkout', '-q', '--detach');
    refused('a detached HEAD');
    mkdirSync(join(g, 'worktrees', 'planted'));
    refused('a new admin dir');
    for (const name of ['commondir', 'gitdir']) {
      writeFileSync(join(g, name), `${r.base}\n`);
      refused(name);
    }
  } finally {
    r.cleanup();
  }
});

test("kernel: a linked worktree child cannot move another branch, a symbolic or packed ref, a reflog, HEAD or another worktree's admin dir", { skip, timeout: 60_000 }, async () => {
  const r = linkedRepo();
  try {
    const c = join(r.repo, '.git');
    r.git(r.repo, 'branch', 'unrelated');
    const other = join(r.base, 'other');
    r.git(r.repo, 'worktree', 'add', '-qb', 'b0-other/task', other, 'HEAD');
    const unrelated = r.git(r.repo, 'rev-parse', 'unrelated');
    const head = readFileSync(join(r.admin, 'HEAD'), 'utf8');
    const otherCommondir = readFileSync(join(c, 'worktrees', 'other', 'commondir'), 'utf8');
    // Each probe prints only a fixed marker; a symbolic ref inside the namespace may be made, but updating through it
    // must not reach the branch it names.
    const script = `set -u
      wrote() { echo "WROTE $1"; exit 71; }
      echo z > z && git add z && git -c user.name=A -c user.email=a@example.invalid commit -qm child || exit 70
      git update-ref refs/heads/unrelated HEAD 2>/dev/null && wrote unrelated-ref
      ( echo planted > ${c}/refs/heads/unrelated ) 2>/dev/null && wrote unrelated-ref-file
      git symbolic-ref refs/heads/a0-child/link refs/heads/unrelated 2>/dev/null
      git update-ref refs/heads/a0-child/link HEAD 2>/dev/null && wrote symbolic-ref
      ( printf '%s refs/heads/injected\\n' "$(git rev-parse HEAD)" >> ${c}/packed-refs ) 2>/dev/null && wrote packed-refs
      git pack-refs --all 2>/dev/null && wrote pack-refs
      ( echo planted >> ${c}/logs/refs/heads/unrelated ) 2>/dev/null && wrote unrelated-reflog
      ( echo planted >> ${c}/logs/HEAD ) 2>/dev/null && wrote common-head-reflog
      git symbolic-ref HEAD refs/heads/unrelated 2>/dev/null && wrote head-retarget
      ( echo 'ref: refs/heads/unrelated' > ${r.admin}/HEAD ) 2>/dev/null && wrote head-file
      ( echo ../../planted > ${c}/worktrees/other/commondir ) 2>/dev/null && wrote other-commondir
      mkdir ${c}/worktrees/planted 2>/dev/null && wrote new-admin-dir
      ( mkdir -p ${c}/hooks && echo planted > ${c}/hooks/pre-commit ) 2>/dev/null && wrote common-hooks
      ( echo planted > ${c}/commondir ) 2>/dev/null && wrote common-commondir
      ( echo planted > ${c}/shallow ) 2>/dev/null && wrote shallow
      echo OK`;
    const result = await spawnLaunch(launchIn(r.wt, '/bin/sh', ['-c', script], { bwrap: locateBwrap() }));
    assert.equal(result.status, 0, result.out);
    assert.equal(result.out.trim(), 'OK');
    assert.notEqual(r.git(r.wt, 'rev-parse', 'HEAD'), unrelated, 'the child committed on its own branch');
    assert.equal(r.git(r.repo, 'rev-parse', 'unrelated'), unrelated);
    assert.equal(readFileSync(join(r.admin, 'HEAD'), 'utf8'), head);
    assert.equal(readFileSync(join(c, 'worktrees', 'other', 'commondir'), 'utf8'), otherCommondir);
    for (const name of ['worktrees/planted', 'hooks/pre-commit', 'commondir', 'shallow']) assert.equal(existsSync(join(c, name)), false, name);
    assert.ok(!r.git(r.repo, 'for-each-ref', '--format=%(refname)').split('\n').includes('refs/heads/injected'));
  } finally {
    r.cleanup();
  }
});

// ---- new in P2-5 ----

test("git: config is judged by Git's own parser: include, includeIf or worktreeConfig refuse in LF, CRLF and inline-header forms; unparseable config refuses", () => {
  const r = linkedRepo();
  try {
    const config = join(r.repo, '.git', 'config');
    const original = readFileSync(config, 'utf8');
    const state = join(r.base, 'state');
    const refused = (extra: string, code: string) => {
      writeFileSync(config, original + extra);
      assert.throws(() => sandboxRoot(childCreate(r.wt), { stateDir: state, paths: [] }), typed(code), JSON.stringify(extra));
      assert.throws(() => launchIn(r.wt, '/bin/true', []), typed(code), JSON.stringify(extra));
    };
    const evil = join(r.wt, 'evil.cfg');
    for (const eol of ['\n', '\r\n']) {
      refused(`[include]${eol}\tpath = ${evil}${eol}`, 'sandbox_git_config_include_refused');
      refused(`[includeIf "gitdir:/"]${eol}\tpath = ${evil}${eol}`, 'sandbox_git_config_include_refused');
      // A section header may follow another on the same line (PR #30, astra F3).
      refused(`[core] [include]${eol}path = ${evil}${eol}`, 'sandbox_git_config_include_refused');
      refused(`[core] [includeIf "gitdir:/"]${eol}path = ${evil}${eol}`, 'sandbox_git_config_include_refused');
      refused(`[extensions]${eol}\tworktreeConfig = true${eol}`, 'sandbox_git_worktree_config_refused');
      // A bare key is true in Git, a key may share its line with the header, and any true value counts.
      refused(`[extensions]${eol}\tworktreeConfig${eol}`, 'sandbox_git_worktree_config_refused');
      refused(`[extensions] worktreeConfig = yes # on${eol}`, 'sandbox_git_worktree_config_refused');
      refused(`[core] [extensions] worktreeConfig${eol}`, 'sandbox_git_worktree_config_refused');
      refused(`[extensions]${eol}\tworktreeConfig = false${eol}\tworktreeConfig = 1${eol}`, 'sandbox_git_worktree_config_refused');
    }
    refused('[core\n', 'sandbox_git_config_invalid');
    refused('[extensions]\n\tworktreeConfig = maybe\n', 'sandbox_git_config_invalid');
    writeFileSync(config, `${original}[extensions]\r\n\tworktreeConfig = false\r\n`);
    launchIn(r.wt, '/bin/true', []).close();
    // The ordinary layout refuses before its config is read, whatever the config holds.
    writeFileSync(config, `${original}[core] [include]\r\npath = ${evil}\r\n`);
    assert.throws(() => launchIn(r.repo, '/bin/true', []), typed('sandbox_git_ordinary_checkout_refused'));
    writeFileSync(config, original);
    launchIn(r.wt, '/bin/true', []).close();
  } finally {
    r.cleanup();
  }
});

test('git: a linked worktree whose repository lies inside its root, or contains it, refuses (409 no_effect) before any mount', () => {
  const tmp = privateTmp();
  const base = realpathSync(tmp.dir);
  const git = gitIn(base);
  try {
    const state = join(base, 'state');
    const refused = (root: string) => {
      assert.throws(() => sandboxRoot(childCreate(root), { stateDir: state, paths: [] }), typed('sandbox_git_common_dir_overlaps_root'), root);
      assert.throws(() => launchIn(root, '/bin/true', []), typed('sandbox_git_common_dir_overlaps_root'), root);
    };
    // PR #30, grok F1: the common hooks (and every admin dir) would be writable through the root bind.
    const { wt, inner } = nestedRepo(git, base, 'nest');
    assert.equal(git(wt, 'rev-parse', '--git-common-dir'), join(inner, '.git'));
    refused(wt);
    // A worktree inside the common dir exposes part of it the same way.
    const within = join(inner, '.git', 'inside');
    git(inner, 'worktree', 'add', '-qb', 'in/task', within, 'HEAD');
    refused(within);
  } finally {
    tmp.cleanup();
  }
});

test('git: a gitfile copied into another root, a gitfile naming no worktree admin dir, a linked .git and a non-object detached HEAD refuse', () => {
  const r = linkedRepo();
  try {
    const gitfile = readFileSync(join(r.wt, '.git'), 'utf8');
    const other = join(r.base, 'other');
    mkdirSync(other);
    // The admin dir names the worktree back: another root never gets that admin dir writable.
    writeFileSync(join(other, '.git'), gitfile);
    assert.throws(() => launchIn(other, '/bin/true', []), /sandbox_git_not_linked_worktree/);
    writeFileSync(join(other, '.git'), `gitdir: ${join(r.repo, '.git')}\n`);
    assert.throws(() => launchIn(other, '/bin/true', []), /sandbox_git_not_linked_worktree/);
    writeFileSync(join(other, '.git'), 'not a gitfile\n');
    assert.throws(() => launchIn(other, '/bin/true', []), /sandbox_git_invalid_gitfile/);
    execFileSync('rm', [join(other, '.git')]);
    symlinkSync(join(r.repo, '.git'), join(other, '.git'));
    assert.throws(() => launchIn(other, '/bin/true', []), /sandbox_git_invalid_gitfile/);
    // A detached HEAD is writable, so it must be an object name; `ref:` without the space is a symbolic ref to Git.
    const head = r.git(r.wt, 'rev-parse', 'HEAD');
    r.git(r.repo, 'branch', 'a0-sibling/task');
    writeFileSync(join(r.admin, 'HEAD'), 'ref:refs/heads/a0-sibling/task\n');
    assert.throws(() => launchIn(r.wt, '/bin/true', []), /sandbox_git_invalid_head/);
    writeFileSync(join(r.admin, 'HEAD'), `${head}\n`);
    const detached = launchIn(r.wt, '/bin/true', []);
    detached.close();
    assert.equal(detached.gitPin?.head, null);
    assert.ok(!fdMounts(detached.args).some(m => m.endsWith('/refs/heads/a0-child')), 'a detached worktree gets no branch namespace');
  } finally {
    r.cleanup();
  }
});

test('git: a Git mount containing or inside the state or a control path is refused before any record', () => {
  const r = linkedRepo();
  try {
    const c = join(r.repo, '.git');
    const state = join(r.base, 'state');
    mkdirSync(state);
    assert.equal(sandboxRoot(childCreate(r.wt), { stateDir: state, paths: [] }).gitPin?.kind, 'linked');
    const inObjects = join(c, 'objects', 'piw-state');
    mkdirSync(inObjects);
    assert.throws(() => sandboxRoot(childCreate(r.wt), { stateDir: inObjects, paths: [] }), /sandbox_git_overlaps_protected_control_path/);
    assert.throws(() => sandboxRoot(childCreate(r.wt), { stateDir: state, paths: [join(c, 'refs', 'heads')] }), /sandbox_git_overlaps_protected_control_path/);
    assert.throws(() => sandboxRoot(childCreate(r.wt), { stateDir: state, paths: [r.base] }), /overlaps_protected_control_path/);
  } finally {
    r.cleanup();
  }
});

/** A stand-in bwrap that records its argv in `out`, then exits. */
function fakeBwrap(dir: string, out: string): string {
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'bwrap');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}.argv'\nmv '${out}.argv' '${out}.argv.done'\n`);
  chmodSync(path, 0o755);
  return path;
}

test('git: a create refuses bad Git metadata before any record; its spawn mounts only the pin its validation accepted', async () => {
  const launches: HostLaunch[] = [];
  const f = fixture({
    launch: launch => {
      launches.push(launch);
      return undefined;
    },
  });
  const tmp = privateTmp();
  const tree = realpathSync(tmp.dir);
  const git = gitIn(tree);
  try {
    const repo = join(tree, 'repo');
    initRepo(git, repo);
    const parentCwd = join(tree, 'parent');
    mkdirSync(parentCwd);
    const spec: Spec = { environment: { id: 'family', revision: 1, root: tree, allowed_methods: ['children.report'] }, role: 'parent', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' };
    const made = await f.supervisor.create({ command_id: 'parent', cwd: parentCwd, provider: 'p', model: 'm', thinking: 'off', launch_spec: spec });
    assert.equal(made.state, 'delivered', JSON.stringify(made));
    const parent = f.supervisor.get(made.worker_id!);
    assert.equal((await f.supervisor.prompt(parent.worker_id, { ...bind(parent, 'run'), message: 'run' })).state, 'delivered');
    const running = f.supervisor.get(parent.worker_id);
    const child = (name: string, cwd: string): Create => ({
      command_id: name,
      cwd,
      provider: 'p',
      model: 'm',
      thinking: 'off',
      parent: { worker_id: parent.worker_id, worker_epoch: parent.worker_epoch, session_id: parent.session_id!, binding_revision: parent.binding_revision, execution_id: running.execution!.execution_id, task_id: `task-${name}`, generation_id: 'gen' },
      launch_spec: { ...spec, role: 'child', environment: { id: name, revision: 1, allowed_methods: ['children.report'], filesystem: 'bwrap', root: cwd } },
    });
    // A flat branch refuses in validation: nothing recorded, no factory call.
    const flat = join(tree, 'flat');
    git(repo, 'worktree', 'add', '-qb', 'flat', flat, 'HEAD');
    const before = launches.length;
    await assert.rejects(f.supervisor.create(child('flat', flat)), /sandbox_git_branch_requires_private_namespace/);
    assert.equal(launches.length, before, 'no spawn for refused Git metadata');
    assert.equal(f.supervisor.receipts.all.has('flat'), false, 'a refusal before any record');
    // PR #30: an ordinary checkout root and a repository inside the root refuse the same way.
    const nested = nestedRepo(git, tree, 'nest').wt;
    for (const [name, cwd, code] of [
      ['ordinary', repo, 'sandbox_git_ordinary_checkout_refused'],
      ['nested', nested, 'sandbox_git_common_dir_overlaps_root'],
    ] as const) {
      await assert.rejects(f.supervisor.create(child(name, cwd)), typed(code), name);
      assert.equal(launches.length, before, name);
      assert.equal(f.supervisor.receipts.all.has(name), false, name);
    }
    // An accepted child: the factory gets the pin its validation read.
    const wt = join(tree, 'wt');
    git(repo, 'worktree', 'add', '-qb', 'ns/task', wt, 'HEAD');
    const ok = await f.supervisor.create(child('wt', wt));
    assert.equal(ok.state, 'delivered', JSON.stringify(ok));
    const launch = launches.find(l => l.workerId === ok.worker_id)!;
    assert.equal(launch.sandbox, wt);
    assert.equal(launch.gitPin?.kind, 'linked');
    assert.equal(launch.gitPin?.head, 'ref: refs/heads/ns/task\n');
    assert.equal(launch.gitPin?.common_dir, join(repo, '.git'));
    // The production factory hands that pin to the launch: a HEAD retargeted after validation refuses, and bwrap never
    // runs; with the validated metadata back, it runs with the worktree's own namespace writable.
    const out = join(tree, 'capture');
    const factory = productionHosts(fakeBwrap(tree, out), SYNTHETIC_ENV).factory;
    const admin = join(repo, '.git', 'worktrees', 'wt');
    git(repo, 'branch', 'other/task');
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/other/task\n');
    assert.throws(() => factory({ ...launch, prefix: [] }), /git_metadata_changed_since_launch/);
    assert.equal(existsSync(`${out}.argv.done`), false, 'bwrap never ran');
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/ns/task\n');
    const host = factory({ ...launch, prefix: [] }) as SdkHost;
    await once(host, 'exit');
    const args = readFileSync(`${out}.argv.done`, 'utf8').trim().split('\n');
    const mounts = fdMounts(args);
    assert.ok(mounts.includes(`rw ${join(repo, '.git', 'refs', 'heads', 'ns')}`));
    assert.ok(!mounts.some(m => m.endsWith('/refs/heads/other')));
  } finally {
    f.cleanup();
    tmp.cleanup();
  }
});
