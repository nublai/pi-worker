/**
 * Owner Git (P2-6), ported from A0 `src/git-safe.ts`: the one way owner-side code (the supervisor, the harness,
 * Maestro) runs Git in a checkout a sandboxed agent could write.
 *
 * A pin compare followed by `git --git-dir=<path>` is not one step: Git would re-open the gitfile, `commondir`, HEAD and
 * config by path, and a sandboxed writer can rewrite admin files in that window. So every call:
 *  1. opens the checkout's `.git`, admin and common dirs with O_NOFOLLOW and compares the launch-time pin (gitfile,
 *     gitdir, commondir, symbolic HEAD, config hash, alternates) through those descriptors;
 *  2. copies HEAD, config (re-hashed against the pin), refs, packed-refs, shallow and the index from the SAME
 *     descriptors (never `info/`: its exclude, attributes, grafts and sparse-checkout files each change what Git
 *     reports, step 6) into a fresh mode-0700 snapshot directory in
 *     the supervisor's state, `<stateDir>/git-snapshots/` (`$XDG_STATE_HOME/pi-worker/git-snapshots/`), never under
 *     `TMPDIR`. Its real path, read back from its open descriptor, must lie outside the checkout, the admin dir and the
 *     common dir: a path string (a symlinked `TMPDIR` or state directory) cannot put it where the agent writes;
 *  3. refuses a config that names a program Git could run (filters, diff drivers, textconv, includes, aliases,
 *     credential helpers, help viewers and browsers, ...): `-c` cannot neutralise a driver it does not know the name
 *     of, and worktree `.gitattributes` (agent data) selects drivers by name. It also refuses any `protocol.allow` or
 *     `protocol.<name>.allow` other than `never` (`-c protocol.allow=never` does not override a specific key), and a
 *     split index (a `sharedindex.*` file in the admin dir, or `core.splitIndex`): the snapshot copies only `index`;
 *  4. runs Git with GIT_DIR = that snapshot (no `commondir`, so nothing is redirected), objects from the pinned common
 *     dir (content-addressed data), a clean environment allowlist, no global/system/XDG config or attributes, fsmonitor
 *     and hooks disabled, replacement objects off (`GIT_NO_REPLACE_OBJECTS`), no glob pathspecs and every caller path
 *     literal (`:(literal)`), no exclude file (`core.excludesFile=/dev/null`), every transport
 *     refused (`protocol.allow`, and `protocol.ext.allow` and `protocol.file.allow` by name), and on diff-family and
 *     status commands `--no-ext-diff --no-textconv --ignore-submodules=all` (on the command line: an agent-written
 *     `.gitmodules` `ignore = none` overrides `diff.ignoreSubmodules`, and Git then runs inside the nested repository).
 *  5. on the calls that read the index (`gitStatus`, a worktree or cached `gitDiff`, `gitLsFiles`), fails closed on
 *     index state that hides tracked changes, all of it writable by the sandbox (the admin dir's index) or pinned by the
 *     owner (config): any index entry marked assume-unchanged or skip-worktree, any entry whose mode is not a regular
 *     file, an executable, a symlink or a gitlink (a sparse index's directory entry, mode 040000, makes Git skip the
 *     directory whole), and a sparse index's `sdir` extension (`git_index_hides_changes`, read from
 *     the snapshot's copy of the index, the bytes Git then reads, at most 256 MiB: a larger one is
 *     `git_index_too_large`; an index format this reader does not know is `git_index_unreadable`), and, on the calls
 *     that compare the working tree, a pinned `core.ignoreStat`, `core.sparseCheckout` or `index.sparse`
 *     (`git_config_trusts_stat`). `core.checkStat`, `core.trustctime` and `core.untrackedCache` (also an
 *     untracked cache stored in the index) are overridden on the command line to Git's full checks, which can only add
 *     content comparisons. Nothing else in that index is trusted either: in the snapshot's copy (never the checkout's
 *     own index) every entry's recorded stat data (ctime, mtime, dev, ino, size) is zeroed, so Git re-reads and hashes
 *     every tracked file (a recorded size of 0 makes Git compare content whenever the stat differs, and a real file's
 *     ctime and inode are never 0), and the cache-tree extension (`TREE`, which can vouch that a staged directory
 *     matches HEAD) is dropped with the two that describe the old layout (`EOIE`, `IEOT`); the index checksum is
 *     written anew (Git does not check it on read, so neither does this reader). An index Git then cannot read (its own
 *     checks, past this reader's) refuses `git_index_unreadable` too, never a guess. The other extensions are kept, and
 *     none can make a read report clean or unchanged: `UNTR` (the untracked cache) is off by `core.untrackedCache=false`
 *     (`ls-files --others` never uses it), `FSMN` is ignored with `core.fsmonitor=false` on every call, `link` names a
 *     shared index the snapshot never has (Git fails; `sharedindex.*` beside the index already refuses), and `REUC`
 *     (resolve-undo) and unknown optional extensions are not read by status or diff.
 *  6. on the calls that list untracked files (`gitStatus`, `gitLsFiles` with `untracked`), trusts no exclude state:
 *     the snapshot has no `info/exclude` (step 2) and `core.excludesFile` is `/dev/null` (step 4), so neither a
 *     repository exclude file nor a configured one hides a file. Status runs with `--untracked-files=all` (every
 *     untracked file listed one by one, whatever `status.showUntrackedFiles` says; porcelain v1 reads no other
 *     `status.*` key that changes what it lists) and `--ignored=traditional`: a file a `.gitignore` in the tree ignores
 *     (tree data the child writes or commits) is listed too, as `!!`. `ls-files --others` reads no exclude source at
 *     all. Untracked content below pi-worker's runtime directories at the root (`.piw-agent`, `.piw-worker`,
 *     `.piw-slots`; sandbox.ts) is left out: status drops its `??` and `!!` lines, `ls-files --others` excludes it by
 *     pathspec. Tracked, staged and unmerged entries there are reported like any other. Git skips every entry named
 *     `.git` when it lists untracked files and never looks inside a gitlink (`--ignore-submodules=all`, step 4), so both
 *     calls first walk the checkout (descriptors, no link followed; the runtime directories skipped) and refuse any
 *     nested `.git` (`git_nested_repository_refused`), and every index read refuses an index holding a gitlink
 *     (`git_gitlink_refused`, step 5's reader). Git never runs inside a nested repository.
 *  7. on every call, compares as the owner's Linux service does, whatever the pinned config says: `core.ignoreCase`
 *     false (a case-variant untracked file is listed), `core.symlinks` true (a symlink replaced by a file is a type
 *     change) and `core.fileMode` true (a mode change is a change). Overridden, not refused: the overrides can only add
 *     differences.
 *
 * What a status here is: Git's normalised comparison of the checkout with its HEAD and index, a hygiene fact. It is not
 * proof that the checkout's bytes equal the commit's: in-tree `.gitattributes` (`ident`, `text`, `eol`) normalise
 * content before Git compares it, and a status is a point in time.
 *
 * The API is typed: one function per supported inspection (status, diff, log, show, rev-parse, cat-file, ls-files, ls-tree,
 * for-each-ref, merge-base). Callers pass validated values (revisions, paths, ref prefixes, counts), never options:
 * owner Git builds every argv itself and places `--end-of-options` and `--`. A value that starts with `-`, pathspec
 * magic, or a control character refuses (`git_argument_refused`) before anything is opened. Adding a function or an
 * option needs the rule 6 security review. Owner Git never re-opens an agent-writable path for anything that selects
 * code to execute. Read-only: writes Git makes land in the discarded snapshot.
 *
 * Named limits: a supervisor killed during a call leaves its snapshot (a copy of the repository's config and refs) in the
 * private snapshot directory; it is no new authority (mode 0700, same user). Every call is synchronous (it copies the
 * snapshot and waits for Git): a long-lived process that must keep answering (the supervisor) runs owner Git in a child
 * process of its own, never on its event loop (supervisor/artifacts.ts).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, readSync, rmSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { Refusal } from '../b2/errors.js';
import { assertPin, checkConfig, inspect, type GitPin } from '../sandbox/git-sandbox.js';
import { AGENT_DIR, SLOTS_DIR, WORKER_DIR } from '../sandbox/sandbox.js';
import { DIR_FLAGS, FILE_FLAGS, fdPath, isMissing, openPinned, openUnder, readFd } from '../sandbox/pinned-fs.js';
export type { GitPin } from '../sandbox/git-sandbox.js';

/** Where owner Git and its environment come from. */
export interface OwnerGit {
  /** The supervisor's state directory (`resolvePaths().stateDir`): snapshots are made in its `git-snapshots`. */
  readonly stateDir: string;
  /** The environment PATH and the locale are taken from (the supervisor's own); nothing else in it reaches Git. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A checkout owner Git inspects: the owner, the checkout root and the root's launch-time pin. */
export interface GitCheckout {
  readonly owner: OwnerGit;
  readonly root: string;
  readonly pin: GitPin | null | undefined;
}

export const SAFE_GIT_CONFIG = [
  ...['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'core.excludesFile=/dev/null', 'diff.ignoreSubmodules=all', 'submodule.recurse=false'],
  // Step 7: the owner's comparison semantics.
  ...['core.ignoreCase=false', 'core.symlinks=true', 'core.fileMode=true'],
  ...['protocol.allow=never', 'protocol.ext.allow=never', 'protocol.file.allow=never'],
].flatMap(setting => ['-c', setting]);
/** Config keys whose value names a program Git can run. */
const EXECUTES =
  /^(include|includeif)\.|^filter\.|^diff\.external$|^diff\..+\.(command|textconv)$|^merge\..+\.driver$|^alias\.|^gpg\.(.+\.)?program$|^core\.(sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$|^pager\.|^sequence\.editor$|^uploadpack\.packobjectshook$|^credential\.(.+\.)?helper$/i;
/**
 * The other documented keys that name a program or a shell command (git-config(1), git-send-email(1), git-archive(1)),
 * and the help dispatch keys (`help.*`, `man.*`, `web.browser`, `browser.*`): help is not reachable through the typed
 * API, but a key that selects a program refuses all the same.
 */
const EXECUTES_TOO =
  /^(help|man|browser)\.|^web\.browser$|^interactive\.difffilter$|^gpg\.ssh\.defaultkeycommand$|^gc\.recentobjectshook$|^(difftool|mergetool)\..+\.(cmd|path)$|^guitool\..+\.cmd$|^imap\.tunnel$|^instaweb\.(httpd|browser)$|^remote\..+\.(receivepack|uploadpack)$|^trailer\..+\.(command|cmd)$|^sendemail\.(.+\.)?(cccmd|tocmd|headercmd|smtpserver|sendmailcmd)$|^tar\..+\.command$/i;
/** `submodule.<name>.update` runs a command when its value starts with `!`. */
const SUBMODULE_UPDATE = /^submodule\..+\.update$/i;
/** `protocol.allow` and `protocol.<name>.allow`: any value but `never` refuses. */
const PROTOCOL_ALLOW = /^protocol\.(.+\.)?allow$/i;
const SPLIT_INDEX = /^core\.splitindex$/i;
/** Pinned settings that make Git trust stat data or skip paths when it compares the working tree (step 5): true refuses. */
const STAT_TRUST = /^(core\.ignorestat|core\.sparsecheckout|index\.sparse)$/i;
/** Step 5's command-line overrides: full stat checks, no untracked cache (a config's, or one stored in the index). */
const WORKTREE_CONFIG = ['core.checkStat=default', 'core.trustctime=true', 'core.untrackedCache=false', 'core.ignoreStat=false'].flatMap(setting => ['-c', setting]);
/** Git's false spellings; a key with no value is true. */
const FALSE = new Set(['false', 'no', 'off', '0', '']);
const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES'];
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
    // Artifact identity is the commit and its native tree: a copied `refs/replace/*` must not substitute objects.
    GIT_NO_REPLACE_OBJECTS: '1',
    // No glob in any pathspec; a caller's path also carries `:(literal)` (`pathArgs`), so it is never magic either.
    GIT_NOGLOB_PATHSPECS: '1',
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

/**
 * Steps 1-3: compare the pin and copy the pinned metadata through the same descriptors. With `worktree`, the call
 * compares the working tree with the index: step 5's config refusals too.
 */
function snapshot(owner: OwnerGit, root: string, expected: GitPin, dir: string, worktree = false): Snapshot {
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
    refuseSplitIndex(admin);
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
  return refuseExecutingConfig(owner, dir, worktree);
}

/** What the snapshot's config says about reading its index: the length of an object id. */
interface Snapshot {
  readonly oidBytes: number;
}

/** HEAD selects a branch, never code; still demand the pinned shape. */
function headMatches(pin: GitPin, head: string | null): boolean {
  if (head === null) return false;
  if (pin.head !== null) return head === pin.head;
  return /^[a-f0-9]{40,64}\s*$/.test(head);
}

function readBytes(base: number, names: string[], limit?: number): Buffer | null {
  let fd: number;
  try {
    fd = openUnder(base, names, 'file');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return readFd(fd, limit);
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

/** The rest of the open file `fd` into a new entry `name` of `dest`. */
function copyFd(fd: number, dest: number, name: string, budget: Budget): void {
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
  } finally {
    closeSync(out);
  }
}

/**
 * Copies the regular file `names` below `source` to `name` in `dest` through one O_NOFOLLOW descriptor; an absent entry
 * is skipped.
 */
function copyFileAt(source: number, names: string[], dest: number, name: string, budget: Budget): void {
  let fd: number;
  try {
    fd = openUnder(source, names, 'file');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    copyFd(fd, dest, name, budget);
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

/**
 * Refs, packed-refs, shallow and the index: data, copied through the pinned descriptors; links refused. Never `info/`
 * (step 2).
 */
/** The common dir's directories the snapshot copies whole: `refs` only, never `info` (step 2). */
const COPIED_DIRS: readonly string[] = ['refs'];

function copyData(admin: number, common: number, out: number): void {
  const budget: Budget = { entries: 0, bytes: 0 };
  for (const name of ['packed-refs', 'shallow']) copyFileAt(common, [name], out, name, budget);
  // Its mtime does not matter: a call that reads the index blanks every entry's stat data (step 5), so none is trusted.
  copyFileAt(admin, ['index'], out, 'index', budget);
  for (const name of COPIED_DIRS) {
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

/** A split index keeps its entries in `sharedindex.<id>` beside `index`; the snapshot copies only `index`. */
function refuseSplitIndex(admin: number): void {
  if (readdirSync(fdPath(admin)).some(name => name.startsWith('sharedindex.'))) throw new Refusal('git_split_index_refused');
}

/** Step 3 (and with `worktree` step 5's config refusals), with Git's own parser (BOMs, quoting, case) on the private copy. */
function refuseExecutingConfig(owner: OwnerGit, dir: string, worktree = false): Snapshot {
  const listed = spawnSync('git', ['config', '--file', join(dir, 'config'), '--no-includes', '--null', '--list'], { cwd: '/', env: cleanEnv(owner, join(dir, 'home')), stdio: ['ignore', 'pipe', 'ignore'] });
  if (listed.error || listed.status !== 0) throw new Refusal('git_config_unparseable');
  let oidBytes = 20;
  for (const entry of listed.stdout.toString('utf8').split('\0')) {
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? null : entry.slice(newline + 1);
    if (!key) continue;
    if (EXECUTES.test(key)) throw new Refusal(`git_config_executes_code: ${key}`);
    if (EXECUTES_TOO.test(key) || (SUBMODULE_UPDATE.test(key) && value?.startsWith('!'))) throw new Refusal(`git_config_executes_code: ${key}`);
    if (PROTOCOL_ALLOW.test(key) && value?.toLowerCase() !== 'never') throw new Refusal(`git_config_allows_protocol: ${key}`);
    if (SPLIT_INDEX.test(key) && (value === null || !FALSE.has(value.toLowerCase()))) throw new Refusal('git_split_index_refused');
    if (worktree && STAT_TRUST.test(key) && (value === null || !FALSE.has(value.toLowerCase()))) throw new Refusal(`git_config_trusts_stat: ${key}`);
    if (/^extensions\.objectformat$/i.test(key)) oidBytes = value?.toLowerCase() === 'sha256' ? 32 : 20;
  }
  return { oidBytes };
}

/** An index entry's flags: assume-unchanged (CE_VALID), extended flags follow; extended: skip-worktree. */
const ASSUME_VALID = 0x8000;
const EXTENDED = 0x4000;
const SKIP_WORKTREE = 0x4000;

/** Entry modes a status or diff reads file by file: a regular file, an executable, a symlink and a gitlink. */
const FILE_MODES = new Set([0o100644, 0o100755, 0o120000, 0o160000]);
/** A gitlink (a submodule's commit): Git never looks inside it here (step 6). */
const GITLINK = 0o160000;
const MODE_AT = 24;

/** An index as git-index(5) lays it out: where each entry starts, its flags, and the extensions after the entries. */
interface IndexLayout {
  readonly entries: readonly { readonly start: number; readonly hidden: boolean; readonly gitlink: boolean }[];
  /** The offset just past the last entry. */
  readonly entriesEnd: number;
  readonly extensions: readonly { readonly signature: string; readonly start: number; readonly end: number }[];
}

const indexHash = (oidBytes: number) => createHash(oidBytes === 32 ? 'sha256' : 'sha1');

/**
 * Step 5's reader, on the snapshot's copy of the index (the bytes Git reads). Formats 2 to 4 (git-index(5)): the header,
 * every entry, and the extensions framed up to the trailing checksum. Anything this reader does not know, or that does
 * not add up, refuses `git_index_unreadable`.
 */
function indexLayout(index: Buffer, oidBytes: number): IndexLayout {
  const unreadable = () => new Refusal('git_index_unreadable');
  if (index.length < 12 + oidBytes || index.toString('latin1', 0, 4) !== 'DIRC') throw unreadable();
  const version = index.readUInt32BE(4);
  if (version < 2 || version > 4) throw unreadable();
  const count = index.readUInt32BE(8);
  const trailer = index.length - oidBytes;
  const entries: { start: number; hidden: boolean; gitlink: boolean }[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const start = at;
    // ctime, mtime, dev, ino, mode, uid, gid, size (40 bytes), the object id, then the flags.
    at += 40 + oidBytes;
    if (at + 2 > index.length) throw unreadable();
    const flags = index.readUInt16BE(at);
    at += 2;
    let extended = 0;
    if (flags & EXTENDED) {
      if (version < 3 || at + 2 > index.length) throw unreadable();
      extended = index.readUInt16BE(at);
      at += 2;
    }
    // A mode other than a file's: a sparse index's directory (040000, which Git skips whole, flag or not), or one Git
    // does not write.
    const mode = index.readUInt32BE(start + MODE_AT);
    entries.push({ start, hidden: (flags & ASSUME_VALID) !== 0 || (extended & SKIP_WORKTREE) !== 0 || !FILE_MODES.has(mode), gitlink: mode === GITLINK });
    // Version 4: a varint (how much of the previous path to keep), then the rest of the path; no padding.
    if (version === 4)
      do {
        if (at >= index.length) throw unreadable();
      } while (index[at++]! & 0x80);
    const nul = index.indexOf(0, at);
    if (nul < 0) throw unreadable();
    at = nul + 1;
    // Versions 2 and 3: the entry is NUL-padded to a multiple of 8 bytes.
    if (version !== 4) at = start + Math.ceil((at - start) / 8) * 8;
    if (at > trailer) throw unreadable();
  }
  const entriesEnd = at;
  // Extensions: a 4-byte signature and a 4-byte length, then that many bytes; the last ends at the checksum.
  const extensions: { signature: string; start: number; end: number }[] = [];
  while (at < trailer) {
    if (at + 8 > trailer) throw unreadable();
    const end = at + 8 + index.readUInt32BE(at + 4);
    if (end > trailer) throw unreadable();
    extensions.push({ signature: index.toString('latin1', at, at + 4), start: at, end });
    at = end;
  }
  return { entries, entriesEnd, extensions };
}

/** The extension that marks a sparse index (its directory entries are not expanded): `sdir`. */
const SPARSE_INDEX = 'sdir';

/**
 * Step 5: an entry marked assume-unchanged or skip-worktree (a sparse checkout's entries), an entry whose mode is not a
 * file's (a sparse index's directory entry: Git skips the directory, and the files in it are never entries to compare),
 * or a sparse index's `sdir` extension refuses.
 */
function refuseHiddenEntries(layout: IndexLayout): void {
  if (layout.entries.some(entry => entry.hidden) || layout.extensions.some(extension => extension.signature === SPARSE_INDEX)) throw new Refusal('git_index_hides_changes');
  // Step 6: a gitlink's checkout is a nested repository Git never looks inside (`--ignore-submodules=all`).
  if (layout.entries.some(entry => entry.gitlink)) throw new Refusal('git_gitlink_refused');
}

/**
 * Extensions the snapshot's index drops: `TREE` (the cache tree: a forged one vouches that a staged directory matches
 * HEAD, and Git then skips comparing it), and `EOIE` and `IEOT`, which describe the layout the rewrite changes (both
 * only speed loading).
 */
const UNTRUSTED_EXTENSIONS = new Set(['TREE', 'EOIE', 'IEOT']);
/** An entry's recorded stat data: ctime, mtime (seconds and nanoseconds), dev and ino (24 bytes); size (4 at 36). */
const STAT_HEAD = 24;
const SIZE_AT = 36;

/**
 * Step 5: rewrites the snapshot's own index (never the checkout's) so Git trusts nothing in it: every entry's stat data
 * zeroed (mode, uid, gid, object id, flags and path kept), the untrusted extensions dropped, the checksum written anew.
 * `index` is the snapshot's private copy; it is changed in place.
 */
function writeUntrustedIndex(dir: string, index: Buffer, layout: IndexLayout, oidBytes: number): void {
  for (const { start } of layout.entries) {
    index.fill(0, start, start + STAT_HEAD);
    index.fill(0, start + SIZE_AT, start + SIZE_AT + 4);
  }
  const kept = layout.extensions.filter(extension => !UNTRUSTED_EXTENSIONS.has(extension.signature));
  const pieces = [index.subarray(0, layout.entriesEnd), ...kept.map(extension => index.subarray(extension.start, extension.end))];
  const hash = indexHash(oidBytes);
  for (const piece of pieces) hash.update(piece);
  pieces.push(hash.digest());
  const dirFd = openSync(dir, DIR_FLAGS);
  try {
    const fd = openSync(fdPath(dirFd, 'index'), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
      for (const piece of pieces) {
        let off = 0;
        while (off < piece.length) off += writeSync(fd, piece, off, piece.length - off);
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(dirFd);
  }
}

// ---- typed values: what a caller may pass. Never an option; owner Git places `--end-of-options` and `--`. ----

const CONTROL = /[\x00-\x1f\x7f]/;
const refused = (what: string) => new Refusal(`git_argument_refused: ${what}`);
const VALUE_MAX = 4096;

/** A revision (`HEAD`, `v1`, `A..B`, `X^{tree}`, `rev:path`): never an option, no control characters. */
function revision(value: string): string {
  if (typeof value !== 'string' || value === '' || value.length > VALUE_MAX || value.startsWith('-') || CONTROL.test(value)) throw refused('revision');
  return value;
}

/** Revisions after `--end-of-options`, so none can be read as an option. */
const revArgs = (...revs: string[]): string[] => ['--end-of-options', ...revs.map(revision)];

/** A path relative to the root: never an option, never pathspec magic (`:(top)`, `:!`), never absolute or with `..`. */
function path(value: string): string {
  if (typeof value !== 'string' || value === '' || value.length > VALUE_MAX || /^[-:/]/.test(value) || CONTROL.test(value) || value.split('/').includes('..')) throw refused('path');
  return value;
}

/** Paths after `--`, each literal (`:(literal)`: no magic, no glob). */
const pathArgs = (paths: readonly string[] = []): string[] => ['--', ...paths.map(value => `:(literal)${path(value)}`)];

/** Step 6: pi-worker's own runtime directories at the root; untracked content below them is not listed. */
const RUNTIME_DIRS: readonly string[] = [AGENT_DIR, WORKER_DIR, SLOTS_DIR];
/** Step 6, on `ls-files --others` (untracked only): the runtime directories excluded by pathspec, after `pathArgs`. */
const RUNTIME_EXCLUDED = RUNTIME_DIRS.map(name => `:(exclude,literal)${name}`);

/**
 * Step 6, on status: a `??` or `!!` line (untracked, never a rename) for a path at or below a runtime directory. Git
 * quotes a path with special characters (`"…"`); a runtime directory's name has none, so its prefix is intact.
 */
function runtimeUntracked(line: string): boolean {
  const code = line.slice(0, 2);
  if (code !== '??' && code !== '!!') return false;
  const rest = line.slice(3);
  const path = rest.startsWith('"') ? rest.slice(1) : rest;
  return RUNTIME_DIRS.some(dir => path === dir || path.startsWith(`${dir}/`));
}

/** The most entries, and the deepest directory, the nested-repository walk visits before it refuses. */
const WALK_MAX_ENTRIES = 2_000_000;
const WALK_MAX_DEPTH = 256;

/**
 * Step 6: refuses `git_nested_repository_refused` when any entry below the checkout root is named `.git` (a nested
 * repository, a gitfile, or bytes Git would never list), except the root's own gitfile and anything below a runtime
 * directory. Walks through descriptors (O_NOFOLLOW at every step, so a link is never followed); reads names only.
 */
function refuseNestedRepositories(root: string): void {
  let entries = 0;
  const walk = (dir: number, depth: number): void => {
    if (depth > WALK_MAX_DEPTH) throw new Refusal('git_worktree_too_deep');
    for (const entry of readdirSync(fdPath(dir), { withFileTypes: true })) {
      if (++entries > WALK_MAX_ENTRIES) throw new Refusal('git_worktree_too_large');
      if (depth === 0 && (entry.name === '.git' || RUNTIME_DIRS.includes(entry.name))) continue;
      if (entry.name === '.git') throw new Refusal('git_nested_repository_refused');
      if (!entry.isDirectory()) continue;
      let child: number;
      try {
        child = openUnder(dir, [entry.name], 'dir');
      } catch (error) {
        // Gone, or no longer a directory (a link now): nothing to walk.
        if (isMissing(error) || ['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      try {
        walk(child, depth + 1);
      } finally {
        closeSync(child);
      }
    }
  };
  const fd = openPinned(root, 'dir');
  try {
    walk(fd, 0);
  } finally {
    closeSync(fd);
  }
}
/**
 * Step 6, on status: every untracked file listed one by one whatever the config says, and those a `.gitignore` in the
 * tree ignores too (as `!!`).
 */
const ALL_UNTRACKED = ['--untracked-files=all', '--ignored=traditional'];

/** A literal ref prefix under `refs/`: no glob characters, nothing a ref name cannot hold. */
function refPrefix(value: string): string {
  if (typeof value !== 'string' || value.length > VALUE_MAX || !/^refs\/[^\x00-\x20\x7f~^:?*[\\]*$/.test(value) || value.includes('..')) throw refused('ref_prefix');
  return value;
}

/** A positive whole count. */
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw refused('count');
  return value;
}

/** On every diff-family call: no external diff and no textconv, whatever the config says. */
const NO_HELPERS = ['--no-ext-diff', '--no-textconv'];
/**
 * On every diff-family and status call, on the command line: an agent-written `.gitmodules` `ignore = none` overrides
 * `diff.ignoreSubmodules`, and Git then runs Git inside the nested repository, under that repository's own config.
 */
const NO_SUBMODULES = ['--ignore-submodules=all'];

/** How a diff is printed. `patch` is `--binary` (a full patch, binary files included). */
export type DiffFormat = 'patch' | 'stat' | 'name-only' | 'name-status';
const FORMATS: Readonly<Record<DiffFormat, readonly string[]>> = { patch: ['--binary'], stat: ['--stat'], 'name-only': ['--name-only', '-z'], 'name-status': ['--name-status', '-z'] };
function format(value: DiffFormat): readonly string[] {
  if (typeof value !== 'string' || !Object.hasOwn(FORMATS, value)) throw refused('format');
  return FORMATS[value];
}

/** What a diff compares: two revisions; the index against a revision (`--cached`); or the worktree against the index. */
export type DiffOf = { readonly kind: 'revisions'; readonly from: string; readonly to: string } | { readonly kind: 'index'; readonly from: string } | { readonly kind: 'worktree' };
function diffSides(of: DiffOf): string[] {
  switch (of?.kind) {
    case 'revisions':
      return revArgs(of.from, of.to);
    case 'index':
      return ['--cached', ...revArgs(of.from)];
    case 'worktree':
      return revArgs();
    default:
      throw refused('diff');
  }
}

/** What each kind of diff reads besides objects (`run`): a cached diff the index; a worktree diff the working tree too. */
const READS: Readonly<Record<DiffOf['kind'], Reads | undefined>> = { revisions: undefined, index: 'index', worktree: 'worktree' };

const lines = (out: Buffer): string[] => out.toString('utf8').split('\n').filter(Boolean);

/** What a failed Git run carries: its exit status, its signal and the start of its stderr. */
export interface GitFailure {
  readonly command: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/**
 * The most index bytes the hidden-entry check reads into memory: 256 MiB, about two million tracked paths, far past a
 * real repository (the general 1 MiB cap of `readFd` is for config and HEAD, not an index). A larger index refuses
 * `git_index_too_large`; the snapshot's own 1 GiB copy budget still bounds what reaches the snapshot.
 */
const INDEX_READ_MAX = 256 * 1024 * 1024;

/** The snapshot's own copy of the index (private, ours), or null when the checkout has none. */
function readSnapshotIndex(dir: string): Buffer | null {
  const fd = openSync(dir, DIR_FLAGS);
  try {
    return readBytes(fd, ['index'], INDEX_READ_MAX);
  } catch (error) {
    if (error instanceof Refusal && error.message === 'pinned_file_too_large') throw new Refusal('git_index_too_large');
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** Git exited nonzero (or was killed). Not exported: the API is the typed functions (callers read `GitFailure`). */
class GitFailed extends Error implements GitFailure {
  constructor(
    readonly command: string,
    readonly status: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
  ) {
    super(`git ${command} failed: ${stderr}`);
  }
}

/**
 * What a call reads besides objects and refs: `index`, the index (a cached diff, `ls-files`); `worktree`, the working
 * tree compared with the index (status, a worktree diff). Both get step 5's index checks and rewrite; `worktree` also
 * its config refusals and overrides.
 */
type Reads = 'index' | 'worktree';

/** Runs Git on a pinned snapshot with an argv owner Git built; throws a `GitFailure` on a nonzero exit; returns stdout. */
function run(at: GitCheckout, argv: readonly string[], options: { readonly reads?: Reads; readonly lists?: boolean } = {}): Buffer {
  const { owner, root, pin } = at;
  if (!pin) throw new Refusal('git_launch_pin_required');
  const worktree = options.reads === 'worktree';
  const readsIndex = options.reads === 'index' || worktree;
  const dir = privateDir(owner, root, pin);
  try {
    const { oidBytes } = snapshot(owner, root, pin, dir, worktree);
    // Step 6, on a call that lists untracked files: no nested `.git` anywhere Git would skip it.
    if (options.lists === true) refuseNestedRepositories(root);
    // Step 5, on the snapshot's index: the bytes Git reads next.
    const index = readsIndex ? readSnapshotIndex(dir) : null;
    if (index !== null) {
      const layout = indexLayout(index, oidBytes);
      refuseHiddenEntries(layout);
      writeUntrustedIndex(dir, index, layout, oidBytes);
    }
    const home = join(dir, 'home');
    mkdirSync(home, { mode: 0o700 });
    const git = (args: readonly string[], stdout: 'pipe' | 'ignore') =>
      spawnSync('git', ['-C', root, `--git-dir=${dir}`, `--work-tree=${root}`, ...SAFE_GIT_CONFIG, ...(worktree ? WORKTREE_CONFIG : []), ...args], {
        env: cleanEnv(owner, home, join(pin.common_dir, 'objects')),
        stdio: ['ignore', stdout, 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      });
    const result = git(argv, 'pipe');
    if (result.error) throw result.error;
    // An index read that failed: if Git cannot read the rewritten index on its own (`ls-files` reads only the index;
    // its exit, not its translated message, decides), that is the typed refusal, never a guess from the stderr text.
    if (result.status !== 0 && index !== null) {
      const probe = git(['ls-files', '--stage', '-z'], 'ignore');
      if (!probe.error && probe.status !== 0 && probe.signal === null) throw new Refusal('git_index_unreadable');
    }
    if (result.status !== 0) throw new GitFailed(argv[0]!, result.status, result.signal, result.stderr.toString('utf8').slice(0, 512));
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `git status --porcelain` (v1) as Git prints it; with `branch`, its `## ` line first; limited to `paths`. Every
 * untracked file is listed (`??`), and every file a `.gitignore` ignores (`!!`), except below pi-worker's runtime
 * directories (step 6); tracked, staged and unmerged entries there are reported. Refuses a nested repository
 * (`git_nested_repository_refused`) and an index holding a gitlink (`git_gitlink_refused`).
 */
export function gitStatus(at: GitCheckout, options: { readonly branch?: boolean; readonly paths?: readonly string[] } = {}): string {
  const out = run(at, ['status', '--porcelain', ...(options.branch === true ? ['--branch'] : []), ...ALL_UNTRACKED, ...NO_SUBMODULES, ...pathArgs(options.paths)], { reads: 'worktree', lists: true }).toString('utf8');
  // Step 6: untracked content below a runtime directory is not listed; its tracked, staged and unmerged entries are.
  return out
    .split('\n')
    .filter(line => !runtimeUntracked(line))
    .join('\n');
}

/** `git diff` of `of`, printed as `format` (default `patch`), limited to `paths`. */
export function gitDiff(at: GitCheckout, of: DiffOf, options: { readonly format?: DiffFormat; readonly paths?: readonly string[] } = {}): Buffer {
  return run(at, ['diff', ...NO_HELPERS, ...NO_SUBMODULES, ...format(options.format ?? 'patch'), ...diffSides(of), ...pathArgs(options.paths)], { reads: READS[of.kind] });
}

/** One commit of a log: its id and subject line. */
export interface GitLogEntry {
  readonly commit: string;
  readonly subject: string;
}

/** `git log` of `range` (a revision or `A..B`), newest first, at most `max` commits. */
export function gitLog(at: GitCheckout, range: string, max: number): GitLogEntry[] {
  const out = run(at, ['log', ...NO_HELPERS, ...NO_SUBMODULES, '--no-show-signature', '--format=%H %s', `--max-count=${count(max)}`, ...revArgs(range), '--']);
  return lines(out).map(line => {
    const space = line.indexOf(' ');
    return { commit: line.slice(0, space), subject: line.slice(space + 1) };
  });
}

/** `git show` of a revision (its header and diff, as `format`) or of `rev:path` (the blob's bytes). */
export function gitShow(at: GitCheckout, object: string, options: { readonly format?: DiffFormat } = {}): Buffer {
  return run(at, ['show', ...NO_HELPERS, ...NO_SUBMODULES, '--no-show-signature', ...format(options.format ?? 'patch'), ...revArgs(object), '--']);
}

/** `git rev-parse --verify` of one revision: its object id, or with `symbolicFullName` its full ref name. */
export function gitRevParse(at: GitCheckout, rev: string, options: { readonly symbolicFullName?: boolean } = {}): string {
  return run(at, ['rev-parse', '--verify', ...(options.symbolicFullName === true ? ['--symbolic-full-name'] : []), ...revArgs(rev)])
    .toString('utf8')
    .trim();
}

const CAT_FILE = { type: '-t', size: '-s', contents: '-p' } as const;
/** `git cat-file`: an object's type, its size, or its contents (`-p`: a blob's bytes, a tree listed). */
export function gitCatFile(at: GitCheckout, mode: 'type', object: string): string;
export function gitCatFile(at: GitCheckout, mode: 'size', object: string): number;
export function gitCatFile(at: GitCheckout, mode: 'contents', object: string): Buffer;
export function gitCatFile(at: GitCheckout, mode: keyof typeof CAT_FILE, object: string): string | number | Buffer {
  if (typeof mode !== 'string' || !Object.hasOwn(CAT_FILE, mode)) throw refused('cat_file_mode');
  const out = run(at, ['cat-file', CAT_FILE[mode], ...revArgs(object)]);
  if (mode === 'contents') return out;
  const text = out.toString('utf8').trim();
  return mode === 'size' ? Number(text) : text;
}

/**
 * `git ls-files`: the tracked files or, with `untracked`, every untracked file (no exclude file or `.gitignore` read)
 * except below pi-worker's runtime directories (step 6); limited to `paths`. Refuses an index holding a gitlink and,
 * with `untracked`, a nested repository (step 6).
 */
export function gitLsFiles(at: GitCheckout, options: { readonly untracked?: boolean; readonly paths?: readonly string[] } = {}): string[] {
  const untracked = options.untracked === true;
  const out = run(at, ['ls-files', '-z', ...(untracked ? ['--others'] : []), ...pathArgs(options.paths), ...(untracked ? RUNTIME_EXCLUDED : [])], { reads: 'index', lists: untracked });
  return out.toString('utf8').split('\0').filter(Boolean);
}

/** One entry of a tree: its mode (octal text, `160000` a gitlink), type, object id and path from the tree's root. */
export interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly path: string;
}

/** `git ls-tree -r --full-tree` of a revision's tree: every blob, link and gitlink in it (reads objects only). */
export function gitLsTree(at: GitCheckout, rev: string): GitTreeEntry[] {
  const out = run(at, ['ls-tree', '-r', '-z', '--full-tree', ...revArgs(rev)]);
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(record => {
      const tab = record.indexOf('\t');
      const [mode = '', type = '', object = ''] = record.slice(0, tab).split(' ');
      return { mode, type, object, path: record.slice(tab + 1) };
    });
}

/** One ref: its full name, the object it names and that object's type. */
export interface GitRef {
  readonly ref: string;
  readonly object: string;
  readonly type: string;
}

/** `git for-each-ref` of the refs under `prefix` (`refs/` for all), in ref name order. */
export function gitForEachRef(at: GitCheckout, prefix: string): GitRef[] {
  const out = run(at, ['for-each-ref', '--format=%(objectname) %(objecttype) %(refname)', '--end-of-options', refPrefix(prefix)]);
  return lines(out).map(line => {
    const [object = '', type = '', ref = ''] = line.split(' ');
    return { ref, object, type };
  });
}

/** `git merge-base` of two revisions: their best common ancestor. */
export function gitMergeBase(at: GitCheckout, a: string, b: string): string {
  return run(at, ['merge-base', ...revArgs(a, b)])
    .toString('utf8')
    .trim();
}

/** `git --version` of the Git owner Git runs (no repository, no configuration read). */
export function gitVersion(owner: OwnerGit): string {
  const result = spawnSync('git', ['--version'], { cwd: '/', env: cleanEnv(owner, '/nonexistent'), stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) throw new Refusal('git_unavailable');
  return result.stdout.toString('utf8').trim();
}
