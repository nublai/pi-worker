/** Weaker process-group fallback. Never proves containment or authorizes reuse. */
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
export const bootId = (): string => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
export function procInfo(pid: number): { start: string; group: number; state: string } | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { start: fields[19]!, group: Number(fields[2]), state: fields[0]! };
  } catch { return null; }
}
export const processToken = (pid: number): string | null => {
  if (process.platform !== 'linux') {
    try { const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim(); return start ? `ps:${start}` : null; } catch { return null; }
  }
  const p = procInfo(pid); return p ? `${bootId()}:${p.start}` : null;
};
function groupAlive(group: number): boolean {
  return readdirSync('/proc').filter(x => /^\d+$/.test(x)).some(x => {
    const p = procInfo(Number(x)); return p?.group === group && p.state !== 'Z';
  });
}
export async function killGroup(pid: number, token: string | null): Promise<boolean> {
  if (!token) return false;
  if (process.platform !== 'linux') {
    // If the leader has already disappeared, do not guess about a reused PID.
    // ps birth-time evidence is weaker than Linux boot/start ticks; no macOS
    // acceptance claim is made, and the supervisor still blocks environment reuse.
    if (processToken(pid) !== token) return false;
    try { process.kill(-pid, 'SIGKILL'); } catch { return false; }
    for (let i = 0; i < 50; i++) {
      try { process.kill(-pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      await delay(20);
    }
    return false;
  }
  if (!token.startsWith(bootId() + ':')) return true; // Prior boot's processes cannot survive.
  const current = processToken(pid);
  if (current !== null && current !== token) return false;
  if (!groupAlive(pid)) return true;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  for (let i = 0; i < 50; i++) { if (!groupAlive(pid)) return true; await delay(20); }
  return false;
}
