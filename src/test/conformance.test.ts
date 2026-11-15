/** Public HTTP replay of language-neutral section 0.1 fixtures. No model-success assertions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, ClientFailure } from '../client.js';
import { router, listenPrivate } from '../server.js';
import { Journal, parseJournal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import type { operations } from '../api.generated.js';
import type { Worker } from '../types.js';
import { fixture, bind, tick } from './helpers.js';
type Step = { kind?: string; macro?: string; method?: keyof operations; command_id?: string; binding?: string; fields?: Record<string, unknown>; mode?: string; event?: { type: string } };
type Row = { id: string; profile?: string; steps: Step[]; expect: { path: string; equals: unknown }[] };
const data = JSON.parse(readFileSync(new URL('../../src/test/fixtures/transitions.json', import.meta.url), 'utf8')) as { macros: Record<string, Step[]>; rows: Row[] };
const get = (object: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, object);
const expand = (steps: Step[]): Step[] => steps.flatMap(s => s.macro ? expand(data.macros[s.macro]!) : [s]);
for (const row of data.rows) test(`contract 0.1 fixture ${row.id}`, async () => {
  const f = fixture({ unconfirmedIdentity: row.profile === 'unconfirmed_native_identity' });
  let supervisor = f.supervisor, server = router(supervisor), journal: Journal | undefined;
  const socket = join(f.dir, 'socket'); const client = new Client(socket);
  try {
    await listenPrivate(server, socket);
    const initial = await f.create(), host = f.hosts[0]!;
    let worker = initial, result: unknown = null, inflight: Promise<unknown> | undefined, rejectReply: (() => void) | undefined;
    const context = () => ({ initial, worker, child_cwd: f.dir });
    const substitute = (value: unknown): unknown => {
      if (typeof value === 'string' && value.startsWith('@')) return get(context(), value.slice(1));
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, substitute(v)]));
      return value;
    };
    const invoke = async (step: Step): Promise<unknown> => {
      try { return await client.call(step.method!, { id: initial.worker_id, body: { ...bind(step.binding === 'worker' ? worker : initial, step.command_id!), ...substitute(step.fields ?? {}) as Record<string, unknown> } as never }); }
      catch (error) { if (error instanceof ClientFailure) return { error: error.message, effect: error.effect, ...error.details }; throw error; }
    };
    for (const step of expand(row.steps)) {
      if (step.kind === 'host_reply') {
        if (step.mode === 'drop') host.failure = true;
        else {
          const native = host.request.bind(host);
          let once = true;
          const gate = new Promise<never>((_r, reject) => { rejectReply = () => reject(new Error('fixture_dropped_reply')); });
          host.request = async c => { const reply = await native(c); if (c.type === 'prompt' && once) { once = false; await gate; } return reply; };
        }
      } else if (step.kind === 'call') result = await invoke(step);
      else if (step.kind === 'begin') {
        const started = new Promise<void>(resolve => { const listener = (event: { type: string }) => { if (event.type === 'agent_start') { host.off('event', listener); resolve(); } }; host.on('event', listener); });
        inflight = invoke(step); await started;
      } else if (step.kind === 'drop_reply') { rejectReply!(); result = await inflight; }
      else if (step.kind === 'host_event') { if (step.event!.type === 'exit') host.emit('exit'); else host.emit('event', step.event!); }
      else if (step.kind === 'drain') { await tick(); await tick(); }
      else if (step.kind === 'restart') {
        server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
        journal = new Journal(f.journal.file);
        supervisor = new Supervisor(f.dir, journal, '1.5.2', () => { assert.fail('restart must not adopt or relaunch'); }); await supervisor.recover();
        server = router(supervisor); await listenPrivate(server, socket);
      } else throw new Error('unknown fixture step ' + step.kind);
      worker = await client.call('workers.get', { id: initial.worker_id });
    }
    const records = parseJournal(readFileSync(f.journal.file)).records;
    const disk = records.filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === initial.worker_id).at(-1)!.value.worker;
    const actual = { worker, disk, result, effects: { prompts: host.prompts, hosts: f.hosts.length } };
    for (const check of row.expect) assert.deepEqual(get(actual, check.path), check.equals, row.id + ': ' + check.path);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); journal?.close(); f.cleanup(); }
});
