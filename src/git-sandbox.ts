/** Sparse Git mounts for a linked worktree. Never mount the repository checkout.
 * Shared objects are writable; refs/reflogs are read-only except a private branch
 * namespace. The owner must verify the complete refs map after the job. */
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Refusal } from './types.js';

export function gitWorktreeMounts(root: string): string[] {
  const dot = join(root, '.git');
  if (!existsSync(dot) || lstatSync(dot).isDirectory()) return []; // ordinary repo is already in the writable workspace
  if (!lstatSync(dot).isFile() || lstatSync(dot).isSymbolicLink()) throw new Refusal('sandbox_git_invalid_gitfile');
  const text = readFileSync(dot, 'utf8').trim();
  if (!text.startsWith('gitdir: ')) throw new Refusal('sandbox_git_invalid_gitfile');
  const admin = realpathSync(resolve(root, text.slice(8))), common = realpathSync(resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim()));
  if (dirname(admin) !== join(common, 'worktrees') || realpathSync(readFileSync(join(admin, 'gitdir'), 'utf8').trim()) !== realpathSync(dot)) throw new Refusal('sandbox_git_not_linked_worktree');
  const head = readFileSync(join(admin, 'HEAD'), 'utf8').trim();
  const mounts = ['--bind', admin, admin];
  for (const name of ['config', 'packed-refs', 'shallow', 'info/exclude', 'refs', 'logs']) {
    const path = join(common, name); if (existsSync(path)) mounts.push('--ro-bind', path, path);
  }
  // A commit creates loose objects and may update object-store metadata. This
  // shared writable store is a documented integrity limit, not Git isolation.
  mounts.push('--bind', join(common, 'objects'), join(common, 'objects'));
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    // Directory writes are needed for ref.lock + atomic rename. Demand a unique
    // namespace rather than exposing all heads for a flat branch name.
    if (!/^refs\/heads\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(ref)) throw new Refusal('sandbox_git_branch_requires_private_namespace');
    const refs = dirname(join(common, ref)), leaf = ref.split('/').at(-1)!;
    if (readdirSync(refs).some(name => name !== leaf)) throw new Refusal('sandbox_git_branch_namespace_not_private');
    const logs = dirname(join(common, 'logs', ref));
    mkdirSync(logs, { recursive: true });
    if (readdirSync(logs).some(name => name !== leaf)) throw new Refusal('sandbox_git_reflog_namespace_not_private');
    mounts.push('--bind', refs, refs, '--bind', logs, logs);
  } else if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Refusal('sandbox_git_invalid_head');
  return mounts;
}
