/** A0 cleanup domain, not a hostile-same-uid security boundary. No PID adoption. */
import { spawn, execFileSync, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { bootId, killGroup } from './process.js';
export type CleanupUnit = { root: string; name: string; boot: string };
export interface Containment {
  readonly profile: string;
  reserve(epoch: string): CleanupUnit | undefined;
  spawn(unit: CleanupUnit, command: string, args: string[], options: SpawnOptions): ChildProcess;
  clean(unit: CleanupUnit): Promise<boolean>;
  sweepUnknown?(known: CleanupUnit[]): Promise<void>;
}
export class CgroupContainment implements Containment {
  readonly profile = 'cgroup_v2_user_delegation; Linux; cgroup.kill + populated=0 + removed; no hostile-same-uid guarantee';
  readonly root: string;
  constructor(root: string, readonly timeoutMs = 5000, readonly installationOwned = false) {
    this.root = realpathSync(root);
    if (!this.root.startsWith('/sys/fs/cgroup/')) throw new Error('delegation must be under cgroup v2 mount');
    const own = readFileSync('/proc/self/cgroup', 'utf8').trim();
    if (!own.startsWith('0::') || own.includes('\n')) throw new Error('pure cgroup v2 required');
    const current = join('/sys/fs/cgroup', own.slice(3)).split('/');
    const target = this.root.split('/'); let common = 0;
    while (common < current.length && current[common] === target[common]) common++;
    try { accessSync(join(current.slice(0, common).join('/') || '/', 'cgroup.procs'), constants.W_OK); }
    catch { throw new Error('supervisor cannot migrate from current cgroup; launch it via systemd-run --user --pipe --wait (not an SSH init.scope process)'); }
    accessSync(join(this.root, 'cgroup.procs'), constants.W_OK);
    accessSync(join(this.root, 'cgroup.subtree_control'), constants.W_OK);
    if (!existsSync(join(this.root, 'cgroup.kill'))) throw new Error('cgroup v2 kill unavailable');
    const controllers = readFileSync(join(this.root, 'cgroup.controllers'), 'utf8').split(/\s+/);
    if (!['memory', 'pids'].every(c => controllers.includes(c))) throw new Error('memory/pids not delegated');
  }
  async sweepUnknown(known: CleanupUnit[]): Promise<void> {
    // Only openContainment's installation-hashed service is ours to sweep.
    // A0_CGROUP_DIR can be shared by an operator and is never swept.
    if (!this.installationOwned) return;
    const recorded = new Set(known.filter(unit => unit.root === this.root).map(unit => unit.name));
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^w-[a-zA-Z0-9-]+$/.test(entry.name) || recorded.has(entry.name)) continue;
      if (!await this.clean({ root: this.root, name: entry.name, boot: bootId() })) throw new Error('orphan_cleanup_unproven');
    }
  }
  reserve(epoch: string): CleanupUnit {
    if (!/^[a-zA-Z0-9-]+$/.test(epoch)) throw new Error('invalid cleanup generation');
    return { root: this.root, name: `w-${epoch}`, boot: bootId() };
  }
  private path(unit: CleanupUnit): string {
    if (unit.root !== this.root || !/^w-[a-zA-Z0-9-]+$/.test(unit.name)) throw new Error('cleanup delegation mismatch');
    return join(this.root, unit.name);
  }
  spawn(unit: CleanupUnit, command: string, args: string[], options: SpawnOptions): ChildProcess {
    if (unit.boot !== bootId()) throw new Error('stale cleanup boot');
    const path = this.path(unit);
    // A generation is never reused, even when empty. Removal closes the delayed
    // pre-exec join race: a wrapper from a killed supervisor cannot join later.
    if (existsSync(path)) throw new Error('cleanup unit already exists; populated or not retired');
    mkdirSync(path);
    // The only pre-join program is this fixed shell; no payload executes until
    // membership succeeds. cgroup.kill reaches setsid/nohup descendants too.
    return spawn('/bin/sh', ['-c', 'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"', 'a0-join', path, command, ...args], options);
  }
  async clean(unit: CleanupUnit): Promise<boolean> {
    if (unit.boot !== bootId()) return true;
    let path: string; try { path = this.path(unit); } catch { return false; }
    const deadline = Date.now() + this.timeoutMs;
    do {
      try {
        if (!existsSync(path)) return true;
        writeFileSync(join(path, 'cgroup.kill'), '1\n');
        if (/^populated 0$/m.test(readFileSync(join(path, 'cgroup.events'), 'utf8'))) {
          // Tools can create nested cgroups on an unsandboxed same-uid host.
          const remove = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) remove(join(dir, entry.name)); rmdirSync(dir); };
          remove(path); return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(path)) return true;
        // Busy/removal/permission errors never become confirmed cleanup.
      }
      await delay(10);
    } while (Date.now() < deadline);
    return false;
  }
}
export class ProcessGroupContainment implements Containment {
  readonly profile = 'process_group_only; WEAKER; escaped descendants unproven; environment reuse/resume blocked';
  reserve(): undefined { return undefined; }
  spawn(): never { throw new Error('process group uses host spawn'); }
  async clean(): Promise<boolean> { return false; }
}
export const cleanGroup = killGroup;
/** Stable, installation-scoped delegated user service, kept across supervisor crashes.
 * Runtime uses no sudo. An operator may instead supply a delegated subtree. */
export function openContainment(stateDir: string): Containment {
  if (process.env.A0_CLEANUP === 'process-group' || process.platform !== 'linux') return new ProcessGroupContainment();
  if (process.env.A0_CGROUP_DIR) return new CgroupContainment(process.env.A0_CGROUP_DIR);
  const uid = process.getuid!();
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus` };
  const unit = `a0-${createHash('sha256').update(realpathSync(stateDir)).digest('hex').slice(0, 20)}.service`;
  const run = (bin: string, args: string[]) => execFileSync(bin, args, { env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (run('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value']) !== 'active') {
    run('systemd-run', ['--user', `--unit=${unit}`, '--property=Delegate=yes', '--property=KillMode=control-group', '--property=TimeoutStopSec=5', '/bin/sleep', 'infinity']);
  }
  const group = run('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value']);
  if (!group.startsWith('/user.slice/')) throw new Error('not a user delegation; refusing silent cleanup downgrade');
  return new CgroupContainment(join('/sys/fs/cgroup', group), 5000, true);
}
