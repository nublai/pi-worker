/**
 * Git metadata in a sandbox root (P2-5), ported from A0 `src/git-sandbox.ts`. The repository's checkout is never mounted
 * wholesale: a root's Git metadata reaches the sandbox only through these binds, each from a descriptor opened with no
 * symlink at any component, so bwrap never re-resolves a path sandboxed code can rename.
 *
 * Read-only inside: everything that decides what Git later executes or where it looks. For a linked worktree that is
 * the worktree's `.git` gitfile, the admin dir's `gitdir`, `commondir` (and `config`, `config.worktree`, `hooks` when
 * present) and a symbolic HEAD, plus the common dir's `config`, `packed-refs`, `shallow`, `info/exclude`, `refs`,
 * `logs` and `objects/info` (alternates). The rest of the common dir (`hooks`, `worktrees`, other worktrees' admin
 * dirs) is not mounted at all. Writable: the admin dir (index, logs, locks, and HEAD when it is detached), the shared
 * object store, and, with a symbolic HEAD, one private branch namespace `refs/heads/<ns>/` with its reflogs, which must
 * hold only the worktree's own branch (loose or packed). A detached HEAD gets no branch namespace.
 *
 * Refused before any record: an ordinary checkout root (a `.git` directory). Its `.git` is both the common and the admin
 * dir, and Git must create files at its top (index and HEAD locks), so it is writable: a sandbox could then plant a
 * `commondir` there that sends the owner's next Git to a config and hooks it wrote, or a `shallow` that cuts history.
 * Neither can be pre-created harmlessly, so no ordinary layout can be made as safe as a linked worktree. Also refused:
 * a gitfile that is not a linked worktree's (its admin dir must name this root back, and lie in its common dir's
 * `worktrees`), a common dir inside the root or containing it (the root bind would make it writable), a config Git
 * cannot parse, one with an `include.*` or `includeIf.*` key (it can pull configuration from a path the sandbox writes)
 * or with `extensions.worktreeConfig` true (it makes the writable admin dir's `config.worktree` effective), judged by
 * Git's own parser on the pinned bytes, a flat branch or a shared branch namespace, and a detached HEAD that is not an
 * object name.
 *
 * The bytes read at validation form a pin (`GitPin`): the launch refuses metadata that differs from the pin it was
 * given (`git_metadata_changed_since_launch`), so a HEAD retargeted after validation never mounts another namespace.
 *
 * Named limit: the object store is shared and writable (a commit creates loose objects), so a sandbox can add or remove
 * objects other checkouts of the repository use. That is an integrity limit, not Git isolation.
 */
import { closeSync, fstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { Refusal } from '../b2/errors.js';
import { DIR_FLAGS, fdPath, isMissing, openPinned, openUnder, readFd, readUnder } from './pinned-fs.js';

/** The launch-time bytes of a root's Git metadata; any change refuses a launch that names this pin. */
export interface GitPin {
  /** Always `linked`: an ordinary checkout root is refused (the B2 schema still names `ordinary`). */
  readonly kind: 'linked' | 'ordinary';
  /** The gitfile's bytes. */
  readonly dot_git: string;
  readonly git_dir: string;
  readonly common_dir: string;
  readonly gitdir_file: string | null;
  readonly commondir_file: string | null;
  /** The worktree's symbolic HEAD (it selects the writable namespace); null when detached. */
  readonly head: string | null;
  readonly config_sha256: string;
  readonly alternates: string | null;
}

export interface GitMount {
  readonly mode: 'bind' | 'ro-bind';
  readonly fd: number;
  readonly dest: string;
}

/** A branch a sandbox may write: `refs/heads/<namespace>/<leaf>`, the namespace its own. */
const PRIVATE_BRANCH = /^refs\/heads\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

/** Git reading only the config bytes on its stdin: no system, global or repository config, no includes followed. */
const GIT_CONFIG_ENV = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };

function gitConfig(bytes: Buffer, args: string[]): { status: number | null; out: string } {
  const r = spawnSync('git', ['config', '--file', '-', '--no-includes', ...args], { input: bytes, cwd: '/', env: GIT_CONFIG_ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw new Refusal('sandbox_git_config_unreadable');
  return { status: r.status, out: r.stdout };
}

/**
 * The sha256 of the Git config bytes the sandbox may see, judged by Git's own parser on exactly those bytes (never a
 * path that could change). Refused: a missing config, one Git cannot parse, any `include.*` or `includeIf.*` key, and
 * `extensions.worktreeConfig` true in any of its values.
 */
export function checkConfig(bytes: Buffer | null): string {
  if (bytes === null) throw new Refusal('sandbox_git_config_missing');
  const list = gitConfig(bytes, ['--list', '--null']);
  if (list.status !== 0) throw new Refusal('sandbox_git_config_invalid');
  // Each entry is `key` (a bare key) or `key\nvalue`; Git lowercases section and variable names.
  const keys = list.out
    .split('\0')
    .filter(Boolean)
    .map(entry => entry.split('\n', 1)[0]!);
  // An include (or includeIf) can pull configuration from a sandbox-writable path.
  if (keys.some(key => key.startsWith('include.') || key.startsWith('includeif.'))) throw new Refusal('sandbox_git_config_include_refused');
  // worktreeConfig makes the writable admin dir's config.worktree effective. Git's bool parser decides (a bare key is
  // true); a value it cannot parse refuses like any other invalid config.
  if (keys.includes('extensions.worktreeconfig')) {
    const values = gitConfig(bytes, ['--type=bool', '--get-all', '--null', 'extensions.worktreeConfig']);
    if (values.status !== 0) throw new Refusal('sandbox_git_config_invalid');
    if (values.out.split('\0').includes('true')) throw new Refusal('sandbox_git_worktree_config_refused');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/** A regular file's bytes below the open directory `base`, no link followed; null only when the final entry is absent. */
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

/** `path` is `dir` or below it (both canonical). */
const within = (dir: string, path: string): boolean => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`);

function samePin(a: GitPin | null, b: GitPin | null): boolean {
  if (a === null || b === null) return a === b;
  const keys = Object.keys(a) as (keyof GitPin)[];
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
}

/** With an `expected` pin, the current one must equal it. */
export function assertPin(current: GitPin | null, expected: GitPin | null | undefined): void {
  if (expected !== undefined && !samePin(current, expected)) throw new Refusal('git_metadata_changed_since_launch');
}

const real = (path: string, error: string): string => {
  try {
    return realpathSync(path);
  } catch {
    throw new Refusal(error);
  }
};

interface Inspection {
  pin: GitPin | null;
  fds: number[];
  dotGit?: number;
  admin?: number;
  common?: number;
}

/**
 * Reads the Git pointers below the open root `rootFd` (the canonical `root`). The caller owns `fds`; `dotGit`, `admin`
 * and `common` are the exact objects the pin was read from.
 */
function inspect(root: string, rootFd: number): Inspection {
  const fds: number[] = [];
  const keep = (fd: number) => {
    fds.push(fd);
    return fd;
  };
  try {
    let dot: number;
    try {
      dot = keep(openSync(fdPath(rootFd, '.git'), DIR_FLAGS));
    } catch (error) {
      if (isMissing(error)) return { pin: null, fds };
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw new Refusal('sandbox_git_invalid_gitfile');
      // Not a directory: a regular gitfile, never a link (O_NOFOLLOW) or anything else.
      try {
        dot = keep(openUnder(rootFd, ['.git'], 'file'));
      } catch {
        throw new Refusal('sandbox_git_invalid_gitfile');
      }
    }
    // An ordinary `.git` (its common and its admin dir at once) must stay writable for Git's top-level locks, so a
    // sandbox could plant a `commondir` or `shallow` there; no mount closes that (module comment).
    if (fstatSync(dot).isDirectory()) throw new Refusal('sandbox_git_ordinary_checkout_refused');
    const text = readFd(dot).toString('utf8');
    if (!text.startsWith('gitdir: ')) throw new Refusal('sandbox_git_invalid_gitfile');
    const adminPath = real(resolve(root, text.slice(8).trim()), 'sandbox_git_not_linked_worktree');
    const admin = keep(openPinned(adminPath, 'dir'));
    const commondir = readUnder(admin, ['commondir']);
    const gitdir = readUnder(admin, ['gitdir']);
    const head = readUnder(admin, ['HEAD']);
    if (commondir === null || gitdir === null || head === null) throw new Refusal('sandbox_git_not_linked_worktree');
    const commonPath = real(resolve(adminPath, commondir.trim()), 'sandbox_git_not_linked_worktree');
    // A common dir (so its hooks, config and every admin dir) inside the root would be writable through the root bind;
    // a root inside the common dir would expose part of it the same way.
    if (within(root, commonPath) || within(commonPath, root)) throw new Refusal('sandbox_git_common_dir_overlaps_root');
    // The admin dir lies in its common dir's `worktrees` and names this root back: a gitfile copied into another root
    // never gets that worktree's admin dir.
    if (dirname(adminPath) !== join(commonPath, 'worktrees') || real(gitdir.trim(), 'sandbox_git_not_linked_worktree') !== join(root, '.git')) {
      throw new Refusal('sandbox_git_not_linked_worktree');
    }
    const common = keep(openPinned(commonPath, 'dir'));
    const pin: GitPin = {
      kind: 'linked',
      dot_git: text,
      git_dir: adminPath,
      common_dir: commonPath,
      gitdir_file: gitdir,
      commondir_file: commondir,
      head: head.trim().startsWith('ref: ') ? head : null,
      config_sha256: checkConfig(readBytes(common, ['config'])),
      alternates: readUnder(common, ['objects', 'info', 'alternates']),
    };
    return { pin, fds, dotGit: dot, admin, common };
  } catch (error) {
    for (const fd of fds) closeSync(fd);
    // A link or an unreadable entry in the metadata is refused like any other metadata the sandbox must not get.
    if (error instanceof Refusal) throw error;
    throw new Refusal('sandbox_git_metadata_unreadable');
  }
}

/**
 * The Git mounts of the sandbox root `root` (canonical, open as `rootFd`): every source an open descriptor the caller
 * owns (`fds`, closed on a refusal). With `expected`, the metadata must equal that pin.
 */
export function gitPlan(root: string, rootFd: number, expected?: GitPin | null): { pin: GitPin | null; mounts: GitMount[]; fds: number[] } {
  const found = inspect(root, rootFd);
  const fds = found.fds;
  const mounts: GitMount[] = [];
  try {
    assertPin(found.pin, expected);
    const pin = found.pin;
    if (!pin) return { pin, mounts, fds };
    const open = (base: number, names: string[], leaf: 'dir' | 'file', create = false) => {
      const fd = openUnder(base, names, leaf, create);
      fds.push(fd);
      return fd;
    };
    const optional = (base: number, names: string[], leaf: 'dir' | 'file') => {
      try {
        return open(base, names, leaf);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    };
    const ro = (fd: number | undefined, dest: string) => {
      if (fd !== undefined) mounts.push({ mode: 'ro-bind', fd, dest });
    };
    const common = found.common!;
    const admin = found.admin!;
    const c = pin.common_dir;
    const a = pin.git_dir;
    ro(found.dotGit!, join(root, '.git'));
    mounts.push({ mode: 'bind', fd: admin, dest: a });
    ro(open(admin, ['gitdir'], 'file'), join(a, 'gitdir'));
    ro(open(admin, ['commondir'], 'file'), join(a, 'commondir'));
    for (const name of ['config', 'config.worktree']) ro(optional(admin, [name], 'file'), join(a, name));
    ro(optional(admin, ['hooks'], 'dir'), join(a, 'hooks'));
    if (pin.head) ro(open(admin, ['HEAD'], 'file'), join(a, 'HEAD'));
    for (const name of ['config', 'packed-refs', 'shallow']) ro(optional(common, [name], 'file'), join(c, name));
    ro(optional(common, ['info', 'exclude'], 'file'), join(c, 'info', 'exclude'));
    for (const name of ['refs', 'logs']) ro(optional(common, [name], 'dir'), join(c, name));
    // A commit creates loose objects: the shared store is writable (the named integrity limit); alternates are not.
    mounts.push({ mode: 'bind', fd: open(common, ['objects'], 'dir'), dest: join(c, 'objects') });
    ro(open(common, ['objects', 'info'], 'dir', true), join(c, 'objects', 'info'));
    if (pin.head) {
      const ref = pin.head.trim().slice(5);
      // A ref write needs its directory writable (ref.lock, then rename): the branch's namespace must be its own,
      // never a flat name beside every other head.
      if (!PRIVATE_BRANCH.test(ref)) throw new Refusal('sandbox_git_branch_requires_private_namespace');
      const [, , ns, leaf] = ref.split('/') as [string, string, string, string];
      const refs = open(common, ['refs', 'heads', ns], 'dir', true);
      // A packed sibling counts too: a loose ref written in the namespace would shadow it.
      const packed = (readUnder(common, ['packed-refs']) ?? '').split('\n').flatMap(line => /^[0-9a-f]{40,64} (refs\/\S+)$/.exec(line.trim())?.slice(1) ?? []);
      if (readdirSync(fdPath(refs)).some(name => name !== leaf) || packed.some(name => name.startsWith(`refs/heads/${ns}/`) && name !== ref)) {
        throw new Refusal('sandbox_git_branch_namespace_not_private');
      }
      const logs = open(common, ['logs', 'refs', 'heads', ns], 'dir', true);
      if (readdirSync(fdPath(logs)).some(name => name !== leaf)) throw new Refusal('sandbox_git_reflog_namespace_not_private');
      mounts.push({ mode: 'bind', fd: refs, dest: join(c, 'refs', 'heads', ns) }, { mode: 'bind', fd: logs, dest: join(c, 'logs', 'refs', 'heads', ns) });
    } else if (!/^[a-f0-9]{40,64}$/.test(readUnder(admin, ['HEAD'])!.trim())) throw new Refusal('sandbox_git_invalid_head');
    return { pin, mounts, fds };
  } catch (error) {
    for (const fd of fds) closeSync(fd);
    if (error instanceof Refusal) throw error;
    throw new Refusal('sandbox_git_metadata_unreadable');
  }
}
