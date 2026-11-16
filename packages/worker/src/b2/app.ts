/**
 * Wires the generated route table to the handlers this build serves; operations the spec marks unsupported answer
 * 501. Without state (an embedded router in tests), a served operation that needs the supervisor's state refuses
 * `409 supervisor_state_unavailable`, `no_effect`.
 *
 * Every request, `hello` included, needs a bearer grant (P1-9): the router authenticates it before reading parameters
 * or body, checks the route's grant method, and runs the handler under a guard the supervisor rechecks at dispatch.
 * Scope is enforced here: a worker outside the grant's scope is refused `grant_scope_denied` on every worker route,
 * filtered out of `workers.list` and the event stream, and a receipt of such a worker is not readable. Without a
 * grant store every request is refused: there is no unauthenticated mode.
 */
import { Refusal } from './errors.js';
import { createHello, type HelloSource } from './hello.js';
import { createRouter, type Authorized, type B2Request, type RequestHandler } from './router.js';
import type { Handlers } from './types.js';
import type { ReceiptStore } from '../receipts/receipts.js';
import { sseRecord } from '../events/hub.js';
import { eventManifest, type Cursor } from '../generated/events.js';
import type { Route } from '../generated/routes.js';
import { allowsCwd, allowsMethod, allowsWorker, type Caller, type GrantStore } from '../grants/store.js';
import type { Supervisor } from '../supervisor/supervisor.js';

export interface AppOptions extends HelloSource {
  /** The supervisor; its receipt store answers receipts.get. */
  readonly supervisor?: Supervisor;
  /** A receipt store without a supervisor (receipt tests). */
  readonly receipts?: ReceiptStore;
  /** The grant registry every request is authenticated against. */
  readonly grants?: GrantStore;
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

/** Authenticates the bearer and the route's grant method; the guard rereads the grant (revocation) when rechecked. */
function authorizer(grants: GrantStore | undefined): (request: B2Request, route: Route) => Authorized {
  return (request, route) => {
    const header = request.headers.authorization;
    if (!grants) throw new Refusal(header ? 'invalid_grant' : 'bearer_grant_required');
    const caller = grants.authenticate(header);
    if (!allowsMethod(caller, route.grantMethod)) throw new Refusal('grant_method_denied');
    const guard = Object.assign(
      () => {
        if (!allowsMethod(grants.current(caller), route.grantMethod)) throw new Refusal('grant_method_denied');
      },
      { grant_id: caller.grant_id, caller_name: caller.caller, methods: caller.methods },
    );
    return { caller, guard };
  };
}

export function createApp(options: AppOptions = {}): { handle: RequestHandler; handlers: Handlers } {
  const receipts = options.receipts ?? options.supervisor?.receipts;
  const hello = createHello({ ...options, ...(receipts ? { retention: receipts.limits } : {}) });
  const supervisor = (): Supervisor => {
    if (!options.supervisor) throw unavailable();
    return options.supervisor;
  };
  const worker = (id: string) => {
    const live = supervisor().state.workers.get(id);
    if (!live) throw new Refusal('unknown_worker');
    return live.worker;
  };
  const visible = (caller: Caller | undefined, id: string): boolean => {
    const live = options.supervisor?.state.workers.get(id);
    return !!caller && !!live && allowsWorker(caller, live.worker);
  };
  /** A grant over every worker learns nothing from telling a missing worker from an existing one. */
  const seesAll = (caller: Caller | undefined): boolean => !!caller?.scope.worker_ids.includes('*');
  /**
   * Every route with a worker in its path: the worker must exist and be in the caller's scope. A scoped grant gets
   * the same refusal for a missing worker as for one outside its scope, so it cannot probe for other workers.
   */
  const inScope = (caller: Caller | undefined, id: string): void => {
    if (!seesAll(caller) && !visible(caller, id)) throw new Refusal('grant_scope_denied');
    const w = worker(id);
    if (!caller || !allowsWorker(caller, w)) throw new Refusal('grant_scope_denied');
  };
  /**
   * A catalog session is visible when its cwd is in the caller's cwd scope and its last owner is a worker the caller
   * may see. A scoped grant gets the same refusal for an unknown session as for one outside its scope.
   */
  const sessionVisible = (caller: Caller | undefined, row: { cwd: string; last_worker_id: string }): boolean => !!caller && allowsCwd(caller, row.cwd) && visible(caller, row.last_worker_id);
  const sessionRow = (caller: Caller | undefined, sessionId: string) => {
    const row = supervisor().features.row(sessionId);
    if (!row) throw new Refusal(seesAll(caller) ? 'unknown_session' : 'grant_scope_denied');
    if (!sessionVisible(caller, row)) throw new Refusal('grant_scope_denied');
    return row;
  };
  /** models.list and commands.list: a worker in scope, or a cwd in the caller's cwd scope. */
  const featureTarget = (caller: Caller | undefined, q: { worker_id?: string; cwd?: string; project_trusted?: boolean }) => {
    if (q.worker_id !== undefined) inScope(caller, q.worker_id);
    if (q.cwd !== undefined && (!caller || !allowsCwd(caller, q.cwd))) throw new Refusal('grant_scope_denied');
    return q;
  };
  const handlers: Handlers = {
    hello: () => hello(),
    'receipts.get': ({ path, caller }) => {
      if (!receipts) throw unavailable();
      const receipt = receipts.all.get(path.command_id);
      // Only receipts of workers in scope; a receipt with no worker only for a grant over every worker.
      const readable = (workerId: string | undefined) =>
        workerId ? (options.supervisor ? visible(caller, workerId) : !!caller?.scope.worker_ids.includes('*')) : !!caller?.scope.worker_ids.includes('*');
      if (!receipt) {
        // An evicted receipt (P1-12) or an unknown command_id is never proof that nothing ran. A caller that could not
        // read the receipt cannot tell an evicted one from an unknown one either.
        const gone = receipts.expired.get(path.command_id);
        if (gone && readable(gone.worker_id)) throw new Refusal('receipt_expired', 'unknown', path.command_id, {}, 409);
        throw new Refusal('unknown_command_id_is_not_proof_of_no_effect', 'unknown', undefined, {}, 409);
      }
      if (!readable(receipt.worker_id)) throw new Refusal('grant_scope_denied');
      return receipt;
    },
    'workers.list': ({ caller }) => supervisor().list().filter(w => !!caller && allowsWorker(caller, w)),
    'workers.get': ({ path }) => supervisor().get(path.worker_id),
    'workers.create': ({ body, caller }) => {
      const s = supervisor();
      if (!caller || !allowsCwd(caller, body.cwd)) throw new Refusal('grant_scope_denied');
      // A typed child's parent must be in scope as well.
      if (body.parent && !visible(caller, body.parent.worker_id)) throw new Refusal('grant_scope_denied');
      // Reattaching a session needs its last owner in scope too.
      const owner = body.resume_session_id ? s.state.sessionFiles.get(body.resume_session_id)?.worker_id : undefined;
      if (owner && !visible(caller, owner)) throw new Refusal('grant_scope_denied');
      return s.create(body);
    },
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
    'children.launch': ({ path, body, caller }) => {
      // The child's environment must be in the caller's scope too.
      if (!caller || !allowsCwd(caller, body.launch.cwd)) throw new Refusal('grant_scope_denied');
      return supervisor().launchChild(path.worker_id, body);
    },
    'children.report': ({ path, body }) => supervisor().report(path.worker_id, body),
    'interactions.list': ({ path }) => supervisor().interactionList(path.worker_id),
    'interactions.status': ({ path, query }) => supervisor().interactionStatus(path.worker_id, query.interaction_id),
    'interactions.answer_if_current': ({ path, body, caller }) => {
      // Only a grant that answers for a person (the bridge profile) may answer; the actor is its opaque reference.
      if (!caller?.answers_for_person) throw new Refusal('grant_cannot_answer_for_person');
      return supervisor().answer(path.worker_id, body, { caller: caller.caller, grant_id: caller.grant_id });
    },
    'items.read': ({ path }) => supervisor().item(path.worker_id, path.entry_id),
    'session.configure': ({ path, body }) => supervisor().configure(path.worker_id, body),
    'sessions.list': ({ query, caller }) => supervisor().features.list(row => sessionVisible(caller, row), query),
    'sessions.get': ({ path, caller }) => sessionRow(caller, path.session_id),
    'sessions.history': ({ path, query, caller }) => {
      sessionRow(caller, path.session_id);
      return supervisor().features.history(path.session_id, query);
    },
    'models.list': ({ query, caller }) => supervisor().features.models(featureTarget(caller, query)),
    'commands.list': ({ query, caller }) => supervisor().features.commands(featureTarget(caller, query)),
    'events.subscribe': ({ query, header, caller }) => {
      const s = supervisor();
      const since = cursorOf(header['last-event-id']);
      const types = query.types?.split(',');
      if (types?.some(t => !(t in eventManifest))) throw new Refusal('unknown_event_type', 'no_effect', undefined, {}, 400);
      const workerIds = query.worker_id?.split(',');
      // A scoped grant naming a missing worker is refused exactly like one naming a worker outside its scope.
      for (const id of workerIds ?? []) if ((s.state.workers.has(id) || !seesAll(caller)) && !visible(caller, id)) throw new Refusal('grant_scope_denied');
      const grants = options.grants;
      return {
        sse: sink => {
          const subscription = s.subscribe(frame => sink.write(sseRecord(frame)), {
            since,
            ...(workerIds ? { workerIds } : {}),
            ...(types ? { types } : {}),
            // A worker outside the grant's scope never appears in the snapshot or in a frame.
            acceptWorker: id => visible(caller, id),
            // A revoked grant ends the stream at its next frame, with no frame.
            recheck: () => {
              if (!grants || !caller || !allowsMethod(grants.current(caller), 'events.subscribe')) throw new Refusal('grant_revoked');
            },
            overflowResync: query.resync === 'overflow',
            onEnd: () => sink.end(),
          });
          sink.onDrain(subscription.drain);
          sink.onClose(subscription.close);
        },
      };
    },
  };
  // Scope on every route that names a worker in its path, before the handler (no handler can forget it).
  // SAFETY: each wrapper has its handler's key and passes the router's validated input through unchanged, so the
  // map keeps the Handlers type of the object it was built from.
  const scoped = Object.fromEntries(
    Object.entries(handlers).map(([op, handler]) => [
      op,
      (input: { path: Record<string, unknown>; caller?: Caller }) => {
        if (typeof input.path.worker_id === 'string') inScope(input.caller, input.path.worker_id);
        return (handler as (i: unknown) => unknown)(input);
      },
    ]),
  ) as unknown as Handlers;
  return { handle: createRouter({ handlers: scoped, authorize: authorizer(options.grants) }), handlers: scoped };
}
