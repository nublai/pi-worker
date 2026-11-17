/**
 * Error mapping: every failure prints one JSON object on stderr naming its typed error, and the exit code says
 * whether anything may have happened.
 *
 * Exit codes: 0 done; 1 refused or failed with no effect; 2 usage (nothing sent); 3 effect unknown: read the receipt
 * of the printed `command_id` (`receipts.get`), never retry blindly.
 */
import { ClientFailure, ProtocolMismatch, ResyncRequired } from '@nublai/pi-worker-client';
import { UsageError } from './commands.js';

export const EXIT = { ok: 0, noEffect: 1, usage: 2, unknown: 3 } as const;

/** The local `grant` command failed; `code` is its refusal (`invalid_grant`, …) or the system error code. */
export class GrantCommandFailed extends Error {
  constructor(
    readonly code: string,
    readonly effect: 'no_effect' | 'unknown',
  ) {
    super(code);
  }
}

/** A mutation's receipt recorded a refusal or an unknown outcome; the receipt itself is already on stdout. */
export class ReceiptRefusal extends Error {
  constructor(
    readonly code: string,
    readonly effect: 'no_effect' | 'unknown',
    readonly state: string,
  ) {
    super(code);
  }
}

export interface Mapped {
  readonly body: Record<string, unknown>;
  readonly exitCode: number;
}

const TYPED_NAME = /^[a-z][a-z0-9_]*$/;

/** `context` adds what the caller needs to reconcile: the command id of a mutation, the attachment id of an upload. */
export function mapError(error: unknown, context: Record<string, string | undefined> = {}): Mapped {
  const extra = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
  const mapped = (body: Record<string, unknown>, effect: 'no_effect' | 'unknown', exitCode?: number): Mapped => ({
    body: { ...body, effect, ...extra },
    exitCode: exitCode ?? (effect === 'no_effect' ? EXIT.noEffect : EXIT.unknown),
  });
  if (error instanceof UsageError) return { body: { error: 'usage', effect: 'no_effect', detail: error.message }, exitCode: EXIT.usage };
  if (error instanceof ClientFailure) {
    if (error.phase === 'http') {
      const { error: _name, effect: _effect, ...details } = error.details;
      return mapped({ error: error.message, status: error.status, ...details }, error.effect);
    }
    const name = TYPED_NAME.test(error.message) ? error.message : error.phase === 'before_write' ? 'transport_before_write' : 'transport_after_write';
    return mapped({ error: name, ...(name === error.message ? {} : { detail: error.message }) }, error.effect);
  }
  if (error instanceof ProtocolMismatch) return mapped({ error: 'protocol_mismatch', detail: error.message }, 'no_effect');
  if (error instanceof ResyncRequired) return mapped({ error: 'resync_required', reason: error.reason }, 'no_effect');
  if (error instanceof GrantCommandFailed) return mapped({ error: error.code }, error.effect);
  if (error instanceof ReceiptRefusal) return mapped({ error: error.code, receipt_state: error.state }, error.effect);
  return mapped({ error: 'cli_failure', detail: error instanceof Error ? error.message : String(error) }, 'unknown');
}

/**
 * The typed failure of the daemon package's `grant` command from its stderr: a `Refusal` (`invalid_grant`, …) was
 * checked before anything was written, so it has no effect; anything else (a system error such as `EEXIST` on
 * `--out` after the registry record) may have left a record, so its effect is unknown.
 */
export function grantFailure(stderr: string, status: number | null): GrantCommandFailed {
  const refusal = /^Refusal \[Error\]: ([a-z][a-z0-9_]*)$/m.exec(stderr);
  if (refusal) return new GrantCommandFailed(refusal[1]!, 'no_effect');
  if (status === 2) return new GrantCommandFailed('grant_usage', 'no_effect');
  const code = /^\s*code: '([A-Z][A-Z0-9_]*)'/m.exec(stderr);
  return new GrantCommandFailed(code ? code[1]! : 'grant_command_failed', 'unknown');
}
