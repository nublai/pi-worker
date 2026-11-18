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
  /** `uid` is the uid the commands see (default: this process's). */
  unit: { active: boolean; delegate: string; linger: string; serveVersion: string | undefined; journalStatus: number; uid: number };
  cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string[]; json?: Record<string, unknown>; error?: Record<string, unknown> }>;
  tarball(version: string, options?: TarballOptions): string;
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
  const unit = { active: false, delegate: 'yes', linger: 'yes', serveVersion: undefined as string | undefined, journalStatus: 0, uid: UID };
  const calls: string[][] = [];
  let server: Server | undefined;
  const start = () => {
    if (server || unit.serveVersion === undefined) return;
    mkdirSync(join(socket, '..'), { recursive: true, mode: 0o700 });
    const version = unit.serveVersion;
    server = createServer((req, res) => {
      res.writeHead(req.url === '/b2/hello' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/b2/hello' ? { ...HELLO, worker_version: version } : { error: 'not_found', effect: 'no_effect' }));
    });
    server.listen(socket);
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
          case 'show':
            return ok(`Delegate=${unit.delegate}\nControlGroup=${unit.active ? unitCg : ''}\n`);
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
    unitFile: join(home, '.config', 'systemd', 'user', 'pi-worker.service'),
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

const systemctlCalls = (h: Host) => h.calls.filter(c => c[0] === 'systemctl').map(c => c.slice(2).join(' '));

test('install: verifies, unpacks, links, writes a Delegate=yes unit, starts it and waits for hello', async () => {
  const h = await host();
  try {
    h.unit.serveVersion = '1.2.3';
    const r = await h.cli('install', '--from', h.tarball('1.2.3'));
    assert.equal(r.code, 0, `install exit code (stderr error: ${String(r.error?.error)})`);
    assert.deepEqual(r.json, { version: '1.2.3', socket: h.socket, unit: 'pi-worker.service' });
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
      'WantedBy=default.target',
    ]) {
      assert.ok(unit.split('\n').includes(line), `the unit has the line ${line.split('=')[0]}`);
    }
    assert.ok(unit.includes(`Environment=PATH=${join(process.execPath, '..')}:`), "the unit's PATH starts with the installing node's directory");
    assert.deepEqual(systemctlCalls(h), ['daemon-reload', 'is-active pi-worker.service', 'enable --now pi-worker.service']);
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
    assert.deepEqual(systemctlCalls(h), ['daemon-reload', 'is-active pi-worker.service', 'enable --now pi-worker.service'], 'no restart: the unit did not change');
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

/** Replaces the installed unit's pinned state directory or socket, as an older or hand-edited unit would hold it. */
function pin(h: Host, key: 'PIW_STATE_DIR' | 'PIW_SOCKET', value: string): void {
  const text = readFileSync(h.unitFile, 'utf8').replace(new RegExp(`^Environment=${key}=.*$`, 'm'), `Environment=${key}=${value}`);
  writeFileSync(h.unitFile, text);
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
      assert.deepEqual(systemctlCalls(h), [], `HOME${label}: the unit was not touched`);
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
    assert.deepEqual(systemctlCalls(h), [], 'the unit was not touched');
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
      assert.deepEqual(systemctlCalls(h), [], `${label}: the unit was not touched`);
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
