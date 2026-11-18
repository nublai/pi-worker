/**
 * The B2 side of a parent channel (P2-8), ported from A0 `src/server.ts` (`router(supervisor, channel)`). One channel
 * serves one generation of one sandboxed parent (supervisor/channel.ts makes its socket and grant):
 *
 * - **Its own grant, by connection.** Every request runs as the channel's grant: the Authorization header is ignored
 *   (no bearer exists in the sandbox), and the owner's grants are never consulted. The grant is reread on every
 *   request and at dispatch, so revoking it (or the grant that created the parent) stops the channel.
 * - **One generation.** A request is refused `parent_channel_retired` once the parent's epoch is not the channel's,
 *   the parent is no longer starting or ready, or the supervisor no longer serves this channel (closed).
 * - **Open streams too.** An event stream rechecks this whole guard before every frame, when the channel closes, and
 *   every `RECHECK_MS` (b2/app.ts): it ends with one `overflow` naming the refusal, and nothing after it.
 * - **Method whitelist.** Only `CHANNEL_METHODS` are served (`parent_channel_method_denied` before parameters or body).
 * - **Own workers only.** The parent and its children are the only workers it can see (b2/app.ts `owned`).
 * - **Interrupt: a child's turn only.** `executions.interrupt` is served for the parent's own children
 *   (`channelInterruptTarget`): the parent's own turn is refused `parent_channel_requires_own_child`, a worker that is
 *   not the parent's or its child's is out of scope (`grant_scope_denied`, as for every method), and the child's
 *   binding, the generation and both grants are checked exactly as for the other channel methods. It is not a stop, and
 *   a creating grant without the method leaves it out of the channel grant (`grant_method_denied`).
 * - **Own children's artifacts only.** `artifacts.inspect` (P3-6) reads only the parent's own children, never the
 *   parent itself (`parent_channel_requires_own_child`, b2/app.ts).
 * - **Own children only.** `workers.create` must name this parent and carry a launch spec
 *   (`parent_channel_requires_own_child`); the child is an SDK worker in the bwrap profile of its cwd, which the
 *   supervisor requires to be an owner-prepared slot (`PARENT/.piw-slots/<name>`, children.ts). Its resources must
 *   lie in the parent's profile (`parent_channel_resource_outside_profile`) and are named in the child's staged copy.
 *   This normalization reads no file, so an exact retry hashes the same and returns its stored receipt.
 */
import { join, normalize } from 'node:path';
import { Refusal } from './errors.js';
import { createApp, type AppOptions } from './app.js';
import type { Authorized, B2Request, RequestHandler } from './router.js';
import type { Route } from '../generated/routes.js';
import { allowsMethod, type GrantStore } from '../grants/store.js';
import { AGENT_DIR } from '../sandbox/sandbox.js';
import { CHANNEL_METHODS, type ChannelFactory, type ChannelIdentity } from '../supervisor/channel.js';
import type { Create } from '../supervisor/state.js';
import type { Supervisor } from '../supervisor/supervisor.js';

/** The channel handlers for every parent generation: the B2 app over `options`, in its channel mode. */
export function parentChannels(options: Omit<AppOptions, 'channel'>): ChannelFactory {
  return (identity: ChannelIdentity): RequestHandler => createApp({ ...options, channel: identity }).handle;
}

/**
 * Authenticates every channel request as the channel's own grant. The check (generation, the parent's creating grant,
 * whitelist, the channel grant and its methods) runs now and again whenever the supervisor rechecks the guard.
 */
export function channelAuthorizer(supervisor: Supervisor | undefined, grants: GrantStore | undefined, channel: ChannelIdentity): (request: B2Request, route: Route) => Authorized {
  return (_request, route) => {
    const check = () => {
      if (!supervisor || !grants) throw new Refusal('supervisor_state_unavailable');
      const live = supervisor.state.workers.get(channel.workerId);
      const parent = live?.worker;
      if (!parent || parent.worker_epoch !== channel.epoch || !['starting', 'ready'].includes(parent.status)) throw new Refusal('parent_channel_retired');
      // A channel the supervisor no longer serves (closed at the generation's cleanup, shutdown included) is retired.
      if (live.channel?.grantId !== channel.grantId) throw new Refusal('parent_channel_retired');
      // Revoking the grant that created the parent stops its channel too.
      if (parent.grant_source_id && grants.read(parent.grant_source_id).revoked) throw new Refusal('grant_revoked');
      if (!CHANNEL_METHODS.includes(route.grantMethod)) throw new Refusal('parent_channel_method_denied');
      const caller = grants.current({ grant_id: channel.grantId, caller: '', scope: { worker_ids: [], cwd_roots: [] }, methods: [], answers_for_person: false });
      if (!allowsMethod(caller, route.grantMethod)) throw new Refusal('grant_method_denied');
      return caller;
    };
    const caller = check();
    const guard = Object.assign(
      () => {
        check();
      },
      { grant_id: caller.grant_id, caller_name: caller.caller, methods: caller.methods },
    );
    return { caller, guard };
  };
}

/**
 * An interrupt on a parent's channel: the target must be the parent's own child, never the parent itself (its own turn
 * is not the parent's to interrupt through the worker). Called after the scope check, before any receipt or record,
 * so a refusal is `no_effect`.
 */
export function channelInterruptTarget(target: { worker_id: string; parent_worker_id?: string | null }, channel: ChannelIdentity): void {
  if (target.parent_worker_id !== channel.workerId) throw new Refusal('parent_channel_requires_own_child');
}

/**
 * A create on a parent's channel: the parent's own typed child, an SDK worker sandboxed in its cwd, with each resource
 * the parent names in its profile (`PARENT/.piw-agent/…`) named in the child's staged copy (`CHILD/.piw-agent/…`).
 * Pure: it reads no file.
 */
export function channelChild(c: Create, channel: ChannelIdentity): Create {
  if (c.parent?.worker_id !== channel.workerId || !c.launch_spec) throw new Refusal('parent_channel_requires_own_child');
  const profile = join(channel.root, AGENT_DIR);
  const staged = join(c.cwd, AGENT_DIR);
  const remap = (path: string): string => {
    if (path !== normalize(path) || !path.startsWith(`${profile}/`)) throw new Refusal('parent_channel_resource_outside_profile');
    return join(staged, path.slice(profile.length + 1));
  };
  const spec = c.launch_spec;
  return {
    ...c,
    host: 'sdk',
    launch_spec: {
      ...spec,
      environment: { ...spec.environment, filesystem: 'bwrap', root: c.cwd },
      resources: { extensions: spec.resources.extensions.map(remap), skills: spec.resources.skills.map(remap) },
    },
  };
}
