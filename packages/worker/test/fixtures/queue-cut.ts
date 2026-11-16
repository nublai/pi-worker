/**
 * Ported from A0 `src/test/fixtures/queue-cut.ts`: SIGKILL right after the automatic queue-readiness fsync, before
 * any dispatch or owner action. Prints its state directory first. `queue-cut.js child` queues a child launch instead.
 */
import { bind, fixture, tick } from '../supervisor-fixture.js';

const f = fixture();
process.stdout.write(`${f.dir}\n`);
const w = await f.create();
await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
// The child variant (P1-11): an untyped child launch queued under the running execution instead of a follow-up.
if (process.argv[2] === 'child') await f.supervisor.launchChild(w.worker_id, { ...bind(w, 'queued'), execution_id, launch: { command_id: 'create-child', cwd: f.dir, provider: 'p', model: 'm', thinking: 'off' } });
else await f.supervisor.followUp(w.worker_id, { ...bind(w, 'queued'), execution_id, message: 'next' });
const journal = f.state.journal;
const append = journal.append.bind(journal);
journal.append = (kind, value, label, reservation) => {
  const record = append(kind, value, label, reservation); // Real fsync first, then the cut.
  if (kind === 'receipt' && value.command_id === 'queued' && ['queue_ready', 'intent_ready'].includes(String(value.state))) process.kill(process.pid, 'SIGKILL');
  return record;
};
f.hosts[0]!.emit('event', { type: 'agent_settled' });
await tick();
await tick();
await tick();
throw new Error('automatic readiness cut was not reached');
