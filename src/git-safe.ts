/** The ONE way owner-side and harness code runs Git in a checkout that a
 * sandboxed agent could write. Before every command it re-reads the `.git`
 * pointer, the admin dir's gitdir/commondir (and symbolic HEAD), common config
 * and alternates through O_NOFOLLOW descriptor opens and compares them with the
 * launch-time pin. It then runs Git against the pinned git dir with fsmonitor
 * and hooks disabled and submodules ignored. Repository config is read-only to
 * every sandbox and may not contain includes. */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync } from 'node:fs';
import { assertPin, gitPinAt, type GitPin } from './git-sandbox.js';
import { openPinned } from './pinned-fs.js';
import { Refusal } from './types.js';
export type { GitPin } from './git-sandbox.js';

export const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false'];
/** Read the current pin. Use ONLY for checkouts the owner created and no sandbox
 * has touched yet (that is what makes it a launch-time pin). */
export function readGitPin(root: string): GitPin {
  const fd = openPinned(root, 'dir');
  try {
    const pin = gitPinAt(root, fd);
    if (!pin) throw new Refusal('git_checkout_missing');
    return pin;
  } finally { closeSync(fd); }
}
export function checkGitPin(root: string, expected: GitPin | null | undefined): GitPin {
  if (!expected) throw new Refusal('git_launch_pin_required');
  const fd = openPinned(root, 'dir');
  try {
    let current;
    try { current = gitPinAt(root, fd); }
    catch (error) { throw new Refusal(`git_metadata_changed_since_launch: ${error instanceof Error ? error.message : 'unreadable'}`); }
    assertPin(current, expected);
  } finally { closeSync(fd); }
  return expected;
}
function env(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXEC_PATH|NAMESPACE|CEILING_DIRECTORIES)$/.test(k)) delete e[k];
  return e;
}
/** Run Git after checking the pin; returns the raw result (no status check). */
export function safeGitRun(root: string, pin: GitPin | null | undefined, args: string[], options: { maxBuffer?: number } = {}): SpawnSyncReturns<Buffer> {
  const checked = checkGitPin(root, pin);
  const result = spawnSync('git', ['-C', root, `--git-dir=${checked.git_dir}`, `--work-tree=${root}`, ...SAFE_GIT_CONFIG, ...args], { env: env(), maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
/** Run Git after checking the pin; throws on nonzero exit; returns trimmed UTF-8. */
export function safeGit(root: string, pin: GitPin | null | undefined, args: string[]): string {
  return safeGitBuffer(root, pin, args).toString('utf8').trim();
}
export function safeGitBuffer(root: string, pin: GitPin | null | undefined, args: string[]): Buffer {
  const result = safeGitRun(root, pin, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').slice(0, 512)}`);
  return result.stdout;
}
