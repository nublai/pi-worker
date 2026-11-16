/**
 * Opens the supervisor's state: an exclusive lock on the state directory, then the journal, then one durable
 * `supervisor` start record. The supervisor id persists across starts (it is the first start's id); the epoch is new
 * on every start. A second supervisor on the same state directory is refused before it reads the journal.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock, type FileLock } from '../lock.js';
import { Journal, DEFAULT_JOURNAL_BYTES } from './journal.js';

export interface SupervisorState {
  readonly journal: Journal;
  readonly supervisorId: string;
  readonly supervisorEpoch: string;
  /** Closes the journal, then releases the lock. */
  close(): void;
}

export const journalPath = (stateDir: string) => join(stateDir, 'journal.jsonl');

export function openState(stateDir: string, options: { maxBytes?: number } = {}): SupervisorState {
  const lock: FileLock = acquireLock(join(stateDir, 'journal.lock'));
  let journal: Journal;
  try {
    journal = new Journal(journalPath(stateDir), options.maxBytes ?? DEFAULT_JOURNAL_BYTES);
  } catch (error) {
    lock.release();
    throw error;
  }
  try {
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
