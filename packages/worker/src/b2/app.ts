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
import { sseRecord } from '../events/hub.js';
import { eventManifest, type Cursor } from '../generated/events.js';
import type { Supervisor } from '../supervisor/supervisor.js';

export interface AppOptions extends HelloSource {
  /** The supervisor; its receipt store answers receipts.get. */
  readonly supervisor?: Supervisor;
  /** A receipt store without a supervisor (receipt tests). */
  readonly receipts?: ReceiptStore;
}

const unavailable = () => new Refusal('supervisor_state_unavailable');

/** `Last-Event-ID`: the cursor of the last frame seen, as JSON. A malformed one is refused before the stream opens. */
function cursorOf(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Refusal('invalid_last_event_id', 'no_effect', undefined, {}, 400);
  }
  const c = value as Cursor;
  if (!c || typeof c.transport_epoch !== 'string' || !Number.isSafeInteger(c.seq) || c.seq < 0) throw new Refusal('invalid_last_event_id', 'no_effect', undefined, {}, 400);
  return { transport_epoch: c.transport_epoch, seq: c.seq };
}

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
    'sessions.prompt': ({ path, body }) => supervisor().prompt(path.worker_id, body),
    'sessions.steer': ({ path, body }) => supervisor().steer(path.worker_id, body),
    'sessions.follow_up': ({ path, body }) => supervisor().followUp(path.worker_id, body),
    'executions.cancel': ({ path, body }) => supervisor().control(path.worker_id, body, false),
    'executions.interrupt': ({ path, body }) => supervisor().control(path.worker_id, body, true),
    'sessions.rebind': ({ path, body }) => supervisor().rebind(path.worker_id, body),
    'sessions.new': ({ path, body }) => supervisor().newSession(path.worker_id, body),
    'sessions.resolve_unknown': ({ path, body }) => supervisor().resolveUnknown(path.worker_id, body),
    'history.page': ({ path, query }) => supervisor().history(path.worker_id, query),
    'items.read': ({ path }) => supervisor().item(path.worker_id, path.entry_id),
    'events.subscribe': ({ query, header }) => {
      const s = supervisor();
      const since = cursorOf(header['last-event-id']);
      const types = query.types?.split(',');
      if (types?.some(t => !(t in eventManifest))) throw new Refusal('unknown_event_type', 'no_effect', undefined, {}, 400);
      const workerIds = query.worker_id?.split(',');
      return {
        sse: sink => {
          const subscription = s.subscribe(frame => sink.write(sseRecord(frame)), {
            since,
            ...(workerIds ? { workerIds } : {}),
            ...(types ? { types } : {}),
            overflowResync: query.resync === 'overflow',
            onEnd: () => sink.end(),
          });
          sink.onDrain(subscription.drain);
          sink.onClose(subscription.close);
        },
      };
    },
  };
  return { handle: createRouter({ handlers }), handlers };
}
