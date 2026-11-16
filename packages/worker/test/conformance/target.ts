/**
 * The seam the section 0.1 replay drives: a real supervisor behind its B2 socket over real fsynced state, plus
 * fixture-only controls over a deterministic host (never model effects). Ported from A0
 * `src/test/conformance.test.ts` (its fixture and host controls).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type components } from '@nublai/pi-worker-client';
import { createApp } from '../../src/b2/app.js';
import { createB2Server, listenPrivate } from '../../src/b2/server.js';
import { parseJournal } from '../../src/journal/journal.js';
import { fixture, tick, type Host } from '../supervisor-fixture.js';

export type Worker = components['schemas']['Worker'];

/** Fixture controls over the deterministic host of the initial worker (A0's `Host` test seam). */
export interface HostSeam {
  /** `host_reply drop`: the next prompt starts (`agent_start`) and its reply is lost. */
  dropNextPromptReply(): void;
  /** `host_reply hold`: the next prompt starts and its reply waits until `releaseHeldReply`. */
  holdNextPromptReply(): void;
  /** `drop_reply`: lose the held reply. */
  releaseHeldReply(): void;
  /** Resolves on the next native `agent_start`. */
  nextAgentStart(): Promise<void>;
  /** `host_event`: inject a native event; `exit` is the host lifecycle event. */
  emit(event: { type: string }): void;
  /** Let due supervisor queue items run to the next asynchronous barrier. */
  drain(): Promise<void>;
  /** Native prompt submissions, counted independently of receipts. */
  readonly prompts: number;
}

export interface Session {
  readonly client: Client;
  readonly initial: Worker;
  readonly host: HostSeam;
  /** A separate available cwd for child launches. */
  readonly childCwd: string;
  /** Native host launches, counted independently of receipts. */
  hosts(): number;
  /** The latest fsynced journal record of the worker. */
  disk(workerId: string): Worker;
  /** Discard the supervisor, recover its journal, new transport epoch; never adopt a host. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface TargetOptions {
  /** `unconfirmed_native_identity`: the host's process identity cannot be confirmed, so cleanup stays pending. */
  profile?: string;
}

export class TargetUnavailable extends Error {}

export const TODO = 'needs the rows prerequisites (plan section 5.1)';

function seam(host: Host): HostSeam {
  let rejectReply: (() => void) | undefined;
  return {
    dropNextPromptReply() {
      host.failure = true;
    },
    holdNextPromptReply() {
      const native = host.request.bind(host);
      let once = true;
      const gate = new Promise<never>((_r, reject) => {
        rejectReply = () => reject(new Error('fixture_dropped_reply'));
      });
      gate.catch(() => {});
      host.request = async c => {
        const reply = await native(c);
        if (c.type === 'prompt' && once) {
          once = false;
          await gate;
        }
        return reply;
      };
    },
    releaseHeldReply() {
      rejectReply!();
    },
    nextAgentStart() {
      return new Promise<void>(resolve => {
        const listener = (event: { type: string }) => {
          if (event.type !== 'agent_start') return;
          host.off('event', listener);
          resolve();
        };
        host.on('event', listener);
      });
    },
    emit(event) {
      if (event.type === 'exit') host.emit('exit');
      else host.emit('event', event);
    },
    async drain() {
      await tick();
      await tick();
    },
    get prompts() {
      return host.prompts;
    },
  };
}

export async function startTarget(options: TargetOptions): Promise<Session> {
  const f = fixture({ unconfirmedIdentity: options.profile === 'unconfirmed_native_identity' });
  const socketPath = join(f.dir, 'b2.sock');
  let server = createB2Server(createApp({ supervisor: f.supervisor }).handle);
  const close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  await listenPrivate(server, socketPath);
  const client = new Client({ socketPath });
  const initial = await f.create();
  const childCwd = join(f.dir, 'child-cwd');
  mkdirSync(childCwd);
  return {
    client,
    initial,
    host: seam(f.hosts[0]!),
    childCwd,
    hosts: () => f.hosts.length,
    disk(workerId) {
      const records = parseJournal(readFileSync(f.journalFile)).records;
      return (records.filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === workerId).at(-1)!.value as { worker: Worker }).worker;
    },
    async restart() {
      await close();
      await f.restart();
      server = createB2Server(createApp({ supervisor: f.supervisor }).handle);
      await listenPrivate(server, socketPath);
    },
    async close() {
      await close();
      f.cleanup();
    },
  };
}
