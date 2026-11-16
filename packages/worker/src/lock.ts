/**
 * An exclusive, process-lifetime lock on a file. Node has no flock or fcntl API, so this uses `node:sqlite`, which
 * ships with Node: an exclusive-mode transaction holds a POSIX record lock on the file until the connection closes.
 * The kernel drops the lock when the process dies, SIGKILL included, so a crashed holder never leaves it stuck.
 * A second holder, in this process or another, is refused at once (no busy wait).
 */
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';

export class LockHeld extends Error {}

export interface FileLock {
  release(): void;
}

/** Takes the lock at `path` (created 0600 under the caller's umask) or throws LockHeld. */
export function acquireLock(path: string): FileLock {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.uid !== process.getuid?.()) throw new Error(`${path}: lock must be an owned regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5 /* SQLITE_BUSY */) throw new LockHeld(`${path} is held by another supervisor`);
    throw error;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      db.close();
    },
  };
}
