/**
 * Opens the supervisor's state: an exclusive lock on the state directory, then the journal, then one durable
 * `supervisor` start record. The supervisor id and the installation id persist across starts (they are the first
 * start's); the epoch is new on every start. A second supervisor on the same state directory is refused before it reads the journal. A journal
 * past half its bound is compacted before anything is appended (journal/retention.ts), so recovery has room to write.
 *
 * State format: every start record carries the format it was written in, and a state directory written in any other
 * format is refused before anything is repaired, compacted, appended, recovered or launched: the format is read from
 * the journal's bytes before the journal is opened, because opening it truncates a torn final record and removes a
 * cut compaction's `.compact` copy (GPT PR #21 delta finding 3). There is no migration and no
 * compatibility (nubl decisions 2026-11-17): a P1 state's terminal rows claim cleanup a process-group kill could not
 * prove, and no later evidence can make them safe to release. A P2-1 state names cleanup domains `w-<epoch>`, which
 * this version's cleanup does not accept (P2-2 PR #23 reviews): opened, its recorded domains would never be killed.
 *
 * Installation (P2-2): the installation id is random, made when the state is created and recorded in every start
 * record, so it moves with the state directory (a renamed or remounted state keeps its cleanup domains) and a new
 * state at the same path is another installation (it can never select the domains of a supervisor still running on
 * the state that was there). It names every cleanup domain (containment/containment.ts).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, type FileLock } from '../lock.js';
import { Journal, parseJournal, type JournalRecord } from './journal.js';
import { DEFAULT_RETENTION, goalFor, planCompaction, type RetentionLimits } from './retention.js';

export interface SupervisorState {
  readonly journal: Journal;
  readonly supervisorId: string;
  readonly supervisorEpoch: string;
  /** This installation's id: random, made when the state was created, recorded in every start record. */
  readonly installation: string;
  /** Closes the journal, then releases the lock. */
  close(): void;
}

export const journalPath = (stateDir: string) => join(stateDir, 'journal.jsonl');

/**
 * The state format this supervisor writes, and the only one it opens. 1: P1 (start records carry no version; cleanup
 * was a process-group kill). 2: P2-1 (per-epoch cgroup v2 cleanup domains named `w-<epoch>`). 3: P2-2 (a recorded
 * random installation id; domains named `w-<installation>-<epoch>`).
 */
export const STATE_VERSION = 3;

/** An installation id: 80 random bits, lowercase hex. */
export const INSTALLATION_ID = /^[0-9a-f]{20}$/;

/** A state directory written in another format: startup fails, naming both versions; nothing in it was changed. */
export class StateVersionRefused extends Error {
  readonly code: 'state_from_older_version' | 'state_from_newer_version';

  constructor(
    readonly found: number,
    readonly required: number,
  ) {
    const code = found < required ? 'state_from_older_version' : 'state_from_newer_version';
    super(`${code}: the state directory was written in state format ${found}; this supervisor opens only format ${required} and never migrates`);
    this.code = code;
  }
}

/** The format a journal's records were written in: its first start record's, 1 when that carries none. */
function stateVersion(records: readonly JournalRecord[]): number | null {
  if (records.length === 0) return null;
  const version = records.find(r => r.kind === 'supervisor')?.value.state_version;
  return typeof version === 'number' && Number.isInteger(version) ? version : 1;
}

/**
 * Refuses a journal written in another format, reading only: no byte of the state directory is written, truncated or
 * removed. A torn final record is ignored here as the journal's parse ignores it; a missing journal is a new state.
 */
function refuseOtherFormat(file: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const found = stateVersion(parseJournal(bytes).records);
  if (found !== null && found !== STATE_VERSION) throw new StateVersionRefused(found, STATE_VERSION);
}

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
    // Under the lock and before the journal opens (which repairs a torn tail and removes `.compact`): a refused state
    // is left byte for byte as it was.
    refuseOtherFormat(journalPath(stateDir));
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
    const first = journal.records.find(r => r.kind === 'supervisor')?.value;
    const supervisorId = typeof first?.supervisor_id === 'string' ? first.supervisor_id : randomUUID();
    // A new state gets a new installation; a state in this format always recorded one, so a missing or malformed id
    // is a damaged state, never a reason to start as another installation.
    const installation = first === undefined ? randomBytes(10).toString('hex') : first.installation_id;
    if (typeof installation !== 'string' || !INSTALLATION_ID.test(installation)) throw new Error('the state directory records no valid installation id');
    const supervisorEpoch = randomUUID();
    journal.append('supervisor', { supervisor_id: supervisorId, supervisor_epoch: supervisorEpoch, installation_id: installation, state_version: STATE_VERSION, started_at: new Date().toISOString() }, 'supervisor.start');
    return {
      journal,
      supervisorId,
      supervisorEpoch,
      installation,
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
