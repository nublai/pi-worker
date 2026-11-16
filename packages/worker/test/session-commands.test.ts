/**
 * Session commands (P1-15): `sessions.compact`, `resources.reload` and `commands.invoke` over B2. Each is a session
 * write: fence, busy and stale-binding refusals are `no_effect` before any record; built-ins with their own method are
 * refused `use_method`; pi's refusal before any change is `no_effect`; a lost reply is `outcome_unknown` and fences
 * durably before the receipt. The real-pi cases run pi 1.5.2 with HOME and PI_CODING_AGENT_DIR in the test directory:
 * a reload and an extension command with no model, and a compaction whose summary comes from a local provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { parseJournal } from '../src/journal/journal.js';
import { bind, fixture, tick } from './supervisor-fixture.js';
import { ownerGrant } from './helpers.js';
import { fakeProvider, providerExtension, realPiSupervisor, until } from './real-pi.js';

const METHODS = [
  { op: 'compact', path: 'compact', host: 'compact', extra: { custom_instructions: 'keep TODOs' } },
  { op: 'reload', path: 'reload', host: 'reload', extra: {} },
  { op: 'invoke', path: 'commands/invoke', host: 'invoke', extra: { name: 'deploy', args: 'staging' } },
] as const;

test('session-commands: compact, reload and invoke reach pi once after their dispatch record, with their results', async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const memory = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const w = await f.create();
    const host = f.hosts[0]!;
    for (const m of METHODS) {
      let dispatched = false;
      host.before = c => {
        if (c.type === m.host) dispatched = f.supervisor.receipts.all.get(`${m.op}-1`)?.state === 'accepted';
      };
      const r = await memory.request('POST', `/b2/workers/${w.worker_id}/${m.path}`, { json: { ...bind(f.supervisor.get(w.worker_id), `${m.op}-1`), ...m.extra } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((r.body as { state: string }).state, 'delivered', m.op);
      assert.ok(dispatched, `${m.op}: the dispatch record is durable before pi gets the command`);
      // A duplicate returns the stored receipt and reaches pi no second time.
      const again = await memory.request('POST', `/b2/workers/${w.worker_id}/${m.path}`, { json: { ...bind(f.supervisor.get(w.worker_id), `${m.op}-1`), ...m.extra } });
      assert.deepEqual(again.body, r.body);
      assert.equal(host.commands.filter(c => c.type === m.host).length, 1, `${m.op} reached pi once`);
    }
    host.before = () => {};
    assert.deepEqual(f.supervisor.receipts.all.get('compact-1')!.result, { tokens_before: 1234, first_kept_entry_id: null });
    assert.deepEqual(f.supervisor.receipts.all.get('reload-1')!.result, { extension_errors: [] });
    assert.deepEqual(f.supervisor.receipts.all.get('invoke-1')!.result, { disposition: 'handled' });
    assert.deepEqual(host.commands.find(c => c.type === 'invoke'), { type: 'invoke', name: 'deploy', args: 'staging' });
    assert.deepEqual(host.commands.find(c => c.type === 'compact'), { type: 'compact', customInstructions: 'keep TODOs' });
    // commands.list now offers extension commands through commands.invoke and compact and reload as methods.
    const listed = (await memory.request('GET', `/b2/commands?worker_id=${w.worker_id}`)).body as { commands: { name: string; invocation: string; method: string | null }[] };
    const by = new Map(listed.commands.map(c => [c.name, c]));
    assert.equal(by.get('deploy')!.invocation, 'commands.invoke');
    assert.deepEqual([by.get('compact')!.method, by.get('reload')!.method], ['sessions.compact', 'resources.reload']);
  } finally {
    f.cleanup();
  }
});

test('session-commands: fence, busy and stale-binding refusals are no_effect before any record, and nothing reaches pi', async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const memory = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const w = await f.create();
    const host = f.hosts[0]!;
    const send = (m: (typeof METHODS)[number], cmd: string, binding = bind(f.supervisor.get(w.worker_id), cmd)) =>
      memory.request('POST', `/b2/workers/${w.worker_id}/${m.path}`, { json: { ...binding, ...m.extra } });
    const reached = () => host.commands.filter(c => ['compact', 'reload', 'invoke'].includes(c.type)).length;
    for (const m of METHODS) {
      const stale = await send(m, `${m.op}-stale`, { ...bind(f.supervisor.get(w.worker_id), `${m.op}-stale`), binding_revision: 9 });
      assert.deepEqual([stale.status, (stale.body as { error: string }).error, (stale.body as { effect: string }).effect], [409, 'stale_binding', 'no_effect'], m.op);
    }
    // Busy: an execution runs.
    await f.supervisor.prompt(w.worker_id, { ...bind(f.supervisor.get(w.worker_id), 'p1'), message: 'hi' });
    for (const m of METHODS) assert.deepEqual((await send(m, `${m.op}-busy`)).body, { error: 'worker_busy', effect: 'no_effect' }, m.op);
    host.emit('event', { type: 'agent_settled' });
    await tick();
    // Fenced: a lost prompt reply.
    host.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(f.supervisor.get(w.worker_id), 'p-lost'), message: 'lost' });
    host.failure = false;
    for (const m of METHODS) assert.deepEqual((await send(m, `${m.op}-fenced`)).body, { error: 'session_fenced', effect: 'no_effect', uncertain_command_id: 'p-lost' }, m.op);
    assert.equal(reached(), 0, 'no refused session command reached pi');
    for (const m of METHODS) for (const k of ['stale', 'busy', 'fenced']) assert.equal(f.supervisor.receipts.all.has(`${m.op}-${k}`), false, `${m.op}-${k} left no receipt`);
  } finally {
    f.cleanup();
  }
});

test('session-commands: a built-in with its own method is refused use_method naming it; other built-ins, skills and unknown names are refused', async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const memory = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const w = await f.create();
    const invoke = (name: string) => memory.request('POST', `/b2/workers/${w.worker_id}/commands/invoke`, { json: { ...bind(w, `invoke-${name}`), name } });
    for (const [name, method] of [['new', 'sessions.new'], ['model', 'session.configure'], ['compact', 'sessions.compact'], ['reload', 'resources.reload'], ['tree', 'sessions.rebind']] as const) {
      assert.deepEqual((await invoke(name)).body, { error: 'use_method', effect: 'no_effect', detail: method }, name);
    }
    for (const name of ['login', 'quit', 'skill:review']) assert.deepEqual((await invoke(name)).body, { error: 'unsupported_command', effect: 'no_effect' }, name);
    assert.deepEqual((await invoke('not-registered')).body, { error: 'unknown_command', effect: 'no_effect' });
    assert.equal(f.hosts[0]!.commands.filter(c => c.type === 'invoke').length, 0);
    assert.equal([...f.supervisor.receipts.all.keys()].filter(k => k.startsWith('invoke-')).length, 0, 'refused before any record');
  } finally {
    f.cleanup();
  }
});

test('session-commands: pi refusing before any change is no_effect; a lost reply is outcome_unknown and fences durably before the receipt', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    const call = (m: (typeof METHODS)[number], cmd: string) => {
      const b = { ...bind(f.supervisor.get(w.worker_id), cmd), ...m.extra };
      return m.op === 'compact' ? f.supervisor.compact(w.worker_id, b) : m.op === 'reload' ? f.supervisor.reload(w.worker_id, b) : f.supervisor.invoke(w.worker_id, b as never);
    };
    let generation = 0;
    for (const m of METHODS) {
      host.commandRefusal = 'pi_busy';
      const refused = await call(m, `${m.op}-refused`);
      host.commandRefusal = null;
      assert.deepEqual([refused.state, refused.effect], ['rejected', 'no_effect'], m.op);
      assert.equal(f.supervisor.get(w.worker_id).fence, null, `${m.op}: pi's refusal does not fence`);
      host.commandFailure = true;
      const lost = await call(m, `${m.op}-lost`);
      host.commandFailure = false;
      assert.deepEqual([lost.state, lost.effect], ['outcome_unknown', 'unknown'], m.op);
      const records = parseJournal(readFileSync(f.journalFile)).records;
      const fenceAt = records.findIndex(r => r.kind === 'worker' && ((r.value.worker as { fence?: { uncertain_command_ids?: string[] } }).fence?.uncertain_command_ids ?? []).includes(`${m.op}-lost`));
      assert.ok(fenceAt >= 0, `${m.op}: the fence is durable`);
      const fenced = f.supervisor.get(w.worker_id);
      assert.ok(fenced.fence!.fence_generation > generation);
      generation = fenced.fence!.fence_generation;
      const kept = await f.supervisor.resolveUnknown(w.worker_id, { ...bind(fenced, `resolve-${m.op}`), uncertain_command_id: `${m.op}-lost`, fence_generation: generation, disposition: 'keep' });
      assert.equal(kept.state, 'delivered');
    }
    // A generic negative reply after the dispatch record is no proof that nothing changed: unknown, fenced.
    for (const m of METHODS) {
      host.commandNegative = true;
      const negative = await call(m, `${m.op}-negative`);
      host.commandNegative = false;
      assert.deepEqual([negative.state, negative.effect], ['outcome_unknown', 'unknown'], `${m.op}: a negative reply`);
      const fenced = f.supervisor.get(w.worker_id);
      assert.ok(fenced.fence?.uncertain_command_ids?.includes(`${m.op}-negative`));
      await f.supervisor.resolveUnknown(w.worker_id, { ...bind(fenced, `resolve-neg-${m.op}`), uncertain_command_id: `${m.op}-negative`, fence_generation: fenced.fence!.fence_generation, disposition: 'keep' });
    }
    host.commandFailure = true;
    await call(METHODS[1], 'reload-restart');
    host.commandFailure = false;
    await f.restart();
    assert.ok(f.supervisor.get(w.worker_id).fence?.uncertain_command_ids?.includes('reload-restart'), 'the fence survives a restart');
  } finally {
    f.cleanup();
  }
});

const COMMANDS = (marker: string) => `import { writeFileSync } from 'node:fs';
export default pi => {
  pi.registerCommand('mark', { description: 'Write a marker', handler: async args => { writeFileSync(${JSON.stringify(marker)}, String(args)); } });
};
`;

test('session-commands (real pi): reload picks up a new extension command, which commands.invoke then runs, with no model', { timeout: 60_000 }, async () => {
  // The provider only has to exist for the model lookup at start; nothing here calls a model.
  const f = realPiSupervisor({ 'provider.ts': providerExtension('http://127.0.0.1:9') });
  try {
    const marker = join(f.root, 'marker.txt');
    const id = await f.create();
    const owner = ownerGrant(f.state);
    const memory = createMemoryTransport(createApp({ supervisor: f.s, grants: owner.grants }).handle, owner.headers);
    const before = await memory.request('POST', `/b2/workers/${id}/commands/invoke`, { json: { ...bind(f.s.get(id), 'mark-before'), name: 'mark', args: 'x' } });
    assert.deepEqual(before.body, { error: 'unknown_command', effect: 'no_effect' }, 'not registered yet');
    writeFileSync(join(f.agent, 'extensions', 'mark.ts'), COMMANDS(marker));
    const reload = await f.s.reload(id, bind(f.s.get(id), 'reload'));
    assert.deepEqual([reload.state, reload.result], ['delivered', { extension_errors: [] }], JSON.stringify(reload));
    assert.ok(((f.s.get(id).resources as { extensions: string[] }).extensions).some(e => e.endsWith('mark.ts')), 'the row lists the reloaded extension');
    const listed = (await memory.request('GET', `/b2/commands?worker_id=${id}`)).body as { commands: { name: string; invocation: string }[] };
    assert.equal(listed.commands.find(c => c.name === 'mark')?.invocation, 'commands.invoke');
    // The child checks pi's own registry too: a name pi does not have never becomes a prompt to the model.
    const host = f.s.state.require(id).host!;
    const unknown = await host.request({ type: 'invoke', name: 'not-registered' });
    assert.deepEqual([unknown.success, unknown.refused, unknown.error], [false, 'before_input', 'unknown_command']);
    const run = await f.s.invoke(id, { ...bind(f.s.get(id), 'mark-1'), name: 'mark', args: 'hello from B2' });
    assert.deepEqual([run.state, run.result], ['delivered', { disposition: 'handled' }], JSON.stringify(run));
    assert.equal(readFileSync(marker, 'utf8'), 'hello from B2');
    assert.equal(f.s.get(id).foreground, 'idle');
    assert.equal(f.s.get(id).fence, null);
  } finally {
    await f.cleanup();
  }
});

test('session-commands (real pi): compaction appends pi’s compaction entry, its summary from a local provider; too small is refused no_effect', { timeout: 90_000 }, async () => {
  const provider = await fakeProvider();
  const f = realPiSupervisor({ 'provider.ts': providerExtension(provider.url) });
  try {
    writeFileSync(join(f.agent, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    const id = await f.create();
    // Nothing to compact yet: pi's own precondition, refused before anything ran.
    const early = await f.s.compact(id, bind(f.s.get(id), 'compact-early'));
    assert.deepEqual([early.state, early.effect], ['rejected', 'no_effect'], JSON.stringify(early));
    assert.equal(f.s.get(id).fence, null);
    for (const n of [1, 2]) {
      await f.s.prompt(id, { ...bind(f.s.get(id), `turn-${n}`), message: `turn ${n}: ${'words '.repeat(200)}` });
      await until(() => f.s.get(id).foreground === 'idle' && f.s.get(id).execution?.state === 'settled', 20_000, `turn ${n}`);
    }
    const requests = provider.requests.length;
    const compacted = await f.s.compact(id, { ...bind(f.s.get(id), 'compact-1'), custom_instructions: 'keep it short' });
    assert.equal(compacted.state, 'delivered', JSON.stringify(compacted));
    assert.ok(provider.requests.length > requests, 'the summary came from the local provider');
    const entries = readFileSync(f.s.state.require(id).sessionFile!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string; summary?: string });
    const entry = entries.filter(e => e.type === 'compaction').at(-1);
    assert.ok(entry, 'the compaction entry is in the session file');
    assert.equal(entry.summary?.includes('canned reply'), true);
    assert.equal(f.s.get(id).binding_revision, 1, 'compaction does not move the binding');
    assert.equal(existsSync(f.s.state.require(id).sessionFile!), true);
  } finally {
    await f.cleanup();
    await provider.close();
  }
});
