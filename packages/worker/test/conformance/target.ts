/**
 * The seam the section 0.1 replay drives: a real supervisor behind its B2 socket, plus fixture-only controls over a
 * deterministic host (never model effects). P1 implements it (supervisor P1-4 to P1-6, journal P1-1); until then
 * `startTarget` refuses and the rows run as `todo`.
 */
import type { Client, components } from '@nublai/pi-worker-client';

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

export const TODO = 'P1: needs the supervisor, journal and fake host (P1-1, P1-4 to P1-6)';

export async function startTarget(_options: TargetOptions): Promise<Session> {
  throw new TargetUnavailable(TODO);
}
