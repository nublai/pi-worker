/** Orchestrator evidence helper, not a claim based on an agent completion.
 * Every Git call goes through the pinned safe helper: `pin` is the checkout's
 * launch-time pin (Worker.git_pin, or readGitPin for an owner-made clone). */
import { createHash } from 'node:crypto';
import { safeGit, safeGitBuffer, type GitPin } from './git-safe.js';
export function artifactSubject(cwd: string, commit: string, base: string | undefined, pin: GitPin) {
  const git = (...args: string[]) => safeGit(cwd, pin, args);
  const commit_id = git('rev-parse', '--verify', commit + '^{commit}');
  const tree_id = git('rev-parse', '--verify', commit_id + '^{tree}');
  const git_version = git('--version');
  const base_id = base ? git('rev-parse', '--verify', base + '^{commit}') : undefined;
  return { commit_id, tree_id, ...(base_id ? { base_id, diff_digest: {
    advisory: true, git_version, algorithm: 'sha256', definition: 'git diff --no-ext-diff --no-textconv --binary BASE COMMIT; not artifact identity',
    value: createHash('sha256').update(safeGitBuffer(cwd, pin, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base_id, commit_id])).digest('hex'),
  } } : {}) };
}
