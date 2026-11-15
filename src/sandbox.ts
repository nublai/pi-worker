/** Linux bwrap filesystem profile. Network is deliberately shared, not filtered. */
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Create } from './types.js';
import { Refusal } from './types.js';
export const inside = (root: string, path: string): boolean => path === root || path.startsWith(root === '/' ? '/' : root + '/');
const runtime = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
export function sandboxRoot(c: Create, stateDir: string): string | undefined {
  const env = c.launch_spec?.environment;
  if (env?.filesystem !== 'bwrap') return undefined;
  if (process.platform !== 'linux' || !c.parent || !['sdk', 'acp'].includes(c.host ?? 'rpc')) throw new Refusal('bwrap_requires_linux_sdk_or_acp_child');
  if (!env.root || realpathSync(env.root) !== realpathSync(c.cwd)) throw new Refusal('sandbox_root_must_equal_cwd');
  const root = realpathSync(env.root), state = realpathSync(stateDir);
  if (root === '/') throw new Refusal('sandbox_root_is_host_root');
  if (inside(root, state) || inside(state, root)) throw new Refusal('sandbox_overlaps_supervisor_state');
  const protectedPaths = ['/sys/fs/cgroup', ...(process.env.PI_WORKER_SOCKET ? [realpathSync(dirname(process.env.PI_WORKER_SOCKET))] : []), ...(process.env.PI_WORKER_GRANT_FILE ? [realpathSync(process.env.PI_WORKER_GRANT_FILE)] : [])];
  if (protectedPaths.some(path => inside(root, path) || inside(path, root))) throw new Refusal('sandbox_overlaps_protected_control_path');
  for (const path of c.launch_spec!.resources.extensions.concat(c.launch_spec!.resources.skills)) if (!inside(root, realpathSync(path))) throw new Refusal('sandbox_resource_outside_root');
  // Runtime mounts are worker-owned code/dependencies, never a user-selected
  // host directory. Refuse accidental exposure of state via any read-only bind.
  for (const path of runtimePaths()) if (inside(path, state) || inside(path, root) || inside(root, path)) throw new Refusal('sandbox_runtime_overlaps_state_or_worktree');
  return root;
}
function runtimePaths(): string[] {
  return [...new Set([join(runtime, 'dist'), join(runtime, 'node_modules'), join(runtime, 'package.json'), dirname(realpathSync(process.execPath)), ...[join(runtime, 'node_modules')].filter(existsSync).map(path => realpathSync(path))])];
}
export function sandboxLaunch(root: string, command: string, args: string[], parent: NonNullable<Create['parent']>, workerId: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const mounts = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run'];
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', ...runtimePaths()]) if (existsSync(path)) mounts.push('--ro-bind', path, path);
  mounts.push('--bind', root, root, '--chdir', root, '--dir', '/tmp/a0-home');
  return { command: 'bwrap', args: [...mounts, '--', command, ...args], env: {
    PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin`, HOME: '/tmp/a0-home', LANG: 'C.UTF-8', TERM: 'dumb',
    PI_CODING_AGENT_DIR: join(root, '.a0-agent'), PI_WORKER_ID: workerId, PI_WORKER_REPORT_FD: '3', PI_WORKER_TASK_ID: parent.task_id, PI_SUBAGENT_ID: parent.task_id,
  } };
}
/** Walk from a pinned / fd, refusing symlinks at EVERY component. A renamed
 * directory cannot redirect a later component through a textual ancestor. */
function pinnedOpen(path: string): number {
  const parts = path.split('/').filter(Boolean);
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (let i = 0; i < parts.length; i++) {
      const next = openSync(`/proc/self/fd/${fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (i < parts.length - 1 ? constants.O_DIRECTORY : 0));
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
/** Internal history opens allow hidden session directories, but never symlinks
 * or paths outside the environment. Keep this distinct from files.read policy. */
export function openRooted(root: string, path: string): number {
  if (!isAbsolute(path) || !inside(realpathSync(root), resolve(path))) throw new Refusal('session_file_outside_sandbox');
  return pinnedOpen(path);
}
export function sandboxSessionDir(root: string, workerId: string): string {
  let fd = pinnedOpen(root);
  try {
    if (!fstatSync(fd).isDirectory()) throw new Refusal('sandbox_root_not_directory');
    for (const part of ['.a0-worker', 'sessions', workerId]) {
      const path = `/proc/self/fd/${fd}/${part}`;
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const next = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      closeSync(fd); fd = next;
    }
    return join(root, '.a0-worker', 'sessions', workerId);
  } finally { closeSync(fd); }
}
export function readConfined(root: string, path: string, roots: string[]): { path: string; content: string; bytes: number; evidence: 'pinned_file_read' } {
  if (!roots.length || roots.length > 32) throw new Refusal('explicit_roots_required');
  if (path.split('/').some(p => p.startsWith('.'))) throw new Refusal('hidden_or_traversal_path_refused');
  const canonical = realpathSync(root), target = resolve(root, path);
  if (!inside(canonical, target) || roots.some(r => !isAbsolute(r) || !inside(canonical, resolve(r))) || !roots.some(r => inside(resolve(r), target))) throw new Refusal('file_outside_explicit_roots');
  if (relative(canonical, target).split('/').some(p => p.startsWith('.'))) throw new Refusal('hidden_path_refused');
  let fd: number;
  try { fd = pinnedOpen(target); } catch { throw new Refusal('file_symlink_or_unavailable'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Refusal('file_not_regular_or_over_1MiB');
    const buf = Buffer.alloc(1024 * 1024 + 1); let n = 0, count: number;
    do { count = readSync(fd, buf, n, buf.length - n, null); n += count; } while (count && n < buf.length);
    if (n > 1024 * 1024) throw new Refusal('file_over_1MiB');
    let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n)); } catch { throw new Refusal('file_not_utf8'); }
    return { path: target, content, bytes: n, evidence: 'pinned_file_read' };
  } finally { closeSync(fd); }
}
