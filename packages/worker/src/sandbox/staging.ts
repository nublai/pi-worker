/**
 * Profile staging for sandboxed typed children (P2-7), ported from A0 `src/pinned-fs.ts` (`copyTreeAt`,
 * `stageProfileAt`, `removeTreeAt`) and `src/supervisor.ts` (`stageProfile`), with Gate 1's fixes D1 to D3.
 *
 * A sandboxed child whose parent's cwd holds a pi profile (`PARENT/.piw-agent`) gets a copy of it in a fresh
 * `ROOT/.piw-agent`, its own agent directory (sandbox.ts `AGENT_DIR`). The copy runs only after every validation and
 * after the launch's dispatch record (lifecycle.ts), so a refused launch stages nothing.
 *
 * - **Descriptor copy.** Every entry is opened with O_NOFOLLOW from its parent's descriptor and copied from that exact
 *   descriptor, so a swap after readdir yields the original file or a link, never a link target's bytes. A link is
 *   recreated verbatim (never followed), a FIFO, socket or device refuses (`profile_copy_special_file`).
 * - **Dependency trees (D1).** Every `node_modules` directory is not copied: staging leaves an empty mount point and
 *   returns the source directory's open descriptor, which the sandbox binds read-only (`--ro-bind-fd`) at that point.
 *   The copy stays small whatever the dependency tree's size, and nothing writable is shared.
 * - **Budget.** At most 10,000 copied entries, 256 MiB of copied bytes, depth 32 and 64 dependency binds
 *   (`PROFILE_LIMITS`); past any of them the launch refuses.
 * - **Outcome (D2).** A failure before `ROOT/.piw-agent` was created is `ProvenNoEffect` (nothing staged). Once it was
 *   created, the partial copy is removed best effort and the failure is always `outcome_unknown`: the root is writable
 *   by the parent's tree, so the created directory can be renamed aside before the cleanup opens its name, and an
 *   absent name proves nothing about the inode (the Gate 1 security delta). The child row ends `failed` (D3,
 *   lifecycle.ts) and an unknown fences the parent (children.ts).
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import { DIR_FLAGS, FILE_FLAGS, fdPath, isMissing, openPinned, openUnder } from './pinned-fs.js';
import { AGENT_DIR, inside } from './sandbox.js';

/** A profile dependency directory (`node_modules`): its open source descriptor and its path below the profile root. */
export interface DependencyBind {
  readonly fd: number;
  readonly dest: readonly string[];
}

export interface ProfileLimits {
  readonly entries: number;
  readonly bytes: number;
  readonly depth: number;
  readonly dependencyBinds: number;
}

export const PROFILE_LIMITS: ProfileLimits = { entries: 10_000, bytes: 256 * 1024 * 1024, depth: 32, dependencyBinds: 64 };

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Writes the rest of the open file `fd` to a new entry `name` in `dest`, never through a link. */
function writeFdAt(fd: number, dest: number, name: string, mode: number, budget: { bytes: number }, limits: ProfileLimits): void {
  const out = openSync(fdPath(dest, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      budget.bytes += n;
      if (budget.bytes > limits.bytes) throw new Refusal('profile_copy_too_large');
      let off = 0;
      while (off < n) off += writeSync(out, buf, off, n - off);
    }
  } finally {
    closeSync(out);
  }
}

interface Walk {
  readonly limits: ProfileLimits;
  readonly budget: { entries: number; bytes: number };
  readonly found: DependencyBind[];
}

/** Copies the directory `source` into `dest` (both open), descriptor-relative, never following a link. */
function copyTreeAt(source: number, dest: number, prefix: readonly string[], walk: Walk): void {
  if (prefix.length > walk.limits.depth) throw new Refusal('profile_copy_too_deep');
  for (const name of readdirSync(fdPath(source))) {
    if (++walk.budget.entries > walk.limits.entries) throw new Refusal('profile_copy_too_many_entries');
    let fd: number | undefined;
    let link: string | undefined;
    // A concurrent swap can flip the entry between file and link; either outcome is safe, so retry a few times rather
    // than fail the launch.
    for (let attempt = 0; fd === undefined && link === undefined; attempt++) {
      try {
        fd = openSync(fdPath(source, name), FILE_FLAGS);
      } catch (error) {
        if (code(error) !== 'ELOOP' || attempt > 16) throw error;
        try {
          link = readlinkSync(fdPath(source, name));
        } catch (again) {
          if (code(again) !== 'EINVAL') throw again;
        }
      }
    }
    if (fd === undefined) {
      symlinkSync(link!, fdPath(dest, name));
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (st.isDirectory() && name === 'node_modules') {
        // An immutable dependency tree: an empty mount point, bound read-only from this exact descriptor at launch.
        // Ownership of `fd` moves to `found`.
        if (walk.found.length >= walk.limits.dependencyBinds) throw new Refusal('profile_dependency_binds_too_many');
        mkdirSync(fdPath(dest, name), { mode: 0o700 });
        walk.found.push({ fd, dest: [...prefix, name] });
        fd = undefined;
        continue;
      }
      if (st.isDirectory()) {
        mkdirSync(fdPath(dest, name), { mode: (st.mode & 0o777) | 0o700 });
        const child = openSync(fdPath(dest, name), DIR_FLAGS);
        try {
          copyTreeAt(fd, child, [...prefix, name], walk);
        } finally {
          closeSync(child);
        }
      } else if (st.isFile()) writeFdAt(fd, dest, name, st.mode & 0o777, walk.budget, walk.limits);
      else throw new Refusal('profile_copy_special_file');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

/**
 * Stages a pi profile from the open directory `source` into the open directory `dest`: its files copied, each
 * `node_modules` left as an empty mount point and returned as an opened source descriptor for a read-only bind. On
 * failure every returned descriptor is closed; the partial copy is the caller's to remove.
 */
export function stageProfileAt(source: number, dest: number, limits: ProfileLimits = PROFILE_LIMITS): DependencyBind[] {
  const found: DependencyBind[] = [];
  try {
    copyTreeAt(source, dest, [], { limits, budget: { entries: 0, bytes: 0 }, found });
    return found;
  } catch (error) {
    for (const bind of found) closeSync(bind.fd);
    throw error;
  }
}

/**
 * Removes entry `name` below the open directory `parent` without following any link: links and files are unlinked,
 * directories emptied through their own O_NOFOLLOW descriptor, then removed. A missing entry is already removed.
 */
export function removeTreeAt(parent: number, name: string, depth = 0): void {
  if (depth > 64) throw new Refusal('remove_tree_too_deep');
  let fd: number;
  try {
    fd = openSync(fdPath(parent, name), DIR_FLAGS);
  } catch (error) {
    if (isMissing(error)) return;
    if (code(error) === 'ENOTDIR' || code(error) === 'ELOOP') {
      unlinkSync(fdPath(parent, name));
      return;
    }
    throw error;
  }
  try {
    for (const entry of readdirSync(fdPath(fd))) removeTreeAt(fd, entry, depth + 1);
  } finally {
    closeSync(fd);
  }
  rmdirSync(fdPath(parent, name));
}

/**
 * The profile a sandboxed child of a parent with cwd `parentCwd` stages into its root `root`, judged in the create's
 * validation (refusals are `no_effect`, before any record): `PARENT/.piw-agent` when it exists, else null (nothing is
 * staged). Refused: a parent profile that is not a real directory (a link at any component), a child root that
 * overlaps it, and a child root that already holds `.piw-agent` (staging creates its own).
 */
export function profileSource(parentCwd: string, root: string): string | null {
  const source = join(parentCwd, AGENT_DIR);
  let fd: number;
  try {
    fd = openPinned(source, 'dir');
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Refusal('parent_profile_not_directory');
  }
  closeSync(fd);
  if (inside(source, root) || inside(root, source)) throw new Refusal('child_root_overlaps_parent_profile');
  // Anything at the name (a directory, a file, a link) is not a profile this launch created.
  let held = true;
  const rootFd = openPinned(root, 'dir');
  try {
    closeSync(openUnder(rootFd, [AGENT_DIR], 'any'));
  } catch (error) {
    if (isMissing(error)) held = false;
  } finally {
    closeSync(rootFd);
  }
  if (held) throw new Refusal('child_profile_exists');
  return source;
}

/** Removes a failed staging's `ROOT/.piw-agent` (best effort) through the root's descriptor. */
export const removeStagedProfile = (rootFd: number): void => removeTreeAt(rootFd, AGENT_DIR);

/**
 * Stages the profile `source` (from `profileSource`) into a fresh `ROOT/.piw-agent` and returns its dependency binds,
 * which the caller closes once the sandbox has them. Before `ROOT/.piw-agent` exists a failure is `ProvenNoEffect`;
 * after, `cleanup` removes the partial copy best effort and the failure is always `outcome_unknown` (D2).
 */
export function stageProfile(source: string, root: string, cleanup: (rootFd: number) => void = removeStagedProfile): DependencyBind[] {
  let sourceFd: number | undefined;
  let rootFd: number | undefined;
  let created = false;
  try {
    sourceFd = openPinned(source, 'dir');
    rootFd = openPinned(root, 'dir');
    mkdirSync(fdPath(rootFd, AGENT_DIR), { mode: 0o700 });
    created = true;
    const dest = openUnder(rootFd, [AGENT_DIR], 'dir');
    try {
      return stageProfileAt(sourceFd, dest);
    } finally {
      closeSync(dest);
    }
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : `profile_staging_failed:${code(error) ?? 'error'}`;
    if (!created) throw new ProvenNoEffect(reason, 'nothing_staged');
    try {
      cleanup(rootFd!);
    } catch {
      /* best effort: the outcome is unknown either way */
    }
    throw new Refusal(reason, 'unknown');
  } finally {
    if (sourceFd !== undefined) closeSync(sourceFd);
    if (rootFd !== undefined) closeSync(rootFd);
  }
}
