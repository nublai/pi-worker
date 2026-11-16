/** B2 refusals. Every refusal says which kind it is (contract invariant 4). Ported from A0 `src/types.ts`. */
import type { components } from '../generated/api.js';

export type Effect = components['schemas']['Effect'];
export type ErrorBody = components['schemas']['Error'];
type Details = Omit<ErrorBody, 'error' | 'effect' | 'uncertain_command_id'>;

export class Refusal extends Error {
  constructor(
    message: string,
    readonly effect: Effect = 'no_effect',
    readonly uncertain_command_id?: string,
    readonly details: Details = {},
    /** HTTP status; defaults to 409 for `no_effect` and 500 for `unknown`. */
    readonly status: number = effect === 'unknown' ? 500 : 409,
  ) {
    super(message);
  }

  toBody(): ErrorBody {
    return {
      error: this.message,
      effect: this.effect,
      ...(this.uncertain_command_id ? { uncertain_command_id: this.uncertain_command_id } : {}),
      ...this.details,
    };
  }
}

/**
 * The only refusal that may report `no_effect` after the dispatch record. Throw it only with evidence that the
 * dispatched work changed nothing (for example, every created entry removed and verified absent by descriptor, or an
 * explicit negative acknowledgement from the host). Any other failure after dispatch is `outcome_unknown`.
 */
export class ProvenNoEffect extends Refusal {
  constructor(
    message: string,
    readonly evidence: string,
  ) {
    super(message, 'no_effect', undefined, { no_effect_evidence: evidence });
  }
}
