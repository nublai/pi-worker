/**
 * The interactions crash scenario (P1-10), ported from A0 `src/test/fixtures/interaction-crash-child.ts`: an answered
 * question, a cancelled one, an approval released and one whose grant is revoked before release, a deadline cancel, a
 * dialog cancelled by a B2 navigation, a consumed answer whose acknowledgement is lost (unknown, fenced, kept), and a
 * question left pending across a restart. Answer ids follow the world's `<native_id>-answer` convention.
 */
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { authority } from '../../src/grants/authority.js';
import type { Answer } from '../../src/interactions/interactions.js';
import type { Worker } from '../../src/supervisor/state.js';
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld } from './world.js';

export async function interactionsScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const w: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = w.worker_id;
  const host = world.hosts[0]!;
  appendFileSync(host.file, `${JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: [] } })}\n`);
  const open = (nativeId: string, method = 'input', extra: Record<string, unknown> = {}) => {
    host.emit('event', { type: 'extension_ui_request', id: nativeId, method, ...extra });
    return world.supervisor.interactionList(id).find(i => i.native_id === nativeId)!;
  };
  const answer = (nativeId: string, kind: Answer['kind'] = 'input', extra: Partial<Answer> = {}) => {
    const i = world.supervisor.interactionList(id).find(x => x.native_id === nativeId)!;
    const now = world.supervisor.get(id);
    const a: Answer = { ...bind(now, `${nativeId}-answer`), answer_id: `${nativeId}-answer`, interaction_id: i.interaction_id, revision: 1, kind, outcome: 'answer', value: kind === 'tool_approval' ? true : 'PRIVATE_NO_HASH', ...extra };
    return world.call('answer', a as unknown as Record<string, unknown>, id);
  };
  open('question');
  await answer('question');
  open('cancelled');
  await answer('cancelled', 'input', { outcome: 'cancel', value: undefined });
  for (const mode of ['allow', 'revoked']) {
    const approval = { gate_token: mode, digest: 'artifact', policy_revision: 'p1', expiry: Date.now() + 60_000, operation: 'bash', resource: root, environment: root, offered_scope: 'once' };
    open(mode, 'tool_approval', { approval });
    let authorized = true;
    const guard = Object.assign(
      () => {
        if (!authorized) throw new Error('grant_revoked');
      },
      { grant_id: 'scenario' },
    );
    await authority.run(guard, () => answer(mode, 'tool_approval'));
    if (mode === 'revoked') authorized = false;
    const live = world.supervisor.state.require(id);
    await world.supervisor.interactions.gate(live.worker, { type: 'gate_check', ...approval }, () => world.supervisor.input.writable(live));
  }
  open('timeout', 'confirm', { timeout: 1 });
  await delay(20);
  open('navigate-dialog');
  const before = world.supervisor.get(id);
  await world.call('rebind', { ...bind(before, 'navigate'), action: 'navigate', entry_id: 'entry', source_leaf_id: before.leaf_id }, id);
  // A consumed answer whose acknowledgement is lost: unknown, fenced, never replayed; the owner keeps it.
  open('lost');
  host.answerUI = async () => {
    throw new Error('dropped_ack');
  };
  await answer('lost');
  const fenced = world.supervisor.get(id);
  await world.call('resolve', { ...bind(fenced, 'resolve-lost'), uncertain_command_id: 'lost-answer', fence_generation: fenced.fence!.fence_generation, disposition: 'keep' }, id);
  // A question left open across a restart: interrupted, never re-opened, and its stale answer refused.
  open('restart-pending');
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
