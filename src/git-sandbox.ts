/** Git metadata policy for sandbox roots. Never mount the repository checkout.
 *
 * Everything that decides what Git EXECUTES later is read-only inside the
 * sandbox: the worktree `.git` pointer, the admin dir's gitdir/commondir and
 * symbolic HEAD, common config, hooks, info and objects/info (alternates).
 * Writable: the linked worktree's admin dir (index, logs, lock files), shared
 * objects, and one private branch/reflog namespace. Every mount source is an
 * O_NOFOLLOW-opened descriptor, so bwrap never re-resolves a path that sandboxed
 * code can rename. The launch-time bytes form a pin: relaunch and owner Git
 * commands refuse when any pinned byte changed. */
import { closeSync, fstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { Refusal } from './types.js';
import { DIR_FLAGS, fdPath, isMissing, openPinned, openUnder, readFd, readUnder } from './pinned-fs.js';

export type GitPin = {
  kind: 'linked' | 'ordinary';
  /** Gitfile bytes, or `directory` for an ordinary checkout. */
  dot_git: string;
  git_dir: string; common_dir: string;
  gitdir_file: string | null; commondir_file: string | null;
  /** Symbolic HEAD of a linked worktree (it selects writable mounts); null when detached or ordinary. */
  head: string | null;
  config_sha256: string;
  alternates: string | null;
};
export type GitMount = { mode: 'bind' | 'ro-bind'; fd: number; dest: string };
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root === '/' ? '/' : root + sep);
const real = (path: string, error: string) => { try { return realpathSync(path); } catch { throw new Refusal(error); } };
export function checkConfig(text: string | null): string {
  if (text === null) throw new Refusal('sandbox_git_config_missing');
  // An include can pull configuration from a sandbox-writable path, and
  // worktreeConfig makes the writable admin dir's config.worktree effective.
  if (/^\s*\[\s*include/im.test(text)) throw new Refusal('sandbox_git_config_include_refused');
  if (/^\s*worktreeconfig\s*=\s*(true|yes|on|1)\s*$/im.test(text)) throw new Refusal('sandbox_git_worktree_config_refused');
  return createHash('sha256').update(text).digest('hex');
}
function samePin(a: GitPin | null, b: GitPin | null): boolean {
  if (a === null || b === null) return a === b;
  return (Object.keys(a) as (keyof GitPin)[]).every(k => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
}
export function assertPin(current: GitPin | null, expected: GitPin | null | undefined): void {
  if (expected !== undefined && !samePin(current, expected)) throw new Refusal('git_metadata_changed_since_launch');
}
export type Inspection = { pin: GitPin | null; fds: number[]; dotGit?: number; admin?: number; common: number | undefined };
/** Read Git pointers below an open root. `within` confines admin/common dirs.
 * The caller owns (and must close) `fds`; `dotGit`/`admin`/`common` are the
 * exact directories the pin was read from. */
export function inspect(root: string, rootFd: number, within?: string): Inspection {
  const fds: number[] = [];
  const keep = (fd: number) => { fds.push(fd); return fd; };
  try {
    let dot: number;
    try { dot = keep(openSync(fdPath(rootFd, '.git'), DIR_FLAGS)); }
    catch (error) {
      if (isMissing(error)) return { pin: null, fds, common: undefined };
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw new Refusal('sandbox_git_invalid_gitfile');
      dot = keep(openUnder(rootFd, ['.git'], 'file'));
    }
    if (fstatSync(dot).isDirectory()) {
      if (readUnder(dot, ['commondir']) !== null || readUnder(dot, ['gitdir']) !== null) throw new Refusal('sandbox_git_ordinary_checkout_redirected');
      const gitDir = join(root, '.git');
      const pin: GitPin = { kind: 'ordinary', dot_git: 'directory', git_dir: gitDir, common_dir: gitDir, gitdir_file: null, commondir_file: null, head: null, config_sha256: checkConfig(readUnder(dot, ['config'])), alternates: readUnder(dot, ['objects', 'info', 'alternates']) };
      return { pin, fds, dotGit: dot, common: dot };
    }
    const text = readFd(dot).toString('utf8');
    if (!text.startsWith('gitdir: ')) throw new Refusal('sandbox_git_invalid_gitfile');
    const adminPath = real(resolve(root, text.slice(8).trim()), 'sandbox_git_not_linked_worktree');
    const admin = keep(openPinned(adminPath, 'dir'));
    const commondir = readUnder(admin, ['commondir']), gitdir = readUnder(admin, ['gitdir']), head = readUnder(admin, ['HEAD']);
    if (commondir === null || gitdir === null || head === null) throw new Refusal('sandbox_git_not_linked_worktree');
    const commonPath = real(resolve(adminPath, commondir.trim()), 'sandbox_git_not_linked_worktree');
    if (dirname(adminPath) !== join(commonPath, 'worktrees') || real(gitdir.trim(), 'sandbox_git_not_linked_worktree') !== join(root, '.git')) throw new Refusal('sandbox_git_not_linked_worktree');
    if (within && (!inside(within, adminPath) || !inside(within, commonPath))) throw new Refusal('sandbox_git_outside_parent_root');
    const common = keep(openPinned(commonPath, 'dir'));
    const symbolic = head.trim().startsWith('ref: ');
    const pin: GitPin = { kind: 'linked', dot_git: text, git_dir: adminPath, common_dir: commonPath, gitdir_file: gitdir, commondir_file: commondir, head: symbolic ? head : null, config_sha256: checkConfig(readUnder(common, ['config'])), alternates: readUnder(common, ['objects', 'info', 'alternates']) };
    return { pin, fds, dotGit: dot, admin, common };
  } catch (error) { for (const fd of fds) closeSync(fd); throw error; }
}
/** Launch-time pin of the checkout below an open root (no mounts, no writes). */
export function gitPinAt(root: string, rootFd: number, within?: string): GitPin | null {
  const found = inspect(root, rootFd, within);
  for (const fd of found.fds) closeSync(fd);
  return found.pin;
}
/** Mount plan for a sandbox root; every source is an open descriptor. */
export function gitPlan(root: string, rootFd: number, options: { within?: string; expected?: GitPin | null } = {}): { pin: GitPin | null; mounts: GitMount[]; fds: number[] } {
  const found = inspect(root, rootFd, options.within), fds = found.fds, mounts: GitMount[] = [];
  try {
    assertPin(found.pin, options.expected);
    const pin = found.pin;
    if (!pin) return { pin, mounts, fds };
    const open = (base: number, names: string[], leaf: 'dir' | 'file', create = false) => { const fd = openUnder(base, names, leaf, create); fds.push(fd); return fd; };
    const optional = (base: number, names: string[], leaf: 'dir' | 'file') => { try { return open(base, names, leaf); } catch (error) { if (isMissing(error)) return undefined; throw error; } };
    const ro = (fd: number | undefined, dest: string) => { if (fd !== undefined) mounts.push({ mode: 'ro-bind', fd, dest }); };
    const common = found.common!;
    if (pin.kind === 'ordinary') {
      // Bind .git onto itself so the sandbox cannot rename it away and plant a
      // fresh one; then overlay everything Git can execute from read-only.
      const git = pin.git_dir;
      mounts.push({ mode: 'bind', fd: found.dotGit!, dest: git });
      ro(open(common, ['config'], 'file'), join(git, 'config'));
      for (const name of ['hooks', 'info']) ro(open(common, [name], 'dir', true), join(git, name));
      ro(open(common, ['objects', 'info'], 'dir', true), join(git, 'objects', 'info'));
      return { pin, mounts, fds };
    }
    const admin = found.admin!, c = pin.common_dir, a = pin.git_dir;
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
    // A commit creates loose objects. This shared writable store is a documented
    // integrity limit, not Git isolation; alternates stay read-only.
    mounts.push({ mode: 'bind', fd: open(common, ['objects'], 'dir'), dest: join(c, 'objects') });
    ro(open(common, ['objects', 'info'], 'dir', true), join(c, 'objects', 'info'));
    if (pin.head) {
      const ref = pin.head.trim().slice(5);
      // Directory writes are needed for ref.lock + atomic rename. Demand a unique
      // namespace rather than exposing all heads for a flat branch name.
      if (!/^refs\/heads\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(ref)) throw new Refusal('sandbox_git_branch_requires_private_namespace');
      const [, , ns, leaf] = ref.split('/') as [string, string, string, string];
      const refs = open(common, ['refs', 'heads', ns], 'dir');
      if (readdirSync(fdPath(refs)).some(name => name !== leaf)) throw new Refusal('sandbox_git_branch_namespace_not_private');
      const logs = open(common, ['logs', 'refs', 'heads', ns], 'dir', true);
      if (readdirSync(fdPath(logs)).some(name => name !== leaf)) throw new Refusal('sandbox_git_reflog_namespace_not_private');
      mounts.push({ mode: 'bind', fd: refs, dest: join(c, 'refs', 'heads', ns) }, { mode: 'bind', fd: logs, dest: join(c, 'logs', 'refs', 'heads', ns) });
    } else if (!/^[a-f0-9]{40,64}$/.test(readUnder(admin, ['HEAD'])!.trim())) throw new Refusal('sandbox_git_invalid_head');
    return { pin, mounts, fds };
  } catch (error) { for (const fd of fds) closeSync(fd); throw error; }
}
