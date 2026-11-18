/**
 * Index edits a sandboxed child can make in its own linked worktree's index (git-index(5), versions 2 and 3; convert to
 * version 4 with `git update-index --index-version 4` afterwards): forge an entry's stat data, swap extensions, and
 * write the checksum Git checks. Written from the format, independently of owner Git's own reader.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';

export interface IndexParts {
  /** The header and every entry. */
  readonly head: Buffer;
  /** Each entry's offset and path. */
  readonly entries: readonly { readonly start: number; readonly path: string }[];
  /** Each extension, whole (signature, length and data). */
  readonly extensions: readonly { readonly signature: string; readonly bytes: Buffer }[];
}

const hashOf = (oidBytes: number) => createHash(oidBytes === 32 ? 'sha256' : 'sha1');

export function readIndex(file: string, oidBytes = 20): IndexParts {
  const index = readFileSync(file);
  const version = index.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`test helper reads index versions 2 and 3, not ${version}`);
  const entries: { start: number; path: string }[] = [];
  let at = 12;
  for (let i = 0; i < index.readUInt32BE(8); i++) {
    const start = at;
    at += 40 + oidBytes;
    const flags = index.readUInt16BE(at);
    at += flags & 0x4000 ? 4 : 2;
    const nul = index.indexOf(0, at);
    entries.push({ start, path: index.toString('utf8', at, nul) });
    at = start + Math.ceil((nul + 1 - start) / 8) * 8;
  }
  const head = index.subarray(0, at);
  const extensions: { signature: string; bytes: Buffer }[] = [];
  while (at < index.length - oidBytes) {
    const end = at + 8 + index.readUInt32BE(at + 4);
    extensions.push({ signature: index.toString('latin1', at, at + 4), bytes: index.subarray(at, end) });
    at = end;
  }
  return { head, entries, extensions };
}

/** Writes `head` and `extensions` with a valid checksum (or, with `checksum`, those bytes instead). */
export function writeIndex(file: string, head: Buffer, extensions: readonly Buffer[], oidBytes = 20, checksum?: Buffer): void {
  const body = Buffer.concat([head, ...extensions]);
  writeFileSync(file, Buffer.concat([body, checksum ?? hashOf(oidBytes).update(body).digest()]));
}

/**
 * Replaces every entry below `dir` with one sparse-directory entry (`dir/`, mode 040000, the object `tree`, flags the
 * name length only: no skip-worktree bit), as a sparse index records a directory it does not expand. Git 2.53 then
 * skips the directory, so a change to a file inside it is never seen.
 */
export function sparseDirectory(indexFile: string, dir: string, tree: string, oidBytes = 20): void {
  const parts = readIndex(indexFile, oidBytes);
  const name = `${dir}/`;
  const kept: { path: string; bytes: Buffer }[] = [];
  parts.entries.forEach((entry, i) => {
    const end = i + 1 < parts.entries.length ? parts.entries[i + 1]!.start : parts.head.length;
    if (!entry.path.startsWith(name)) kept.push({ path: entry.path, bytes: parts.head.subarray(entry.start, end) });
  });
  const fixed = Buffer.alloc(40 + oidBytes + 2);
  fixed.writeUInt32BE(0o040000, 24);
  Buffer.from(tree, 'hex').copy(fixed, 40);
  fixed.writeUInt16BE(Buffer.byteLength(name), 40 + oidBytes);
  const length = Math.ceil((fixed.length + Buffer.byteLength(name) + 1) / 8) * 8;
  const entry = Buffer.alloc(length);
  fixed.copy(entry);
  entry.write(name, fixed.length, 'utf8');
  kept.push({ path: name, bytes: entry });
  kept.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const header = Buffer.from(parts.head.subarray(0, 12));
  header.writeUInt32BE(kept.length, 8);
  writeIndex(indexFile, Buffer.concat([header, ...kept.map(e => e.bytes)]), parts.extensions.filter(e => e.signature !== 'TREE').map(e => e.bytes), oidBytes);
}

/**
 * Rewrites the entry for `path` so its recorded stat data (ctime, mtime, dev, ino, uid, gid, size) is `file`'s current
 * stat: Git then trusts the entry and never reads the changed bytes.
 */
export function forgeStat(indexFile: string, path: string, file: string, oidBytes = 20): void {
  const parts = readIndex(indexFile, oidBytes);
  const entry = parts.entries.find(e => e.path === path);
  if (!entry) throw new Error(`no index entry for ${path}`);
  const st = lstatSync(file, { bigint: true });
  const head = Buffer.from(parts.head);
  const u32 = (value: bigint) => Number(value & 0xffffffffn);
  const fields = [st.ctimeNs / 1_000_000_000n, st.ctimeNs % 1_000_000_000n, st.mtimeNs / 1_000_000_000n, st.mtimeNs % 1_000_000_000n, st.dev, st.ino];
  fields.forEach((value, i) => head.writeUInt32BE(u32(value), entry.start + 4 * i));
  [st.uid, st.gid, st.size].forEach((value, i) => head.writeUInt32BE(u32(value), entry.start + 28 + 4 * i));
  writeIndex(indexFile, head, parts.extensions.map(e => e.bytes), oidBytes);
}
