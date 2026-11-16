/** Where the supervisor keeps state and listens. Linux only; no `/tmp` fallback for the socket. */
import { isAbsolute, join } from 'node:path';

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
