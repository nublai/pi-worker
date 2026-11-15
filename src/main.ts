#!/usr/bin/env node
/** THROWAWAY A0 entrypoint; Linux /proc process-group profile only. */
import { mkdirSync, lstatSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { processToken } from './process.js';
import { Journal } from './journal.js';
import { Supervisor } from './supervisor.js';
import { openContainment } from './containment.js';
import { router, listenPrivate } from './server.js';
const stateDir = resolve(process.env.A0_STATE_DIR ?? '.a0');
process.umask(0o077);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const st = lstatSync(stateDir);
if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('state directory must be owned 0700, no symlink');
const lock = join(stateDir, 'supervisor.lock');
try { mkdirSync(lock, { mode: 0o700 }); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  let owner: { pid: number; token: string };
  try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as typeof owner; }
  catch { throw new Error('incomplete supervisor lock; inspect before manual removal'); }
  if (processToken(owner.pid) === owner.token) throw new Error('another supervisor owns this installation');
  rmSync(lock, { recursive: true }); mkdirSync(lock, { mode: 0o700 });
}
writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: processToken(process.pid) }), { mode: 0o600 });
const pi = process.env.A0_PI ?? 'pi';
let version: string;
try { version = execFileSync(pi, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim(); }
catch (cause) { throw new Error('cannot read installed pi version', { cause }); }
const journal = new Journal(join(stateDir, 'journal.jsonl'));
const supervisor = new Supervisor(stateDir, journal, version, Supervisor.rpcFactory(pi), openContainment(stateDir));
await supervisor.recover();
const server = router(supervisor);
const socket = join(stateDir, 'worker.sock');
await listenPrivate(server, socket);
console.error(JSON.stringify({ prototype: true, socket, supervisor_epoch: supervisor.epoch, pid: process.pid }));
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true;
  await supervisor.shutdown();
  server.closeAllConnections(); server.close();
  journal.close(); rmSync(lock, { recursive: true });
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
