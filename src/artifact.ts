/** Orchestrator evidence helper, not a claim based on an agent completion. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export function artifactSubject(cwd: string, commit = 'HEAD', base?: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const commit_id = git('rev-parse', '--verify', commit + '^{commit}');
  const tree_id = git('rev-parse', '--verify', commit_id + '^{tree}');
  const git_version = git('--version');
  const base_id = base ? git('rev-parse', '--verify', base + '^{commit}') : undefined;
  return { commit_id, tree_id, ...(base_id ? { base_id, diff_digest: {
    advisory: true, git_version, algorithm: 'sha256', definition: 'git diff --no-ext-diff --no-textconv --binary BASE COMMIT; not artifact identity',
    value: createHash('sha256').update(execFileSync('git', ['-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--binary', base_id, commit_id])).digest('hex'),
  } } : {}) };
}
