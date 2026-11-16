/** `hello`: protocol, supervisor identity and the named limits (contract invariant 8). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { components } from '../generated/api.js';
import { jsonBodyLimit, routes } from '../generated/routes.js';

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

/** Attachment limits per prompt (Shep's current photo limits); `sessions.prompt` enforces them from P1-16. */
export const ATTACHMENTS_PER_MESSAGE = 4;
export const ATTACHMENTS_TOTAL_BYTES = 8 * 1024 * 1024;

/** The limits a client reads in hello; the byte limits come from the spec through the generated route table. */
export const LIMITS: Hello['limits'] = {
  request_body_bytes: jsonBodyLimit,
  attachment_max_bytes: routes['attachments.stage'].maxBodyBytes,
  attachments_per_message: ATTACHMENTS_PER_MESSAGE,
  attachments_total_bytes: ATTACHMENTS_TOTAL_BYTES,
  event_frame_bytes: routes['events.subscribe'].responses['200'].maxFrameBytes,
};

export interface HelloSource {
  supervisorId?: string;
  supervisorEpoch?: string;
  piVersion?: string | null;
}

/** main.ts passes the supervisor id persisted in the journal and the epoch of this start (journal/state.ts). */
export function createHello(source: HelloSource = {}): () => Hello {
  const hello: Hello = {
    protocol: { ...PROTOCOL },
    worker_version: workerVersion(),
    supervisor_id: source.supervisorId ?? randomUUID(),
    supervisor_epoch: source.supervisorEpoch ?? randomUUID(),
    pi_version: source.piVersion ?? null,
    capabilities: [],
    limits: { ...LIMITS },
    named_limits: [...NAMED_LIMITS],
  };
  return () => structuredClone(hello);
}
