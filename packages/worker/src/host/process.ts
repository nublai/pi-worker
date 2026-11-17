/**
 * Linux process identity and process-group termination, ported from A0 `src/process.ts` (Linux branch only; the
 * daemon is Linux-only). A pid alone is not an identity: the token is `<boot id>:<start time>`, so a recycled pid is
 * never signalled. Killing the group is not proof that every descendant is gone (a tool may `setsid`); P2's cgroup
 * domains provide that proof. Until then cleanup stays pending for anything this module did not observe.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const bootId = (): string => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

export function procInfo(pid: number): { start: string; group: number; state: string } | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { start: fields[19]!, group: Number(fields[2]), state: fields[0]! };
  } catch {
    return null;
  }
}

/** A /proc read that failed because the process (or thread) does not exist: the only failure that is evidence. */
const absent = (error: unknown): boolean => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

const stateOf = (stat: string): string => stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!;

/** Whether any task (thread) of `pid`'s thread group is still not a zombie. True when that cannot be read. */
function liveTask(pid: number): boolean {
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch (error) {
    return !absent(error);
  }
  return tasks.some(tid => {
    try {
      const state = stateOf(readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8'));
      return state !== 'Z' && state !== 'X';
    } catch (error) {
      return !absent(error);
    }
  });
}

/**
 * OS evidence that the process `token` names, spawned on this boot as `pid`, is gone (Grok and GPT PR #27): the pid
 * names no process, or names another one (a different start time: the pid was recycled), or the token is of another
 * boot, or the process is a zombie whose every thread has exited (a zombie leader with a live thread still runs). An
 * unreadable /proc entry or a missing token proves nothing; neither does anything said by the process's pipes.
 */
export function processGone(pid: number, token: string | null): boolean {
  const boot = bootId();
  if (token && !token.startsWith(`${boot}:`)) return true;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return absent(error);
  }
  if (!token) return false;
  if (token !== `${boot}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`) return true;
  const state = stateOf(stat);
  if (state !== 'Z' && state !== 'X') return false;
  return !liveTask(pid);
}

/** `<boot id>:<start ticks>` of a live pid, or null. */
export function processToken(pid: number): string | null {
  const info = procInfo(pid);
  return info ? `${bootId()}:${info.start}` : null;
}

function groupAlive(group: number): boolean {
  return readdirSync('/proc')
    .filter(x => /^\d+$/.test(x))
    .some(x => {
      const info = procInfo(Number(x));
      return info?.group === group && info.state !== 'Z';
    });
}

/**
 * SIGKILLs the process group led by `pid` if `token` still names that leader, then waits up to one second for the
 * group to disappear. True only when the group was observed gone. A missing token is never enough to signal.
 */
export async function killGroup(pid: number, token: string | null): Promise<boolean> {
  if (!token) return false;
  if (!token.startsWith(`${bootId()}:`)) return true; // A prior boot's processes cannot survive.
  const current = processToken(pid);
  if (current !== null && current !== token) return false; // The pid was recycled: never signal it.
  if (!groupAlive(pid)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  for (let i = 0; i < 50; i++) {
    if (!groupAlive(pid)) return true;
    await delay(20);
  }
  return false;
}
