/** THROWAWAY. One supervisor stream; every attach snapshots at a synchronous barrier.
 * No historical replay or dead event ring. Each subscriber has a bounded queue.
 */
import { randomUUID } from 'node:crypto';
import type { Cursor, Snapshot, Worker, WorkerEvent } from './types.js';
export type Frame = Snapshot | WorkerEvent;
type Options = { workerIds?: string[]; types?: string[]; overflowResync?: boolean; onOverflow?: () => void };
type Subscriber = { send: (frame: Frame) => unknown; queued: WorkerEvent[]; bytes: number; blocked: boolean; attaching: boolean; closed: boolean; options: Options };
export class EventHub {
  private seq = 0;
  private subscribers = new Set<Subscriber>();
  constructor(readonly epoch: string, readonly maxQueued = 64, readonly maxBytes = 256 * 1024) {}
  scoped(workerId: string): EventScope { return new EventScope(this, workerId); }
  publish(type: string, data: Record<string, unknown>, execution_id: string | null = null, producer: 'pi' | 'supervisor' = 'pi', durable = false, worker_id?: string): void {
    const bytes = Buffer.byteLength(JSON.stringify(data));
    const event: WorkerEvent = { type, cursor: { worker_epoch: this.epoch, seq: ++this.seq }, event_id: randomUUID(), producer, execution_id, ...(worker_id ? { worker_id } : {}), evidence: durable ? 'supervisor_journal_fsynced' : 'observed_memory', data: bytes > 16 * 1024 ? { stub: true, bytes } : data };
    for (const sub of this.subscribers) {
      if (sub.options.workerIds && (!worker_id || !sub.options.workerIds.includes(worker_id))) continue;
      if (sub.options.types && !sub.options.types.includes(type)) continue;
      if (sub.attaching || sub.blocked) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (sub.queued.length >= this.maxQueued || sub.bytes + size > this.maxBytes) { this.overflow(sub); continue; }
        sub.queued.push(event); sub.bytes += size;
      } else sub.blocked = sub.send(event) === false;
    }
  }
  private overflow(sub: Subscriber): void {
    if (sub.closed) return;
    sub.closed = true; this.subscribers.delete(sub); sub.queued = []; sub.bytes = 0;
    sub.send({ type: 'overflow', cursor: { worker_epoch: this.epoch, seq: this.seq }, event_id: randomUUID(), execution_id: null, producer: 'supervisor', evidence: 'observed_memory', data: { resync_required: true, reason: 'subscriber_queue_overflow' } });
    sub.options.onOverflow?.();
  }
  subscribe(state: () => Worker[], since: Cursor | null, send: Subscriber['send'], options: Options = {}): { close: () => void; drain: () => void } {
    // State read may publish derived changes, all before this barrier is captured.
    const workers = structuredClone(state().filter(w => !options.workerIds || options.workerIds.includes(w.worker_id)));
    const cursor = { worker_epoch: this.epoch, seq: this.seq };
    const resync_reason: Snapshot['resync_reason'] = options.overflowResync ? 'overflow' : !since ? 'fresh' : since.worker_epoch !== this.epoch ? 'epoch' : since.seq > this.seq ? 'ahead' : since.seq === this.seq ? 'current' : 'gap';
    const sub: Subscriber = { send, attaching: true, queued: [], bytes: 0, blocked: false, closed: false, options };
    const close = () => { sub.closed = true; sub.queued = []; sub.bytes = 0; this.subscribers.delete(sub); };
    const drain = () => {
      sub.blocked = false;
      while (!sub.closed && !sub.blocked && sub.queued.length) {
        const event = sub.queued.shift()!; sub.bytes -= Buffer.byteLength(JSON.stringify(event));
        sub.blocked = send(event) === false;
      }
    };
    this.subscribers.add(sub);
    try {
      const worker = workers.length === 1 ? workers[0]! : undefined;
      sub.blocked = send({ type: 'snapshot', workers, ...(worker ? { worker, history: worker.history } : {}), cursor, resync_reason }) === false;
      sub.attaching = false;
      if (!sub.blocked) drain();
    } catch (error) { close(); throw error; }
    return { close, drain };
  }
  /** Embedded single-worker convenience; still the same supervisor stream. */
  attach(state: () => Worker, since: Cursor | null, send: Subscriber['send']): () => void {
    return this.subscribe(() => [state()], since, send).close;
  }
}
export class EventScope {
  constructor(readonly root: EventHub, readonly workerId: string) {}
  publish(type: string, data: Record<string, unknown>, execution: string | null = null, producer: 'pi' | 'supervisor' = 'pi', durable = false): void { this.root.publish(type, data, execution, producer, durable, this.workerId); }
  attach(state: () => Worker, since: Cursor | null, send: Subscriber['send']): () => void { return this.root.subscribe(() => [state()], since, send, { workerIds: [this.workerId] }).close; }
}
