/** The supervisor daemon: config, private directories, cleanup domains, recovery, B2 socket, signals. */
import { chmodSync, chownSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './b2/app.js';
import { createB2Server, listenPrivate } from './b2/server.js';
import { resolvePaths, resolveSocketAccess, socketModes, type SocketAccess } from './config.js';
import type { Containment } from './containment/containment.js';
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

/** The socket's directory: 0700, or with group access (S-6) 0750 in the configured group. */
function socketDir(path: string, access: SocketAccess): void {
  if (access.mode === 'owner') {
    privateDir(path);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) throw new Error(`${path} must be an owned, non-symlink directory`);
  chownSync(path, st.uid, access.gid);
  chmodSync(path, socketModes(access).dir);
}

/**
 * Runs the daemon. `containment` opens the cleanup domains for the state directory; it throws when there is no
 * delegation, and the daemon then refuses to start: it never listens, so nothing can run outside a domain (P2-1).
 */
export async function runDaemon(containment: (stateDir: string) => Containment): Promise<void> {
  const paths = resolvePaths();
  const access = resolveSocketAccess();
  // Every file and socket the supervisor creates is private from the moment it exists.
  process.umask(0o077);
  privateDir(paths.stateDir);
  socketDir(dirname(paths.socketPath), access);

  let domains: Containment;
  try {
    domains = containment(paths.stateDir);
  } catch (error) {
    console.error(JSON.stringify({ event: 'refused', reason: 'no_cgroup_delegation', detail: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }

  // Every request needs a bearer grant registered by the owner with the local `grant` command (src/grant.ts).
  const grants = new GrantStore(paths.stateDir);
  // One supervisor per state directory: the journal lock refuses a second one before anything is read.
  const state = openState(paths.stateDir);
  const supervisor = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir: paths.stateDir,
    containment: domains,
    factory: launch =>
      new SdkHost(
        {
          cwd: launch.cwd,
          sessionDir: launch.sessionDir,
          provider: launch.create.provider,
          model: launch.create.model,
          thinking: launch.create.thinking,
          projectTrusted: launch.create.project_trusted === true,
          // A typed child: its launch spec, and its task's FD 3 report channel (unsandboxed until P2-4).
          launchSpec: launch.create.launch_spec ?? null,
          taskId: launch.create.parent?.task_id ?? null,
        },
        // pi starts inside the worker's cleanup domain.
        { prefix: launch.prefix },
      ),
    grants,
    // models.list and commands.list for a cwd before any worker exists: a pi process that opens no session.
    inventory: (cwd, projectTrusted) => new SdkHost({ cwd, sessionDir: '', provider: '', model: '', thinking: 'off', projectTrusted, inventory: true }),
  });
  // Recovery before the socket listens: undispatched intents become intent_recovered, dispatched ones outcome_unknown,
  // and every worker that held a session is recorded cleanup_pending, then its domain is killed and removed. No replay.
  await supervisor.recover();
  const app = createApp({
    supervisorId: state.supervisorId,
    supervisorEpoch: state.supervisorEpoch,
    piVersion: pinnedPiVersion(),
    cleanupProfile: domains.profile,
    supervisor,
    grants,
  });
  const server = createB2Server(app.handle);
  await listenPrivate(server, paths.socketPath, access);
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
    // successor's socket, so the daemon never unlinks it itself.
    server.close(() => {
      state.close();
      process.exit(0);
    });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
