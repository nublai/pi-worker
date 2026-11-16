#!/usr/bin/env node
/**
 * The owner's grant command: registers and revokes B2 grants through local file access to the supervisor's state
 * directory (the same `PIW_STATE_DIR` / `$XDG_STATE_HOME/pi-worker` the daemon uses). Grants are never managed over
 * HTTP; there is no B2 operation for them. P1-18's `pi-worker grant` wraps this command.
 *
 *   grant register --caller <name> --out <file> [--method <operationId|*>]... [--worker <id|*>]... [--cwd-root <path|*>]...
 *                  [--answers-for-person] [--id <grant_id>]
 *   grant revoke <grant_id>
 *   grant list
 *
 * `register` writes the bearer only to `--out` (a new 0600 file, `{"token": …}`); it prints the grant id and that
 * path, never the bearer. The registry keeps only the bearer's SHA-256. The daemon rereads grants on every request,
 * so a registration or revocation takes effect without a restart.
 */
import { mkdirSync } from 'node:fs';
import { resolvePaths } from './config.js';
import { GrantStore, writeBearerFile } from './grants/store.js';

function usage(): never {
  console.error('usage: grant register --caller <name> --out <file> [--method <m>]... [--worker <id>]... [--cwd-root <path>]... [--answers-for-person] [--id <id>] | grant revoke <id> | grant list');
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
process.umask(0o077);
const { stateDir } = resolvePaths();
// The daemon creates the same 0700 directory on start; registering first (before any start) is allowed.
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const store = new GrantStore(stateDir);

if (command === 'register') {
  const many = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]!] : []));
  const one = (flag: string) => many(flag).at(-1);
  const caller = one('--caller');
  const out = one('--out');
  if (!caller || !out) usage();
  const methods = many('--method');
  const { grant, token } = store.register({
    caller,
    scope: { worker_ids: many('--worker'), cwd_roots: many('--cwd-root') },
    methods: methods.length ? methods : ['*'],
    answers_for_person: args.includes('--answers-for-person'),
    ...(one('--id') ? { grant_id: one('--id')! } : {}),
  });
  // The registry is durable before the bearer exists anywhere; a crash in between leaves an unusable grant, never a
  // bearer without a record.
  writeBearerFile(out, token);
  process.stdout.write(`${JSON.stringify({ grant_id: grant.grant_id, caller: grant.caller, bearer_file: out })}\n`);
} else if (command === 'revoke' && args[0]) {
  const grant = store.revoke(args[0]);
  process.stdout.write(`${JSON.stringify({ grant_id: grant.grant_id, revoked: true })}\n`);
} else if (command === 'list') {
  process.stdout.write(`${JSON.stringify(store.list())}\n`);
} else usage();
