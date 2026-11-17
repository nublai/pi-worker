/**
 * Cleanup domains: one cgroup v2 directory per worker epoch under a delegated subtree, ported from A0
 * `src/containment.ts` without the process-group fallback (plan decision D3).
 *
 * A domain is cleanup, not isolation: a tool that detaches (`setsid`, `nohup`, a double fork) stays in its worker's
 * domain and dies with it, but hostile code running as the same user outside the worker can still signal or escape it,
 * and work handed to another daemon (tmux, `systemd-run --user`, Docker) leaves the domain (plan section 13.5).
 *
 * The lifecycle records a domain's identity in the worker's starting row before anything is spawned, so a restarted
 * supervisor can clean it from the journal alone. A domain is never reused, even when empty: its removal is what
 * retires a delayed join (a wrapper of a killed supervisor that has not joined yet cannot join later).
 *
 * Installation (P2-2): every domain's name carries the installation id, `w-<installation>-<generation>`, a hash of the
 * state directory's real path (one supervisor per state directory, so one per installation). That name is what proves a
 * domain is this installation's: clean and the startup sweep act only on such names in their own delegation, so
 * another installation's domains and any other cgroup (an operator's, the keeper's own) are never killed or removed,
 * also when installations share an operator-supplied delegation (`PIW_CGROUP_ROOT`). Before recovery, the sweep kills
 * and removes every domain of this installation the journal does not account for (left by a lost journal tail, a state
 * directory recreated at the same path, or a supervisor that crashed before its record), so nothing an older run
 * started keeps running unrecorded.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bootId } from '../host/process.js';

/** A domain's identity, durable in the worker's rows: its delegation, its name and the boot it belongs to. */
export type Domain = { root: string; name: string; boot: string };

export interface Containment {
  /** What a domain proves; the daemon names it in `hello`'s named limits. */
  readonly profile: string;
  /** A new domain identity for a worker epoch. Nothing is created yet. */
  reserve(epoch: string): Domain;
  /**
   * Creates the domain (refusing one that exists) and returns the argv prefix that runs a program inside it: the
   * prefix joins the domain before it executes the program, and exits 125 without running it when it cannot join.
   */
  enter(domain: Domain): readonly string[];
  /** `cgroup.kill`, then `populated 0`, then removal. True only when the domain is observed gone. Never throws. */
  clean(domain: Domain): Promise<boolean>;
  /**
   * The startup sweep: kills and removes every domain of this installation in the delegation except `known` (the
   * domains journal records still account for, which recovery cleans and records itself). Throws `SweepUnproven` when
   * one is not observed gone: the daemon then fails to start.
   */
  sweep(known: readonly Domain[]): Promise<void>;
}

/** A domain of this installation the sweep could not prove gone: startup fails, nothing listens. */
export class SweepUnproven extends Error {
  readonly code = 'orphan_cleanup_unproven';
  constructor(readonly domains: readonly string[]) {
    super(`orphan_cleanup_unproven: ${domains.length} unrecorded cleanup domain(s) of this installation were not observed gone`);
  }
}

/** An installation id: a hash of the state directory's real path (`installationId`). */
const INSTALLATION = /^[0-9a-f]{20}$/;

/** This installation's id, from the state directory's real path; it names the keeper service and every domain. */
export function installationId(stateDir: string): string {
  return createHash('sha256').update(realpathSync(stateDir)).digest('hex').slice(0, 20);
}
/** The fixed program that runs before any payload: it moves itself into the domain, then executes the payload. */
const JOIN = 'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"';

export class CgroupContainment implements Containment {
  readonly profile = 'cgroup_v2_user_delegation: cgroup.kill, populated 0, removed; cleanup, not isolation from same-user code';

  /** This installation's domain names: `w-<installation>-<generation>`. */
  private readonly name: RegExp;

  /**
   * `root` is a delegated cgroup v2 directory; `checkDelegation` proves it before the daemon uses it. `installation` is
   * this installation's id (`installationId`).
   */
  constructor(
    readonly root: string,
    readonly installation: string,
    readonly timeoutMs = 5000,
  ) {
    if (!INSTALLATION.test(installation)) throw new Error('invalid installation id');
    this.name = new RegExp(`^w-${installation}-[a-zA-Z0-9-]+$`);
  }

  reserve(epoch: string): Domain {
    if (!/^[a-zA-Z0-9-]+$/.test(epoch)) throw new Error('invalid cleanup generation');
    return { root: this.root, name: `w-${this.installation}-${epoch}`, boot: bootId() };
  }

  /** The domain's directory; only a domain of this delegation, with this installation's domain name. */
  private path(domain: Domain): string {
    if (domain.root !== this.root || !this.name.test(domain.name)) throw new Error('cleanup delegation mismatch');
    return join(this.root, domain.name);
  }

  enter(domain: Domain): readonly string[] {
    if (domain.boot !== bootId()) throw new Error('stale cleanup boot');
    const path = this.path(domain);
    // A generation is never reused, even when empty (mkdir refuses an existing directory).
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('cleanup domain already exists; populated or not retired');
      throw error;
    }
    return ['/bin/sh', '-c', JOIN, 'piw-join', path];
  }

  async clean(domain: Domain): Promise<boolean> {
    // cgroupfs does not survive a reboot: nothing of a prior boot's domain can still run.
    if (domain.boot !== bootId()) return true;
    let path: string;
    try {
      path = this.path(domain);
    } catch {
      return false;
    }
    const deadline = Date.now() + this.timeoutMs;
    do {
      try {
        if (!existsSync(path)) return true;
        writeFileSync(join(path, 'cgroup.kill'), '1\n');
        if (/^populated 0$/m.test(readFileSync(join(path, 'cgroup.events'), 'utf8'))) {
          // Tools can create nested cgroups on an unsandboxed same-user host: remove the deepest first.
          const remove = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) remove(join(dir, entry.name));
            rmdirSync(dir);
          };
          remove(path);
          return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(path)) return true;
        // A busy, removal or permission error never becomes confirmed cleanup.
      }
      await delay(10);
    } while (Date.now() < deadline);
    return false;
  }

  async sweep(known: readonly Domain[]): Promise<void> {
    const recorded = new Set(known.filter(domain => domain.root === this.root).map(domain => domain.name));
    const unproven: string[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      // Only this installation's domains: never another installation's, the keeper's or an operator's cgroups.
      if (!entry.isDirectory() || !this.name.test(entry.name) || recorded.has(entry.name)) continue;
      // cgroupfs does not survive a reboot: a domain listed now is of this boot.
      if (!(await this.clean({ root: this.root, name: entry.name, boot: bootId() }))) unproven.push(entry.name);
    }
    if (unproven.length > 0) throw new SweepUnproven(unproven);
  }
}

/**
 * Refuses a root the daemon cannot use as a delegation: outside the cgroup v2 mount, a supervisor that cannot move a
 * child into it (it runs outside a delegated user tree, e.g. an SSH session scope), no write access, no `cgroup.kill`
 * (Linux 5.14+), or memory and pids not delegated. Returns the root's real path.
 */
export function checkDelegation(root: string, procSelfCgroup = '/proc/self/cgroup'): string {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new Error(`cgroup delegation ${root} does not exist`);
  }
  if (!real.startsWith('/sys/fs/cgroup/')) throw new Error('cgroup delegation must be under the cgroup v2 mount /sys/fs/cgroup');
  const own = readFileSync(procSelfCgroup, 'utf8').trim();
  if (!own.startsWith('0::') || own.includes('\n')) throw new Error('pure cgroup v2 required');
  const current = join('/sys/fs/cgroup', own.slice(3)).split('/');
  const target = real.split('/');
  let common = 0;
  while (common < current.length && current[common] === target[common]) common++;
  try {
    accessSync(join(current.slice(0, common).join('/') || '/', 'cgroup.procs'), constants.W_OK);
  } catch {
    throw new Error('the supervisor cannot move a process into the delegation from its own cgroup; start it in a systemd user service (systemd-run --user), not an SSH session scope');
  }
  for (const file of ['cgroup.procs', 'cgroup.subtree_control']) {
    try {
      accessSync(join(real, file), constants.W_OK);
    } catch {
      throw new Error(`cgroup delegation ${real} is not writable (${file})`);
    }
  }
  if (!existsSync(join(real, 'cgroup.kill'))) throw new Error('cgroup v2 cgroup.kill unavailable (Linux 5.14+ required)');
  const controllers = readFileSync(join(real, 'cgroup.controllers'), 'utf8').split(/\s+/);
  if (!['memory', 'pids'].every(c => controllers.includes(c))) throw new Error('memory and pids controllers are not delegated');
  return real;
}

/** The systemd user service that keeps this installation's delegation, named from the state directory's real path. */
export function keeperUnit(stateDir: string): string {
  return `piw-domains-${installationId(stateDir)}.service`;
}

/**
 * The daemon's delegation, refused (throws, naming why) when it has none. `PIW_CGROUP_ROOT` names an operator-supplied
 * delegated cgroup, which other installations may share (each sweeps only its own domains); otherwise a stable, installation-scoped systemd user service with `Delegate=yes` keeps one, started
 * once and kept across supervisor crashes. No sudo, no fallback.
 */
export function openContainment(stateDir: string, env: NodeJS.ProcessEnv = process.env): CgroupContainment {
  if (process.platform !== 'linux') throw new Error('cgroup v2 delegation requires Linux');
  const installation = installationId(stateDir);
  if (env.PIW_CGROUP_ROOT) return new CgroupContainment(checkDelegation(env.PIW_CGROUP_ROOT), installation);
  const uid = process.getuid!();
  const userEnv = {
    ...env,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`,
  };
  const run = (bin: string, args: string[]): string => {
    try {
      return execFileSync(bin, args, { env: userEnv, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      throw new Error(`no cgroup delegation: ${bin} ${args[0] ?? ''} failed (a systemd user manager is required; set PIW_CGROUP_ROOT to a delegated cgroup otherwise): ${String((error as { stderr?: string }).stderr ?? error).trim().slice(0, 256)}`);
    }
  };
  const unit = keeperUnit(stateDir);
  if (run('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value']) !== 'active') {
    run('systemd-run', ['--user', `--unit=${unit}`, '--property=Delegate=yes', '--property=KillMode=control-group', '--property=TimeoutStopSec=5', '/bin/sleep', 'infinity']);
  }
  const group = run('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value']);
  if (!group.startsWith('/user.slice/')) throw new Error('the keeper service is not in a user delegation; refusing');
  return new CgroupContainment(checkDelegation(join('/sys/fs/cgroup', group)), installation);
}
