/**
 * Opens the supervisor's state: an exclusive lock on the state directory, then the journal, then one durable
 * `supervisor` start record. The supervisor id persists across starts (it is the first start's id); the epoch is new
 * on every start. A second supervisor on the same state directory is refused before it reads the journal. A journal
 * past half its bound is compacted before anything is appended (journal/retention.ts), so recovery has room to write.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock, type FileLock } from '../lock.js';
import { Journal } from './journal.js';
import { DEFAULT_RETENTION, goalFor, planCompaction, type RetentionLimits } from './retention.js';

export interface SupervisorState {
  readonly journal: Journal;
  readonly supervisorId: string;
  readonly supervisorEpoch: string;
  /** Closes the journal, then releases the lock. */
  close(): void;
}

export const journalPath = (stateDir: string) => join(stateDir, 'journal.jsonl');

export interface StateOptions {
  /** The journal's byte bound (the retention default otherwise). */
  maxBytes?: number;
  /** The receipt retention the ReceiptStore over this journal enforces; an open-time compaction uses the same. */
  retention?: Partial<Omit<RetentionLimits, 'journalBytes'>>;
  now?: () => number;
}

export function openState(stateDir: string, options: StateOptions = {}): SupervisorState {
  const lock: FileLock = acquireLock(join(stateDir, 'journal.lock'));
  let journal: Journal;
  try {
    journal = new Journal(journalPath(stateDir), options.maxBytes ?? DEFAULT_RETENTION.journalBytes);
  } catch (error) {
    lock.release();
    throw error;
  }
  try {
    if (journal.size() >= journal.maxBytes / 2) {
      const limits: RetentionLimits = { ...DEFAULT_RETENTION, ...options.retention, journalBytes: journal.maxBytes };
      try {
        journal.compact(planCompaction(journal.records, { limits, goal: goalFor(limits), now: (options.now ?? Date.now)(), inFlight: new Set() }).entries);
      } catch (error) {
        // A compaction that failed before its rename left the journal whole: start on it. After the rename it is failed.
        if (journal.failed) throw error;
      }
    }
    const first = journal.records.find(r => r.kind === 'supervisor')?.value.supervisor_id;
    const supervisorId = typeof first === 'string' ? first : randomUUID();
    const supervisorEpoch = randomUUID();
    journal.append('supervisor', { supervisor_id: supervisorId, supervisor_epoch: supervisorEpoch, started_at: new Date().toISOString() }, 'supervisor.start');
    return {
      journal,
      supervisorId,
      supervisorEpoch,
      close() {
        journal.close();
        lock.release();
      },
    };
  } catch (error) {
    journal.close();
    lock.release();
    throw error;
  }
}
