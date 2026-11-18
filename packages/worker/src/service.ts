/**
 * The supervisor as the main process of the installed `pi-worker.service` user unit (`Delegate=yes`, docs/plan/
 * install.md section 3.1), with the delegation the kernel tier uses (harness/ci/kernel.sh): the process moves itself
 * into the unit cgroup's `supervisor` leaf, and the unit cgroup becomes the daemon's delegation (`PIW_CGROUP_ROOT`), so
 * the cgroup that holds the domains holds no process itself.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The leaf the supervisor moves into, next to its workers' `w-<installation>-…` domains (never a domain name). */
export const SUPERVISOR_LEAF = 'supervisor';
/** The installed unit (docs/plan/install.md section 3.1). */
export const SERVICE_UNIT = 'pi-worker.service';

/** The process is not the main process of a delegated systemd service: the daemon refuses to start. */
export class ServiceDelegationRefused extends Error {
  readonly code = 'no_service_delegation';
}

/**
 * Moves this process into `<unit cgroup>/supervisor` and returns the unit cgroup's path, the delegation to open.
 * Refuses (throws `ServiceDelegationRefused`) when the process is not in the pure cgroup v2 cgroup of a
 * `pi-worker.service` unit (never another service's cgroup, which it would otherwise reshape), or the leaf cannot be
 * made or entered (a unit without `Delegate=yes`).
 */
export function enterServiceLeaf(procSelfCgroup = '/proc/self/cgroup', mount = '/sys/fs/cgroup'): string {
  const own = readFileSync(procSelfCgroup, 'utf8').trim();
  if (!own.startsWith('0::/') || own.includes('\n')) throw new ServiceDelegationRefused('pure cgroup v2 required');
  const relative = own.slice(3);
  if (relative.split('/').includes('..') || basename(relative) !== SERVICE_UNIT) {
    throw new ServiceDelegationRefused('pi-worker daemon runs only as the main process of the pi-worker.service user unit');
  }
  const unit = join(mount, relative);
  const leaf = join(unit, SUPERVISOR_LEAF);
  try {
    mkdirSync(leaf);
  } catch (error) {
    // A restart of the unit can find the leaf it made before; anything else is not a delegation.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !statSync(leaf).isDirectory()) {
      throw new ServiceDelegationRefused(`cannot create ${SUPERVISOR_LEAF} in the unit cgroup (is Delegate=yes set?): ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }
  try {
    // `0` is the writing process: the whole supervisor moves.
    writeFileSync(join(leaf, 'cgroup.procs'), '0\n');
  } catch (error) {
    throw new ServiceDelegationRefused(`cannot enter the ${SUPERVISOR_LEAF} leaf: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  return unit;
}
