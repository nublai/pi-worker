/**
 * One supervisor-wide event stream. Rewritten from A0 `src/events.ts` around the generated event manifest.
 *
 * - Attach is a synchronous barrier: the worker rows are read, the cursor captured and the subscriber added in one
 *   turn, then the snapshot is sent first. Later events only; there is no replay of missed events: a reconnect gets
 *   a fresh snapshot whose `resync_reason` says why (`fresh`, `current`, `gap`, `epoch`, `ahead`, `overflow`).
 * - Each subscriber has a bounded queue (64 events or 256 KiB) that fills only while its transport is backpressured.
 *   Past that bound the subscriber gets one `overflow` frame and is closed; the caller must resync from a snapshot.
 * - Every frame is validated against its event schema before it is queued (the generated publishers for worker
 *   events, `validateEventFrame` for snapshot and overflow). A frame that fails is never sent: every subscriber that
 *   would have received it gets `overflow` and is closed, and the hub logs `invalid_frame`. A frame whose SSE record
 *   would exceed the spec's frame cap is treated the same way.
 * - Publishing never throws into the supervisor: an event problem costs subscribers a resync, never a worker.
 * - `assistant.delta` carries the whole text tail, so a queued one is superseded by the next delta of the same worker:
 *   a backpressured subscriber holds at most one undelivered delta per worker, and a delta storm cannot overflow it.
 */
import { randomUUID } from 'node:crypto';
import { routes } from '../generated/routes.js';
import { createPublishers, validateEventFrame, type Cursor, type EventFrame, type EventOf, type PublishInput, type WorkerEventType } from '../generated/events.js';
import type { components } from '../generated/api.js';

export type Worker = components['schemas']['Worker'];
export type Snapshot = EventOf<'snapshot'>;
export type ResyncReason = Snapshot['resync_reason'];

export const QUEUE_EVENTS = 64;
export const QUEUE_BYTES = 256 * 1024;
/** The spec's x-piw-max-frame-bytes for events.subscribe: the most bytes one SSE record may carry. */
export const FRAME_BYTES = routes['events.subscribe'].responses['200'].maxFrameBytes;

/** One SSE record: the cursor as its id, the type as its event name, the frame as one JSON data line. */
export function sseRecord(frame: EventFrame): string {
  return `id: ${JSON.stringify(frame.cursor)}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** Returns false when the transport is backpressured; the hub queues until `drain`. */
export type Send = (frame: EventFrame) => boolean | void;

export interface SubscribeOptions {
  readonly workerIds?: readonly string[];
  readonly types?: readonly string[];
  /** The caller's grant may see this worker (P1-9). Events without a visible worker are not delivered. */
  readonly acceptWorker?: (workerId: string) => boolean;
  /** Rechecked before every frame (P1-9 grant revocation); a throw closes the subscription without a frame. */
  readonly recheck?: () => void;
  readonly since?: Cursor | null;
  readonly overflowResync?: boolean;
  /** Called once when the hub ends the subscription (overflow, invalid frame, failed recheck). */
  readonly onEnd?: (reason: string) => void;
}

export interface Subscription {
  close(): void;
  /** The transport drained: send what was queued. */
  drain(): void;
}

interface Subscriber {
  readonly send: Send;
  readonly options: SubscribeOptions;
  queued: { frame: EventFrame; bytes: number }[];
  bytes: number;
  blocked: boolean;
  attaching: boolean;
  closed: boolean;
}

export type HubLog = (record: Record<string, unknown>) => void;
const stderrLog: HubLog = record => process.stderr.write(`${JSON.stringify(record)}\n`);

export class EventHub {
  private seq = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly publishers;

  constructor(
    /** The transport epoch: new on every supervisor start (the supervisor epoch). */
    readonly epoch: string,
    readonly maxQueued = QUEUE_EVENTS,
    readonly maxBytes = QUEUE_BYTES,
    readonly log: HubLog = stderrLog,
  ) {
    this.publishers = createPublishers({
      stamp: () => ({ cursor: this.cursor(++this.seq), event_id: randomUUID() }),
      deliver: frame => this.fanout(frame),
    });
  }

  private cursor(seq = this.seq): Cursor {
    return { transport_epoch: this.epoch, seq };
  }

  get size(): number {
    return this.subscribers.size;
  }

  /** Publishes one worker event through its generated (validating) publisher. Never throws. */
  publish<T extends WorkerEventType>(type: T, input: PublishInput<T>): void {
    try {
      // SAFETY: `type` selects the publisher whose input type is PublishInput<T>.
      (this.publishers[type] as (input: PublishInput<T>) => void)(input);
    } catch (error) {
      this.log({ event: 'invalid_frame', type, reason: error instanceof Error ? error.message.slice(0, 256) : 'publish_failed' });
      for (const sub of this.subscribers) if (this.wants(sub, type, input.worker_id)) this.overflow(sub, 'invalid_frame');
    }
  }

  private wants(sub: Subscriber, type: string, workerId: string | undefined): boolean {
    const o = sub.options;
    if (o.workerIds && (!workerId || !o.workerIds.includes(workerId))) return false;
    if (o.acceptWorker && (!workerId || !o.acceptWorker(workerId))) return false;
    if (o.types && !o.types.includes(type)) return false;
    return true;
  }

  private fanout(frame: EventFrame): void {
    const workerId = 'worker_id' in frame ? frame.worker_id : undefined;
    const bytes = Buffer.byteLength(sseRecord(frame));
    for (const sub of this.subscribers) {
      if (sub.closed || !this.wants(sub, frame.type, workerId)) continue;
      if (bytes > FRAME_BYTES) {
        this.log({ event: 'invalid_frame', type: frame.type, reason: 'frame_too_large' });
        this.overflow(sub, 'invalid_frame');
        continue;
      }
      if (sub.attaching || sub.blocked) {
        if (frame.type === 'assistant.delta') this.supersede(sub, workerId);
        if (sub.queued.length >= this.maxQueued || sub.bytes + bytes > this.maxBytes) {
          this.overflow(sub, 'subscriber_queue_overflow');
          continue;
        }
        sub.queued.push({ frame, bytes });
        sub.bytes += bytes;
      } else this.deliver(sub, frame);
    }
  }

  /** Drops the subscriber's undelivered `assistant.delta` of this worker: the newer one replaces its tail. */
  private supersede(sub: Subscriber, workerId: string | undefined): void {
    const i = sub.queued.findIndex(q => q.frame.type === 'assistant.delta' && q.frame.worker_id === workerId);
    if (i < 0) return;
    sub.bytes -= sub.queued[i]!.bytes;
    sub.queued.splice(i, 1);
  }

  /** Sends one frame after the subscriber's recheck; a failed recheck ends the subscription with no frame. */
  private deliver(sub: Subscriber, frame: EventFrame): void {
    try {
      sub.options.recheck?.();
    } catch {
      this.end(sub, 'recheck_failed');
      return;
    }
    sub.blocked = sub.send(frame) === false;
  }

  private end(sub: Subscriber, reason: string): void {
    if (sub.closed) return;
    sub.closed = true;
    sub.queued = [];
    sub.bytes = 0;
    this.subscribers.delete(sub);
    sub.options.onEnd?.(reason);
  }

  /** The subscriber missed or would miss an event: one `overflow` frame, then the subscription ends. */
  private overflow(sub: Subscriber, reason: string): void {
    if (sub.closed) return;
    const frame: EventFrame = {
      type: 'overflow',
      cursor: this.cursor(),
      event_id: randomUUID(),
      producer: 'supervisor',
      execution_id: null,
      evidence: 'observed_memory',
      data: { resync_required: true, reason },
    };
    sub.closed = true;
    this.subscribers.delete(sub);
    sub.queued = [];
    sub.bytes = 0;
    // The overflow frame is sent even to a backpressured transport (it buffers one bounded record); then the stream ends.
    if (validateEventFrame(frame)) sub.send(frame);
    sub.options.onEnd?.(reason);
  }

  /**
   * Attaches a subscriber at a synchronous barrier: `state()` runs first (it may publish derived changes, which land
   * before the barrier), then the cursor is captured, the subscriber added and the snapshot sent, then anything
   * queued meanwhile. No event before the barrier is ever delivered, and none after it is missed.
   */
  subscribe(state: () => Worker[], send: Send, options: SubscribeOptions = {}): Subscription {
    const sub: Subscriber = { send, options, queued: [], bytes: 0, blocked: false, attaching: true, closed: false };
    const close = () => this.end(sub, 'closed');
    const drain = () => {
      sub.blocked = false;
      while (!sub.closed && !sub.blocked && sub.queued.length) {
        const next = sub.queued.shift()!;
        sub.bytes -= next.bytes;
        this.deliver(sub, next.frame);
      }
    };
    const workers = structuredClone(state().filter(w => (!options.workerIds || options.workerIds.includes(w.worker_id)) && (!options.acceptWorker || options.acceptWorker(w.worker_id))));
    const cursor = this.cursor();
    const since = options.since ?? null;
    const resync_reason: ResyncReason = options.overflowResync
      ? 'overflow'
      : !since
        ? 'fresh'
        : since.transport_epoch !== this.epoch
          ? 'epoch'
          : since.seq > this.seq
            ? 'ahead'
            : since.seq === this.seq
              ? 'current'
              : 'gap';
    this.subscribers.add(sub);
    const snapshot: Snapshot = { type: 'snapshot', workers, cursor, resync_reason };
    if (!validateEventFrame(snapshot) || Buffer.byteLength(sseRecord(snapshot)) > FRAME_BYTES) {
      this.log({ event: 'invalid_frame', type: 'snapshot', reason: validateEventFrame.errors?.[0]?.message ?? 'frame_too_large' });
      this.overflow(sub, 'invalid_frame');
      return { close, drain };
    }
    try {
      this.deliver(sub, snapshot);
      if (sub.closed) return { close, drain };
      sub.attaching = false;
      if (!sub.blocked) drain();
    } catch (error) {
      close();
      throw error;
    }
    return { close, drain };
  }
}
