/** Descriptor-relative filesystem access for paths that sandboxed code can write.
 * Every component is opened with O_NOFOLLOW from an already-open parent
 * descriptor, so a concurrent rename or symlink swap cannot redirect a later
 * component or the final object. Callers own and close returned descriptors. */
import { constants, openSync, closeSync, fstatSync, readSync, writeSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { Refusal } from './types.js';

export const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** The magic link names the open object itself, never a re-resolved path. */
export const fdPath = (fd: number, name?: string): string => `/proc/self/fd/${fd}` + (name === undefined ? '' : '/' + component(name));
function component(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Refusal('pinned_path_component_invalid');
  return name;
}
export function components(path: string): string[] {
  if (!isAbsolute(path) || normalize(path) !== path) throw new Refusal('pinned_path_not_canonical');
  return path.split('/').filter(Boolean).map(component);
}
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
export const isMissing = (error: unknown) => code(error) === 'ENOENT';
/** Open `names` below `base`, refusing a symlink at every component. With
 * `create`, missing intermediate and final directories are made with mkdirat. */
export function openUnder(base: number, names: string[], leaf: 'dir' | 'file' | 'any' = 'dir', create = false): number {
  let fd = base, owned = false;
  try {
    for (let i = 0; i < names.length; i++) {
      const last = i === names.length - 1, path = fdPath(fd, names[i]!);
      const flags = !last || leaf === 'dir' ? DIR_FLAGS : FILE_FLAGS;
      let next: number;
      try { next = openSync(path, flags); }
      catch (error) {
        if (!create || !isMissing(error) || (last && leaf !== 'dir')) throw error;
        try { mkdirSync(path); } catch (made) { if (code(made) !== 'EEXIST') throw made; }
        next = openSync(path, flags);
      }
      if (owned) closeSync(fd);
      fd = next; owned = true;
    }
    if (!owned) throw new Refusal('pinned_path_empty');
    const st = fstatSync(fd);
    if (leaf === 'file' && !st.isFile()) throw new Refusal('pinned_path_not_regular_file');
    if (leaf === 'dir' && !st.isDirectory()) throw new Refusal('pinned_path_not_directory');
    return fd;
  } catch (error) { if (owned) closeSync(fd); throw error; }
}
/** Open an absolute canonical path from `/` with no symlink at any component. */
export function openPinned(path: string, leaf: 'dir' | 'file' | 'any' = 'dir', create = false): number {
  const root = openSync('/', DIR_FLAGS);
  try {
    const names = components(path);
    if (!names.length) { if (leaf === 'file') throw new Refusal('pinned_path_not_regular_file'); return openSync('/', DIR_FLAGS); }
    return openUnder(root, names, leaf, create);
  } finally { closeSync(root); }
}
export function readFd(fd: number, limit = 1024 * 1024): Buffer {
  const chunks: Buffer[] = []; let total = 0;
  for (;;) {
    const buf = Buffer.alloc(64 * 1024), n = readSync(fd, buf, 0, buf.length, null);
    if (!n) return Buffer.concat(chunks);
    total += n; if (total > limit) throw new Refusal('pinned_file_too_large');
    chunks.push(buf.subarray(0, n));
  }
}
/** Read a regular file below `base`; null only when the final entry is absent. */
export function readUnder(base: number, names: string[]): string | null {
  let fd: number;
  try { fd = openUnder(base, names, 'file'); } catch (error) { if (isMissing(error)) return null; throw error; }
  try { return readFd(fd).toString('utf8'); } finally { closeSync(fd); }
}
/** Copy a directory tree between two open directories without following any
 * link. Links are recreated verbatim; regular files are read through the exact
 * descriptor opened with O_NOFOLLOW, so a swap after readdir yields either the
 * original file or a refused link, never the link target's bytes. */
export function copyTreeAt(source: number, dest: number, budget = { entries: 0, bytes: 0 }, depth = 0, links: 'recreate' | 'refuse' = 'recreate'): void {
  if (depth > 32) throw new Refusal('profile_copy_too_deep');
  for (const name of readdirSync(fdPath(source))) {
    if (++budget.entries > 10000) throw new Refusal('profile_copy_too_many_entries');
    let fd: number | undefined, link: string | undefined;
    // A concurrent swap can flip the entry between file and link; either
    // outcome is safe, so retry a few times rather than fail the launch.
    for (let attempt = 0; fd === undefined && link === undefined; attempt++) {
      try { fd = openSync(fdPath(source, name), FILE_FLAGS); }
      catch (error) {
        if (code(error) !== 'ELOOP' || attempt > 16) throw error;
        try { link = readlinkSync(fdPath(source, name)); } catch (again) { if (code(again) !== 'EINVAL') throw again; }
      }
    }
    if (fd === undefined) {
      if (links === 'refuse') throw new Refusal('pinned_copy_link_refused');
      symlinkSync(link!, fdPath(dest, name)); continue;
    }
    try {
      const st = fstatSync(fd);
      if (st.isDirectory()) {
        mkdirSync(fdPath(dest, name), { mode: (st.mode & 0o777) | 0o700 });
        const child = openSync(fdPath(dest, name), DIR_FLAGS);
        try { copyTreeAt(fd, child, budget, depth + 1, links); } finally { closeSync(child); }
      } else if (st.isFile()) writeFdAt(fd, dest, name, st.mode & 0o777, budget);
      else throw new Refusal('profile_copy_special_file');
    } finally { closeSync(fd); }
  }
}
/** Write the remaining bytes of open file `fd` to a new entry `name` in `dest`. */
function writeFdAt(fd: number, dest: number, name: string, mode: number, budget: { bytes: number }): void {
  const out = openSync(fdPath(dest, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null); if (!n) break;
      budget.bytes += n; if (budget.bytes > 256 * 1024 * 1024) throw new Refusal('profile_copy_too_large');
      let off = 0; while (off < n) off += writeSync(out, buf, off, n - off);
    }
  } finally { closeSync(out); }
}
/** Copy the regular file `names` below `source` to `name` in `dest` through one
 * O_NOFOLLOW descriptor. Returns false when the final entry is absent. */
export function copyFileAt(source: number, names: string[], dest: number, name: string, budget = { entries: 0, bytes: 0 }): boolean {
  let fd: number;
  try { fd = openUnder(source, names, 'file'); } catch (error) { if (isMissing(error)) return false; throw error; }
  try { writeFdAt(fd, dest, name, 0o600, budget); return true; } finally { closeSync(fd); }
}
