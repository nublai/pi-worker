/**
 * The host commands (src/host.ts, docs/plan/install.md) through the CLI's `run`, against a fake systemd: `systemctl`,
 * `loginctl`, `journalctl` and `bwrap` are answered by the fake; `tar` and the daemon package's real `grant` command
 * run. "Starting" the unit starts a fake B2 server on the pinned socket that answers `hello` with a chosen version.
 * Every test uses a synthetic environment under its own scratch directory, never this process's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState } from '@nublai/pi-worker/dist/src/journal/state.js';
import { realSystem, removeTree, type ExecResult, type System } from '../src/host.js';
import { run } from '../src/run.js';

const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const OTHER_ARCH = ARCH === 'x64' ? 'arm64' : 'x64';
// The spec's own hello example: the client checks every reply against the spec before the CLI sees it.
const HELLO = (JSON.parse(readFileSync(new URL('../../../../api/fixtures/wire/hello/ok.json', import.meta.url), 'utf8')) as { response: { body: Record<string, unknown> } }).response.body;
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
// The real uid: purge only removes what this user owns.
const UID = process.getuid!();

interface Host {
  dir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  data: string;
  socket: string;
  state: string;
  unitFile: string;
  bin: string;
  calls: string[][];
  /**
   * `uid` is the uid the commands see (default: this process's). `show` answers from the unit files as they were at the
   * last `daemon-reload` (`systemdShow`; a unit never reloaded is `not-found`), with `NeedDaemonReload=yes` once the
   * files on disk differ; `showStatus`, `loadState` and `environment` override it, as a manager that cannot be asked,
   * has not loaded the file, or prints its environment differently would. `failReloads` fails that many
   * `daemon-reload`s (an install interrupted there).
   */
  unit: {
    active: boolean;
    delegate: string;
    linger: string;
    serveVersion: string | undefined;
    journalStatus: number;
    uid: number;
    showStatus: number;
    failReloads: number;
    loadState?: string;
    environment?: string;
  };
  cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string[]; json?: Record<string, unknown>; error?: Record<string, unknown> }>;
  tarball(version: string, options?: TarballOptions): string;
  /** `systemctl --user daemon-reload` as the owner runs it: the manager reads the unit files on disk. */
  reload(): void;
  /** The supervisor restarted with the environment the manager has loaded (its fake B2 server moves to that socket). */
  restartServer(): Promise<void>;
  close(): Promise<void>;
}

interface TarballOptions {
  arch?: string;
  release?: Record<string, unknown>;
  extraTop?: boolean;
  badSha?: boolean;
  noSha?: boolean;
  /** Changes the unpacked tree (`top` is `pi-worker-<version>/`) before it is packed. */
  edit?: (top: string, src: string) => void;
  /** Extra `tar -c` arguments (members added after the top directory, `--transform`, `-P`). */
  tarArgs?: string[];
}

/** `configure` returns environment overrides; an `undefined` value removes the variable. */
async function host(configure: (dirs: { dir: string; home: string; runtime: string }) => NodeJS.ProcessEnv = () => ({})): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'piw-host-'));
  const home = join(dir, 'home');
  const runtime = join(dir, 'run');
  mkdirSync(home);
  mkdirSync(runtime, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_RUNTIME_DIR: runtime, PATH: '/usr/bin:/bin', ...configure({ dir, home, runtime }) };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const socket = env.PIW_SOCKET ?? join(runtime, 'pi-worker', 'b2.sock');
  // A fake cgroupfs: the user manager's delegation and the unit's cgroup, both offering memory and pids.
  const cgroupMount = join(dir, 'cgroupfs');
  const unitCg = `/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/pi-worker.service`;
  for (const cg of [`/user.slice/user-${UID}.slice/user@${UID}.service`, unitCg]) {
    mkdirSync(join(cgroupMount, cg), { recursive: true });
    for (const [file, text] of [['cgroup.controllers', 'cpu memory pids\n'], ['cgroup.kill', ''], ['cgroup.procs', '']]) writeFileSync(join(cgroupMount, cg, file!), text!);
  }
  writeFileSync(join(cgroupMount, 'cgroup.controllers'), 'cpu memory pids\n');
  const unitFile = join(home, '.config', 'systemd', 'user', 'pi-worker.service');
  const unit: Host['unit'] = { active: false, delegate: 'yes', linger: 'yes', serveVersion: undefined, journalStatus: 0, uid: UID, showStatus: 0, failReloads: 0 };
  const calls: string[][] = [];
  // What the user manager has read: the unit files' bytes and what they configure, as of the last daemon-reload.
  let loaded: { files: string; show: ReturnType<typeof systemdShow> } | undefined;
  const reload = () => {
    loaded = existsSync(unitFile) ? { files: unitFiles(unitFile), show: systemdShow(unitFile) } : undefined;
  };
  // The socket the daemon would listen on: the loaded PIW_SOCKET unless UnsetEnvironment= removes it.
  const effectiveSocket = () => {
    const show = loaded?.show;
    const word = show?.environment.split(' ').find(w => w.startsWith('PIW_SOCKET='));
    return word && !show!.unset.some(u => u === 'PIW_SOCKET' || u === word) ? word.slice('PIW_SOCKET='.length) : socket;
  };
  let server: Server | undefined;
  const start = () => {
    if (server || unit.serveVersion === undefined) return;
    const at = effectiveSocket();
    mkdirSync(join(at, '..'), { recursive: true, mode: 0o700 });
    const version = unit.serveVersion;
    server = createServer((req, res) => {
      res.writeHead(req.url === '/b2/hello' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/b2/hello' ? { ...HELLO, worker_version: version } : { error: 'not_found', effect: 'no_effect' }));
    });
    server.listen(at);
  };
  const stop = () =>
    new Promise<void>(resolve => {
      if (!server) return resolve();
      server.closeAllConnections();
      server.close(() => resolve());
      server = undefined;
    });
  const real = realSystem();
  const system: System = {
    exec(file, args, options) {
      calls.push([file, ...args]);
      if (file === 'systemctl') {
        const [user, verb, ...rest] = args;
        assert.equal(user, '--user', 'systemctl always runs against the user manager');
        switch (verb) {
          case 'daemon-reload':
            if (unit.failReloads > 0) {
              unit.failReloads--;
              return { status: 1, stdout: '', stderr: 'Failed to reload daemon: Connection timed out\n' };
            }
            reload();
            return ok();
          case 'reset-failed':
            return ok();
          case 'is-active':
            return { status: unit.active ? 0 : 3, stdout: unit.active ? 'active\n' : 'inactive\n', stderr: '' };
          case 'enable':
            if (rest.includes('--now')) {
              unit.active = true;
              start();
            }
            return ok();
          case 'restart':
            unit.active = true;
            return ok();
          case 'disable':
            unit.active = false;
            void stop();
            return ok();
          case 'show': {
            if (unit.showStatus !== 0) return { status: unit.showStatus, stdout: '', stderr: 'Failed to connect to bus: No medium found\n' };
            const shown = loaded?.show;
            const props: Record<string, string | undefined> = {
              Delegate: unit.delegate,
              ControlGroup: unit.active ? unitCg : '',
              LoadState: unit.loadState ?? (loaded ? 'loaded' : 'not-found'),
              NeedDaemonReload: loaded && loaded.files !== unitFiles(unitFile) ? 'yes' : 'no',
              // systemctl leaves out an empty EnvironmentFiles even when asked for it.
              EnvironmentFiles: shown?.environmentFiles.length ? shown.environmentFiles.map(f => `${f} (ignore_errors=no)`).join(' ') : undefined,
              Environment: unit.environment ?? shown?.environment ?? '',
              UnsetEnvironment: (shown?.unset ?? []).join(' '),
            };
            const asked = rest.filter(a => a.startsWith('--property=')).map(a => a.slice('--property='.length));
            return ok(asked.filter(name => props[name] !== undefined).map(name => `${name}=${props[name]}\n`).join(''));
          }
          default:
            return { status: 1, stdout: '', stderr: 'unexpected systemctl verb' };
        }
      }
      if (file === 'loginctl') return ok(`${unit.linger}\n`);
      if (file === 'journalctl') return { status: unit.journalStatus, stdout: '', stderr: '' };
      if (file === 'bwrap') return ok();
      if (file === 'sudo') throw new Error('sudo must never run');
      const result = spawnSync(file, args, { env: options.env, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    get uid() {
      return unit.uid;
    },
    user: 'tester',
    arch: ARCH,
    nodeVersion: '26.13.1',
    nodePath: process.execPath,
    cgroupMount,
    grantCommand: real.grantCommand,
  };
  const downloads = join(dir, 'downloads');
  mkdirSync(downloads);
  return {
    dir,
    env,
    home,
    data: join(home, '.local', 'share', 'pi-worker'),
    socket,
    state: env.PIW_STATE_DIR ?? join(home, '.local', 'state', 'pi-worker'),
    unitFile,
    bin: join(home, '.local', 'bin', 'pi-worker'),
    calls,
    unit,
    async cli(...argv) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, { out: l => out.push(l), err: l => err.push(l), env, system });
      return { code, out, err, ...(out.length === 1 && out[0]!.startsWith('{') ? { json: JSON.parse(out[0]!) as Record<string, unknown> } : {}), ...(err.length ? { error: JSON.parse(err[0]!) as Record<string, unknown> } : {}) };
    },
    tarball(version, options = {}) {
      const arch = options.arch ?? ARCH;
      const src = mkdtempSync(join(dir, 'src-'));
      const top = join(src, `pi-worker-${version}`);
      mkdirSync(join(top, 'bin'), { recursive: true });
      writeFileSync(join(top, 'bin', 'pi-worker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      // A link inside the version directory, as node_modules/.bin has: allowed.
      mkdirSync(join(top, 'lib'));
      symlinkSync(join('..', 'bin', 'pi-worker'), join(top, 'lib', 'entry'));
      const release = { version, commit: '0'.repeat(40), node_engine: '>=26.12.1', b2_protocol: { major: 0, minor: 1 }, ...options.release };
      writeFileSync(join(top, 'release.json'), JSON.stringify(release));
      if (options.extraTop) mkdirSync(join(src, 'stray'));
      options.edit?.(top, src);
      const name = `pi-worker-${version}-linux-${arch}.tar.gz`;
      const file = join(downloads, name);
      const tar = spawnSync('tar', ['-czf', file, '-C', src, ...readdirSync(src), ...(options.tarArgs ?? [])], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      assert.equal(tar.status, 0, 'the test tarball was packed');
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (!options.noSha) writeFileSync(`${file}.sha256`, `${options.badSha ? digest.replace(/^./, c => (c === '0' ? '1' : '0')) : digest}  ${name}\n`);
      return file;
    },
    reload,
    async restartServer() {
      await stop();
      start();
    },
    async close() {
      await stop();
      removeScratch(dir);
    },
  };
}

/**
 * Removes a test's scratch directory and cannot throw: every real directory in it (never a link's target) is made
 * writable first, so a test that failed with a read-only directory still reports its own assertion.
 */
function removeScratch(dir: string): void {
  const writable = (path: string): void => {
    try {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) writable(join(path, entry));
    } catch {
      // Gone already, or not ours to change: the removal below is forced.
    }
  };
  writable(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left in TMPDIR; never replaces the test's own failure.
  }
}

/**
 * What `systemctl --user show -p Environment -p EnvironmentFiles` prints for the unit files on disk, as systemd.unit(5)
 * and systemd.exec(5) define it: the main file, then `pi-worker.service.d/*.conf` in name order; an `Environment=` line
 * holds space-separated assignments (double quotes keep spaces), a later assignment of a variable replaces the earlier
 * one, an empty `Environment=` clears the list; systemctl prints a value holding a space or newline as
 * `[unprintable]`. `UnsetEnvironment=` words accumulate (an empty one clears them) and print as their own property.
 * (Specifiers such as `%h` are not expanded here.)
 */
function systemdShow(unitFile: string): { environment: string; environmentFiles: string[]; unset: string[] } {
  const env = new Map<string, string>();
  const environmentFiles: string[] = [];
  const unset: string[] = [];
  for (const file of unitFilePaths(unitFile)) {
    for (const line of readFileSync(file, 'utf8').split('\n').map(l => l.trim())) {
      if (line.startsWith('EnvironmentFile=')) {
        const value = line.slice('EnvironmentFile='.length);
        if (value === '') environmentFiles.length = 0;
        else environmentFiles.push(value);
      }
      if (line.startsWith('UnsetEnvironment=')) {
        const words = line.slice('UnsetEnvironment='.length).split(/\s+/).filter(w => w !== '');
        if (words.length === 0) unset.length = 0;
        else unset.push(...words);
      }
      if (!line.startsWith('Environment=')) continue;
      const words: string[] = [];
      let word: string | undefined;
      let quoted = false;
      for (const c of line.slice('Environment='.length)) {
        if (c === '"') {
          quoted = !quoted;
          word ??= '';
        } else if (/\s/.test(c) && !quoted) {
          if (word !== undefined) words.push(word);
          word = undefined;
        } else word = (word ?? '') + c;
      }
      if (word !== undefined) words.push(word);
      if (words.length === 0) env.clear();
      for (const assignment of words) if (assignment.indexOf('=') > 0) env.set(assignment.slice(0, assignment.indexOf('=')), assignment);
    }
  }
  return { environment: [...env.values()].map(v => (/[ \n]/.test(v) ? '[unprintable]' : v)).join(' '), environmentFiles, unset };
}

/** The unit file and its `pi-worker.service.d/*.conf` drop-ins that exist, in the order systemd reads them. */
function unitFilePaths(unitFile: string): string[] {
  const dropins = `${unitFile}.d`;
  return [unitFile, ...(existsSync(dropins) ? readdirSync(dropins).filter(n => n.endsWith('.conf')).sort().map(n => join(dropins, n)) : [])].filter(f => existsSync(f));
}

/** The unit files' bytes, to tell whether they changed since the manager read them. */
const unitFiles = (unitFile: string) => JSON.stringify(unitFilePaths(unitFile).map(f => [f, readFileSync(f, 'utf8')]));

const SHOW = 'show pi-worker.service --property=LoadState --property=NeedDaemonReload --property=EnvironmentFiles --property=Environment --property=UnsetEnvironment';

const systemctlCalls = (h: Host) => h.calls.filter(c => c[0] === 'systemctl').map(c => c.slice(2).join(' '));
/** The systemctl calls that change the manager or the unit (every one but `show`). */
const touched = (h: Host) => systemctlCalls(h).filter(c => !c.startsWith('show '));

test('install: verifies, unpacks, links, writes a Delegate=yes unit, starts it and waits for hello', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const r = await h.cli('install', '--from', h.tarball('1.2.3'));
    assert.equal(r.code, 0, `install exit code (stderr error: ${String(r.error?.error)})`);
    assert.deepEqual(r.json, { version: '1.2.3', socket: h.socket, unit: 'pi-worker.service', restarted: false });
    assert.equal(JSON.parse(readFileSync(join(h.data, 'versions', '1.2.3', 'release.json'), 'utf8')).version, '1.2.3');
    assert.equal(readlinkSync(join(h.data, 'current')), join('versions', '1.2.3'), 'current names the version');
    assert.equal(readlinkSync(h.bin), join(h.data, 'current', 'bin', 'pi-worker'), 'the bin link goes through current');
    const unit = readFileSync(h.unitFile, 'utf8');
    for (const line of [
      'Delegate=yes',
      'Restart=on-failure',
      'Type=exec',
      `ExecStart=${join(h.data, 'current', 'bin', 'pi-worker')} daemon`,
      `Environment=PIW_STATE_DIR=${h.state}`,
      `Environment=PIW_SOCKET=${h.socket}`,
      'StandardOutput=null',
      'Environment=NODE_NO_WARNINGS=1',
      'WantedBy=default.target',
    ]) {
      assert.ok(unit.split('\n').includes(line), `the unit has the line ${line.split('=')[0]}`);
    }
    assert.ok(unit.includes(`Environment=PATH=${join(process.execPath, '..')}:`), "the unit's PATH starts with the installing node's directory");
    assert.deepEqual(systemctlCalls(h), ['daemon-reload', SHOW, 'is-active pi-worker.service', 'enable --now pi-worker.service']);
    assert.ok(!h.calls.some(c => c[0] === 'sudo' || c.includes('sudo')), 'never sudo');
    assert.equal(statSync(join(h.data, 'doctor.grant.json')).mode & 0o777, 0o600, 'the doctor grant is a 0600 file');
    const grants = readdirSync(join(h.state, 'grants')).map(f => readFileSync(join(h.state, 'grants', f), 'utf8'));
    assert.ok(grants.some(g => g.includes('pi-worker-doctor')), 'the doctor grant is registered in the pinned state directory');
    assert.ok(!readdirSync(join(h.data, 'versions')).some(e => e.startsWith('.staging')), 'no staging directory is left');
  } finally {
    await h.close();
  }
});

test('install: the same version again is idempotent (no restart, no second unpack, same output)', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const tarball = h.tarball('1.2.3');
    const first = await h.cli('install', '--from', tarball);
    assert.equal(first.code, 0, 'first install');
    const grantBefore = readFileSync(join(h.data, 'doctor.grant.json'), 'utf8');
    h.calls.length = 0;
    const again = await h.cli('install', '--from', tarball);
    assert.equal(again.code, 0, 'second install');
    assert.deepEqual(again.json, first.json);
    assert.deepEqual(systemctlCalls(h), [SHOW, 'daemon-reload', SHOW, 'is-active pi-worker.service', 'enable --now pi-worker.service'], 'no restart: the unit did not change');
    assert.ok(!h.calls.some(c => c[0] === 'tar'), 'the installed version is not unpacked again');
    assert.equal(readFileSync(join(h.data, 'doctor.grant.json'), 'utf8'), grantBefore, 'the doctor grant is kept');
  } finally {
    await h.close();
  }
});

test('install: a tarball whose bytes differ from its .sha256 is refused before anything is written', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const r = await h.cli('install', '--from', h.tarball('1.2.3', { badSha: true }), '--wait-ms', '200');
    assert.equal(r.code, 1, 'refused, no effect');
    assert.deepEqual([r.error?.error, r.error?.effect], ['pi_worker_checksum_mismatch', 'no_effect']);
    assert.equal(existsSync(h.data), false, 'nothing unpacked');
    assert.equal(existsSync(h.unitFile), false, 'no unit written');
    assert.deepEqual(systemctlCalls(h), [], 'systemctl never ran');
  } finally {
    await h.close();
  }
});

test('install: a missing .sha256, a name that is not a release tarball, or another arch is refused', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const missing = await h.cli('install', '--from', h.tarball('1.2.3', { noSha: true }), '--wait-ms', '200');
    assert.deepEqual([missing.code, missing.error?.error], [1, 'pi_worker_checksum_missing']);
    const arch = await h.cli('install', '--from', h.tarball('1.2.3', { arch: OTHER_ARCH }), '--wait-ms', '200');
    assert.deepEqual([arch.code, arch.error?.error], [1, 'pi_worker_arch_mismatch']);
    const named = await h.cli('install', '--from', join(h.dir, 'worker.tar.gz'), '--wait-ms', '200');
    assert.deepEqual([named.code, named.error?.error], [1, 'pi_worker_tarball_name']);
    const relative = await h.cli('install', '--from', 'pi-worker-1.2.3-linux-x64.tar.gz', '--wait-ms', '200');
    assert.deepEqual([relative.code, relative.error?.error], [1, 'pi_worker_tarball_name']);
    assert.equal(existsSync(h.data), false, 'nothing unpacked');
    assert.deepEqual(systemctlCalls(h), [], 'systemctl never ran');
  } finally {
    await h.close();
  }
});

test('install: another version while one is installed is refused pi_worker_upgrade_unavailable, nothing changes', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'first install');
    const unitBefore = readFileSync(h.unitFile, 'utf8');
    h.calls.length = 0;
    const r = await h.cli('install', '--from', h.tarball('1.3.0'), '--wait-ms', '200');
    assert.equal(r.code, 1, 'refused, no effect');
    assert.deepEqual(r.error, { error: 'pi_worker_upgrade_unavailable', installed: '1.2.3', requested: '1.3.0', effect: 'no_effect' });
    assert.equal(readlinkSync(join(h.data, 'current')), join('versions', '1.2.3'), 'current is unchanged');
    assert.equal(existsSync(join(h.data, 'versions', '1.3.0')), false, 'the other version is not unpacked');
    assert.equal(readFileSync(h.unitFile, 'utf8'), unitBefore, 'the unit is unchanged');
    assert.deepEqual(systemctlCalls(h), [], 'systemctl never ran');
  } finally {
    await h.close();
  }
});

test("install: a release whose node floor is above the host's node is refused and leaves no version behind", async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const r = await h.cli('install', '--from', h.tarball('1.2.3', { release: { node_engine: '>=27.0.0' } }), '--wait-ms', '200');
    assert.equal(r.code, 1, 'refused, no effect');
    assert.deepEqual(r.error, { error: 'pi_worker_node_unsupported', required: '>=27.0.0', found: '26.13.1', effect: 'no_effect' });
    assert.equal(existsSync(h.data), false, 'checked before anything is written: no versions directory was created');
    assert.equal(existsSync(h.unitFile), false, 'no unit written');
  } finally {
    await h.close();
  }
});

test('install: a tarball without exactly one matching top directory and release.json is refused', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const stray = await h.cli('install', '--from', h.tarball('1.2.3', { extraTop: true }), '--wait-ms', '200');
    assert.deepEqual([stray.code, stray.error?.error], [1, 'pi_worker_tarball_invalid']);
    const wrong = await h.cli('install', '--from', h.tarball('1.2.4', { release: { version: '9.9.9' } }), '--wait-ms', '200');
    assert.deepEqual([wrong.code, wrong.error?.error], [1, 'pi_worker_tarball_invalid']);
    assert.equal(existsSync(h.data), false, 'refused before anything is written');
  } finally {
    await h.close();
  }
});

test('install: an existing ~/.local/bin/pi-worker that is not ours is refused', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    mkdirSync(join(h.home, '.local', 'bin'), { recursive: true });
    writeFileSync(h.bin, '#!/bin/sh\n');
    const r = await h.cli('install', '--from', h.tarball('1.2.3'), '--wait-ms', '200');
    assert.deepEqual([r.code, r.error?.error], [1, 'pi_worker_bin_conflict']);
    assert.equal(existsSync(h.data), false, 'nothing unpacked');
  } finally {
    await h.close();
  }
});

test('install: a supervisor that never answers hello with this version fails pi_worker_not_ready, effect unknown', async () => {
  const h = await host();
  try {
    const silent = await h.cli('install', '--from', h.tarball('1.2.3'), '--wait-ms', '300');
    assert.equal(silent.code, 3, 'effect unknown');
    assert.deepEqual([silent.error?.error, silent.error?.effect, silent.error?.socket], ['pi_worker_not_ready', 'unknown', h.socket]);
  } finally {
    await h.close();
  }
  const h2 = await host();
  try {
    h2.unit.serveVersion = '0.9.0';
    const stale = await h2.cli('install', '--from', h2.tarball('1.2.3'), '--wait-ms', '300');
    assert.deepEqual([stale.code, stale.error?.error], [3, 'pi_worker_not_ready'], 'a hello from another version is not ready');
  } finally {
    await h2.close();
  }
});

test('install: restarted is true only when the unit file changed while the unit was active (and then it was restarted)', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const tarball = h.tarball('1.2.3');
    const first = await h.cli('install', '--from', tarball);
    assert.equal(first.json?.restarted, false, 'a first install starts the unit, it does not restart it');
    assert.ok(!systemctlCalls(h).includes('restart pi-worker.service'), 'no restart on a first install');

    h.calls.length = 0;
    const same = await h.cli('install', '--from', tarball);
    assert.equal(same.json?.restarted, false, 'the unit file is the same: not restarted');
    assert.ok(!systemctlCalls(h).includes('restart pi-worker.service'), 'no restart call when the unit is unchanged');

    // The unit file on disk differs from what install writes (an older install's, loaded), the unit is active.
    writeFileSync(h.unitFile, readFileSync(h.unitFile, 'utf8').replace('RestartSec=2', 'RestartSec=9'));
    h.reload();
    h.calls.length = 0;
    const changed = await h.cli('install', '--from', tarball);
    assert.equal(changed.code, 0, `install exit code (stderr error: ${String(changed.error?.error)})`);
    assert.equal(changed.json?.restarted, true, 'the unit file changed while active: restarted');
    assert.deepEqual(systemctlCalls(h), [SHOW, 'daemon-reload', SHOW, 'is-active pi-worker.service', 'enable --now pi-worker.service', 'restart pi-worker.service']);
    assert.ok(readFileSync(h.unitFile, 'utf8').includes('RestartSec=2'), 'the unit file was rewritten');

    // Changed while the unit is not active: enable --now starts it, nothing is restarted.
    writeFileSync(h.unitFile, readFileSync(h.unitFile, 'utf8').replace('RestartSec=2', 'RestartSec=9'));
    h.reload();
    h.unit.active = false;
    h.calls.length = 0;
    const stopped = await h.cli('install', '--from', tarball);
    assert.equal(stopped.json?.restarted, false, 'the unit was not active: nothing was running to restart');
    assert.ok(!systemctlCalls(h).includes('restart pi-worker.service'), 'no restart call for an inactive unit');
  } finally {
    await h.close();
  }
});

test('version: prints the installed release.json and the daemon hello version as one JSON line; null without the daemon', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3', { release: { commit: 'a'.repeat(40), b2_protocol: { major: 0, minor: 7 } } }))).code, 0, 'install');
    const expected = { version: '1.2.3', commit: 'a'.repeat(40), b2_protocol: { major: 0, minor: 7 }, daemon_version: '1.2.3' };
    const r = await h.cli('version');
    assert.equal(r.code, 0);
    assert.equal(r.out.length, 1, 'one line');
    assert.deepEqual(r.json, expected);
    assert.deepEqual((await h.cli('version', '--json')).json, expected, '--json is the same line');
    assert.deepEqual(r.err, []);
  } finally {
    await h.close();
  }
  // Installed but the daemon never became ready (so nothing answers hello): the install is still queryable.
  const down = await host();
  try {
    const failed = await down.cli('install', '--from', down.tarball('1.2.3'), '--wait-ms', '200');
    assert.equal(failed.error?.error, 'pi_worker_not_ready');
    const r = await down.cli('version');
    assert.equal(r.code, 0, 'works without the daemon');
    assert.deepEqual(r.json, { version: '1.2.3', commit: '0'.repeat(40), b2_protocol: { major: 0, minor: 1 }, daemon_version: null });
  } finally {
    await down.close();
  }
});

test('version: nothing installed, or a release.json that cannot be read, is refused with a typed error and no output', async () => {
  const h = await host();
  try {
    const none = await h.cli('version');
    assert.equal(none.code, 1, 'refused, no effect');
    assert.deepEqual(none.out, []);
    assert.deepEqual(none.error, { error: 'pi_worker_not_installed', effect: 'no_effect' });
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
    writeFileSync(join(h.data, 'versions', '1.2.3', 'release.json'), JSON.stringify({ version: '1.2.3', node_engine: '>=26.12.1' }));
    const broken = await h.cli('version');
    assert.equal(broken.code, 1);
    assert.deepEqual(broken.out, []);
    assert.deepEqual(broken.error, { error: 'pi_worker_release_unreadable', effect: 'no_effect' });
  } finally {
    await h.close();
  }
});

test('every install failure ends stderr with one typed JSON line, the last line', async () => {
  const h = await host();
  try {
    const r = await h.cli('install', '--from', h.tarball('1.2.3', { badSha: true }));
    assert.equal(r.code, 1);
    assert.equal(r.err.length, 1, 'exactly one stderr line');
    const last = JSON.parse(r.err.at(-1)!) as Record<string, unknown>;
    assert.deepEqual([last.error, last.effect], ['pi_worker_checksum_mismatch', 'no_effect']);
  } finally {
    await h.close();
  }
});

test('doctor: every check passes on a healthy install; each failure is named and exits 1', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
    const healthy = await h.cli('doctor', '--json');
    assert.equal(healthy.code, 0, 'healthy doctor exits 0');
    const checks = healthy.json!.checks as { id: string; ok: boolean; detail: string }[];
    assert.deepEqual(
      checks.map(c => [c.id, c.ok]),
      [
        ['node_version', true],
        ['bwrap_usable', true],
        ['cgroup_delegation', true],
        ['unit_active', true],
        ['socket_reachable', true],
        ['hello', true],
        ['linger', true],
      ],
    );
    assert.equal(healthy.json!.ok, true);
    assert.match(checks.find(c => c.id === 'hello')!.detail, /worker 1\.2\.3, protocol 0\.1/);
    const text = await h.cli('doctor');
    assert.equal(text.code, 0);
    assert.equal(text.out.length, 7, 'one line per check');

    h.unit.linger = 'no';
    h.unit.delegate = 'no';
    const sick = await h.cli('doctor', '--json');
    assert.equal(sick.code, 1, 'a failed check exits 1');
    const failed = (sick.json!.checks as { id: string; ok: boolean }[]).filter(c => !c.ok).map(c => c.id);
    assert.deepEqual(failed, ['cgroup_delegation', 'linger']);
  } finally {
    await h.close();
  }
});

test('doctor: nothing installed fails unit, socket and hello checks', async () => {
  const h = await host();
  try {
    h.unit.delegate = '';
    const r = await h.cli('doctor', '--json');
    assert.equal(r.code, 1);
    const failed = (r.json!.checks as { id: string; ok: boolean }[]).filter(c => !c.ok).map(c => c.id);
    assert.deepEqual(failed, ['cgroup_delegation', 'unit_active', 'socket_reachable', 'hello']);
  } finally {
    await h.close();
  }
});

test('uninstall: stops and removes the unit and links, keeps versions and state; --purge leaves nothing', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const tarball = h.tarball('1.2.3');
    assert.equal((await h.cli('install', '--from', tarball)).code, 0, 'install');
    h.calls.length = 0;
    const r = await h.cli('uninstall');
    assert.equal(r.code, 0, 'uninstall');
    assert.deepEqual(r.json, { uninstalled: true, purged: false });
    assert.deepEqual(systemctlCalls(h), ['disable --now pi-worker.service', 'daemon-reload', 'reset-failed pi-worker.service']);
    assert.equal(existsSync(h.unitFile), false, 'unit file removed');
    assert.equal(lstatExists(h.bin), false, 'bin link removed');
    assert.equal(lstatExists(join(h.data, 'current')), false, 'current removed');
    assert.ok(existsSync(join(h.data, 'versions', '1.2.3', 'release.json')), 'versions kept');
    assert.ok(readdirSync(join(h.state, 'grants')).length > 0, 'state kept');

    // Installing again reuses the kept version and state.
    assert.equal((await h.cli('install', '--from', tarball)).code, 0, 're-install');
    assert.equal(readlinkSync(join(h.data, 'current')), join('versions', '1.2.3'));

    // A read-only directory in the state does not stop a purge.
    mkdirSync(join(h.state, 'sessions', 'locked'), { recursive: true });
    chmodSync(join(h.state, 'sessions'), 0o500);
    const purge = await h.cli('uninstall', '--purge');
    assert.equal(purge.code, 0, 'purge');
    assert.deepEqual(purge.json, { uninstalled: true, purged: true });
    for (const path of [h.data, h.state, join(h.env.XDG_RUNTIME_DIR!, 'pi-worker'), h.unitFile, h.bin]) assert.equal(lstatExists(path), false, 'nothing left');

    const again = await h.cli('uninstall');
    assert.deepEqual([again.code, again.json], [0, { uninstalled: true, purged: false }], 'uninstall with nothing installed succeeds');
  } finally {
    await h.close();
  }
});

test('uninstall --purge with a socket configured outside a pi-worker directory keeps that directory and removes only the socket', async () => {
  const h = await host(({ runtime }) => ({ PIW_SOCKET: join(runtime, 'b2.sock') }));
  try {
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
    const unit = readFileSync(h.unitFile, 'utf8').split('\n');
    assert.ok(unit.includes(`Environment=PIW_SOCKET=${h.socket}`), 'the configured socket is pinned');
    const purge = await h.cli('uninstall', '--purge');
    assert.equal(purge.code, 0, 'purge');
    assert.ok(existsSync(h.env.XDG_RUNTIME_DIR!), 'the runtime directory is kept');
    assert.equal(lstatExists(h.socket), false, 'the socket itself is removed');
    assert.equal(existsSync(h.data), false, 'the versions are removed');
  } finally {
    await h.close();
  }
});

/** Every file and directory under `root` (relative paths), to show a refused purge deleted nothing. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      out.push(join(rel, entry.name));
      if (entry.isDirectory()) walk(join(dir, entry.name), join(rel, entry.name));
    }
  };
  walk(root, '');
  return out.sort();
}

/** Replaces the installed unit's pinned state directory or socket, as an older or hand-edited unit would hold it (loaded). */
function pin(h: Host, key: 'PIW_STATE_DIR' | 'PIW_SOCKET', value: string): void {
  const text = readFileSync(h.unitFile, 'utf8').replace(new RegExp(`^Environment=${key}=.*$`, 'm'), `Environment=${key}=${value}`);
  writeFileSync(h.unitFile, text);
  h.reload();
}

test('uninstall --purge refuses a state directory that is HOME, holds HOME, or has a . or .. component; nothing is deleted', async () => {
  for (const bad of [(home: string) => `${home}/..`, (home: string) => `${home}/.`, (home: string) => `${home}/foo/..`, (home: string) => home, (home: string) => `${home}/`]) {
    const h = await host();
    try {
      h.unit.serveVersion = '1.2.3';
      assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
      mkdirSync(join(h.home, 'foo'));
      writeFileSync(join(h.home, 'keep.txt'), 'mine');
      writeFileSync(join(h.dir, 'beside-home.txt'), 'mine');
      const value = bad(h.home);
      pin(h, 'PIW_STATE_DIR', value);
      const before = tree(h.dir);
      h.calls.length = 0;
      const purge = await h.cli('uninstall', '--purge');
      const label = value.slice(h.home.length) || '(HOME)';
      assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect, purge.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', 'state'], `HOME${label} is refused`);
      assert.deepEqual(tree(h.dir), before, `HOME${label}: nothing was deleted`);
      assert.deepEqual(touched(h), [], `HOME${label}: the unit was not touched`);
    } finally {
      await h.close();
    }
  }
  // HOME used as the state directory, holding nothing but a pi-worker journal: it looks like pi-worker's own state,
  // and is still HOME.
  const h = await host(({ home }) => ({ PIW_STATE_DIR: home }));
  try {
    openState(h.home).close();
    const before = tree(h.dir);
    const purge = await h.cli('uninstall', '--purge');
    assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect, purge.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', 'state'], 'a HOME holding only a pi-worker journal is refused');
    assert.deepEqual(tree(h.dir), before, 'HOME with a journal: nothing was deleted');
  } finally {
    await h.close();
  }
});

test('install refuses a state directory or socket with a . or .. component, or a state directory holding HOME, before anything is written', async () => {
  const cases: [string, (home: string, runtime: string) => NodeJS.ProcessEnv][] = [
    ['state', home => ({ PIW_STATE_DIR: `${home}/foo/../state` })],
    ['state', home => ({ PIW_STATE_DIR: `${home}/./state` })],
    ['state', home => ({ PIW_STATE_DIR: `${home}/..` })],
    ['state', home => ({ PIW_STATE_DIR: home })],
    ['state', () => ({ PIW_STATE_DIR: '/' })],
    ['socket', (_home, runtime) => ({ PIW_SOCKET: `${runtime}/pi-worker/../b2.sock` })],
  ];
  for (const [which, configure] of cases) {
    const h = await host(({ home, runtime }) => configure(home, runtime));
    try {
      h.unit.serveVersion = '1.2.3';
      const r = await h.cli('install', '--from', h.tarball('1.2.3'), '--wait-ms', '200');
      assert.deepEqual([r.code, r.error?.error, r.error?.effect, r.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', which], `a ${which} path is refused`);
      assert.equal(existsSync(h.data), false, 'nothing written');
      assert.deepEqual(systemctlCalls(h), [], 'systemctl never ran');
    } finally {
      await h.close();
    }
  }
});

test('uninstall --purge refuses a symlinked state directory, data directory or socket directory, and a socket path that is not a socket; nothing is deleted', async () => {
  const cases: [string, (dirs: { dir: string; home: string; runtime: string }) => NodeJS.ProcessEnv, (h: Host, outside: string) => void][] = [
    ['state', ({ dir }) => ({ PIW_STATE_DIR: join(dir, 'state-link') }), (h, outside) => symlinkSync(outside, join(h.dir, 'state-link'))],
    ['data', () => ({}), (h, outside) => {
      // A symlinked ~/.local/share/pi-worker in a read-only parent: a removal that followed the link would chmod the target.
      rmSync(h.data, { recursive: true, force: true });
      symlinkSync(outside, h.data);
      chmodSync(join(h.data, '..'), 0o500);
    }],
    ['socket', ({ dir }) => ({ PIW_SOCKET: join(dir, 'sock-link', 'pi-worker', 'b2.sock') }), (h, outside) => {
      rmSync(join(h.dir, 'sock-link', 'pi-worker'), { recursive: true, force: true });
      symlinkSync(outside, join(h.dir, 'sock-link', 'pi-worker'));
    }],
    ['socket', ({ home }) => ({ PIW_SOCKET: join(home, 'notes.txt') }), h => writeFileSync(join(h.home, 'notes.txt'), 'mine')],
  ];
  for (const [which, configure, arrange] of cases) {
    const h = await host(configure);
    try {
      const outside = join(h.dir, 'outside');
      mkdirSync(outside, { mode: 0o500 });
      if (which !== 'state') {
        h.unit.serveVersion = '1.2.3';
        assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, `install (${which})`);
        assert.equal((await h.cli('uninstall')).code, 0, `uninstall (${which})`);
      }
      arrange(h, outside);
      chmodSync(outside, 0o500);
      const before = tree(h.dir);
      const purge = await h.cli('uninstall', '--purge');
      assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect, purge.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', which], `the ${which} path is refused`);
      assert.deepEqual(tree(h.dir), before, `${which}: nothing was deleted`);
      assert.equal(statSync(outside).mode & 0o777, 0o500, `${which}: the link's target was not chmodded`);
    } finally {
      if (which === 'data') chmodSync(join(h.home, '.local', 'share'), 0o700);
      chmodSync(join(h.dir, 'outside'), 0o700);
      await h.close();
    }
  }
});

test("uninstall --purge refuses paths another user owns, and a socket whose pi-worker directory is HOME; nothing is deleted", async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
    const before = tree(h.dir);
    h.unit.uid = UID + 1;
    h.calls.length = 0;
    const purge = await h.cli('uninstall', '--purge');
    assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect, purge.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', 'data'], 'files of another uid are refused');
    assert.deepEqual(tree(h.dir), before, 'nothing was deleted');
    assert.deepEqual(touched(h), [], 'the unit was not touched');
  } finally {
    await h.close();
  }
  // HOME named pi-worker, with the socket directly in it: the socket's "pi-worker directory" is HOME.
  const h2 = await host(({ dir }) => {
    mkdirSync(join(dir, 'pi-worker'));
    return { HOME: join(dir, 'pi-worker'), PIW_SOCKET: join(dir, 'pi-worker', 'b2.sock') };
  });
  try {
    writeFileSync(join(h2.dir, 'pi-worker', 'keep.txt'), 'mine');
    const before = tree(h2.dir);
    const purge = await h2.cli('uninstall', '--purge');
    assert.deepEqual([purge.code, purge.error?.error, purge.error?.which], [1, 'pi_worker_unsafe_path', 'socket'], 'a socket directory that is HOME is refused');
    assert.deepEqual(tree(h2.dir), before, 'nothing was deleted');
  } finally {
    await h2.close();
  }
});

test('uninstall --purge removes only what install created: a file of the owner\'s in ~/.local/share/pi-worker is kept', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
    writeFileSync(join(h.data, 'notes.txt'), 'mine');
    const purge = await h.cli('uninstall', '--purge');
    assert.deepEqual([purge.code, purge.json], [0, { uninstalled: true, purged: true }]);
    assert.ok(existsSync(h.data), '~/.local/share/pi-worker is kept: it holds a file of the owner\'s');
    assert.deepEqual(readdirSync(h.data), ['notes.txt'], 'versions, current and the doctor grant are gone; the foreign file stays');
    for (const path of [h.state, h.unitFile, h.bin]) assert.equal(lstatExists(path), false, 'removed');
  } finally {
    await h.close();
  }
});

test('removeTree removes a top-level link only, never chmods or enters its target, even when the link cannot be removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piw-rmtree-'));
  try {
    const outside = join(dir, 'outside');
    mkdirSync(join(outside, 'inner'), { recursive: true });
    chmodSync(outside, 0o500);
    const parent = join(dir, 'parent');
    mkdirSync(parent);
    symlinkSync(outside, join(parent, 'link'));
    chmodSync(parent, 0o500);
    assert.throws(() => removeTree(join(parent, 'link')), 'a link in a read-only directory cannot be removed');
    assert.equal(statSync(outside).mode & 0o777, 0o500, 'the target was not chmodded');
    assert.ok(existsSync(join(outside, 'inner')), 'the target was not entered');
    chmodSync(parent, 0o700);
    removeTree(join(parent, 'link'));
    assert.equal(lstatExists(join(parent, 'link')), false, 'the link is removed');
    assert.ok(existsSync(join(outside, 'inner')), 'its target is kept');
  } finally {
    // Restores both read-only directories, so a failed assertion above is what the test reports.
    removeScratch(dir);
  }
});

test('uninstall --purge refuses a state directory pi-worker did not make (no marker, or a foreign entry) before the unit is touched; nothing is deleted', async () => {
  const cases: [string, (h: Host) => Promise<void>][] = [
    ['a foreign directory, nothing installed', async h => {
      mkdirSync(h.state);
      writeFileSync(join(h.state, 'important.txt'), 'mine');
    }],
    ['an empty directory, nothing installed', async h => {
      mkdirSync(h.state);
    }],
    ['only names pi-worker writes, but no journal and no doctor grant of this install', async h => {
      mkdirSync(join(h.state, 'grants'), { recursive: true });
      writeFileSync(join(h.state, 'journal.jsonl'), 'not a journal\n');
    }],
    ['an installed state that also holds a foreign file', async h => {
      h.unit.serveVersion = '1.2.3';
      assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
      writeFileSync(join(h.state, 'important.txt'), 'mine');
    }],
    ['an installed state that also holds a file named constructor (an Object prototype property)', async h => {
      h.unit.serveVersion = '1.2.3';
      assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
      writeFileSync(join(h.state, 'constructor'), 'mine');
    }],
    ['an installed state that also holds a file named __proto__ (an Object prototype property)', async h => {
      h.unit.serveVersion = '1.2.3';
      assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
      writeFileSync(join(h.state, '__proto__'), 'mine');
    }],
    ['an installed state that also holds a file named toString (an Object prototype property)', async h => {
      h.unit.serveVersion = '1.2.3';
      assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
      writeFileSync(join(h.state, 'toString'), 'mine');
    }],
  ];
  for (const [label, arrange] of cases) {
    const h = await host(({ dir }) => ({ PIW_STATE_DIR: join(dir, 'documents') }));
    try {
      await arrange(h);
      const before = tree(h.dir);
      h.calls.length = 0;
      const purge = await h.cli('uninstall', '--purge');
      assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect, purge.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', 'state'], `${label}: refused`);
      assert.deepEqual(tree(h.dir), before, `${label}: nothing was deleted`);
      assert.deepEqual(touched(h), [], `${label}: the unit was not touched`);
    } finally {
      await h.close();
    }
  }
});

test('uninstall --purge removes a state directory that holds a pi-worker journal, with nothing installed, or while a supervisor holds it', async () => {
  for (const live of [false, true]) {
    const h = await host(({ dir }) => ({ PIW_STATE_DIR: join(dir, 'state') }));
    // Purge is planned while the unit still runs: the supervisor holds its lock (and the lock's SQLite journal).
    let state: { close(): void } | undefined;
    try {
      mkdirSync(h.state, { mode: 0o700 });
      state = openState(h.state);
      // Every directory a supervisor makes in its state: grants, sessions, attachments and owner Git's snapshots.
      for (const name of ['grants', 'sessions', 'attachments', 'git-snapshots']) mkdirSync(join(h.state, name, 'x'), { recursive: true, mode: 0o700 });
      if (!live) {
        state.close();
        state = undefined;
      }
      assert.ok(existsSync(join(h.state, 'journal.jsonl')), 'the supervisor wrote its journal');
      const purge = await h.cli('uninstall', '--purge');
      assert.deepEqual([purge.code, purge.json], [0, { uninstalled: true, purged: true }], `purged (supervisor ${live ? 'running' : 'stopped'})`);
      assert.equal(lstatExists(h.state), false, 'the state directory is removed');
    } finally {
      try {
        state?.close();
      } catch {
        // Its files are gone; the lock goes with the descriptor.
      }
      await h.close();
    }
  }
});

test('install refuses a bin/pi-worker that is a directory or a link, not an executable regular file; effect unknown, nothing installed', async () => {
  const cases: [string, (top: string) => void][] = [
    ['a directory', top => {
      rmSync(join(top, 'bin', 'pi-worker'));
      mkdirSync(join(top, 'bin', 'pi-worker'), { mode: 0o755 });
    }],
    ['a link to a file inside the version directory', top => {
      writeFileSync(join(top, 'lib', 'main'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      rmSync(join(top, 'bin', 'pi-worker'));
      symlinkSync(join('..', 'lib', 'main'), join(top, 'bin', 'pi-worker'));
      // The fixture's lib/entry pointed at the old file; keep it inside.
      rmSync(join(top, 'lib', 'entry'));
      symlinkSync('main', join(top, 'lib', 'entry'));
    }],
  ];
  for (const [label, edit] of cases) {
    const h = await host();
    try {
      h.unit.serveVersion = '1.2.3';
      const r = await h.cli('install', '--from', h.tarball('1.2.3', { edit }), '--wait-ms', '200');
      assert.deepEqual([r.code, r.error?.error, r.error?.effect], [3, 'pi_worker_tarball_invalid', 'unknown'], `${label} is refused`);
      assert.deepEqual(readdirSync(join(h.data, 'versions')), [], `${label}: no version and no staging directory left`);
      assert.equal(existsSync(h.unitFile), false, `${label}: no unit written`);
      assert.deepEqual(systemctlCalls(h), [], `${label}: systemctl never ran`);
    } finally {
      await h.close();
    }
  }
});

test('install refuses an absolute or .. member before anything is written', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    for (const tarArgs of [
      // An absolute member that tar would strip into the top directory.
      ['-P', '--transform=s,^extra,/pi-worker-1.2.3/extra,', 'extra'],
      ['-P', '--transform=s,^extra,pi-worker-1.2.3/../pi-worker-1.2.3/extra,', 'extra'],
    ]) {
      const r = await h.cli('install', '--from', h.tarball('1.2.3', { edit: (_top, src) => writeFileSync(join(src, 'extra'), 'x'), tarArgs }), '--wait-ms', '200');
      assert.deepEqual([r.code, r.error?.error, r.error?.effect], [1, 'pi_worker_tarball_invalid', 'no_effect'], 'refused before unpacking');
      assert.equal(existsSync(h.data), false, 'nothing written');
    }
  } finally {
    await h.close();
  }
});

test('install refuses a link out of the version directory, a hard link, or a FIFO in the tarball; effect unknown, nothing installed', async () => {
  const cases: [string, (top: string) => void][] = [
    ['bin/pi-worker linked to /bin/true', top => {
      rmSync(join(top, 'bin', 'pi-worker'));
      symlinkSync('/bin/true', join(top, 'bin', 'pi-worker'));
    }],
    ['a relative link out of the version directory', top => symlinkSync('../../..', join(top, 'lib', 'up'))],
    ['a link chain that leaves through an inner link', top => {
      symlinkSync('..', join(top, 'lib', 'self'));
      // Lexically inside (lib/self/../.. normalizes to .), but self is the top, so the kernel lands in its parent.
      symlinkSync('lib/self/../..', join(top, 'escape'));
    }],
    ['a hard link', top => linkSync(join(top, 'release.json'), join(top, 'lib', 'release-copy.json'))],
    ['a FIFO', top => assert.equal(spawnSync('mkfifo', [join(top, 'lib', 'pipe')]).status, 0, 'mkfifo')],
  ];
  for (const [label, edit] of cases) {
    const h = await host();
    try {
      h.unit.serveVersion = '1.2.3';
      const r = await h.cli('install', '--from', h.tarball('1.2.3', { edit }), '--wait-ms', '200');
      assert.deepEqual([r.code, r.error?.error, r.error?.effect], [3, 'pi_worker_tarball_invalid', 'unknown'], `${label} is refused after unpacking (effect unknown)`);
      assert.deepEqual(readdirSync(join(h.data, 'versions')), [], `${label}: no version and no staging directory left`);
      assert.equal(lstatExists(join(h.data, 'current')), false, `${label}: nothing is current`);
      assert.deepEqual(systemctlCalls(h), [], `${label}: systemctl never ran`);
    } finally {
      await h.close();
    }
  }
});

test('grant register works with neither XDG_RUNTIME_DIR nor PIW_SOCKET set, as docs/plan/install.md section 7 runs it', async () => {
  const h = await host(() => ({ XDG_RUNTIME_DIR: undefined }));
  try {
    assert.equal(h.env.XDG_RUNTIME_DIR ?? h.env.PIW_SOCKET, undefined, 'no runtime directory and no socket in the environment');
    const out = join(h.dir, 'bridge.grant.json');
    const r = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello');
    assert.equal(r.code, 0, `grant register exit code (error: ${String(r.error?.error)})`);
    assert.equal(r.json?.caller, 'shep-bridge');
    assert.equal(statSync(out).mode & 0o777, 0o600, 'the bearer file is 0600');
    assert.equal(readdirSync(join(h.state, 'grants')).length, 1, 'registered in the default state directory');
    const list = await h.cli('grant', 'list');
    assert.equal(list.code, 0, 'grant list');
  } finally {
    await h.close();
  }
});

/** Installs with the state directory `configure` names, then returns the host with that naming removed from the CLI's environment. */
async function installedWithState(variable: 'PIW_STATE_DIR' | 'XDG_STATE_HOME') {
  const h = await host(({ dir }) => (variable === 'PIW_STATE_DIR' ? { PIW_STATE_DIR: join(dir, 'custom-state') } : { XDG_STATE_HOME: join(dir, 'xdg-state') }));
  h.unit.serveVersion = '1.2.3';
  const installed = await h.cli('install', '--from', h.tarball('1.2.3'), '--wait-ms', '5000');
  assert.equal(installed.code, 0, `install exit code (error: ${String(installed.error?.error)})`);
  const pinned = variable === 'PIW_STATE_DIR' ? join(h.dir, 'custom-state') : join(h.dir, 'xdg-state', 'pi-worker');
  assert.match(readFileSync(h.unitFile, 'utf8'), new RegExp(`^Environment=PIW_STATE_DIR=${pinned}$`, 'm'), 'the unit pins the installing environment\'s state directory');
  const defaultState = join(h.home, '.local', 'state', 'pi-worker');
  assert.equal(existsSync(defaultState), false, 'install did not touch the default state directory');
  return { h, pinned, defaultState };
}

const grantIds = (state: string) => readdirSync(join(state, 'grants')).sort();

for (const variable of ['PIW_STATE_DIR', 'XDG_STATE_HOME'] as const) {
  test(`grant: with an installation, a shell without ${variable} uses the state directory the unit pins (list, register, revoke)`, async () => {
    const { h, pinned, defaultState } = await installedWithState(variable);
    try {
      const doctorOnly = grantIds(pinned);
      assert.equal(doctorOnly.length, 1, 'install registered the doctor grant in the pinned directory');
      delete h.env[variable];
      const list = await h.cli('grant', 'list');
      assert.equal(list.code, 0, `grant list exit code (error: ${String(list.error?.error)})`);
      assert.deepEqual((JSON.parse(list.out[0]!) as { caller: string }[]).map(g => g.caller), ['pi-worker-doctor'], 'list reads the pinned directory, where the daemon\'s doctor grant is');
      const out = join(h.dir, 'bridge.grant.json');
      const reg = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello');
      assert.equal(reg.code, 0, `grant register exit code (error: ${String(reg.error?.error)})`);
      assert.equal(grantIds(pinned).length, 2, 'registered in the pinned directory, which the daemon reads');
      assert.equal(existsSync(defaultState), false, 'nothing was created in the default state directory');
      const id = reg.json!.grant_id as string;
      const revoked = await h.cli('grant', 'revoke', id);
      assert.equal(revoked.code, 0, `grant revoke exit code (error: ${String(revoked.error?.error)})`);
      assert.equal(existsSync(defaultState), false, 'revoke did not touch the default state directory either');
      // The same directory named explicitly (as written, or with a trailing slash) is not a mismatch.
      h.env.PIW_STATE_DIR = variable === 'PIW_STATE_DIR' ? `${pinned}/` : pinned;
      assert.equal((await h.cli('grant', 'list')).code, 0, 'the pinned directory named explicitly is accepted');
    } finally {
      await h.close();
    }
  });
}

test('grant: with an installation, an environment naming another state directory is refused pi_worker_state_mismatch before anything is read or written', async () => {
  const { h, pinned, defaultState } = await installedWithState('PIW_STATE_DIR');
  try {
    const before = grantIds(pinned);
    const other = join(h.dir, 'other-state');
    const out = join(h.dir, 'refused.grant.json');
    const attempts: [string, NodeJS.ProcessEnv, string[]][] = [
      ['PIW_STATE_DIR', { PIW_STATE_DIR: other }, ['grant', 'register', '--caller', 'shep-bridge', '--out', out]],
      ['PIW_STATE_DIR', { PIW_STATE_DIR: other }, ['grant', 'list']],
      ['PIW_STATE_DIR', { PIW_STATE_DIR: other }, ['grant', 'revoke', 'whatever']],
      ['XDG_STATE_HOME', { PIW_STATE_DIR: undefined, XDG_STATE_HOME: join(h.dir, 'other-xdg') }, ['grant', 'register', '--caller', 'shep-bridge', '--out', out]],
      ['a relative XDG_STATE_HOME', { PIW_STATE_DIR: undefined, XDG_STATE_HOME: 'relative' }, ['grant', 'list']],
    ];
    for (const [label, env, argv] of attempts) {
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete h.env[k]; else h.env[k] = v;
      const r = await h.cli(...argv);
      assert.deepEqual([r.code, r.error?.error, r.error?.effect, r.error?.pinned], [1, 'pi_worker_state_mismatch', 'no_effect', pinned], `${label}: ${argv.slice(0, 2).join(' ')} is refused with the pinned directory named`);
      assert.deepEqual(r.out, [], `${label}: nothing on stdout`);
      assert.equal(existsSync(out), false, `${label}: no bearer file`);
      assert.equal(existsSync(other), false, `${label}: the named directory was not created`);
      assert.equal(existsSync(defaultState), false, `${label}: the default directory was not created`);
      assert.deepEqual(grantIds(pinned), before, `${label}: the pinned registry is unchanged`);
    }
    // A relative name never matches, even when it would resolve to the pin from this process's directory.
    const cwd = process.cwd();
    try {
      process.chdir(h.dir);
      h.env.PIW_STATE_DIR = 'custom-state';
      const r = await h.cli('grant', 'list');
      assert.deepEqual([r.code, r.error?.error, r.error?.effect], [1, 'pi_worker_state_mismatch', 'no_effect'], 'a relative PIW_STATE_DIR is refused');
    } finally {
      process.chdir(cwd);
    }
    // PIW_STATE_DIR wins over XDG_STATE_HOME in the daemon's own resolution, so one that names the pin is no mismatch.
    delete h.env.XDG_STATE_HOME;
    h.env.PIW_STATE_DIR = pinned;
    h.env.XDG_STATE_HOME = join(h.dir, 'other-xdg');
    assert.equal((await h.cli('grant', 'list')).code, 0, 'PIW_STATE_DIR naming the pin outranks XDG_STATE_HOME');
  } finally {
    await h.close();
  }
});

test('grant: a unit whose pinned state directory is not canonical is refused pi_worker_unsafe_path; with no installation the caller\'s own environment resolves it', async () => {
  const { h, pinned } = await installedWithState('PIW_STATE_DIR');
  try {
    delete h.env.PIW_STATE_DIR;
    writeFileSync(h.unitFile, readFileSync(h.unitFile, 'utf8').replace(`PIW_STATE_DIR=${pinned}`, 'PIW_STATE_DIR=relative/state'));
    h.reload();
    const r = await h.cli('grant', 'list');
    assert.deepEqual([r.code, r.error?.error, r.error?.which, r.error?.effect], [1, 'pi_worker_unsafe_path', 'state', 'no_effect'], 'a pin the unit file could not have been written with is refused');
    // Uninstalled: no unit, so the environment names the state directory, as before.
    assert.equal((await h.cli('uninstall')).code, 0);
    const own = join(h.dir, 'own-state');
    h.env.PIW_STATE_DIR = own;
    const reg = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', join(h.dir, 'own.grant.json'), '--method', 'hello');
    assert.equal(reg.code, 0, `grant register exit code (error: ${String(reg.error?.error)})`);
    assert.equal(grantIds(own).length, 1, 'registered in the directory the environment names');
  } finally {
    await h.close();
  }
});

test('grant: a HOME spelled with a trailing / or a /./ component is refused pi_worker_unsafe_path, never served from the default state directory', async () => {
  const { h, pinned, defaultState } = await installedWithState('PIW_STATE_DIR');
  try {
    delete h.env.PIW_STATE_DIR;
    const before = grantIds(pinned);
    const out = join(h.dir, 'refused.grant.json');
    for (const spelling of [`${h.home}/`, `${h.dir}/./home`]) {
      h.env.HOME = spelling;
      for (const argv of [['grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello'], ['grant', 'list']]) {
        const r = await h.cli(...argv);
        assert.deepEqual([r.code, r.error?.error, r.error?.effect, r.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', 'HOME'], `HOME ${spelling}: ${argv[1]} is refused`);
        assert.deepEqual(r.out, [], `HOME ${spelling}: nothing on stdout`);
        assert.equal(existsSync(out), false, `HOME ${spelling}: no bearer file`);
        assert.equal(existsSync(defaultState), false, `HOME ${spelling}: the default state directory was not created`);
        assert.deepEqual(grantIds(pinned), before, `HOME ${spelling}: the pinned registry is unchanged`);
      }
    }
  } finally {
    await h.close();
  }
});

/** The installed unit file and its drop-ins put back as install wrote them. */
function restoreUnit(h: Host, text: string): void {
  writeFileSync(h.unitFile, text);
  rmSync(`${h.unitFile}.d`, { recursive: true, force: true });
  h.unit.environment = undefined;
  h.unit.loadState = undefined;
  h.unit.showStatus = 0;
}

function dropIn(h: Host, text: string): void {
  mkdirSync(`${h.unitFile}.d`, { recursive: true });
  writeFileSync(join(`${h.unitFile}.d`, 'override.conf'), `[Service]\n${text}\n`);
}

test('grant: the state directory is the one systemd runs the unit with (drop-in, repeated, quoted or multi-assignment Environment=), not the first line of the unit file', async () => {
  const { h, pinned, defaultState } = await installedWithState('PIW_STATE_DIR');
  try {
    delete h.env.PIW_STATE_DIR;
    const installed = readFileSync(h.unitFile, 'utf8');
    const pinLine = `Environment=PIW_STATE_DIR=${pinned}`;
    const effective = join(h.dir, 'effective-state');
    const cases: [string, () => void, string][] = [
      ['a drop-in Environment= overriding the pin', () => dropIn(h, `Environment=PIW_STATE_DIR=${effective}`), effective],
      ['a second Environment= line for the same variable', () => writeFileSync(h.unitFile, installed.replace(pinLine, `${pinLine}\nEnvironment=PIW_STATE_DIR=${effective}`)), effective],
      ['a quoted assignment on a multi-assignment line', () => writeFileSync(h.unitFile, installed.replace(pinLine, `Environment="PIW_STATE_DIR=${effective}" FOO=bar`)), effective],
      ['a stray word after the pin (systemd ignores it)', () => writeFileSync(h.unitFile, installed.replace(pinLine, `${pinLine} extra`)), pinned],
    ];
    for (const [label, edit, where] of cases) {
      restoreUnit(h, installed);
      rmSync(effective, { recursive: true, force: true });
      edit();
      h.reload();
      const before = existsSync(join(where, 'grants')) ? grantIds(where).length : 0;
      const out = join(h.dir, 'bridge.grant.json');
      rmSync(out, { force: true });
      const reg = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello');
      assert.equal(reg.code, 0, `${label}: grant register exit code (error: ${String(reg.error?.error)})`);
      assert.ok(existsSync(join(where, 'grants')), `${label}: the registry is where systemd's environment points the daemon`);
      assert.equal(grantIds(where).length, before + 1, `${label}: registered where systemd's environment points the daemon`);
      if (where !== pinned) assert.equal(grantIds(pinned).length, 1, `${label}: nothing registered in the unit file's first pin line`);
      assert.equal(existsSync(defaultState), false, `${label}: the default state directory was not created`);
      if (where !== pinned) {
        h.env.PIW_STATE_DIR = pinned;
        const r = await h.cli('grant', 'list');
        assert.deepEqual([r.code, r.error?.error, r.error?.pinned], [1, 'pi_worker_state_mismatch', where], `${label}: the first pin line named explicitly is a mismatch`);
        delete h.env.PIW_STATE_DIR;
      }
    }
  } finally {
    await h.close();
  }
});

test('grant: with a unit installed, systemd that cannot be asked, or an environment without one canonical PIW_STATE_DIR, is refused before anything is written', async () => {
  const { h, pinned, defaultState } = await installedWithState('PIW_STATE_DIR');
  try {
    delete h.env.PIW_STATE_DIR;
    const installed = readFileSync(h.unitFile, 'utf8');
    const pinLine = `Environment=PIW_STATE_DIR=${pinned}`;
    const other = join(h.dir, 'other-state');
    const before = grantIds(pinned);
    const cases: [string, () => void, string, string][] = [
      ['systemctl show fails', () => (h.unit.showStatus = 1), 'pi_worker_systemctl_failed', 'show'],
      ['an empty Environment= in a drop-in resets the pin', () => dropIn(h, 'Environment='), 'pi_worker_unsafe_path', 'state'],
      ['a pin value holding a space (systemctl prints [unprintable])', () => writeFileSync(h.unitFile, installed.replace(pinLine, `Environment="PIW_STATE_DIR=${pinned} extra"`)), 'pi_worker_unsafe_path', 'state'],
      ['an EnvironmentFile= that could set it', () => dropIn(h, `EnvironmentFile=${join(h.dir, 'piw.env')}`), 'pi_worker_unsafe_path', 'state'],
      ['a unit file systemd has not loaded', () => ((h.unit.loadState = 'not-found'), (h.unit.environment = '')), 'pi_worker_unsafe_path', 'state'],
      ['several PIW_STATE_DIR values printed', () => (h.unit.environment = `PIW_STATE_DIR=${other} PIW_STATE_DIR=${pinned}`), 'pi_worker_unsafe_path', 'state'],
      ['a unit systemd could not load as written (LoadState=bad-setting)', () => (h.unit.loadState = 'bad-setting'), 'pi_worker_unsafe_path', 'state'],
      ['no PIW_SOCKET left in the environment (reset, the pin set again)', () => dropIn(h, `Environment=\nEnvironment=PIW_STATE_DIR=${pinned}`), 'pi_worker_unsafe_path', 'socket'],
    ];
    const out = join(h.dir, 'refused.grant.json');
    for (const [label, edit, error, detail] of cases) {
      restoreUnit(h, installed);
      edit();
      h.reload();
      const r = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello');
      assert.deepEqual([r.code, r.error?.error, r.error?.effect, r.error?.which ?? r.error?.step], [1, error, 'no_effect', detail], `${label}: refused`);
      assert.equal(existsSync(out), false, `${label}: no bearer file`);
      assert.equal(existsSync(defaultState), false, `${label}: the default state directory was not created`);
      assert.equal(existsSync(other), false, `${label}: no other state directory was created`);
      assert.deepEqual(grantIds(pinned), before, `${label}: the pinned registry is unchanged`);
    }
  } finally {
    await h.close();
  }
});

test('install: an installed unit pinning another state directory (an override, or drift back to the default) is refused pi_worker_state_mismatch before anything is written or restarted', async () => {
  const { h, pinned, defaultState } = await installedWithState('PIW_STATE_DIR');
  try {
    const tarball = h.tarball('1.2.3');
    const unitBefore = readFileSync(h.unitFile, 'utf8');
    const doctorBefore = readFileSync(join(h.data, 'doctor.grant.json'), 'utf8');
    const grantsBefore = grantIds(pinned);
    const other = join(h.dir, 'other-state');
    for (const [label, requested] of [['another PIW_STATE_DIR', other], ['no override (the default)', defaultState]] as const) {
      if (requested === other) h.env.PIW_STATE_DIR = other;
      else delete h.env.PIW_STATE_DIR;
      h.calls.length = 0;
      const r = await h.cli('install', '--from', tarball, '--wait-ms', '300');
      assert.deepEqual([r.code, r.error?.error, r.error?.effect, r.error?.pinned, r.error?.requested], [1, 'pi_worker_state_mismatch', 'no_effect', pinned, requested], `${label}: refused`);
      assert.deepEqual(systemctlCalls(h), [SHOW], `${label}: systemd was only asked, nothing reloaded or restarted`);
      assert.equal(readFileSync(h.unitFile, 'utf8'), unitBefore, `${label}: the unit file is unchanged`);
      assert.equal(readFileSync(join(h.data, 'doctor.grant.json'), 'utf8'), doctorBefore, `${label}: the doctor grant is unchanged`);
      assert.equal(existsSync(requested), false, `${label}: the requested state directory was not created`);
      assert.deepEqual(grantIds(pinned), grantsBefore, `${label}: the pinned registry is unchanged`);
    }
    h.env.PIW_STATE_DIR = pinned;
    const same = await h.cli('install', '--from', tarball, '--wait-ms', '5000');
    assert.deepEqual([same.code, same.json?.restarted], [0, false], 'the pinned state directory again installs, unchanged');
  } finally {
    await h.close();
  }
});

test('grant, uninstall --purge: an UnsetEnvironment= removing PIW_STATE_DIR or PIW_SOCKET is refused pi_worker_unsafe_path (which: state or socket) before anything is written or stopped', async () => {
  const { h, pinned, defaultState } = await installedWithState('PIW_STATE_DIR');
  try {
    delete h.env.PIW_STATE_DIR;
    const before = grantIds(pinned);
    const out = join(h.dir, 'refused.grant.json');
    for (const [unset, which] of [['PIW_STATE_DIR', 'state'], [`PIW_STATE_DIR=${pinned}`, 'state'], ['PIW_SOCKET', 'socket']] as const) {
      dropIn(h, `UnsetEnvironment=${unset}`);
      h.reload();
      const reg = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello');
      assert.deepEqual([reg.code, reg.error?.error, reg.error?.effect, reg.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', which], `UnsetEnvironment=${unset}: grant register is refused`);
      assert.equal(existsSync(out), false, `UnsetEnvironment=${unset}: no bearer file`);
      assert.deepEqual(grantIds(pinned), before, `UnsetEnvironment=${unset}: the pinned registry is unchanged`);
      assert.equal(existsSync(defaultState), false, `UnsetEnvironment=${unset}: the default state directory was not created`);
      const treeBefore = tree(h.dir);
      h.calls.length = 0;
      const purge = await h.cli('uninstall', '--purge');
      assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect, purge.error?.which], [1, 'pi_worker_unsafe_path', 'no_effect', which], `UnsetEnvironment=${unset}: purge is refused`);
      assert.deepEqual(tree(h.dir), treeBefore, `UnsetEnvironment=${unset}: purge deleted nothing`);
      assert.deepEqual(touched(h), [], `UnsetEnvironment=${unset}: the unit was not stopped`);
    }
  } finally {
    await h.close();
  }
});

test('grant, uninstall --purge: unit files changed since systemd read them (NeedDaemonReload=yes) are refused pi_worker_unit_reload_pending before anything is written or stopped', async () => {
  const { h, pinned } = await installedWithState('PIW_STATE_DIR');
  try {
    delete h.env.PIW_STATE_DIR;
    const before = grantIds(pinned);
    const unread = join(h.dir, 'unread-state');
    dropIn(h, `Environment=PIW_STATE_DIR=${unread}`);
    const out = join(h.dir, 'bridge.grant.json');
    for (const argv of [['grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello'], ['grant', 'list'], ['grant', 'revoke', 'whatever']]) {
      const r = await h.cli(...argv);
      assert.deepEqual([r.code, r.error?.error, r.error?.effect], [1, 'pi_worker_unit_reload_pending', 'no_effect'], `${argv.slice(0, 2).join(' ')} is refused while a drop-in is unread`);
      assert.deepEqual(r.out, [], `${argv[1]}: nothing on stdout`);
    }
    assert.equal(existsSync(out), false, 'no bearer file');
    assert.deepEqual(grantIds(pinned), before, 'the loaded pin\'s registry is unchanged');
    assert.equal(existsSync(unread), false, 'the unread pin was not created');
    const treeBefore = tree(h.dir);
    h.calls.length = 0;
    const purge = await h.cli('uninstall', '--purge');
    assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect], [1, 'pi_worker_unit_reload_pending', 'no_effect'], 'purge is refused');
    assert.deepEqual(tree(h.dir), treeBefore, 'purge deleted nothing');
    assert.deepEqual(touched(h), [], 'the unit was not stopped');
    // Once the owner reloads, the drop-in's pin is the one.
    h.reload();
    const reg = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', out, '--method', 'hello');
    assert.equal(reg.code, 0, `grant register after daemon-reload (error: ${String(reg.error?.error)})`);
    assert.equal(grantIds(unread).length, 1, 'registered in the pin systemd now runs the unit with');
  } finally {
    await h.close();
  }
});

test('install: unit files systemd has not read (NeedDaemonReload=yes) are read first (daemon-reload), and the state directory they pin is checked before anything is written or restarted', async () => {
  const { h, pinned } = await installedWithState('PIW_STATE_DIR');
  try {
    const tarball = h.tarball('1.2.3');
    const unitBefore = readFileSync(h.unitFile, 'utf8');
    const doctorBefore = readFileSync(join(h.data, 'doctor.grant.json'), 'utf8');
    const grantsBefore = grantIds(pinned);
    const other = join(h.dir, 'dropin-state');
    dropIn(h, `Environment=PIW_STATE_DIR=${other}`);
    h.calls.length = 0;
    const r = await h.cli('install', '--from', tarball, '--wait-ms', '300');
    assert.deepEqual([r.code, r.error?.error, r.error?.effect, r.error?.pinned, r.error?.requested], [1, 'pi_worker_state_mismatch', 'no_effect', other, pinned], 'the unread drop-in\'s pin is refused');
    assert.deepEqual(systemctlCalls(h), [SHOW, 'daemon-reload', SHOW], 'systemd read the drop-in first; nothing was enabled or restarted');
    assert.equal(readFileSync(h.unitFile, 'utf8'), unitBefore, 'the unit file is unchanged');
    assert.equal(readFileSync(join(h.data, 'doctor.grant.json'), 'utf8'), doctorBefore, 'the doctor grant is unchanged');
    assert.deepEqual(grantIds(pinned), grantsBefore, 'the pinned registry is unchanged');
    assert.equal(existsSync(other), false, 'the drop-in\'s state directory was not created');
    // An unread drop-in that keeps the pin: read, then installed as before.
    dropIn(h, `Environment=PIW_STATE_DIR=${pinned}`);
    h.calls.length = 0;
    const same = await h.cli('install', '--from', tarball, '--wait-ms', '5000');
    assert.deepEqual([same.code, same.json?.restarted], [0, false], `the same pin installs (error: ${String(same.error?.error)})`);
    assert.deepEqual(systemctlCalls(h).slice(0, 3), [SHOW, 'daemon-reload', SHOW], 'read first');
  } finally {
    await h.close();
  }
});

test('install: an install interrupted after its doctor grant was registered (daemon-reload failed) is repaired in the same state directory; another one is refused pi_worker_state_mismatch, also after uninstall', async () => {
  const h = await host(({ dir }) => ({ PIW_STATE_DIR: join(dir, 'first-state') }));
  try {
    h.unit.serveVersion = '1.2.3';
    h.unit.failReloads = 1;
    const tarball = h.tarball('1.2.3');
    const first = await h.cli('install', '--from', tarball, '--wait-ms', '300');
    assert.deepEqual([first.code, first.error?.error, first.error?.step, first.error?.effect], [3, 'pi_worker_systemctl_failed', 'daemon-reload', 'unknown'], 'interrupted at daemon-reload');
    const firstState = h.state;
    assert.equal(grantIds(firstState).length, 1, 'the interrupted install had registered its doctor grant');
    const unitBefore = readFileSync(h.unitFile, 'utf8');
    const doctorBefore = readFileSync(join(h.data, 'doctor.grant.json'), 'utf8');
    const other = join(h.dir, 'other-state');
    h.env.PIW_STATE_DIR = other;
    h.calls.length = 0;
    const moved = await h.cli('install', '--from', tarball, '--wait-ms', '300');
    assert.deepEqual([moved.code, moved.error?.error, moved.error?.effect, moved.error?.requested], [1, 'pi_worker_state_mismatch', 'no_effect', other], 'another state directory is refused');
    assert.deepEqual(systemctlCalls(h), [SHOW], 'systemd was only asked (it has not loaded the unit)');
    assert.equal(readFileSync(h.unitFile, 'utf8'), unitBefore, 'the unit file is unchanged');
    assert.equal(readFileSync(join(h.data, 'doctor.grant.json'), 'utf8'), doctorBefore, 'the doctor grant is unchanged');
    assert.equal(existsSync(other), false, 'the other state directory was not created');
    h.env.PIW_STATE_DIR = firstState;
    const repaired = await h.cli('install', '--from', tarball, '--wait-ms', '5000');
    assert.equal(repaired.code, 0, `the same state directory completes the install (error: ${String(repaired.error?.error)})`);
    assert.equal(grantIds(firstState).length, 1, 'the doctor grant is kept, not registered again');
    // Uninstall keeps the state and the doctor grant; installing again elsewhere is the same mismatch.
    assert.equal((await h.cli('uninstall')).code, 0, 'uninstall');
    h.env.PIW_STATE_DIR = other;
    h.calls.length = 0;
    const elsewhere = await h.cli('install', '--from', tarball, '--wait-ms', '300');
    assert.deepEqual([elsewhere.code, elsewhere.error?.error, elsewhere.error?.effect, elsewhere.error?.requested], [1, 'pi_worker_state_mismatch', 'no_effect', other], 'after uninstall, another state directory is refused');
    assert.deepEqual(systemctlCalls(h), [], 'no unit file: systemd was not asked');
    assert.equal(existsSync(other), false, 'after uninstall: the other state directory was not created');
    assert.equal(existsSync(h.unitFile), false, 'after uninstall: no unit file was written');
  } finally {
    await h.close();
  }
});

test('install: a drop-in the owner kept (uninstall never removes one) that pins another state directory is found once systemd reads the new unit, and refused before the unit is started', async () => {
  const h = await host(({ dir }) => ({ PIW_STATE_DIR: join(dir, 'state') }));
  try {
    h.unit.serveVersion = '1.2.3';
    const kept = join(h.dir, 'kept-state');
    dropIn(h, `Environment=PIW_STATE_DIR=${kept}`);
    const r = await h.cli('install', '--from', h.tarball('1.2.3'), '--wait-ms', '300');
    assert.deepEqual([r.code, r.error?.error, r.error?.effect, r.error?.pinned, r.error?.requested], [3, 'pi_worker_state_mismatch', 'unknown', kept, h.state], 'refused once systemd has read the drop-in');
    assert.deepEqual(systemctlCalls(h), ['daemon-reload', SHOW], 'the unit was neither enabled nor started');
    assert.equal(h.unit.active, false, 'nothing runs');
    assert.equal(existsSync(kept), false, 'the drop-in\'s state directory was not created');
  } finally {
    await h.close();
  }
});

test('uninstall --purge removes the state directory systemd runs the unit with (a drop-in pin), not the unit file\'s line, and keeps the owner\'s drop-in', async () => {
  const { h, pinned } = await installedWithState('PIW_STATE_DIR');
  try {
    delete h.env.PIW_STATE_DIR;
    const effective = join(h.dir, 'effective-state');
    dropIn(h, `Environment=PIW_STATE_DIR=${effective}`);
    h.reload();
    const reg = await h.cli('grant', 'register', '--caller', 'shep-bridge', '--out', join(h.dir, 'bridge.grant.json'), '--method', 'hello');
    assert.equal(reg.code, 0, `grant register (error: ${String(reg.error?.error)})`);
    assert.ok(existsSync(join(effective, 'grants')), 'registered in the state directory systemd runs the unit with');
    openState(effective).close();
    h.calls.length = 0;
    const purge = await h.cli('uninstall', '--purge');
    assert.deepEqual([purge.code, purge.json], [0, { uninstalled: true, purged: true }], `purged (error: ${String(purge.error?.error)})`);
    assert.equal(lstatExists(effective), false, 'the state directory systemd ran the unit with is removed, its grants with it');
    assert.ok(existsSync(pinned), 'the unit file\'s own line was not the state the unit ran with: not purged');
    assert.ok(existsSync(join(`${h.unitFile}.d`, 'override.conf')), 'the owner\'s drop-in is kept');
    assert.equal(systemctlCalls(h)[0], SHOW, 'systemd was asked before anything was stopped');
  } finally {
    await h.close();
  }
});

test('uninstall --purge refuses before stopping or removing anything when systemd cannot establish the targets: it cannot be asked, or has not loaded the unit', async () => {
  const cases: [string, (h: Host) => void, string][] = [
    ['systemctl show fails', h => (h.unit.showStatus = 1), 'pi_worker_systemctl_failed'],
    ['a unit file systemd has not loaded', h => (h.unit.loadState = 'not-found'), 'pi_worker_unsafe_path'],
  ];
  for (const [label, arrange, error] of cases) {
    const { h } = await installedWithState('PIW_STATE_DIR');
    try {
      arrange(h);
      const before = tree(h.dir);
      h.calls.length = 0;
      const purge = await h.cli('uninstall', '--purge');
      assert.deepEqual([purge.code, purge.error?.error, purge.error?.effect], [1, error, 'no_effect'], `${label}: refused`);
      assert.deepEqual(tree(h.dir), before, `${label}: nothing was deleted`);
      assert.deepEqual(touched(h), [], `${label}: the unit was not stopped`);
    } finally {
      await h.close();
    }
  }
});

test('doctor, version: hello the socket systemd runs the unit with (a drop-in PIW_SOCKET); one systemd cannot establish is never guessed', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    assert.equal((await h.cli('install', '--from', h.tarball('1.2.3'))).code, 0, 'install');
    const moved = join(h.env.XDG_RUNTIME_DIR!, 'moved', 'b2.sock');
    dropIn(h, `Environment=PIW_SOCKET=${moved}`);
    h.reload();
    await h.restartServer();
    assert.equal((await h.cli('version')).json?.daemon_version, '1.2.3', 'version reaches the daemon on the drop-in socket');
    const doctor = await h.cli('doctor', '--json');
    const check = (id: string) => (doctor.json!.checks as { id: string; ok: boolean; detail: string }[]).find(c => c.id === id)!;
    assert.deepEqual([check('socket_reachable').ok, check('socket_reachable').detail, check('hello').ok], [true, moved, true], 'doctor checks the drop-in socket');
    // UnsetEnvironment=PIW_SOCKET: the daemon is back on the manager's default socket, but the CLI cannot establish it.
    dropIn(h, 'UnsetEnvironment=PIW_SOCKET');
    h.reload();
    await h.restartServer();
    assert.ok(existsSync(h.socket), 'a daemon answers on the default socket');
    const version = await h.cli('version');
    assert.deepEqual([version.code, version.json?.daemon_version], [0, null], 'version reports no daemon version rather than a guessed socket\'s');
    const sick = await h.cli('doctor', '--json');
    const failed = (sick.json!.checks as { id: string; ok: boolean; detail: string }[]).filter(c => !c.ok);
    assert.deepEqual(failed.map(c => c.id), ['socket_reachable', 'hello'], 'doctor fails the socket checks');
    assert.match(failed[0]!.detail, /pi_worker_unsafe_path/, 'and names why');
  } finally {
    await h.close();
  }
});

test('logs: journalctl --user -u pi-worker.service, -f follows, its exit status is the exit code', async () => {
  const h = await host();
  try {
    assert.equal((await h.cli('logs')).code, 0);
    assert.equal((await h.cli('logs', '-f')).code, 0);
    h.unit.journalStatus = 4;
    assert.equal((await h.cli('logs', '--follow')).code, 4);
    const journal = h.calls.filter(c => c[0] === 'journalctl').map(c => c.slice(1).join(' '));
    assert.deepEqual(journal, ['--user -u pi-worker.service --no-pager', '--user -u pi-worker.service --no-pager -f', '--user -u pi-worker.service --no-pager -f']);
  } finally {
    await h.close();
  }
});

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
