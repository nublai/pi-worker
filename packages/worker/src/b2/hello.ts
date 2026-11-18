/** `hello`: protocol, supervisor identity and the named limits (contract invariant 8). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { components } from '../generated/api.js';
import { jsonBodyLimit, routes } from '../generated/routes.js';
import { DEFAULT_RETENTION, type RetentionLimits } from '../journal/retention.js';
import { HISTORY_LINE_MAX_BYTES, HISTORY_MAX_BYTES } from '../history/session-file.js';
import { INVENTORY_PROBES_MAX } from '../supervisor/features.js';

export type Hello = components['schemas']['Hello'];

/** Protocol major 0 until the catalog freezes at P6; a client refuses an unknown major. */
export const PROTOCOL = { major: 0, minor: 1 } as const;

export const NAMED_LIMITS: readonly string[] = [
  'Private sockets and bearer grants do not isolate hostile code running as the same OS user, including project extensions.',
  'The worker cannot read the peer credentials of a Unix-socket client; its boundary is file modes plus the bearer grant.',
  'A journal on a bring-your-own machine dies with the machine.',
  'Receipts are retained within the advertised limits; an evicted receipt reads as receipt_expired (unknown) while its id is among the most recent receipt_expired_ids_max evicted ids. After that its command still never runs again: an id the worker may have forgotten (a UUIDv7 command_id not issued after the newest forgotten one, or any other id once one such was forgotten) is refused command_id_beyond_retention (no_effect), so callers mint UUIDv7 command ids.',
  'Linux results are not macOS results.',
  'Each worker runs in its own cgroup v2 cleanup domain, which is cleanup, not isolation: hostile code running as the same user can still signal or escape it, and work a tool hands to another daemon (tmux, systemd-run --user, Docker) leaves it.',
  'A sandboxed typed child (launch_spec filesystem bwrap) can write only its root, its cwd, and, when that root is a Git linked worktree, the worktree admin dir, its own branch namespace and the repository object store, which is shared: it can add or remove objects other checkouts of the repository use. Git pointers, HEAD, config, hooks and alternates stay read-only. It shares the network, and its environment allowlist (model API keys included) and any credential store staged read-only in its root are readable inside it. files.read reads only a sandboxed worker root, inside explicit roots, with no symlink, hidden or traversal component, UTF-8 and at most 1 MiB.',
];

function workerVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

/** Attachment limits per prompt (Shep's current photo limits); `sessions.prompt` enforces them from P1-16. */
export const ATTACHMENTS_PER_MESSAGE = 4;
export const ATTACHMENTS_TOTAL_BYTES = 8 * 1024 * 1024;

/** The retention limits as `hello` states them (P1-12). */
export function retentionLimits(r: RetentionLimits) {
  return {
    journal_max_bytes: r.journalBytes,
    journal_control_reserve_bytes: r.controlReserveBytes,
    ordinary_receipts_max: r.receipts,
    receipt_retention_min_seconds: Math.ceil(r.minAgeMs / 1000),
    receipt_expired_ids_max: r.expiredIds,
  };
}

/**
 * The limits a client reads in hello; the byte limits come from the spec through the generated route table, the
 * retention limits from the receipt store that enforces them (the defaults without one).
 */
export const LIMITS: Hello['limits'] = {
  request_body_bytes: jsonBodyLimit,
  attachment_max_bytes: routes['attachments.stage'].maxBodyBytes,
  attachments_per_message: ATTACHMENTS_PER_MESSAGE,
  attachments_total_bytes: ATTACHMENTS_TOTAL_BYTES,
  event_frame_bytes: routes['events.subscribe'].responses['200'].maxFrameBytes,
  ...retentionLimits(DEFAULT_RETENTION),
  history_max_bytes: HISTORY_MAX_BYTES,
  history_line_max_bytes: HISTORY_LINE_MAX_BYTES,
  blob_max_bytes: routes['blobs.read'].responses['200'].maxBytes,
  inventory_probes_max: INVENTORY_PROBES_MAX,
};

/**
 * What this worker does beyond the base catalog: byte-range JSONL history (S-1), the worker-owned interrupt marker
 * (S-5) and the command id stamped into pi's session file (contract 8.1).
 */
export const CAPABILITIES: readonly string[] = ['history.jsonl', 'interrupt_marker', 'command_stamp', 'image_attachments'];

export interface HelloSource {
  supervisorId?: string;
  supervisorEpoch?: string;
  piVersion?: string | null;
  /** The retention limits the receipt store enforces. */
  retention?: RetentionLimits;
  /** What the daemon's cleanup domains prove (`Containment.profile`), stated as a named limit. */
  cleanupProfile?: string;
}

/** main.ts passes the supervisor id persisted in the journal and the epoch of this start (journal/state.ts). */
export function createHello(source: HelloSource = {}): () => Hello {
  const hello: Hello = {
    protocol: { ...PROTOCOL },
    worker_version: workerVersion(),
    supervisor_id: source.supervisorId ?? randomUUID(),
    supervisor_epoch: source.supervisorEpoch ?? randomUUID(),
    pi_version: source.piVersion ?? null,
    capabilities: [...CAPABILITIES],
    limits: { ...LIMITS, ...(source.retention ? retentionLimits(source.retention) : {}) },
    named_limits: [...NAMED_LIMITS, ...(source.cleanupProfile ? [`Cleanup profile: ${source.cleanupProfile}.`] : [])],
  };
  return () => structuredClone(hello);
}
