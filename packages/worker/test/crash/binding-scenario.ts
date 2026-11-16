/**
 * The binding crash scenario (P1-7): B2 moves (new, resume, fork, navigate, sessions.new), a native move announced
 * and bound, a native move reconciled from pi's state, and a post-write collision that fences and faults.
 */
import { appendFileSync } from 'node:fs';
import type { Worker } from '../../src/supervisor/state.js';
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld } from './world.js';

export async function bindingScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  world.supervisor.nativeMoveTimeoutMs = 20;
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = a.worker_id;
  const h = world.hosts[0]!;
  const now = () => world.supervisor.get(id);
  const original = a.session_id!;
  await world.call('rebind', { ...bind(now(), 'new'), action: 'new' }, id);
  await world.call('new', bind(now(), 'sessions-new'), id);
  await world.call('rebind', { ...bind(now(), 'resume'), action: 'resume', target_session_id: original }, id);
  appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: [] } })}\n`);
  appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'e2', parentId: 'e1', message: { role: 'user', content: [] } })}\n`);
  h.emit('event', { type: 'host_leaf', leafId: 'e2' });
  await world.call('rebind', { ...bind(now(), 'navigate'), action: 'navigate', source_leaf_id: 'e2', entry_id: 'e1' }, id);
  await world.call('rebind', { ...bind(now(), 'fork'), action: 'fork', source_leaf_id: now().leaf_id, entry_id: 'e1' }, id);
  // A native move pi announces and binds on its own.
  h.emit('event', { type: 'host_binding_changing' });
  h.emit('event', { type: 'host_binding', action: 'replace', sessionId: h.sid, sessionFile: h.file, leafId: null });
  // A native move that never binds: reconciled from pi's state.
  h.emit('event', { type: 'host_binding_changing' });
  await new Promise(r => setTimeout(r, 60));
  // A post-write collision: pi reports a session another worker holds.
  const b: Worker = (await createIn(world, 'worker-b')).worker!;
  const hb = world.hosts[1]!;
  const native = hb.request.bind(hb);
  hb.request = async c => {
    const reply = await native(c);
    if (c.type === 'new_session') hb.sid = now().session_id!;
    return reply;
  };
  await world.call('rebind', { ...bind(b, 'collide'), action: 'new' }, b.worker_id);
  await new Promise(r => setImmediate(r));
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
