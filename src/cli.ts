#!/usr/bin/env node
/** THROWAWAY a0 CLI. command_id is explicit on every write. */
import { resolve } from 'node:path';
import { Client } from './client.js';
import type { Binding, Cursor, Snapshot } from './types.js';
const args = process.argv.slice(2), flags = new Map<string, string>(), positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith('--')) { const next = args[i + 1]; flags.set(a.slice(2), next && !next.startsWith('--') ? (i++, next) : 'true'); }
  else positional.push(a);
}
const client = new Client(resolve(flags.get('socket') ?? process.env.A0_SOCKET ?? '.a0/worker.sock'));
function required(name: string): string { const value = flags.get(name); if (!value || value === 'true') throw new Error(`--${name} required`); return value; }
const print = (data: unknown) => console.log(JSON.stringify(data));
async function binding(id: string): Promise<Binding> {
  // CLI convenience only; server still atomically validates expected binding. Tests
  // can pass stale expectations explicitly. Retries use the original binding.
  const worker = await client.call('workers.get', { id });
  if (!worker.session_id) throw new Error('worker has no session binding');
  return { command_id: required('command-id'), worker_epoch: flags.get('worker-epoch') ?? worker.worker_epoch, session_id: flags.get('session-id') ?? worker.session_id, binding_revision: Number(flags.get('binding-revision') ?? worker.binding_revision) };
}
try {
  const [cmd, id] = positional;
  if (cmd === 'hello') print(await client.call('hello'));
  else if (cmd === 'list') print(await client.call('workers.list'));
  else if (cmd === 'receipt') print(await client.call('receipts.get', { id: id ?? required('command-id') }));
  else if (cmd === 'create') print(await client.call('workers.create', { body: { command_id: required('command-id'), cwd: required('cwd'), provider: required('provider'), model: required('model'), thinking: required('thinking') as 'off' } }));
  else if (id && cmd === 'get') print(await client.call('workers.get', { id }));
  else if (id && cmd === 'prompt') print(await client.call('sessions.prompt', { id, body: { ...await binding(id), message: required('message') } }));
  else if (id && cmd === 'stop') print(await client.call('workers.stop', { id, body: await binding(id) }));
  else if (id && cmd === 'history') {
    const query: Record<string, string> = {};
    for (const key of ['watermark', 'after', 'limit']) if (flags.has(key)) query[key] = required(key);
    print(await client.call('history.page', { id, query }));
  } else if (id && cmd === 'watch') {
    const since: Cursor | undefined = flags.has('seq') ? { worker_epoch: required('worker-epoch'), seq: Number(required('seq')) } : undefined;
    let count = 0;
    await client.watch(id, frame => {
      print(frame); count++;
      if (flags.has('max-events') && count >= Number(required('max-events'))) return false;
      if (flags.has('until-settled') && (frame.type === 'agent_settled' || (frame.type === 'snapshot' && (frame as Snapshot).worker.execution?.state === 'settled'))) return false;
      return true;
    }, since);
  } else throw new Error('Usage: a0 [--socket PATH] hello | create --command-id ID --cwd DIR --provider P --model M --thinking off | list | get WORKER | prompt WORKER --command-id ID --message TEXT | watch WORKER [--until-settled|--max-events N] [--worker-epoch E --seq N] | history WORKER [--limit N --watermark ID --after ID] | stop WORKER --command-id ID | receipt COMMAND');
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
