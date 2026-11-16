/**
 * The grant a B2 request runs under, carried through its async work (AsyncLocalStorage) so the supervisor can recheck
 * it at the moment of dispatch, not only when the request arrived. A queued item (follow-up, child launch) keeps the
 * guard of the request that admitted it and is rechecked when it dispatches (contract section 6: revocation is
 * rechecked at dispatch and at tool release). Calls made outside B2 (tests, recovery) carry no guard.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Throws a `Refusal` (grant_revoked, grant_method_denied, …) when the grant no longer authorizes the call. */
export type Guard = (() => void) & { readonly grant_id?: string; readonly caller_name?: string; readonly methods?: readonly string[] };

export const authority = new AsyncLocalStorage<Guard>();

/** The guard of the B2 request this code runs for, if any. */
export const currentGuard = (): Guard | undefined => authority.getStore();

/** Rechecks the current request's grant; a no-op outside a B2 request. */
export function recheck(): void {
  authority.getStore()?.();
}
