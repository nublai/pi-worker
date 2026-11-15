/** Kill after automatic queue readiness fsync, before any dispatch or owner action. */
import { fixture, bind, tick } from '../helpers.js';
const f = fixture(); process.stdout.write(f.dir + '\n');
const w = await f.create();
await f.supervisor.prompt(w.worker_id, { ...bind(w, 'run'), message: 'run' });
const execution_id = f.supervisor.get(w.worker_id).execution!.execution_id;
if (process.argv[2] === 'child') await f.supervisor.launchChild(w.worker_id, { ...bind(w, 'queued'), execution_id, launch: { command_id: 'create-child', cwd: f.dir, provider: 'p', model: 'm', thinking: 'off' } });
else await f.supervisor.followUp(w.worker_id, { ...bind(w, 'queued'), execution_id, message: 'next' });
const append = f.journal.append.bind(f.journal);
f.journal.append = (kind, value) => {
  append(kind, value); // Real fsync first, then cut, also detects the legacy bug.
  if (kind === 'receipt' && value.command_id === 'queued' && ['queue_ready', 'intent_ready'].includes(String(value.state))) process.kill(process.pid, 'SIGKILL');
};
f.hosts[0]!.emit('event', { type: 'agent_settled' });
await tick(); await tick(); await tick();
throw new Error('automatic readiness cut was not reached');
