/**
 * The host commands (docs/plan/install.md): `install --from <tarball>`, `doctor`, `logs`, `uninstall` and `daemon`.
 * Every external program (systemctl, journalctl, loginctl, tar, bwrap) runs through `System.exec`, never a shell, so
 * tests replace systemd with a fake. Nothing here calls sudo.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@nublai/pi-worker-client';
import { resolvePaths } from '@nublai/pi-worker/dist/src/config.js';
import { parseJournal } from '@nublai/pi-worker/dist/src/journal/journal.js';
import { INSTALLATION_ID } from '@nublai/pi-worker/dist/src/journal/state.js';
import { TOKEN_PREFIX } from '@nublai/pi-worker/dist/src/grants/store.js';
import { LocalFailure } from './errors.js';

export const UNIT = 'pi-worker.service';
/** Release tarball names: `pi-worker-<version>-linux-<arch>.tar.gz`. */
const TARBALL = /^pi-worker-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-linux-(x64|arm64)\.tar\.gz$/;
/** What a unit file may hold literally: no spaces, quotes, `%` specifiers or `$` expansions. */
const SAFE_PATH = /^\/[A-Za-z0-9._/@+-]*$/;

/**
 * A configured path a unit file may hold and purge may act on: `SAFE_PATH` characters, absolute and canonical (no
 * empty, `.` or `..` component, no trailing slash), so string comparisons with HOME mean what they say.
 */
export function canonicalPath(path: string | undefined): path is string {
  if (path === undefined || !SAFE_PATH.test(path)) return false;
  return path === '/' || path.slice(1).split('/').every(c => c !== '' && c !== '.' && c !== '..');
}

function unsafe(which: string, detail?: string): LocalFailure {
  return new LocalFailure('pi_worker_unsafe_path', 'no_effect', { which, ...(detail ? { detail } : {}) });
}

/** `path` is `/`, HOME or a directory holding HOME, as written or once symlinks are resolved (native realpath). */
function holdsHome(path: string, home: string): boolean {
  const holds = (p: string, h: string) => p === '/' || p === h || h.startsWith(`${p}/`);
  if (holds(path, home)) return true;
  try {
    return holds(realpathSync.native(path), realpathSync.native(home));
  } catch {
    return false;
  }
}

/** The environment a user-manager command (systemctl, the grant command) runs with: `XDG_RUNTIME_DIR` defaults to `/run/user/<uid>`. */
export function userEnv(env: NodeJS.ProcessEnv, uid: number): NodeJS.ProcessEnv {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return { ...env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus` };
}

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The host as the commands see it; tests pass a fake `exec` (systemctl, loginctl) and synthetic identity. */
export interface System {
  /** Runs a program to completion. `inherit` gives it this process's stdio (`logs`). */
  exec(file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; inherit?: boolean; timeoutMs?: number }): ExecResult;
  readonly uid: number;
  readonly user: string;
  /** `x64` or `arm64`. */
  readonly arch: string;
  readonly nodeVersion: string;
  /** The node running this CLI; its directory leads the unit's PATH. */
  readonly nodePath: string;
  /** cgroup v2 mount point. */
  readonly cgroupMount: string;
  /** The daemon package's `grant` command (dist/src/grant.js). */
  readonly grantCommand: string;
}

export function realSystem(): System {
  return {
    exec(file, args, { env, inherit, timeoutMs }) {
      // `tar -t` of a release lists every node_modules file: well over spawnSync's default 1 MiB.
      const result = spawnSync(file, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: inherit ? 'inherit' : 'pipe', ...(timeoutMs ? { timeout: timeoutMs } : {}) });
      return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error ? String(result.error.message) : '') };
    },
    uid: process.getuid!(),
    user: userInfo().username,
    arch: process.arch,
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
    cgroupMount: '/sys/fs/cgroup',
    grantCommand: join(dirname(fileURLToPath(import.meta.resolve('@nublai/pi-worker'))), 'grant.js'),
  };
}

export interface Layout {
  readonly home: string;
  /** `~/.local/share/pi-worker`. */
  readonly data: string;
  readonly versions: string;
  readonly current: string;
  readonly bin: string;
  readonly unitFile: string;
  readonly doctorGrant: string;
  readonly stateDir: string;
  readonly socket: string;
  /** The environment systemctl and the grant command run with (a user manager needs XDG_RUNTIME_DIR). */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The fixed paths under HOME, and the state directory and socket the installing environment resolves (the daemon's
 * own rules, `XDG_RUNTIME_DIR` defaulting to `/run/user/<uid>`). A unit written from these pins them.
 */
export function layout(env: NodeJS.ProcessEnv, system: System): Layout {
  const home = env.HOME;
  if (!canonicalPath(home) || home === '/') throw unsafe('HOME');
  const runEnv = userEnv(env, system.uid);
  let paths: { stateDir: string; socketPath: string };
  try {
    paths = resolvePaths(runEnv);
  } catch {
    throw new LocalFailure('pi_worker_unsafe_path', 'no_effect', { which: 'state or socket' });
  }
  const data = join(home, '.local', 'share', 'pi-worker');
  return {
    home,
    data,
    versions: join(data, 'versions'),
    current: join(data, 'current'),
    bin: join(home, '.local', 'bin', 'pi-worker'),
    unitFile: join(home, '.config', 'systemd', 'user', UNIT),
    doctorGrant: join(data, 'doctor.grant.json'),
    stateDir: paths.stateDir,
    socket: paths.socketPath,
    env: runEnv,
  };
}

/** `>=X.Y.Z` met by `version` (`X.Y.Z`, any suffix ignored). An unreadable floor or version is not met. */
export function meetsFloor(version: string, floor: string): boolean {
  const want = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(floor);
  const have = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!want || !have) return false;
  for (let i = 1; i <= 3; i++) {
    const a = Number(have[i]);
    const b = Number(want[i]);
    if (a !== b) return a > b;
  }
  return true;
}

export interface Release {
  readonly version: string;
  readonly commit: string;
  readonly node_engine: string;
  readonly b2_protocol: { readonly major: number; readonly minor: number };
}

function readRelease(dir: string): Release | undefined {
  try {
    const release = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')) as Release;
    return typeof release.version === 'string' && typeof release.node_engine === 'string' ? release : undefined;
  } catch {
    return undefined;
  }
}

/** The installed version: the `versions/<version>` that `current` names, or undefined when nothing is installed. */
export function installedVersion(l: Layout): string | undefined {
  try {
    return basename(readlinkSync(l.current));
  } catch {
    return undefined;
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The tarball's `.sha256` next to it, `<hex>  <name>` (sha256sum format), checked against the tarball's bytes. */
async function verifyChecksum(tarball: string): Promise<void> {
  let line: string;
  try {
    line = readFileSync(`${tarball}.sha256`, 'utf8');
  } catch {
    throw new LocalFailure('pi_worker_checksum_missing', 'no_effect');
  }
  const match = /^([0-9a-f]{64}) [ *](\S+)\n?$/.exec(line);
  if (!match || match[2] !== basename(tarball)) throw new LocalFailure('pi_worker_checksum_mismatch', 'no_effect', { detail: 'the .sha256 file does not name this tarball' });
  if ((await sha256(tarball)) !== match[1]) throw new LocalFailure('pi_worker_checksum_mismatch', 'no_effect');
}

/** A symlink at `path` pointing to `target`, replacing what is there atomically (a new link renamed over it). */
function linkAtomically(target: string, path: string): void {
  const temp = `${path}.new-${randomBytes(6).toString('hex')}`;
  symlinkSync(target, temp);
  renameSync(temp, path);
}

function writeAtomically(path: string, text: string): void {
  const temp = `${path}.new-${randomBytes(6).toString('hex')}`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, path);
}

/** The unit file (docs/plan/install.md section 3.1). Every path in it was checked against SAFE_PATH. */
export function unitText(l: Layout, version: string, nodeDir: string): string {
  return [
    `# Written by \`pi-worker install\` (${version}); \`pi-worker uninstall\` removes it.`,
    '[Unit]',
    'Description=pi-worker supervisor (nubl)',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=${join(l.current, 'bin', 'pi-worker')} daemon`,
    // The kernel tier's delegation: the daemon moves into the unit cgroup's `supervisor` leaf and its workers' cleanup
    // domains are siblings of that leaf.
    'Delegate=yes',
    'Restart=on-failure',
    'RestartSec=2',
    'TimeoutStopSec=30',
    'UMask=0077',
    `Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin`,
    `Environment=PIW_STATE_DIR=${l.stateDir}`,
    `Environment=PIW_SOCKET=${l.socket}`,
    // No Node warning on the journal ahead of a typed error (the wrapper sets it too; real errors still print).
    'Environment=NODE_NO_WARNINGS=1',
    // The supervisor logs typed JSON events on stderr only; stdout is unused, so no prompt text reaches the journal.
    'StandardOutput=null',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Something is at the unit file's path (only a missing path or directory means no installation). */
function unitInstalled(unitFile: string): boolean {
  try {
    lstatSync(unitFile);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** `systemctl --user show` output, `Name=value` per line. */
function parseShow(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return props;
}

/**
 * The unit as the user manager has it loaded (`systemctl --user show`): its `LoadState`, `NeedDaemonReload`,
 * `EnvironmentFiles`, `Environment` and `UnsetEnvironment`, so drop-ins, `Environment=` resets, quoting and repeated
 * assignments count as they do for the daemon. systemd that cannot be asked is a refusal, never a guess.
 */
function unitShow(system: System, env: NodeJS.ProcessEnv): Record<string, string> {
  const names = ['LoadState', 'NeedDaemonReload', 'EnvironmentFiles', 'Environment', 'UnsetEnvironment'];
  const result = system.exec('systemctl', ['--user', 'show', UNIT, ...names.map(n => `--property=${n}`)], { env, timeoutMs: 30_000 });
  if (result.status !== 0) throw new LocalFailure('pi_worker_systemctl_failed', 'no_effect', { step: 'show', detail: result.stderr.trim().slice(0, 256) });
  return parseShow(result.stdout);
}

/**
 * The one `KEY` assignment in the unit's final environment, canonical. Anything else is refused
 * `pi_worker_unsafe_path` (`which`), never read as "no pin": an `UnsetEnvironment=` naming it (systemd removes it from
 * the environment last, `Environment=` included), no assignment (systemctl prints a value with a space or newline
 * quoted or as `[unprintable]`), several, or a value that is not canonical.
 */
function pinnedValue(props: Record<string, string>, key: string, which: string): string {
  if (new RegExp(`(^|[\\s"])${key}(=|[\\s"]|$)`).test(props.UnsetEnvironment ?? '')) throw unsafe(which, `the installed unit's UnsetEnvironment= removes ${key}`);
  const values = (props.Environment ?? '').split(' ').filter(word => word.startsWith(`${key}=`));
  if (values.length !== 1) throw unsafe(which, `the installed unit's environment has ${values.length ? 'several' : 'no printable'} ${key}`);
  const value = values[0]!.slice(key.length + 1);
  if (!canonicalPath(value)) throw unsafe(which, `the installed unit pins a ${key} that is not canonical`);
  return value;
}

/**
 * What the installed unit runs with, from `unitShow`: `none` with no unit file under HOME (nothing is asked),
 * `unloaded` for a unit file systemd has not loaded (`LoadState=not-found`), else the state directory and socket its
 * environment pins (`pinnedValue`).
 */
type InstalledUnit = { readonly kind: 'none' } | { readonly kind: 'unloaded' } | { readonly kind: 'pinned'; readonly stateDir: string; readonly socket: string };

/**
 * The one resolver of the installed unit's effective state directory and socket, used by every command that needs
 * them (`grant`, `install`, `uninstall --purge`, `doctor`, `version`); nothing parses the unit file itself. Unit files
 * changed since systemd read them (`NeedDaemonReload=yes`: an unread drop-in, an edited unit) are refused
 * `pi_worker_unit_reload_pending`, unless `reload` is given (install): it runs `daemon-reload` and asks again. An
 * `EnvironmentFile=` (it would override `Environment=`) and a load state other than `loaded` or `not-found` refuse
 * `pi_worker_unsafe_path` (`which: state`).
 */
function installedUnit(system: System, env: NodeJS.ProcessEnv, home: string, reload?: () => void): InstalledUnit {
  if (!unitInstalled(join(home, '.config', 'systemd', 'user', UNIT))) return { kind: 'none' };
  let props = unitShow(system, env);
  if (props.NeedDaemonReload === 'yes' && reload) {
    reload();
    props = unitShow(system, env);
  }
  if (props.NeedDaemonReload === 'yes') throw new LocalFailure('pi_worker_unit_reload_pending', 'no_effect', { detail: 'the unit files changed since systemd read them; run systemctl --user daemon-reload' });
  if (props.LoadState === 'not-found') return { kind: 'unloaded' };
  if (props.LoadState !== 'loaded') throw unsafe('state', `the installed unit's LoadState is ${props.LoadState || 'unknown'}`);
  if (props.EnvironmentFiles) throw unsafe('state', 'the installed unit has an EnvironmentFile=, which could set PIW_STATE_DIR or PIW_SOCKET');
  return { kind: 'pinned', stateDir: pinnedValue(props, 'PIW_STATE_DIR', 'state'), socket: pinnedValue(props, 'PIW_SOCKET', 'socket') };
}

/**
 * The environment a local `grant` command runs with: the state directory the installed unit pins, never the caller's
 * guess. A HOME that is set but not canonical is refused, as `layout` refuses it. With a unit file under HOME, the
 * command gets the state directory systemd runs the unit with (`installedUnit`; any doubt refuses, a unit file systemd
 * has not loaded included); a caller whose
 * environment names a different one (`PIW_STATE_DIR`, else `XDG_STATE_HOME`) is refused `pi_worker_state_mismatch`
 * (no effect) before the command reads or writes anything, so a grant is never registered where the daemon does not
 * look. A caller that names none, or the same one, gets the pin. With no unit file (or no HOME to find one under) the
 * caller's own environment resolves it, as the daemon would.
 */
export function grantEnv(env: NodeJS.ProcessEnv, system: System): NodeJS.ProcessEnv {
  const base = userEnv(env, system.uid);
  const home = env.HOME;
  if (!home) return base;
  if (!canonicalPath(home) || home === '/') throw unsafe('HOME');
  const unit = installedUnit(system, base, home);
  if (unit.kind === 'none') return base;
  if (unit.kind === 'unloaded') throw unsafe('state', 'systemd has not loaded the installed unit; run systemctl --user daemon-reload');
  const stateDir = unit.stateDir;
  const named = env.PIW_STATE_DIR || (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, 'pi-worker') : undefined);
  if (named !== undefined && (!isAbsolute(named) || resolve(named) !== stateDir)) {
    throw new LocalFailure('pi_worker_state_mismatch', 'no_effect', { pinned: stateDir, requested: named });
  }
  return { ...base, PIW_STATE_DIR: stateDir };
}

function systemctl(system: System, l: Layout, step: string, ...args: string[]): ExecResult {
  const result = system.exec('systemctl', ['--user', ...args], { env: l.env, timeoutMs: 120_000 });
  if (result.status !== 0) throw new LocalFailure('pi_worker_systemctl_failed', 'unknown', { step, detail: result.stderr.trim().slice(0, 256) });
  return result;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** `hello` with the doctor grant, or the failure's message. */
async function hello(l: Layout, timeoutMs: number): Promise<{ ok: true; version: string; protocol: string } | { ok: false; detail: string }> {
  try {
    const reply = await new Client({ socketPath: l.socket, grantFile: l.doctorGrant, timeoutMs }).hello();
    return { ok: true, version: reply.worker_version, protocol: `${reply.protocol.major}.${reply.protocol.minor}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 256) : 'hello failed' };
  }
}

/**
 * Reads the tarball without writing anything: every member name (as stored, `tar -tP`) lies under `pi-worker-<version>/`
 * with no absolute path and no `.` or `..` component, and its `release.json` names this version. Returns that release.
 */
function inspectTarball(system: System, l: Layout, tarball: string, version: string): Release {
  const invalid = (detail: string) => new LocalFailure('pi_worker_tarball_invalid', 'no_effect', { detail });
  const top = `pi-worker-${version}`;
  const list = system.exec('tar', ['-tzPf', tarball, '--quoting-style=escape'], { env: l.env, timeoutMs: 300_000 });
  if (list.status !== 0) throw invalid('tar could not list it');
  for (const name of list.stdout.split('\n')) {
    if (name === '') continue;
    const parts = name.replace(/\/$/, '').split('/');
    if (parts[0] !== top || parts.some(p => p === '' || p === '.' || p === '..')) throw invalid(`a member outside ${top}/, absolute or with a . or .. component`);
  }
  const read = system.exec('tar', ['-xzOf', tarball, `${top}/release.json`], { env: l.env, timeoutMs: 300_000 });
  let release: Release | undefined;
  try {
    release = read.status === 0 ? (JSON.parse(read.stdout) as Release) : undefined;
  } catch {
    release = undefined;
  }
  if (release?.version !== version || typeof release.node_engine !== 'string') throw invalid('release.json does not name this version');
  return release;
}

/**
 * What an unpacked tree may not hold: a symlink that does not resolve inside `root` (followed as the kernel would), a
 * hard link, or a device, FIFO or socket. Returns the first problem found.
 */
function unconfined(root: string): string | undefined {
  // The native realpath: Node's own resolves `..` after a link lexically, which is not where the kernel goes.
  const base = realpathSync.native(root);
  const walk = (dir: string): string | undefined => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync.native(path);
        } catch {
          return 'a symlink that resolves to nothing';
        }
        if (target !== base && !target.startsWith(`${base}/`)) return 'a symlink out of the version directory';
      } else if (st.isDirectory()) {
        const inner = walk(path);
        if (inner) return inner;
      } else if (!st.isFile()) return 'a device, FIFO or socket';
      else if (st.nlink > 1) return 'a hard link';
    }
    return undefined;
  };
  return walk(root);
}

/**
 * Unpacks the inspected tarball through a staging directory renamed into `versions/<version>`. It writes first, so its
 * refusals are effect `unknown` (the staging directory is removed; `versions/` may remain).
 */
function unpack(system: System, l: Layout, tarball: string, version: string): void {
  const invalid = (detail: string) => new LocalFailure('pi_worker_tarball_invalid', 'unknown', { detail });
  const target = join(l.versions, version);
  mkdirSync(l.versions, { recursive: true, mode: 0o755 });
  const staging = join(l.versions, `.staging-${randomBytes(6).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const result = system.exec('tar', ['-xzf', tarball, '-C', staging, '--no-same-owner', '--no-same-permissions'], { env: l.env, timeoutMs: 300_000 });
    if (result.status !== 0) throw invalid('tar could not unpack it');
    const top = `pi-worker-${version}`;
    const entries = readdirSync(staging);
    if (entries.length !== 1 || entries[0] !== top || !lstatSync(join(staging, top)).isDirectory()) throw invalid(`expected one top directory ${top}`);
    const problem = unconfined(join(staging, top));
    if (problem) throw invalid(problem);
    if (readRelease(join(staging, top))?.version !== version) throw invalid('release.json does not name this version');
    const entry = join(staging, top, 'bin', 'pi-worker');
    let regular: boolean;
    try {
      regular = lstatSync(entry).isFile();
      accessSync(entry, constants.X_OK);
    } catch {
      regular = false;
    }
    // A directory is searchable (X_OK) and a link is not the file itself: neither is the entry the unit runs.
    if (!regular) throw invalid('bin/pi-worker is not an executable regular file');
    chmodSync(join(staging, top), 0o755);
    renameSync(join(staging, top), target);
  } finally {
    removeTree(staging);
  }
}

/**
 * An installed unit keeps its state directory: another one (an override, or drift back to the default) would repin the
 * daemon away from its journal and grants, so it is refused `pi_worker_state_mismatch` before anything is written.
 * Relocation is not install's job. With no pin (no unit file, or one systemd has not loaded: an install stopped before
 * daemon-reload, or an uninstall that kept the state), the doctor grant an earlier install registered still names its
 * state: when that grant is not in the requested directory, the request is another one, refused the same way.
 */
function keepsPinnedState(l: Layout, unit: InstalledUnit): void {
  if (unit.kind === 'pinned' && unit.stateDir !== l.stateDir) throw new LocalFailure('pi_worker_state_mismatch', 'no_effect', { pinned: unit.stateDir, requested: l.stateDir });
  if (unit.kind !== 'pinned' && lstatExists(l.doctorGrant) && !grantMarker(l.stateDir, l)) {
    throw new LocalFailure('pi_worker_state_mismatch', 'no_effect', { requested: l.stateDir, detail: `the doctor grant of an earlier install (${l.doctorGrant}) is not registered in this state directory` });
  }
}

/**
 * After `daemon-reload`, the state directory systemd runs the written unit with must be the requested one: a drop-in
 * the owner kept (uninstall never removes one) can pin another. Refused `pi_worker_state_mismatch`, effect unknown
 * (the unit file is written), before the unit is enabled or restarted.
 */
function loadedAsWritten(system: System, l: Layout): void {
  let unit: InstalledUnit;
  try {
    unit = installedUnit(system, l.env, l.home);
  } catch (error) {
    if (error instanceof LocalFailure) throw new LocalFailure(error.code, 'unknown', error.details);
    throw error;
  }
  if (unit.kind !== 'pinned' || unit.stateDir !== l.stateDir) {
    throw new LocalFailure('pi_worker_state_mismatch', 'unknown', { ...(unit.kind === 'pinned' ? { pinned: unit.stateDir } : { detail: 'systemd did not load the written unit' }), requested: l.stateDir });
  }
}

export interface InstallOptions {
  readonly from: string;
  readonly waitMs?: number;
}

/** `pi-worker install --from <tarball>`; resolves with the printed `{version, socket, unit, restarted}`. */
export async function install(options: InstallOptions, env: NodeJS.ProcessEnv, system: System): Promise<Record<string, string | boolean>> {
  const tarball = options.from;
  const name = TARBALL.exec(basename(tarball));
  const version = name?.[1];
  const arch = name?.[2];
  if (!version || !arch || !tarball.startsWith('/')) throw new LocalFailure('pi_worker_tarball_name', 'no_effect', { detail: 'pass the absolute path of pi-worker-<version>-linux-<arch>.tar.gz' });
  if (arch !== system.arch) throw new LocalFailure('pi_worker_arch_mismatch', 'no_effect', { tarball: arch, host: system.arch });
  const l = layout(env, system);
  const nodeDir = dirname(system.nodePath);
  for (const [which, path] of [['node', nodeDir], ['state', l.stateDir], ['socket', l.socket]] as const) {
    if (!canonicalPath(path)) throw unsafe(which);
  }
  // A state directory purge could never remove is not pinned in the first place.
  if (holdsHome(l.stateDir, l.home)) throw unsafe('state', 'the state directory is /, HOME or holds HOME');

  // Refusals, before anything is written.
  await verifyChecksum(tarball);
  const installed = installedVersion(l);
  if (installed !== undefined && installed !== version) {
    throw new LocalFailure('pi_worker_upgrade_unavailable', 'no_effect', { installed, requested: version });
  }
  if (lstatExists(l.bin)) {
    const ours = lstatSync(l.bin).isSymbolicLink() && readlinkSync(l.bin).startsWith(`${l.data}/`);
    if (!ours) throw new LocalFailure('pi_worker_bin_conflict', 'no_effect', { path: l.bin });
  }
  // The pin systemd will run with: unit files it has not read yet are read first (daemon-reload), then resolved.
  const installedPin = installedUnit(system, l.env, l.home, () => systemctl(system, l, 'daemon-reload', 'daemon-reload'));
  keepsPinnedState(l, installedPin);
  const target = join(l.versions, version);
  if (existsSync(target)) {
    const release = readRelease(target);
    if (release?.version !== version) throw new LocalFailure('pi_worker_tarball_invalid', 'no_effect', { detail: `${target} is not version ${version}; remove it` });
    if (!meetsFloor(system.nodeVersion, release.node_engine)) {
      throw new LocalFailure('pi_worker_node_unsupported', 'no_effect', { required: release.node_engine, found: system.nodeVersion });
    }
  } else {
    const release = inspectTarball(system, l, tarball, version);
    if (!meetsFloor(system.nodeVersion, release.node_engine)) {
      throw new LocalFailure('pi_worker_node_unsupported', 'no_effect', { required: release.node_engine, found: system.nodeVersion });
    }
    // The first write.
    unpack(system, l, tarball, version);
  }

  // From here the host changes: a failure is effect unknown; install again (idempotent) or uninstall.
  linkAtomically(join('versions', version), l.current);
  mkdirSync(dirname(l.bin), { recursive: true });
  linkAtomically(join(l.current, 'bin', 'pi-worker'), l.bin);
  mkdirSync(dirname(l.unitFile), { recursive: true });
  const unit = unitText(l, version, nodeDir);
  const changed = !existsSync(l.unitFile) || readFileSync(l.unitFile, 'utf8') !== unit;
  if (changed) writeAtomically(l.unitFile, unit);
  if (!existsSync(l.doctorGrant)) registerDoctorGrant(system, l);
  systemctl(system, l, 'daemon-reload', 'daemon-reload');
  loadedAsWritten(system, l);
  const wasActive = system.exec('systemctl', ['--user', 'is-active', UNIT], { env: l.env }).stdout.trim() === 'active';
  systemctl(system, l, 'enable', 'enable', '--now', UNIT);
  // A restart stops every running worker; the caller is told when it happened (docs/plan/install.md section 3).
  const restarted = changed && wasActive;
  if (restarted) systemctl(system, l, 'restart', 'restart', UNIT);

  const deadline = Date.now() + (options.waitMs ?? 60_000);
  let last = 'no answer';
  for (;;) {
    const reply = await hello(l, 5_000);
    if (reply.ok && reply.version === version) break;
    last = reply.ok ? `hello answered version ${reply.version}` : reply.detail;
    if (Date.now() >= deadline) throw new LocalFailure('pi_worker_not_ready', 'unknown', { socket: l.socket, detail: last });
    await sleep(250);
  }
  return { version, socket: l.socket, unit: UNIT, restarted };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The `hello`-only grant that doctor and the readiness wait use; the bearer goes only to its 0600 file. */
function registerDoctorGrant(system: System, l: Layout): void {
  mkdirSync(l.data, { recursive: true });
  const result = system.exec(system.nodePath, [system.grantCommand, 'register', '--caller', 'pi-worker-doctor', '--method', 'hello', '--out', l.doctorGrant], {
    env: { ...l.env, PIW_STATE_DIR: l.stateDir },
    timeoutMs: 60_000,
  });
  if (result.status !== 0) throw new LocalFailure('pi_worker_grant_failed', 'unknown', { detail: /^Refusal \[Error\]: ([a-z_]+)$/m.exec(result.stderr)?.[1] ?? 'grant register failed' });
}

export interface Check {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The node floor of the installed release, else of this CLI's own package (its nearest package.json). */
function nodeFloor(l: Layout): string {
  const installed = readRelease(l.current)?.node_engine;
  if (installed) return installed;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { engines?: { node?: string } }).engines?.node ?? 'unknown';
    if (dirname(dir) === dir) return 'unknown';
    dir = dirname(dir);
  }
}

function properties(system: System, l: Layout, ...names: string[]): Record<string, string> {
  const result = system.exec('systemctl', ['--user', 'show', UNIT, ...names.map(n => `--property=${n}`)], { env: l.env, timeoutMs: 30_000 });
  return result.status === 0 ? parseShow(result.stdout) : {};
}

/**
 * The socket `doctor` and `version` hello: the one systemd runs the installed unit with (`installedUnit`), or with no
 * unit file the one this environment resolves. When systemd cannot establish it (any refusal, or a unit it has not
 * loaded) there is no socket to try, never a guess: why, as `refused`.
 */
function effectiveSocket(system: System, l: Layout): { socket: string } | { refused: string } {
  let unit: InstalledUnit;
  try {
    unit = installedUnit(system, l.env, l.home);
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    const detail = error.details.detail ?? error.details.step;
    return { refused: `${error.code}${error.details.which ? ` (${String(error.details.which)})` : ''}${detail ? `: ${String(detail)}` : ''}` };
  }
  if (unit.kind === 'unloaded') return { refused: 'systemd has not loaded the installed unit' };
  return { socket: unit.kind === 'pinned' ? unit.socket : l.socket };
}

function cgroupCheck(system: System, l: Layout): Check {
  const id = 'cgroup_delegation';
  if (!existsSync(join(system.cgroupMount, 'cgroup.controllers'))) return { id, ok: false, detail: `cgroup v2 is not mounted at ${system.cgroupMount}` };
  const props = properties(system, l, 'Delegate', 'ControlGroup');
  if (props.Delegate !== 'yes') return { id, ok: false, detail: `${UNIT} does not have Delegate=yes (installed?)` };
  // While the unit runs, its own cgroup; while it is stopped, what the user manager would delegate to it.
  const cg = props.ControlGroup ? join(system.cgroupMount, props.ControlGroup) : join(system.cgroupMount, 'user.slice', `user-${system.uid}.slice`, `user@${system.uid}.service`);
  try {
    const controllers = readFileSync(join(cg, 'cgroup.controllers'), 'utf8').split(/\s+/);
    const missing = ['memory', 'pids'].filter(c => !controllers.includes(c));
    if (missing.length) return { id, ok: false, detail: `${missing.join(', ')} not delegated to ${cg}` };
    if (!existsSync(join(cg, 'cgroup.kill'))) return { id, ok: false, detail: 'cgroup.kill unavailable (Linux 5.14+ required)' };
    if (props.ControlGroup) accessSync(join(cg, 'cgroup.procs'), constants.W_OK);
  } catch {
    return { id, ok: false, detail: `${cg} is not a writable cgroup v2 delegation` };
  }
  return { id, ok: true, detail: `${cg}: memory, pids, cgroup.kill` };
}

function reachable(socket: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    const conn = connect(socket);
    const timer = setTimeout(() => {
      conn.destroy();
      resolve('timed out');
    }, timeoutMs);
    conn.once('connect', () => {
      clearTimeout(timer);
      conn.destroy();
      resolve(undefined);
    });
    conn.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code ?? 'error');
    });
  });
}

/** `pi-worker doctor`: every check, in the documented order. */
export async function doctor(env: NodeJS.ProcessEnv, system: System): Promise<Check[]> {
  const l = layout(env, system);
  const effective = effectiveSocket(system, l);
  const checks: Check[] = [];
  const floor = nodeFloor(l);
  checks.push({ id: 'node_version', ok: meetsFloor(system.nodeVersion, floor), detail: `node ${system.nodeVersion} at ${system.nodePath}; required ${floor}` });
  const bwrap = system.exec('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-user', '--unshare-pid', '--', '/bin/sh', '-c', 'true'], { env: l.env, timeoutMs: 30_000 });
  checks.push({ id: 'bwrap_usable', ok: bwrap.status === 0, detail: bwrap.status === 0 ? 'bwrap runs a command in new user and pid namespaces' : `bwrap failed: ${bwrap.stderr.trim().slice(0, 200) || 'not found'}` });
  checks.push(cgroupCheck(system, l));
  const active = system.exec('systemctl', ['--user', 'is-active', UNIT], { env: l.env, timeoutMs: 30_000 }).stdout.trim();
  checks.push({ id: 'unit_active', ok: active === 'active', detail: `${UNIT} ${active || 'unknown'}` });
  if ('socket' in effective) {
    const socket = effective.socket;
    const unreachable = await reachable(socket, 3_000);
    checks.push({ id: 'socket_reachable', ok: unreachable === undefined, detail: unreachable === undefined ? socket : `${socket}: ${unreachable}` });
    const reply = await hello({ ...l, socket }, 10_000);
    checks.push({ id: 'hello', ok: reply.ok, detail: reply.ok ? `worker ${reply.version}, protocol ${reply.protocol}` : reply.detail });
  } else {
    const detail = `the installed unit's socket cannot be established: ${effective.refused}`;
    checks.push({ id: 'socket_reachable', ok: false, detail }, { id: 'hello', ok: false, detail });
  }
  const linger = system.exec('loginctl', ['show-user', system.user, '--property=Linger', '--value'], { env: l.env, timeoutMs: 30_000 }).stdout.trim();
  checks.push({ id: 'linger', ok: linger === 'yes', detail: linger === 'yes' ? 'on' : `off; the unit stops when ${system.user} has no session (loginctl enable-linger ${system.user}, as root)` });
  return checks;
}

/** The installed release's `release.json`, whole: every field `version` prints must be of its documented type. */
function readFullRelease(dir: string): Release | undefined {
  const release = readRelease(dir);
  const protocol = release?.b2_protocol;
  const number = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  return release && typeof release.commit === 'string' && protocol !== null && typeof protocol === 'object' && number(protocol.major) && number(protocol.minor) ? release : undefined;
}

/**
 * `pi-worker version`: `release.json` of the installed `current`, plus the version the daemon's `hello` reports
 * (`null` when it does not answer: this works without the daemon). Nothing installed is refused `pi_worker_not_installed`.
 */
export async function version(env: NodeJS.ProcessEnv, system: System): Promise<Record<string, unknown>> {
  const l = layout(env, system);
  if (installedVersion(l) === undefined) throw new LocalFailure('pi_worker_not_installed', 'no_effect');
  const release = readFullRelease(l.current);
  if (!release) throw new LocalFailure('pi_worker_release_unreadable', 'no_effect');
  const effective = effectiveSocket(system, l);
  const reply = 'socket' in effective ? await hello({ ...l, socket: effective.socket }, 3_000) : { ok: false as const };
  return { version: release.version, commit: release.commit, b2_protocol: release.b2_protocol, daemon_version: reply.ok ? reply.version : null };
}

/** `pi-worker logs [-f]`: the journal of the unit; resolves with journalctl's exit status. */
export function logs(follow: boolean, env: NodeJS.ProcessEnv, system: System): number {
  const l = layout(env, system);
  const result = system.exec('journalctl', ['--user', '-u', UNIT, '--no-pager', ...(follow ? ['-f'] : [])], { env: l.env, inherit: true });
  return result.status ?? 1;
}

/**
 * Removes a tree without following links: a link (or any non-directory) at `path` is unlinked, never entered. When a
 * plain removal is refused, real directories inside (never a link's target) are made writable first.
 */
export function removeTree(path: string): void {
  let top;
  try {
    top = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!top.isDirectory()) {
    rmSync(path, { force: true });
    return;
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Dirent types come from the directory itself (lstat semantics): a link is never a directory here.
    const writable = (dir: string): void => {
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) writable(join(dir, entry.name));
    };
    writable(path);
    rmSync(path, { recursive: true, force: true });
  }
}

type Kind = 'dir' | 'file' | 'socket';

/** What the daemon and the `grant` command write at the top of a state directory, by type (lstat). */
const STATE_ENTRIES: Readonly<Record<string, Kind>> = {
  'journal.jsonl': 'file',
  'journal.jsonl.compact': 'file',
  'journal.lock': 'file',
  // The lock's SQLite rollback journal (src/lock.ts), present while a supervisor holds the lock.
  'journal.lock-journal': 'file',
  grants: 'dir',
  sessions: 'dir',
  attachments: 'dir',
  // Owner Git's pinned snapshots (owner-git/git-safe.ts).
  'git-snapshots': 'dir',
};

/** A `journal.jsonl` pi-worker wrote: it parses as a journal and a start record names a valid installation id. */
function journalMarker(stateDir: string): boolean {
  try {
    const records = parseJournal(readFileSync(join(stateDir, 'journal.jsonl'))).records;
    return records.some(r => r.kind === 'supervisor' && typeof r.value.installation_id === 'string' && INSTALLATION_ID.test(r.value.installation_id));
  } catch {
    return false;
  }
}

/** This install's doctor grant registered in the state directory: `grants/<id>.json`, `<id>` from the bearer's token. */
function grantMarker(stateDir: string, l: Layout): boolean {
  try {
    const token = (JSON.parse(readFileSync(l.doctorGrant, 'utf8')) as { token?: unknown }).token;
    const [prefix, id] = typeof token === 'string' ? token.split('.') : [];
    if (prefix !== TOKEN_PREFIX || !id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return false;
    return lstatSync(join(stateDir, 'grants', `${id}.json`)).isFile();
  } catch {
    return false;
  }
}

/**
 * Why purge may not remove `stateDir` whole, or undefined: it must hold pi-worker's own marker (a journal with an
 * installation id, or this install's doctor grant) and, at its top, nothing pi-worker does not write. Neither the path
 * nor the owner is evidence that pi-worker made the directory.
 */
function foreignState(stateDir: string, l: Layout): string | undefined {
  const is: Record<Kind, (e: { isDirectory(): boolean; isFile(): boolean }) => boolean> = { dir: e => e.isDirectory(), file: e => e.isFile(), socket: () => false };
  let entries;
  try {
    entries = readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return 'cannot be read';
  }
  for (const entry of entries) {
    // Own properties only: a foreign `constructor` or `__proto__` must not resolve to an inherited value.
    const kind = Object.hasOwn(STATE_ENTRIES, entry.name) ? STATE_ENTRIES[entry.name] : undefined;
    if (!kind || !is[kind](entry)) return 'it holds an entry pi-worker does not write';
  }
  if (!journalMarker(stateDir) && !grantMarker(stateDir, l)) return 'it holds no pi-worker journal and no doctor grant of this install';
  return undefined;
}

interface Removal {
  readonly which: string;
  readonly path: string;
  readonly kind: Kind;
  /** Checked but not removed (the data directory is removed only when empty). */
  readonly keep?: boolean;
}

/**
 * What purge removes: only the paths install and the daemon create (`versions/`, the doctor grant, the state directory,
 * the socket's `pi-worker` directory or the socket), never `/`, HOME or a directory holding it. Each that exists must
 * be a real directory, file or socket of this user, not a symlink. Any doubt refuses before anything is removed.
 */
function purgePlan(l: Layout, pin: { stateDir?: string; socket?: string }, uid: number): Removal[] {
  const stateDir = pin.stateDir ?? l.stateDir;
  if (!canonicalPath(stateDir)) throw unsafe('state');
  if (holdsHome(stateDir, l.home)) throw unsafe('state', 'the state directory is /, HOME or holds HOME');
  const socket = pin.socket ?? l.socket;
  if (!canonicalPath(socket)) throw unsafe('socket');
  const own = basename(dirname(socket)) === 'pi-worker';
  if (own && holdsHome(dirname(socket), l.home)) throw unsafe('socket', 'the socket directory holds HOME');
  const plan: Removal[] = [
    { which: 'data', path: l.data, kind: 'dir', keep: true },
    { which: 'data', path: l.versions, kind: 'dir' },
    { which: 'data', path: l.doctorGrant, kind: 'file' },
    { which: 'state', path: stateDir, kind: 'dir' },
    own ? { which: 'socket', path: dirname(socket), kind: 'dir' } : { which: 'socket', path: socket, kind: 'socket' },
  ];
  const is: Record<Kind, (s: Stats) => boolean> = { dir: s => s.isDirectory(), file: s => s.isFile(), socket: s => s.isSocket() };
  return plan.filter(r => {
    let st;
    try {
      st = lstatSync(r.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw unsafe(r.which, 'cannot be inspected');
    }
    if (st.uid !== uid || !is[r.kind](st)) throw unsafe(r.which, `not a ${r.kind === 'dir' ? 'directory' : r.kind} of this user (a symlink?)`);
    if (r.which === 'state') {
      const foreign = foreignState(r.path, l);
      if (foreign) throw unsafe('state', `not a pi-worker state directory: ${foreign}`);
    }
    return !r.keep;
  });
}

/**
 * What purge removes as the state directory and socket: what systemd runs the installed unit with (`installedUnit`;
 * any refusal stands, and a unit file it has not loaded cannot be established either), or, with no unit file, what
 * this environment resolves (`{}`).
 */
function purgeTargets(system: System, l: Layout): { stateDir?: string; socket?: string } {
  const unit = installedUnit(system, l.env, l.home);
  if (unit.kind === 'unloaded') throw unsafe('state', 'systemd has not loaded the installed unit, so its state directory cannot be established; run systemctl --user daemon-reload');
  return unit.kind === 'pinned' ? { stateDir: unit.stateDir, socket: unit.socket } : {};
}

/** `pi-worker uninstall [--purge]`. Without `--purge` it touches no state or socket, so it resolves none. */
export function uninstall(purge: boolean, env: NodeJS.ProcessEnv, system: System): Record<string, unknown> {
  const l = layout(env, system);
  const pin = purge ? purgeTargets(system, l) : {};
  // A purge is planned and checked before anything is stopped or removed.
  const removals = purge ? purgePlan(l, pin, system.uid) : [];
  if (existsSync(l.unitFile)) {
    systemctl(system, l, 'disable', 'disable', '--now', UNIT);
    rmSync(l.unitFile, { force: true });
    systemctl(system, l, 'daemon-reload', 'daemon-reload');
  }
  system.exec('systemctl', ['--user', 'reset-failed', UNIT], { env: l.env, timeoutMs: 30_000 });
  if (lstatExists(l.bin) && lstatSync(l.bin).isSymbolicLink() && readlinkSync(l.bin).startsWith(`${l.data}/`)) rmSync(l.bin, { force: true });
  if (lstatExists(l.current)) rmSync(l.current, { force: true });
  for (const r of removals) removeTree(r.path);
  if (purge) {
    // The data directory goes only when nothing but what install made was in it.
    try {
      rmdirSync(l.data);
    } catch {
      // ENOENT or ENOTEMPTY: a file of the owner's stays.
    }
  }
  return { uninstalled: true, purged: purge };
}

/** `pi-worker daemon`: the supervisor in the installed unit (the daemon package's service entry). */
export async function daemon(): Promise<void> {
  const main = join(dirname(fileURLToPath(import.meta.resolve('@nublai/pi-worker'))), 'service-main.js');
  await import(pathToFileURL(main).href);
}
