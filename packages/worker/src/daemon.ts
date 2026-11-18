/** The supervisor daemon: config, private directories, cleanup domains, recovery, B2 socket, signals. */
import { chmodSync, chownSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './b2/app.js';
import { parentChannels } from './b2/channel.js';
import { createB2Server, listenPrivate } from './b2/server.js';
import { resolvePaths, resolveSocketAccess, socketModes, type SocketAccess } from './config.js';
import { holdInstallation, InstallationRefused, RecordedDomainRefused, SweepUnproven, type Containment, type InstallationHold } from './containment/containment.js';
import { pinnedPiVersion, SdkHost } from './host/host.js';
import { locateBwrap } from './sandbox/sandbox.js';
import type { InventoryFactory } from './supervisor/features.js';
import type { HostFactory } from './supervisor/state.js';
import { openState, StateVersionRefused, type SupervisorState as OpenState } from './journal/state.js';
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
 * The production hosts: pi's SDK child for a worker and for an inventory probe (`models.list` and `commands.list` for
 * a cwd before any worker exists, a pi process that opens no session). Every pi process the supervisor starts is one
 * of these, and each runs through its cleanup domain's join prefix (P2-1). `env` is the supervisor's by default.
 * `bwrap` is the executable the daemon located at start (`locateBwrap`): a sandboxed worker's pi runs in it (P2-4).
 */
export function productionHosts(bwrap: string, env?: NodeJS.ProcessEnv): { factory: HostFactory; inventory: InventoryFactory } {
  return {
    factory: launch =>
      new SdkHost(
        {
          cwd: launch.cwd,
          sessionDir: launch.sessionDir,
          provider: launch.create.provider,
          model: launch.create.model,
          thinking: launch.create.thinking,
          projectTrusted: launch.create.project_trusted === true,
          // A typed child: its launch spec, and its task's FD 3 report channel.
          launchSpec: launch.create.launch_spec ?? null,
          taskId: launch.create.parent?.task_id ?? null,
        },
        // pi starts inside the worker's cleanup domain; a sandboxed worker's pi in the bwrap profile of its root, there,
        // with the Git metadata its validation accepted (P2-5) and its staged profile's dependency trees (P2-7).
        // A sandboxed parent's channel directory is bound into its sandbox (P2-8).
        {
          prefix: launch.prefix,
          ...(env ? { env } : {}),
          ...(launch.sandbox
            ? {
                sandbox: {
                  root: launch.sandbox,
                  bwrap,
                  ...(launch.gitPin !== undefined ? { gitPin: launch.gitPin } : {}),
                  ...(launch.dependencies ? { dependencies: launch.dependencies } : {}),
                  ...(launch.channel ? { channel: { dir: launch.channel, workerId: launch.workerId } } : {}),
                },
              }
            : {}),
        },
      ),
    // pi starts inside the probe's cleanup domain.
    inventory: launch =>
      new SdkHost({ cwd: launch.cwd, sessionDir: '', provider: '', model: '', thinking: 'off', projectTrusted: launch.projectTrusted, inventory: true }, { prefix: launch.prefix, ...(env ? { env } : {}) }),
  };
}

/**
 * Runs the daemon. `containment` opens the cleanup domains for the state's installation (journal/state.ts); it throws
 * when there is no delegation, and the daemon then refuses to start: it never listens, so nothing can run outside a
 * domain (P2-1). Without a bwrap that runs (`options.bwrap`, production `locateBwrap`) it refuses to start too
 * (`bwrap_unavailable`, P2-4). `options.installationPrefix` and `options.bwrap` are for the test daemon only (test/fixtures/daemon.ts): production binds the
 * installation's name from its id alone (`installationName`), never one the environment chooses.
 */
export async function runDaemon(containment: (installation: string) => Containment, options: { installationPrefix?: string; bwrap?: () => string } = {}): Promise<void> {
  const paths = resolvePaths();
  const access = resolveSocketAccess();
  // Every file and socket the supervisor creates is private from the moment it exists.
  process.umask(0o077);
  privateDir(paths.stateDir);
  socketDir(dirname(paths.socketPath), access);

  // One supervisor per state directory: the journal lock refuses a second one before anything is read. A state written
  // in another format is refused here, before the delegation, grants, recovery or any launch, and is left unchanged.
  let state: OpenState;
  try {
    state = openState(paths.stateDir);
  } catch (error) {
    if (!(error instanceof StateVersionRefused)) throw error;
    console.error(JSON.stringify({ event: 'refused', reason: error.code, found: error.found, required: error.required, detail: error.message }));
    process.exit(1);
  }

  let domains: Containment;
  try {
    domains = containment(state.installation);
  } catch (error) {
    console.error(JSON.stringify({ event: 'refused', reason: 'no_cgroup_delegation', detail: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }

  // Sandboxed workers run in bwrap (P2-4): without a bwrap that runs, the daemon refuses to start. Never a fallback.
  let bwrap: string;
  try {
    bwrap = (options.bwrap ?? locateBwrap)();
  } catch (error) {
    console.error(JSON.stringify({ event: 'refused', reason: 'bwrap_unavailable', detail: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }

  // One daemon per installation, held until the daemon exits (the kernel drops it then): a daemon on a copy of this
  // state shares its installation id and so its domain names, and is refused here, before its sweep could remove a
  // domain this daemon's journal records (P2-2). The hold is an abstract socket, which no file operation can remove
  // (PR #23 Grok delta 2). The shutdown below owns it and releases it last, after the state is closed.
  let installation: InstallationHold;
  try {
    installation = await holdInstallation(state.installation, options.installationPrefix);
  } catch (error) {
    if (!(error instanceof InstallationRefused)) throw error;
    console.error(JSON.stringify({ event: 'refused', reason: error.code, installation: state.installation, detail: error.message }));
    process.exit(1);
  }

  // Every request needs a bearer grant registered by the owner with the local `grant` command (src/grant.ts).
  const grants = new GrantStore(paths.stateDir);
  const supervisor = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir: paths.stateDir,
    containment: domains,
    ...productionHosts(bwrap),
    grants,
    // No sandbox root may contain or be inside the B2 socket's directory (the state directory is always protected).
    sandboxControls: [dirname(paths.socketPath)],
  });
  const helloSource = { supervisorId: state.supervisorId, supervisorEpoch: state.supervisorEpoch, piVersion: pinnedPiVersion(), cleanupProfile: domains.profile };
  // Each sandboxed parent's generation gets its own channel, with its own grant and the method whitelist (P2-8).
  supervisor.serveParentChannels(parentChannels({ ...helloSource, supervisor, grants }));
  // Recovery before the socket listens. It awaits the startup sweep (every domain of this installation the journal does
  // not account for is killed and removed; one not proven gone refuses the start, P2-2); then undispatched intents
  // become intent_recovered, dispatched ones outcome_unknown, and every worker that held a session is recorded
  // cleanup_pending, then its domain is killed and removed. No replay. A recorded domain this containment would not
  // clean refuses the start before the sweep (it could never be killed).
  try {
    await supervisor.recover();
  } catch (error) {
    if (!(error instanceof SweepUnproven) && !(error instanceof RecordedDomainRefused)) throw error;
    console.error(JSON.stringify({ event: 'refused', reason: error.code, domains: error.domains, detail: error.message }));
    process.exit(1);
  }
  const app = createApp({ ...helloSource, supervisor, grants });
  const server = createB2Server(app.handle);
  await listenPrivate(server, paths.socketPath, access);
  console.error(JSON.stringify({ event: 'listening', socket: paths.socketPath, pid: process.pid, installation: state.installation }));

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
      installation.release();
      process.exit(0);
    });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
