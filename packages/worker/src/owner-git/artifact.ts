/**
 * The artifact subject (P2-6), ported from A0 `src/artifact.ts`: orchestrator evidence, never a claim based on an agent
 * completion. A commit is identified by its commit AND its native tree; the diff bytes are advisory, with the Git
 * version that produced them. Every Git call goes through owner Git: `pin` is the checkout's launch-time pin (the
 * worker's, or `readGitPin` for an owner-made worktree).
 */
import { createHash } from 'node:crypto';
import { gitVersion, safeGit, safeGitBuffer, type GitPin, type OwnerGit } from './git-safe.js';

export function artifactSubject(owner: OwnerGit, cwd: string, commit: string, base: string | undefined, pin: GitPin) {
  const git = (...args: string[]) => safeGit(owner, cwd, pin, args);
  const commit_id = git('rev-parse', '--verify', `${commit}^{commit}`);
  const tree_id = git('rev-parse', '--verify', `${commit_id}^{tree}`);
  const git_version = gitVersion(owner);
  const base_id = base ? git('rev-parse', '--verify', `${base}^{commit}`) : undefined;
  return {
    commit_id,
    tree_id,
    ...(base_id
      ? {
          base_id,
          diff_digest: {
            advisory: true,
            git_version,
            algorithm: 'sha256',
            definition: 'git diff --no-ext-diff --no-textconv --binary BASE COMMIT; not artifact identity',
            value: createHash('sha256')
              .update(safeGitBuffer(owner, cwd, pin, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base_id, commit_id]))
              .digest('hex'),
          },
        }
      : {}),
  };
}
