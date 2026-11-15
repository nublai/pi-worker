/** THROWAWAY. exmach ring.ts / thread.ts subscribe barrier, adapted to SSE.
 * Every attach resets from an authoritative snapshot; no historical event replay.
 */
import { randomUUID } from 'node:crypto';
import type { Cursor, Snapshot, Worker, WorkerEvent } from './types.js';
type Frame = Snapshot | WorkerEvent;
type Subscriber = { send: (frame: Frame) => void; attaching: boolean; queued: WorkerEvent[] };
export class EventHub {
  private seq = 0;
  private ring: WorkerEvent[] = [];
  private subscribers = new Set<Subscriber>();
  constructor(readonly epoch: string, readonly maxEvents = 512) {}
  publish(type: string, data: Record<string, unknown>, execution_id: string | null = null, producer: 'pi' | 'supervisor' = 'pi', durable = false): void {
    // Stub oversized payloads. The session file is the authoritative full history.
    const bytes = Buffer.byteLength(JSON.stringify(data));
    const event: WorkerEvent = { type, cursor: { worker_epoch: this.epoch, seq: ++this.seq }, event_id: randomUUID(), producer, execution_id, evidence: durable ? 'supervisor_journal_fsynced' : 'observed_memory', data: bytes > 16 * 1024 ? { stub: true, bytes } : data };
    this.ring.push(event);
    if (this.ring.length > this.maxEvents) this.ring.shift();
    for (const sub of this.subscribers) {
      if (sub.attaching) sub.queued.push(event); else sub.send(event);
    }
  }
  attach(state: () => Worker, since: Cursor | null, send: (frame: Frame) => void): () => void {
    // No await between state read, barrier capture and subscriber registration.
    const worker = structuredClone(state());
    const cursor = { worker_epoch: this.epoch, seq: this.seq };
    let resync_reason: Snapshot['resync_reason'] = 'fresh';
    if (since) resync_reason = since.worker_epoch !== this.epoch ? 'epoch' : since.seq > this.seq ? 'ahead' : since.seq < (this.ring[0]?.cursor.seq ?? this.seq + 1) - 1 ? 'evicted' : since.seq === this.seq ? 'current' : 'gap';
    const sub: Subscriber = { send, attaching: true, queued: [] };
    this.subscribers.add(sub);
    try {
      send({ type: 'snapshot', workers: [worker], worker, cursor, history: worker.history, resync_reason });
      // Reentrant sends (e.g. tests/embedded router) cannot overtake the snapshot.
      while (sub.queued.length) send(sub.queued.shift()!);
      sub.attaching = false;
    } catch (error) { this.subscribers.delete(sub); throw error; }
    return () => { this.subscribers.delete(sub); };
  }
}
