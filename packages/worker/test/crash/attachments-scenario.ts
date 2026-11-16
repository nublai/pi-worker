/**
 * The attachments crash scenario (P1-16): a photo staged, the same photo again (a duplicate), a prompt that delivers
 * it (and releases it), a second photo released explicitly, a third whose prompt reply is lost (unknown, fenced, the
 * photo stays staged), then a restart.
 */
import { createHash } from 'node:crypto';
import type { Worker } from '../../src/supervisor/state.js';
import { bind } from '../supervisor-fixture.js';
import { createIn } from './lifecycle-scenario.js';
import { openWorld, type World } from './world.js';

const photo = (fill: number) => {
  const b = Buffer.alloc(4096, fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

function stage(world: World, w: Worker, attachmentId: string, command: string, bytes: Buffer) {
  return world.call('stage', {
    attachment_id: attachmentId,
    command_id: command,
    worker_id: w.worker_id,
    worker_epoch: w.worker_epoch,
    session_id: w.session_id!,
    binding_revision: w.binding_revision,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content_type: 'image/jpeg',
    body_base64: bytes.toString('base64'),
  });
}

export async function attachmentsScenario(root: string): Promise<void> {
  let world = openWorld(root, true);
  const a: Worker = (await createIn(world, 'worker-a')).worker!;
  const id = a.worker_id;
  const host = world.hosts[0]!;
  const now = () => world.supervisor.get(id);
  await stage(world, a, 'photo-1', 'stage-1', photo(1));
  await stage(world, a, 'photo-1', 'stage-1-again', photo(1));
  await world.call('prompt', { ...bind(now(), 'prompt-photo'), message: 'prompt-photo', attachments: [{ attachment_id: 'photo-1' }] }, id);
  host.emit('event', { type: 'agent_settled' });
  await new Promise(r => setImmediate(r));
  await stage(world, a, 'photo-2', 'stage-2', photo(2));
  await world.call('release', { attachment_id: 'photo-2', command_id: 'release-2' });
  await stage(world, a, 'photo-3', 'stage-3', photo(3));
  host.failure = true;
  await world.call('prompt', { ...bind(now(), 'prompt-lost'), message: 'prompt-lost', attachments: [{ attachment_id: 'photo-3' }] }, id);
  host.failure = false;
  world.state.close();
  world = openWorld(root, false);
  await world.supervisor.recover();
  world.state.close();
}
