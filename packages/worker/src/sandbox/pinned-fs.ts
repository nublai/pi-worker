/**
 * Descriptor-relative filesystem access for paths that sandboxed code can write, ported from A0 `src/pinned-fs.ts`
 * (the opens; A0's profile copy and removal are staging.ts, P2-7). Every component is opened with
 * O_NOFOLLOW from an already-open parent descriptor, so a concurrent rename or symlink swap cannot redirect a later
 * component or the final object. Callers own and close returned descriptors.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { Refusal } from '../b2/errors.js';

export const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** A regular file (or anything that is not a directory) is opened without blocking on a FIFO. */
export const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The magic link names the open object itself, never a re-resolved path. */
export const fdPath = (fd: number, name?: string): string => `/proc/self/fd/${fd}` + (name === undefined ? '' : `/${component(name)}`);

function component(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Refusal('pinned_path_component_invalid');
  return name;
}

/** The components of an absolute, normalized path; anything else is refused. */
export function components(path: string): string[] {
  if (!isAbsolute(path) || normalize(path) !== path) throw new Refusal('pinned_path_not_canonical');
  return path.split('/').filter(Boolean).map(component);
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
export const isMissing = (error: unknown) => code(error) === 'ENOENT';

/**
 * Opens `names` below the open directory `base`, refusing a symlink at every component (ELOOP). With `create`,
 * missing intermediate and final directories are made with a descriptor-relative mkdir, then opened the same way.
 */
export function openUnder(base: number, names: string[], leaf: 'dir' | 'file' | 'any' = 'dir', create = false, mode = 0o700): number {
  let fd = base;
  let owned = false;
  try {
    for (let i = 0; i < names.length; i++) {
      const last = i === names.length - 1;
      const path = fdPath(fd, names[i]!);
      const flags = !last || leaf === 'dir' ? DIR_FLAGS : FILE_FLAGS;
      let next: number;
      try {
        next = openSync(path, flags);
      } catch (error) {
        if (!create || !isMissing(error) || (last && leaf !== 'dir')) throw error;
        // Through the magic link the kernel resolves the parent from its descriptor; mkdir never follows a final link.
        try {
          mkdirSync(path, { mode });
        } catch (made) {
          if (code(made) !== 'EEXIST') throw made;
        }
        next = openSync(path, flags);
      }
      if (owned) closeSync(fd);
      fd = next;
      owned = true;
    }
    if (!owned) throw new Refusal('pinned_path_empty');
    const st = fstatSync(fd);
    if (leaf === 'file' && !st.isFile()) throw new Refusal('pinned_path_not_regular_file');
    if (leaf === 'dir' && !st.isDirectory()) throw new Refusal('pinned_path_not_directory');
    return fd;
  } catch (error) {
    if (owned) closeSync(fd);
    throw error;
  }
}

/** The whole content of an open file, at most `limit` bytes (`pinned_file_too_large` beyond). */
export function readFd(fd: number, limit = 1024 * 1024): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, null);
    if (!n) return Buffer.concat(chunks);
    total += n;
    if (total > limit) throw new Refusal('pinned_file_too_large');
    chunks.push(buf.subarray(0, n));
  }
}

/** A regular file below the open directory `base`, read with no link followed; null only when the final entry is absent. */
export function readUnder(base: number, names: string[]): string | null {
  let fd: number;
  try {
    fd = openUnder(base, names, 'file');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return readFd(fd).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Opens an absolute canonical path from `/` with no symlink at any component. */
export function openPinned(path: string, leaf: 'dir' | 'file' | 'any' = 'dir', create = false): number {
  const names = components(path);
  const root = openSync('/', DIR_FLAGS);
  try {
    if (!names.length) {
      if (leaf === 'file') throw new Refusal('pinned_path_not_regular_file');
      return openSync('/', DIR_FLAGS);
    }
    return openUnder(root, names, leaf, create);
  } finally {
    closeSync(root);
  }
}
