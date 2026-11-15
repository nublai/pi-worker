import type { components } from './api.generated.js';
export type Worker = components['schemas']['Worker'];
export type Receipt = components['schemas']['Receipt'];
export type Cursor = components['schemas']['Cursor'];
export type Snapshot = components['schemas']['Snapshot'];
export type WorkerEvent = components['schemas']['Event'];
export type HistoryCursor = components['schemas']['HistoryCursor'];
export type HistoryEntry = Record<string, unknown> & { id: string };
export type HistoryPage = components['schemas']['HistoryPage'];
export type Create = components['schemas']['Create'];
export type Prompt = components['schemas']['Prompt'];
export type Binding = components['schemas']['Binding'];
export type Hello = components['schemas']['Hello'];
export type Resolve = components['schemas']['Resolve'];
export type Rebind = components['schemas']['Rebind'];
export type FollowUp = components['schemas']['FollowUp'];
export type Control = components['schemas']['Control'];
export type ChildLaunch = components['schemas']['ChildLaunch'];
export type Report = components['schemas']['Report'];
export const SIZE_LIMITS = { rawLineBytes: 4 * 1024 * 1024, historyPageBytes: 256 * 1024 };
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export class Refusal extends Error {
  constructor(message: string, readonly effect: 'no_effect' | 'unknown' = 'no_effect', readonly uncertain_command_id?: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
/** The only refusal that may report `no_effect` after the dispatch record.
 * Throw it only with evidence that the dispatched work changed nothing (for
 * example, every created entry removed and verified absent by descriptor, or
 * an explicit negative acknowledgement from the host). Any other failure after
 * dispatch is outcome_unknown. */
export class ProvenNoEffect extends Refusal {
  constructor(message: string, readonly evidence: string) { super(message, 'no_effect', undefined, { no_effect_evidence: evidence }); }
}
