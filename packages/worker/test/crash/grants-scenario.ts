/**
 * The grants crash scenario (P1-9): what the owner's `grant` command does, through the same store functions. Each step
 * is logged to `steps.jsonl` only after it returned, so the oracle knows which steps completed without asking the
 * store. Bearer files live outside the grant directory, as the command writes them for a caller.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GrantStore, writeBearerFile } from '../../src/grants/store.js';

export async function grantsScenario(root: string): Promise<void> {
  const state = join(root, 'state');
  const callers = join(root, 'callers');
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(callers, { mode: 0o700 });
  const step = (value: Record<string, unknown>) => appendFileSync(join(root, 'steps.jsonl'), `${JSON.stringify(value)}\n`);
  const store = new GrantStore(state);
  for (const id of ['reader', 'writer']) {
    const { token } = store.register({ caller: id, scope: { worker_ids: ['*'], cwd_roots: [] }, methods: id === 'reader' ? ['hello'] : ['sessions.prompt'], grant_id: id });
    step({ step: 'registered', id });
    const file = join(callers, `${id}.json`);
    writeBearerFile(file, token);
    step({ step: 'bearer', id, file });
  }
  store.revoke('writer');
  step({ step: 'revoked', id: 'writer' });
}
