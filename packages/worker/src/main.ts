#!/usr/bin/env node
/** pi-worker supervisor entry: config, private directories, B2 socket, signals. */
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './b2/app.js';
import { createB2Server, listenPrivate } from './b2/server.js';
import { resolvePaths } from './config.js';
import { pinnedPiVersion, SdkHost } from './host/host.js';
import { openState } from './journal/state.js';
import { GrantStore } from './grants/store.js';
import { ReceiptStore } from './receipts/receipts.js';
import { Supervisor } from './supervisor/supervisor.js';

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) {
    throw new Error(`${path} must be an owned, non-symlink 0700 directory`);
  }
}

const paths = resolvePaths();
// Every file and socket the supervisor creates is private from the moment it exists.
process.umask(0o077);
privateDir(paths.stateDir);
privateDir(dirname(paths.socketPath));

// One supervisor per state directory: the journal lock refuses a second one before anything is read.
const state = openState(paths.stateDir);
const supervisor = new Supervisor({
  journal: state.journal,
  receipts: new ReceiptStore(state.journal),
  supervisorEpoch: state.supervisorEpoch,
  stateDir: paths.stateDir,
  factory: launch =>
    new SdkHost({
      cwd: launch.cwd,
      sessionDir: launch.sessionDir,
      provider: launch.create.provider,
      model: launch.create.model,
      thinking: launch.create.thinking,
      projectTrusted: launch.create.project_trusted === true,
    }),
});
// Recovery before the socket listens: undispatched intents become intent_recovered, dispatched ones outcome_unknown,
// and every worker that held a session is cleanup_pending with its old pi process group killed. No replay.
await supervisor.recover();
// Every request needs a bearer grant registered by the owner with the local `grant` command (src/grant.ts).
const grants = new GrantStore(paths.stateDir);
const app = createApp({ supervisorId: state.supervisorId, supervisorEpoch: state.supervisorEpoch, piVersion: pinnedPiVersion(), supervisor, grants });
const server = createB2Server(app.handle);
await listenPrivate(server, paths.socketPath);
console.error(JSON.stringify({ event: 'listening', socket: paths.socketPath, pid: process.pid }));

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  void supervisor.shutdown().finally(() => closeServer());
}
function closeServer(): void {
  // Closing removes the socket file, then releases the socket lock. Removing the path after that could delete a
  // successor's socket, so main never unlinks it itself.
  server.close(() => {
    state.close();
    process.exit(0);
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
