/** `hello`: protocol, supervisor identity and the named limits (contract invariant 8). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { components } from '../generated/api.js';
import { REQUEST_BODY_LIMIT } from './router.js';

export type Hello = components['schemas']['Hello'];

/** Protocol major 0 until the catalog freezes at P6; a client refuses an unknown major. */
export const PROTOCOL = { major: 0, minor: 1 } as const;

export const NAMED_LIMITS: readonly string[] = [
  'Private sockets and bearer grants do not isolate hostile code running as the same OS user, including project extensions.',
  'The worker cannot read the peer credentials of a Unix-socket client; its boundary is file modes plus the bearer grant.',
  'A journal on a bring-your-own machine dies with the machine.',
  'Linux results are not macOS results.',
];

function workerVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export interface HelloSource {
  supervisorId?: string;
  supervisorEpoch?: string;
  piVersion?: string | null;
}

/** The supervisor id is per start in P0; P1 persists it in the state directory with the journal. */
export function createHello(source: HelloSource = {}): () => Hello {
  const hello: Hello = {
    protocol: { ...PROTOCOL },
    worker_version: workerVersion(),
    supervisor_id: source.supervisorId ?? randomUUID(),
    supervisor_epoch: source.supervisorEpoch ?? randomUUID(),
    pi_version: source.piVersion ?? null,
    capabilities: [],
    limits: { request_body_bytes: REQUEST_BODY_LIMIT },
    named_limits: [...NAMED_LIMITS],
  };
  return () => structuredClone(hello);
}
