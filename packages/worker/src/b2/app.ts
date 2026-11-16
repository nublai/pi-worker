/**
 * Wires the generated route table to the handlers this build serves; operations the spec marks unsupported answer
 * 501. Without state (an embedded router in tests), a served operation that needs the supervisor's state refuses
 * `409 supervisor_state_unavailable`, `no_effect`.
 */
import { Refusal } from './errors.js';
import { createHello, type HelloSource } from './hello.js';
import { createRouter, type RequestHandler } from './router.js';
import type { Handlers } from './types.js';
import type { ReceiptStore } from '../receipts/receipts.js';
import type { Supervisor } from '../supervisor/supervisor.js';

export interface AppOptions extends HelloSource {
  /** The supervisor; its receipt store answers receipts.get. */
  readonly supervisor?: Supervisor;
  /** A receipt store without a supervisor (receipt tests). */
  readonly receipts?: ReceiptStore;
}

const unavailable = () => new Refusal('supervisor_state_unavailable');

export function createApp(options: AppOptions = {}): { handle: RequestHandler; handlers: Handlers } {
  const hello = createHello(options);
  const receipts = options.receipts ?? options.supervisor?.receipts;
  const supervisor = (): Supervisor => {
    if (!options.supervisor) throw unavailable();
    return options.supervisor;
  };
  const handlers: Handlers = {
    hello: () => hello(),
    'receipts.get': ({ path }) => {
      if (!receipts) throw unavailable();
      const receipt = receipts.all.get(path.command_id);
      // An unknown or expired command_id is never proof that nothing ran.
      if (!receipt) throw new Refusal('unknown_command_id_is_not_proof_of_no_effect', 'unknown', undefined, {}, 409);
      return receipt;
    },
    'workers.list': () => supervisor().list(),
    'workers.get': ({ path }) => supervisor().get(path.worker_id),
    'workers.create': ({ body }) => supervisor().create(body),
    'workers.stop': ({ path, body }) => supervisor().stop(path.worker_id, body),
  };
  return { handle: createRouter({ handlers }), handlers };
}
