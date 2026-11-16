/** Loads the frozen section 0.1 fixture (api/fixtures/transitions.json) and its semantic hash. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers.js';

export type Step = {
  kind?: string;
  macro?: string;
  method?: string;
  command_id?: string;
  binding?: string;
  fields?: Record<string, unknown>;
  mode?: string;
  event?: { type: string };
};
export type Row = {
  id: string;
  from: string;
  event: string;
  to: string;
  profile?: string;
  coverage?: string;
  steps: Step[];
  expect: { path: string; equals: unknown }[];
};
export type Transitions = { contract_revision: number; macros: Record<string, Step[]>; rows: Row[] };

export const transitions = JSON.parse(readFileSync(join(repoRoot, 'api', 'fixtures', 'transitions.json'), 'utf8')) as Transitions;

/** Sorted-key JSON, so the hash does not depend on key order or whitespace. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The frozen fields of each row: id, from, event, to and the assertions. Step bodies are wire data and may migrate
 * with the catalog in a PR that changes no assertion; they are not hashed.
 */
export function semanticHash(rows: readonly Row[]): string {
  const frozen = rows.map(r => ({ id: r.id, from: r.from, event: r.event, to: r.to, expect: r.expect }));
  return createHash('sha256').update(canonical(frozen)).digest('hex');
}

export const expand = (steps: readonly Step[]): Step[] => steps.flatMap(s => (s.macro ? expand(transitions.macros[s.macro]!) : [s]));

export const get = (object: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), object);

/** Replaces strings that start with `@` by the value at that dot-path in the context, recursively. */
export function substitute(value: unknown, context: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('@')) return get(context, value.slice(1));
  if (Array.isArray(value)) return value.map(v => substitute(v, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, context)]));
  return value;
}
