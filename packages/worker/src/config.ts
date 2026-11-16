/** Where the supervisor keeps state and listens. Linux only; no `/tmp` fallback for the socket. */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Who may reach the socket. `owner` (the default): a 0700 directory and a 0600 socket. `group` (Shep's S-6, for a
 * bridge running as its own user): a 0750 directory and a 0660 socket owned by that group. Either way the bearer
 * grant is still required on every request; the group only lets a member connect.
 */
export type SocketAccess = { readonly mode: 'owner' } | { readonly mode: 'group'; readonly gid: number };

export type Paths = {
  /** Journal, grants and sessions outside sandboxes. */
  stateDir: string;
  /** B2 socket. Its parent directory is created 0700 and the socket chmod 0600. */
  socketPath: string;
};

export class ConfigError extends Error {}

function absolute(name: string, value: string): string {
  if (!isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path`);
  return value;
}

/**
 * Resolve paths from the environment:
 * - state: `PIW_STATE_DIR`, else `$XDG_STATE_HOME/pi-worker`, else `$HOME/.local/state/pi-worker`;
 * - socket: `PIW_SOCKET`, else `$XDG_RUNTIME_DIR/pi-worker/b2.sock`.
 * A missing runtime directory is an error, never a world-shared fallback.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  let stateDir: string;
  if (env.PIW_STATE_DIR) stateDir = absolute('PIW_STATE_DIR', env.PIW_STATE_DIR);
  else if (env.XDG_STATE_HOME) stateDir = join(absolute('XDG_STATE_HOME', env.XDG_STATE_HOME), 'pi-worker');
  else if (env.HOME) stateDir = join(absolute('HOME', env.HOME), '.local', 'state', 'pi-worker');
  else throw new ConfigError('set PIW_STATE_DIR, XDG_STATE_HOME or HOME');

  let socketPath: string;
  if (env.PIW_SOCKET) socketPath = absolute('PIW_SOCKET', env.PIW_SOCKET);
  else if (env.XDG_RUNTIME_DIR) socketPath = join(absolute('XDG_RUNTIME_DIR', env.XDG_RUNTIME_DIR), 'pi-worker', 'b2.sock');
  else throw new ConfigError('set PIW_SOCKET or XDG_RUNTIME_DIR (a systemd user session provides it)');

  return { stateDir, socketPath };
}

/** The numeric gid of a group name in `/etc/group`, or of a numeric string. */
function gidOf(value: string, groupFile: string): number {
  if (/^\d{1,10}$/.test(value)) return Number(value);
  if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(value)) throw new ConfigError('PIW_SOCKET_GROUP must be a group name or a numeric gid');
  for (const line of readFileSync(groupFile, 'utf8').split('\n')) {
    const [name, , gid] = line.split(':');
    if (name === value && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new ConfigError('PIW_SOCKET_GROUP names no group in /etc/group');
}

/**
 * `PIW_SOCKET_GROUP` (a group name or gid) selects group access: 0750 directory and 0660 socket for that group.
 * Unset, the socket is owner-only (0700 directory, 0600 socket).
 */
export function resolveSocketAccess(env: NodeJS.ProcessEnv = process.env, groupFile = '/etc/group'): SocketAccess {
  const group = env.PIW_SOCKET_GROUP;
  if (group === undefined || group === '') return { mode: 'owner' };
  return { mode: 'group', gid: gidOf(group, groupFile) };
}

/** The directory and socket modes of an access mode. */
export function socketModes(access: SocketAccess): { dir: number; socket: number } {
  return access.mode === 'group' ? { dir: 0o750, socket: 0o660 } : { dir: 0o700, socket: 0o600 };
}
