/**
 * The Linux bwrap profile for typed children (P2-4), ported from A0 `src/sandbox.ts`. A child declared
 * `launch_spec.environment.filesystem: bwrap` runs pi in a sandbox whose only writable tree is its root (its cwd),
 * bound from a descriptor opened with no symlink at any component, so a rename or symlink swap after the open cannot
 * change what the sandbox gets. Everything else it sees is read-only system and worker runtime paths; `/proc` (its own
 * PID namespace) and `/dev` are private, `/tmp`, `/run` and HOME private and writable, and the sandbox's own `/` (with
 * every directory nothing is bound on) is remounted read-only. bwrap clears the environment (`--clearenv`) and sets only
 * the typed child's allowlist (host.ts `childEnv`), plus `PWD`, which bwrap sets after `--chdir` whatever `--unsetenv`
 * says: it names the root, the sandbox's own cwd. bwrap dies with the supervisor (`--die-with-parent`) and closes every
 * mount descriptor before pi runs, so pi holds stdio and its FD 3 report slot only.
 *
 * Not mounted: the supervisor's state (journal, grants, sessions of unsandboxed workers), the B2 socket's directory,
 * the cgroup tree, the host HOME and the user's pi profile. Readable inside: the model credentials its environment
 * allowlist passes (`*_API_KEY` and the like) and any credential store the owner staged read-only in `ROOT/.piw-agent`.
 * Named limit: the network is shared, not filtered.
 *
 * The supervisor reads what a sandbox can write (its session files, `files.read`) only through opens pinned at the
 * root, never following a link. A root's Git metadata is mounted by git-sandbox.ts (P2-5), for a linked worktree only:
 * pointers, a symbolic HEAD, config and alternates read-only, the worktree's admin dir, the shared objects and one
 * private branch namespace writable; an ordinary checkout root is refused. A child's staged profile (staging.ts, P2-7)
 * is in `ROOT/.piw-agent`; each of its `node_modules` mount points gets the parent's tree read-only, by descriptor. The
 * parent channel is P2-8: until then a sandboxed root worker (a parent) is refused.
 */
import { closeSync, existsSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal } from '../b2/errors.js';
import type { components } from '../generated/api.js';
import { gitPlan, type GitPin } from './git-sandbox.js';
import { isMissing, openPinned, openUnder } from './pinned-fs.js';
import type { DependencyBind } from './staging.js';

type Create = components['schemas']['Create'];
type LaunchSpec = components['schemas']['LaunchSpec'];

/** The sandbox's pi agent directory below its root: settings it writes, credential stores the owner staged. */
export const AGENT_DIR = '.piw-agent';
/** The supervisor-made directory below the root that holds the sandboxed worker's session files. */
export const WORKER_DIR = '.piw-worker';
/** HOME inside the sandbox, on its private /tmp. */
export const SANDBOX_HOME = '/tmp/piw-home';
/** The child descriptor of the first mount source: 0 to 2 are stdio, 3 is the report slot. */
export const SANDBOX_FD_BASE = 4;

/** `path` is `root` or below it (both canonical). */
export const inside = (root: string, path: string): boolean => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/** A launch spec that asks for the bwrap profile. */
export const sandboxed = (spec: LaunchSpec | undefined | null): boolean => spec?.environment.filesystem === 'bwrap';

/**
 * What a sandbox must never overlap (equal, contain or be contained in): the supervisor's state directory and every
 * other control path the daemon names (the B2 socket's directory). The cgroup tree, `/proc`, `/dev` and the user's
 * runtime directory (and its bus) are always protected.
 */
export interface SandboxControls {
  readonly stateDir: string;
  readonly paths: readonly string[];
}

/** The real path of an existing path, else the normalized absolute path. */
const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));

/** The worker package (dist, package.json) and the node_modules its pi SDK resolves from: read-only in every sandbox. */
function runtimePaths(): string[] {
  const pkg = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
  const sdk = realpathSync(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const at = sdk.lastIndexOf('/node_modules/');
  if (at < 0) throw new Error('pi SDK is not installed under a node_modules directory');
  const modules = [sdk.slice(0, at + '/node_modules'.length), join(pkg, 'node_modules')].filter(existsSync).map(path => realpathSync(path));
  return [...new Set([join(pkg, 'dist'), join(pkg, 'package.json'), ...modules, dirname(realpathSync(process.execPath))])];
}

/** System paths every sandbox reads; each is bound read-only when it exists. */
const SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ld.so.cache', '/etc/localtime'];

/**
 * The checks a sandboxed launch passes before any record (refusals are `no_effect`). Returns the sandbox root: the
 * real path of the cwd, which `environment.root` must name. Refused: a host other than the SDK, a root other than the
 * cwd, the host root, a root overlapping the supervisor's state or a protected control path, a launch-spec resource
 * outside the root, and a root overlapping the worker's own runtime (code the sandbox must not write). Then the root's
 * Git metadata (git-sandbox.ts): its refusals, and any Git mount overlapping the state or a protected control path.
 * `gitPin` is the metadata this validation accepted; the launch mounts only that (`sandboxLaunch` `gitPin`).
 */
export interface SandboxCheck {
  readonly root: string;
  readonly gitPin: GitPin | null;
}

export function sandboxRoot(c: Create, controls: SandboxControls): SandboxCheck {
  const env = c.launch_spec?.environment;
  if (!env || env.filesystem !== 'bwrap') throw new Refusal('sandbox_not_declared');
  if (process.platform !== 'linux' || (c.host ?? 'sdk') !== 'sdk') throw new Refusal('bwrap_requires_linux_sdk');
  let root: string;
  try {
    if (!env.root || realpathSync(env.root) !== realpathSync(c.cwd)) throw new Error('mismatch');
    root = realpathSync(env.root);
  } catch {
    throw new Refusal('sandbox_root_must_equal_cwd');
  }
  if (root === '/') throw new Refusal('sandbox_root_is_host_root');
  const state = real(controls.stateDir);
  if (inside(root, state) || inside(state, root)) throw new Refusal('sandbox_overlaps_supervisor_state');
  const userRuntime = [`/run/user/${process.getuid!()}`, ...(process.env.XDG_RUNTIME_DIR ? [process.env.XDG_RUNTIME_DIR] : [])];
  const protectedPaths = ['/sys/fs/cgroup', '/proc', '/dev', ...userRuntime.flatMap(path => [path, join(path, 'bus')]), ...controls.paths].map(real);
  if (protectedPaths.some(path => inside(root, path) || inside(path, root))) throw new Refusal('sandbox_overlaps_protected_control_path');
  // Inside the sandbox a resource resolves only within its own mounts: one outside the root is refused, not hidden.
  for (const path of [...c.launch_spec!.resources.extensions, ...c.launch_spec!.resources.skills]) if (!inside(root, real(path))) throw new Refusal('sandbox_resource_outside_root');
  // The runtime is bound read-only into every sandbox: it must never be the root's, nor expose the state.
  for (const path of runtimePaths()) if (inside(path, state) || inside(path, root) || inside(root, path)) throw new Refusal('sandbox_runtime_overlaps_state_or_root');
  const rootFd = openPinned(root, 'dir');
  try {
    const git = gitPlan(root, rootFd);
    for (const fd of git.fds) closeSync(fd);
    // A Git dir bound into the sandbox (writable or not) never contains or lies in a control path.
    if (git.mounts.some(m => [state, ...protectedPaths].some(p => inside(m.dest, p) || inside(p, m.dest)))) throw new Refusal('sandbox_git_overlaps_protected_control_path');
    return { root, gitPin: git.pin };
  } finally {
    closeSync(rootFd);
  }
}

/**
 * The bwrap executable on `PATH`, proved to run (`bwrap --version`): the daemon refuses to start without it
 * (`bwrap_unavailable`), with no unsandboxed fallback.
 */
export function locateBwrap(env: NodeJS.ProcessEnv = process.env): string {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'bwrap');
    if (!existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, env: {} });
      return candidate;
    } catch {
      /* not executable here: keep looking */
    }
  }
  throw new Refusal('bwrap_unavailable');
}

/** The environment inside a sandbox: the typed child's allowlist with HOME, TMPDIR, PATH and pi's agent directory its own. */
export function sandboxEnv(allowed: NodeJS.ProcessEnv, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(allowed)) {
    // Host locations mean nothing inside (and must not name one): the sandbox has its own.
    if (value === undefined || key.startsWith('XDG_') || ['HOME', 'TMPDIR', 'PATH', 'PI_CODING_AGENT_DIR'].includes(key)) continue;
    out[key] = value;
  }
  return {
    ...out,
    PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin`,
    HOME: SANDBOX_HOME,
    TMPDIR: '/tmp',
    PI_CODING_AGENT_DIR: join(root, AGENT_DIR),
    LANG: out.LANG ?? 'C.UTF-8',
  };
}

/**
 * A bwrap argv running `command args` in the sandbox of `root`. `fds` are the mount sources, which the spawn places
 * at SANDBOX_FD_BASE onwards, in order; `close` closes the supervisor's copies (after the spawn, or on failure).
 * `bwrap` is the executable `locateBwrap` found. `env` is the complete environment inside (`sandboxEnv`). With a
 * `gitPin` (the validation's, `sandboxRoot`), the root's Git metadata must still equal it; `gitPin` in the result is
 * the metadata the launch mounts. `dependencies` are a staged profile's dependency trees (staging.ts), each bound
 * read-only at its mount point below `ROOT/.piw-agent`; their descriptors stay the caller's to close.
 */
export interface SandboxLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly fds: number[];
  readonly gitPin: GitPin | null;
  close(): void;
}

export function sandboxLaunch(root: string, command: string, args: readonly string[], options: { env: Record<string, string>; bwrap?: string; gitPin?: GitPin | null; dependencies?: readonly DependencyBind[] }): SandboxLaunch {
  const opened: number[] = [];
  const close = () => {
    for (const fd of opened.splice(0)) closeSync(fd);
  };
  try {
    // The exact directory, opened with no symlink at any component: bwrap binds this object, whatever the path names
    // by the time it runs.
    const rootFd = openPinned(root, 'dir');
    opened.push(rootFd);
    const fds: number[] = [];
    const mounts: string[] = [];
    const bind = (mode: 'bind' | 'ro-bind', fd: number, dest: string) => {
      fds.push(fd);
      mounts.push(`--${mode}-fd`, String(SANDBOX_FD_BASE + fds.length - 1), dest);
    };
    const env = options.env;
    // --clearenv: the allowlist below is the whole environment inside, whatever the spawn passes to bwrap itself.
    const argv = ['--die-with-parent', '--clearenv', ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v])];
    argv.push('--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run');
    // System and worker runtime paths are owner-controlled, never sandbox-writable.
    for (const path of [...SYSTEM_PATHS, ...runtimePaths()]) if (existsSync(path)) argv.push('--ro-bind', path, path);
    bind('bind', rootFd, root);
    // The root's Git metadata, after the root bind it overlays (git-sandbox.ts); every source a descriptor.
    const git = gitPlan(root, rootFd, options.gitPin);
    opened.push(...git.fds);
    for (const mount of git.mounts) bind(mount.mode, mount.fd, mount.dest);
    // A staged profile's dependency trees: read-only binds of the exact directories staging opened. The mount point must
    // be a real directory below the root (no link at any component), as staging made it.
    for (const dep of options.dependencies ?? []) {
      let point: number;
      try {
        point = openUnder(rootFd, [AGENT_DIR, ...dep.dest], 'dir');
      } catch {
        throw new Refusal('sandbox_dependency_mount_point_invalid');
      }
      closeSync(point);
      bind('ro-bind', dep.fd, join(root, AGENT_DIR, ...dep.dest));
    }
    // pi may read the credential stores the owner staged in its agent directory, read-only. A link there refuses
    // rather than letting bwrap resolve it on the host.
    for (const name of ['auth.json', 'models.json']) {
      let fd: number;
      try {
        fd = openUnder(rootFd, [AGENT_DIR, name], 'file');
      } catch (error) {
        if (isMissing(error)) continue;
        throw new Refusal('sandbox_credential_not_regular_file');
      }
      opened.push(fd);
      bind('ro-bind', fd, join(root, AGENT_DIR, name));
    }
    // After every mount: the sandbox's own root tmpfs (`/`, and `/etc`, `/home`, `/var` where nothing is bound) becomes
    // read-only. bwrap's remount is not recursive, so the root bind, `/tmp`, `/run` and `/dev` keep their own flags.
    argv.push(...mounts, '--dir', SANDBOX_HOME, '--remount-ro', '/', '--chdir', root);
    return { command: options.bwrap ?? 'bwrap', args: [...argv, '--', command, ...args], env, fds, gitPin: git.pin, close };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Opens `file`, a path inside the sandbox `root`, from `/` with no symlink at any component (ELOOP otherwise): the
 * sandbox can write every component below its root, so the supervisor never follows one. A path outside the root is
 * refused the same way (ELOOP): it is never read.
 */
export function openRooted(root: string, file: string): number {
  if (!isAbsolute(file) || normalize(file) !== file || !inside(root, file)) throw Object.assign(new Error('session_file_outside_sandbox'), { code: 'ELOOP' });
  try {
    return openPinned(file, 'any');
  } catch (error) {
    // Absent is absent; anything else (a link, a non-directory component) is never followed or read.
    if (isMissing(error)) throw error;
    throw Object.assign(new Error('session_file_not_pinned'), { code: 'ELOOP' });
  }
}

/**
 * The session directory of a sandboxed worker, `ROOT/.piw-worker/sessions/<worker_id>`, made by the supervisor through
 * descriptor-relative opens that refuse a symlink at every component, so a link planted in the root cannot make the
 * supervisor create a directory elsewhere.
 */
export function sandboxSessionDir(root: string, workerId: string): string {
  const fd = openPinned(root, 'dir');
  try {
    closeSync(openUnder(fd, [WORKER_DIR, 'sessions', workerId], 'dir', true));
  } finally {
    closeSync(fd);
  }
  return join(root, WORKER_DIR, 'sessions', workerId);
}

export const FILE_READ_MAX_BYTES = 1024 * 1024;

/**
 * `files.read` in a sandboxed worker's root: a regular UTF-8 file of at most 1 MiB, inside one of the caller's
 * explicit `roots` (each inside the sandbox root), with no hidden component and no `.` or `..`, opened with no symlink
 * at any component. `path` is absolute or relative to the root.
 *
 * `root` is the canonical cwd recorded at launch and stays the boundary: it is never resolved again, so a root (or an
 * ancestor) replaced by a symlink cannot move the boundary, and the open from `/` refuses that link like any other
 * (`file_symlink_or_unavailable`, as for a removed root).
 */
export function readConfined(root: string, path: string, roots: readonly string[]): { path: string; content: string; bytes: number; evidence: 'pinned_file_read' } {
  if (!roots.length || roots.length > 64) throw new Refusal('explicit_roots_required');
  // A relative path: no hidden component and no traversal anywhere in it. An absolute one: no traversal (its hidden
  // components are checked below the root).
  const parts = path.split('/');
  if (parts.some(p => p === '.' || p === '..') || (!isAbsolute(path) && parts.some(p => p.startsWith('.')))) throw new Refusal('hidden_or_traversal_path_refused');
  const canonical = root;
  const target = resolve(canonical, path);
  if (!inside(canonical, target) || roots.some(r => !isAbsolute(r) || !inside(canonical, resolve(r))) || !roots.some(r => inside(resolve(r), target))) throw new Refusal('file_outside_explicit_roots');
  if (relative(canonical, target).split('/').some(p => p.startsWith('.'))) throw new Refusal('hidden_or_traversal_path_refused');
  let fd: number;
  try {
    fd = openPinned(target, 'any');
  } catch {
    throw new Refusal('file_symlink_or_unavailable');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > FILE_READ_MAX_BYTES) throw new Refusal('file_not_regular_or_over_1MiB');
    const buf = Buffer.alloc(FILE_READ_MAX_BYTES + 1);
    let n = 0;
    let count: number;
    do {
      count = readSync(fd, buf, n, buf.length - n, null);
      n += count;
    } while (count && n < buf.length);
    if (n > FILE_READ_MAX_BYTES) throw new Refusal('file_over_1MiB');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
    } catch {
      throw new Refusal('file_not_utf8');
    }
    return { path: target, content, bytes: n, evidence: 'pinned_file_read' };
  } finally {
    closeSync(fd);
  }
}
