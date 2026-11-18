/**
 * The parent channel (P2-8), ported from A0 `src/supervisor.ts` (`hostContext`, `closeChannel`) and `src/grants.ts`
 * (`channel`). A sandboxed root worker (a parent) cannot reach the B2 socket or read a grant; each of its generations
 * gets its own channel instead:
 *
 * - **Per-generation socket.** A fresh 0700 directory `$STATE/ch/<random>` holding one 0600 socket, made when the
 *   generation launches (create or relaunch, after the dispatch record, before the spawn) and bound read-only into
 *   that generation's sandbox at `/run/piw-parent` (sandbox.ts). It closes, with every connection on it, when the
 *   generation's domain cleanup starts (stop, exit, fault, failed launch, shutdown); a restart removes every channel
 *   directory a killed supervisor left.
 * - **Its own grant.** A grant registered for that generation (`channel-<epoch>`), scoped to the parent worker and its
 *   root, never the owner's: requests on the channel run as it (the Authorization header is ignored, so no bearer
 *   exists in the sandbox), and the children it creates record it as their creating grant. Its methods are the
 *   channel's method whitelist plus the parent spec's grant methods (a ceiling for its children's), within the
 *   methods of the grant that created the parent. The bearer is never written anywhere.
 * - **Method whitelist** (b2/channel.ts): only `CHANNEL_METHODS` are served; everything else is refused
 *   `parent_channel_method_denied` before parameters or body are read.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { Refusal } from '../b2/errors.js';
import type { RequestHandler } from '../b2/router.js';
import { createB2Server } from '../b2/server.js';
import { CHANNEL_SOCKET_NAME } from '../sandbox/sandbox.js';
import type { Live, SupervisorState } from './state.js';

/**
 * What a parent may call on its channel (A0's list): its own and its children's rows, launches, prompts and stops, and
 * the interrupt of a child's turn (`executions.interrupt`, its own children only: b2/channel.ts `channelInterruptTarget`).
 */
export const CHANNEL_METHODS: readonly string[] = ['hello', 'workers.list', 'workers.get', 'workers.create', 'workers.stop', 'executions.interrupt', 'sessions.prompt', 'events.subscribe', 'history.page', 'receipts.get'];

/** The generation a channel serves: the parent, its epoch, its own grant and its root. */
export interface ChannelIdentity {
  readonly workerId: string;
  readonly epoch: string;
  readonly grantId: string;
  readonly root: string;
}

/** Builds the B2 request handler of one channel (b2/channel.ts `parentChannels`). */
export type ChannelFactory = (identity: ChannelIdentity) => RequestHandler;

/** A channel being served: its server, its directory (bound into the sandbox) and its grant. */
export interface Channel {
  readonly server: Server;
  readonly dir: string;
  readonly grantId: string;
  /** Rechecks every open event stream (the hub's `recheck`): this channel's end with `parent_channel_retired`. */
  readonly retire: () => void;
}

/** The directory below the state directory that holds every channel directory. */
export const channelsDir = (stateDir: string): string => join(stateDir, 'ch');

/** A Unix socket path holds at most 107 bytes. */
const SOCKET_PATH_MAX = 107;
/** `/ch/<16 hex>/sock`. */
const channelPathBytes = (stateDir: string): number => Buffer.byteLength(join(channelsDir(stateDir), 'x'.repeat(16), CHANNEL_SOCKET_NAME));

/** A sandboxed root worker needs a channel: refused before any record when none is served or its socket path cannot exist. */
export function channelAvailable(s: SupervisorState): void {
  if (!s.channels || !s.grants) throw new Refusal('sandboxed_parent_requires_parent_channel');
  if (channelPathBytes(s.stateDir) > SOCKET_PATH_MAX) throw new Refusal('parent_channel_socket_path_too_long');
}

/** An owned, non-link 0700 directory, made when missing. */
function privateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('channel directory must be an owned, non-symlink 0700 directory');
}

/**
 * Opens the channel of `live`'s current generation (a sandboxed root worker): registers its grant, makes its directory
 * and listens on its socket. Any channel it still had is closed first.
 */
export async function openChannel(s: SupervisorState, live: Live): Promise<Channel> {
  closeChannel(live);
  channelAvailable(s);
  const grants = s.grants!;
  const w = live.worker;
  // Within the creating grant's methods; a worker created outside B2 has no creating grant.
  const source = w.grant_source_id ? grants.read(w.grant_source_id).methods : ['*'];
  const wanted = [...new Set([...CHANNEL_METHODS, ...(w.launch_spec?.grant_methods ?? [])])].filter(m => source.includes('*') || source.includes(m));
  const { grant } = grants.register({
    caller: `parent-channel:${w.worker_id}`,
    scope: { worker_ids: [w.worker_id], cwd_roots: [w.cwd] },
    methods: wanted.length ? wanted : ['hello'],
    grant_id: `channel-${w.worker_epoch}`,
  });
  privateDir(channelsDir(s.stateDir));
  const dir = join(channelsDir(s.stateDir), randomBytes(8).toString('hex'));
  mkdirSync(dir, { mode: 0o700 });
  const server = createB2Server(s.channels!({ workerId: w.worker_id, epoch: w.worker_epoch, grantId: grant.grant_id, root: w.cwd }));
  const socket = join(dir, CHANNEL_SOCKET_NAME);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(socket, 0o600);
  } catch (error) {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  live.channel = { server, dir, grantId: grant.grant_id, retire: () => s.events.recheck() };
  return live.channel;
}

/**
 * Closes a generation's channel: its open event streams end with `parent_channel_retired` (the channel is no longer
 * served), then no new connection, every open one dropped, its directory removed. Never throws.
 */
export function closeChannel(live: Live): void {
  const channel = live.channel;
  if (!channel) return;
  live.channel = undefined;
  try {
    channel.retire();
  } catch {
    /* the hub never throws; the connections are dropped below either way */
  }
  try {
    channel.server.closeAllConnections();
    channel.server.close(() => rmSync(channel.dir, { recursive: true, force: true }));
  } catch {
    rmSync(channel.dir, { recursive: true, force: true });
  }
}

/** After a restart no channel is served: every channel directory a killed supervisor left is removed. */
export function sweepChannels(stateDir: string): void {
  rmSync(channelsDir(stateDir), { recursive: true, force: true });
}
