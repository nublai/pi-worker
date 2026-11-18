/**
 * The artifact subject (P2-6), ported from A0 `src/artifact.ts`: orchestrator evidence, never a claim based on an agent
 * completion. A commit is identified by its commit AND its native tree (replacement objects off, so a copied
 * `refs/replace/*` cannot substitute another commit's tree); the diff bytes are advisory, with the Git version that
 * produced them. Every Git call goes through owner Git: `pin` is the checkout's launch-time pin (the worker's, or
 * `readGitPin` for an owner-made worktree).
 */
import { createHash } from 'node:crypto';
import { gitDiff, gitRevParse, gitVersion, type GitPin, type OwnerGit } from './git-safe.js';

export function artifactSubject(owner: OwnerGit, cwd: string, commit: string, base: string | undefined, pin: GitPin) {
  const at = { owner, root: cwd, pin };
  const commit_id = gitRevParse(at, `${commit}^{commit}`);
  const tree_id = gitRevParse(at, `${commit_id}^{tree}`);
  const git_version = gitVersion(owner);
  const base_id = base ? gitRevParse(at, `${base}^{commit}`) : undefined;
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
            definition: 'git diff --no-ext-diff --no-textconv --ignore-submodules=all --binary BASE COMMIT, replacement objects off; not artifact identity',
            value: createHash('sha256')
              .update(gitDiff(at, { kind: 'revisions', from: base_id, to: commit_id }))
              .digest('hex'),
          },
        }
      : {}),
  };
}
