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
export const SIZE_LIMITS = { rawLineBytes: 4 * 1024 * 1024, historyPageBytes: 256 * 1024 };
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export class Refusal extends Error {
  constructor(message: string, readonly effect: 'no_effect' | 'unknown' = 'no_effect', readonly uncertain_command_id?: string) { super(message); }
}
