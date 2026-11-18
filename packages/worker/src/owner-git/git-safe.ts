/**
 * Owner Git (P2-6), ported from A0 `src/git-safe.ts`: the one way owner-side code (the supervisor, the harness,
 * Maestro) runs Git in a checkout a sandboxed agent could write.
 *
 * A pin compare followed by `git --git-dir=<path>` is not one step: Git would re-open the gitfile, `commondir`, HEAD and
 * config by path, and a sandboxed writer can rewrite admin files in that window. So every call:
 *  1. opens the checkout's `.git`, admin and common dirs with O_NOFOLLOW and compares the launch-time pin (gitfile,
 *     gitdir, commondir, symbolic HEAD, config hash, alternates) through those descriptors;
 *  2. copies HEAD, config (re-hashed against the pin), refs, packed-refs, shallow, info and the index (keeping its
 *     mtime, so racily-clean entries stay racy) from the SAME descriptors into a fresh mode-0700 snapshot directory in
 *     the supervisor's state, `<stateDir>/git-snapshots/` (`$XDG_STATE_HOME/pi-worker/git-snapshots/`), never under
 *     `TMPDIR`. Its real path, read back from its open descriptor, must lie outside the checkout, the admin dir and the
 *     common dir: a path string (a symlinked `TMPDIR` or state directory) cannot put it where the agent writes;
 *  3. refuses a config that names a program Git could run (filters, diff drivers, textconv, includes, aliases,
 *     credential helpers, ...): `-c` cannot neutralise a driver it does not know the name of, and worktree
 *     `.gitattributes` (agent data) selects drivers by name. It also refuses any `protocol.allow` or
 *     `protocol.<name>.allow` other than `never`: `-c protocol.allow=never` does not override a specific key;
 *  4. runs Git with GIT_DIR = that snapshot (no `commondir`, so nothing is redirected), objects from the pinned common
 *     dir (content-addressed data), a clean environment allowlist, no global/system/XDG config or attributes, fsmonitor
 *     and hooks disabled, submodules ignored, every transport refused (`protocol.allow`, and `protocol.ext.allow` and
 *     `protocol.file.allow` by name), and `--no-ext-diff --no-textconv` on diff-family commands.
 *
 * Only local inspection commands run (`OWNER_GIT_COMMANDS`); a transport or any other command is refused before
 * anything is opened. Adding a command needs the rule 6 security review. Owner Git never re-opens an agent-writable
 * path for anything that selects code to execute. Read-only: writes Git makes land in the discarded snapshot.
 *
 * Named limit: a supervisor killed during a call leaves its snapshot (a copy of the repository's config and refs) in the
 * private snapshot directory; it is no new authority (mode 0700, same user).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, constants, fstatSync, futimesSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, readSync, rmSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { Refusal } from '../b2/errors.js';
import { assertPin, checkConfig, inspect, type GitPin } from '../sandbox/git-sandbox.js';
import { DIR_FLAGS, FILE_FLAGS, fdPath, isMissing, openPinned, openUnder, readFd } from '../sandbox/pinned-fs.js';
export type { GitPin } from '../sandbox/git-sandbox.js';

/** Where owner Git and its environment come from. */
export interface OwnerGit {
  /** The supervisor's state directory (`resolvePaths().stateDir`): snapshots are made in its `git-snapshots`. */
  readonly stateDir: string;
  /** The environment PATH and the locale are taken from (the supervisor's own); nothing else in it reaches Git. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The only commands owner Git runs: local inspection. Transport (`fetch`, `ls-remote`, `push`, ...) is refused. */
export const OWNER_GIT_COMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'log', 'show', 'rev-parse', 'cat-file', 'ls-files', 'for-each-ref', 'merge-base']);

export const SAFE_GIT_CONFIG = [
  ...['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'diff.ignoreSubmodules=all', 'submodule.recurse=false'],
  ...['protocol.allow=never', 'protocol.ext.allow=never', 'protocol.file.allow=never'],
].flatMap(setting => ['-c', setting]);
/** Config keys whose value names a program Git can run. */
const EXECUTES =
  /^(include|includeif)\.|^filter\.|^diff\.external$|^diff\..+\.(command|textconv)$|^merge\..+\.driver$|^alias\.|^gpg\.(.+\.)?program$|^core\.(sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$|^pager\.|^sequence\.editor$|^uploadpack\.packobjectshook$|^credential\.(.+\.)?helper$/i;
/** `protocol.allow` and `protocol.<name>.allow`: any value but `never` refuses. */
const PROTOCOL_ALLOW = /^protocol\.(.+\.)?allow$/i;
const DIFF_FAMILY = new Set(['diff', 'diff-tree', 'diff-index', 'diff-files', 'log', 'show']);
const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ'];
/** `path` is `dir` or below it (both canonical). */
const within = (dir: string, path: string): boolean => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`);
const COPY_MAX_ENTRIES = 100_000;
const COPY_MAX_BYTES = 1024 * 1024 * 1024;

/** The current pin of `root` (canonical). Use ONLY for a checkout the owner created and no sandbox has touched yet. */
export function readGitPin(root: string): GitPin {
  const fd = openPinned(root, 'dir');
  try {
    const found = inspect(root, fd);
    for (const open of found.fds) closeSync(open);
    if (!found.pin) throw new Refusal('git_checkout_missing');
    return found.pin;
  } finally {
    closeSync(fd);
  }
}

function cleanEnv(owner: OwnerGit, home: string, objects?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) if (owner.env[k] !== undefined) env[k] = owner.env[k]!;
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    ...(objects === undefined ? {} : { GIT_OBJECT_DIRECTORY: objects }),
  };
}

/** A directory we own that no other user can enter. */
function assertPrivate(fd: number): void {
  const st = fstatSync(fd);
  if (st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) throw new Refusal('git_snapshot_dir_not_private');
}

/**
 * A fresh snapshot directory in `<stateDir>/git-snapshots/`, both ours and mode 0700. Returns its real path, read back
 * from its open descriptor, which must lie outside the checkout, the admin dir and the common dir.
 */
function privateDir(owner: OwnerGit, root: string, pin: GitPin): string {
  if (!isAbsolute(owner.stateDir) || normalize(owner.stateDir) !== owner.stateDir) throw new Refusal('git_snapshot_state_dir_invalid');
  const parent = join(owner.stateDir, 'git-snapshots');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentFd = openSync(parent, DIR_FLAGS);
  try {
    assertPrivate(parentFd);
    const made = mkdtempSync(fdPath(parentFd, 'snap-'));
    const fd = openUnder(parentFd, [basename(made)], 'dir');
    let dir: string;
    try {
      dir = readlinkSync(fdPath(fd));
      assertPrivate(fd);
    } catch (error) {
      rmSync(fdPath(parentFd, basename(made)), { recursive: true, force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
    if ([root, pin.git_dir, pin.common_dir].some(p => within(p, dir))) {
      rmSync(dir, { recursive: true, force: true });
      throw new Refusal('git_snapshot_dir_inside_checkout');
    }
    return dir;
  } finally {
    closeSync(parentFd);
  }
}

/** Steps 1-3: compare the pin and copy the pinned metadata through the same descriptors. */
function snapshot(owner: OwnerGit, root: string, expected: GitPin, dir: string): void {
  const rootFd = openPinned(root, 'dir');
  let fds: number[] = [];
  const out = openSync(dir, DIR_FLAGS);
  try {
    let found: ReturnType<typeof inspect>;
    try {
      found = inspect(root, rootFd);
    } catch (error) {
      throw new Refusal(`git_metadata_changed_since_launch: ${error instanceof Error ? error.message : 'unreadable'}`);
    }
    fds = found.fds;
    assertPin(found.pin, expected);
    const pin = found.pin!;
    const admin = found.admin!;
    const common = found.common!;
    const head = readBytes(admin, ['HEAD']);
    if (!headMatches(pin, head?.toString('utf8') ?? null)) throw new Refusal('git_metadata_changed_since_launch');
    // Config: the bytes Git will read are the bytes hashed here.
    const config = readBytes(common, ['config']);
    let hash: string;
    try {
      hash = checkConfig(config);
    } catch {
      throw new Refusal('git_metadata_changed_since_launch');
    }
    if (hash !== pin.config_sha256) throw new Refusal('git_metadata_changed_since_launch');
    writeNew(out, 'HEAD', head!);
    writeNew(out, 'config', config!);
    copyData(admin, common, out);
  } finally {
    for (const fd of fds) closeSync(fd);
    closeSync(rootFd);
    closeSync(out);
  }
  refuseExecutingConfig(owner, dir);
}

/** HEAD selects a branch, never code; still demand the pinned shape. */
function headMatches(pin: GitPin, head: string | null): boolean {
  if (head === null) return false;
  if (pin.head !== null) return head === pin.head;
  return /^[a-f0-9]{40,64}\s*$/.test(head);
}

function readBytes(base: number, names: string[]): Buffer | null {
  let fd: number;
  try {
    fd = openUnder(base, names, 'file');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return readFd(fd);
  } finally {
    closeSync(fd);
  }
}

function writeNew(dest: number, name: string, bytes: Buffer): void {
  const fd = openSync(fdPath(dest, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  } finally {
    closeSync(fd);
  }
}

interface Budget {
  entries: number;
  bytes: number;
}

/** The rest of the open file `fd` into a new entry `name` of `dest`; with `mtime` (whole seconds), its times set to it. */
function copyFd(fd: number, dest: number, name: string, budget: Budget, mtime?: number): void {
  const out = openSync(fdPath(dest, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      budget.bytes += n;
      if (budget.bytes > COPY_MAX_BYTES) throw new Refusal('git_snapshot_too_large');
      let off = 0;
      while (off < n) off += writeSync(out, buf, off, n - off);
    }
    if (mtime !== undefined) futimesSync(out, mtime, mtime);
  } finally {
    closeSync(out);
  }
}

/**
 * Copies the regular file `names` below `source` to `name` in `dest` through one O_NOFOLLOW descriptor; an absent entry
 * is skipped. With `keepMtime`, the copy gets the source's mtime from that descriptor, rounded DOWN to whole seconds.
 */
function copyFileAt(source: number, names: string[], dest: number, name: string, budget: Budget, keepMtime = false): void {
  let fd: number;
  try {
    fd = openUnder(source, names, 'file');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    const mtime = keepMtime ? Number(fstatSync(fd, { bigint: true }).mtimeNs / 1_000_000_000n) : undefined;
    copyFd(fd, dest, name, budget, mtime);
  } finally {
    closeSync(fd);
  }
}

/** A directory tree between two open directories; a link or a special file anywhere refuses (never followed). */
function copyTreeAt(source: number, dest: number, budget: Budget, depth = 0): void {
  if (depth > 32) throw new Refusal('git_snapshot_too_deep');
  for (const name of readdirSync(fdPath(source))) {
    if (++budget.entries > COPY_MAX_ENTRIES) throw new Refusal('git_snapshot_too_many_entries');
    let fd: number;
    try {
      fd = openSync(fdPath(source, name), FILE_FLAGS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Refusal('git_snapshot_link_refused');
      throw error;
    }
    try {
      const st = fstatSync(fd);
      if (st.isDirectory()) {
        mkdirSync(fdPath(dest, name), { mode: 0o700 });
        const child = openUnder(dest, [name], 'dir');
        try {
          copyTreeAt(fd, child, budget, depth + 1);
        } finally {
          closeSync(child);
        }
      } else if (st.isFile()) copyFd(fd, dest, name, budget);
      else throw new Refusal('git_snapshot_special_file');
    } finally {
      closeSync(fd);
    }
  }
}

/** Refs, packed-refs, shallow, info and the index: data, copied through the pinned descriptors; links refused. */
function copyData(admin: number, common: number, out: number): void {
  const budget: Budget = { entries: 0, bytes: 0 };
  for (const name of ['packed-refs', 'shallow']) copyFileAt(common, [name], out, name, budget);
  // Keep the index mtime: Git treats an entry as racily clean (and compares content) when its mtime is not older than
  // the index file's. A fresh copy time would make a same-second, same-size edit look clean. Rounding down only widens
  // the racy set, so it can add content checks, never skip one.
  copyFileAt(admin, ['index'], out, 'index', budget, true);
  for (const name of ['refs', 'info']) {
    mkdirSync(fdPath(out, name), { mode: 0o700 });
    let src: number;
    try {
      src = openUnder(common, [name], 'dir');
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    try {
      const dest = openUnder(out, [name], 'dir');
      try {
        copyTreeAt(src, dest, budget);
      } finally {
        closeSync(dest);
      }
    } finally {
      closeSync(src);
    }
  }
}

/** Step 3, with Git's own parser (BOMs, quoting, case) on the private copy. */
function refuseExecutingConfig(owner: OwnerGit, dir: string): void {
  const listed = spawnSync('git', ['config', '--file', join(dir, 'config'), '--no-includes', '--null', '--list'], { cwd: '/', env: cleanEnv(owner, join(dir, 'home')), stdio: ['ignore', 'pipe', 'ignore'] });
  if (listed.error || listed.status !== 0) throw new Refusal('git_config_unparseable');
  for (const entry of listed.stdout.toString('utf8').split('\0')) {
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    if (key && EXECUTES.test(key)) throw new Refusal(`git_config_executes_code: ${key}`);
    if (key && PROTOCOL_ALLOW.test(key) && (newline < 0 || entry.slice(newline + 1).toLowerCase() !== 'never')) throw new Refusal(`git_config_allows_protocol: ${key}`);
  }
}

/** The caller's argv, a local inspection command only; external diff and textconv off for diff-family commands. */
function guarded(args: readonly string[]): string[] {
  const [command, ...rest] = args;
  if (command === undefined || !OWNER_GIT_COMMANDS.has(command)) throw new Refusal('git_command_not_allowed');
  return DIFF_FAMILY.has(command) ? [command, '--no-ext-diff', '--no-textconv', ...rest] : [command, ...rest];
}

/** Runs Git on a pinned snapshot; returns the raw result (no status check). */
export function safeGitRun(owner: OwnerGit, root: string, pin: GitPin | null | undefined, args: readonly string[], options: { maxBuffer?: number } = {}): SpawnSyncReturns<Buffer> {
  if (!pin) throw new Refusal('git_launch_pin_required');
  const argv = guarded(args);
  const dir = privateDir(owner, root, pin);
  try {
    snapshot(owner, root, pin, dir);
    const home = join(dir, 'home');
    mkdirSync(home, { mode: 0o700 });
    const result = spawnSync('git', ['-C', root, `--git-dir=${dir}`, `--work-tree=${root}`, ...SAFE_GIT_CONFIG, ...argv], {
      env: cleanEnv(owner, home, join(pin.common_dir, 'objects')),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs Git on a pinned snapshot; throws on a nonzero exit; returns trimmed UTF-8. */
export function safeGit(owner: OwnerGit, root: string, pin: GitPin | null | undefined, args: readonly string[]): string {
  return safeGitBuffer(owner, root, pin, args).toString('utf8').trim();
}

export function safeGitBuffer(owner: OwnerGit, root: string, pin: GitPin | null | undefined, args: readonly string[]): Buffer {
  const result = safeGitRun(owner, root, pin, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').slice(0, 512)}`);
  return result.stdout;
}

/** `git --version` of the Git owner Git runs (no repository, no configuration read). */
export function gitVersion(owner: OwnerGit): string {
  const result = spawnSync('git', ['--version'], { cwd: '/', env: cleanEnv(owner, '/nonexistent'), stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) throw new Refusal('git_unavailable');
  return result.stdout.toString('utf8').trim();
}
