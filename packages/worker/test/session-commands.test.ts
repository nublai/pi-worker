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
import { bind, fixture, tick, type Host } from './supervisor-fixture.js';
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

/** Holds the host's acknowledgement of every `cancel_ui` until `release()`; `seen` resolves at the first one. */
function holdCancel(host: Host) {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let seen!: () => void;
  const first = new Promise<void>(r => (seen = r));
  const original = host.request.bind(host);
  host.request = async c => {
    if (c.type === 'cancel_ui') {
      seen();
      await gate;
    }
    return original(c);
  };
  return { release, seen: first };
}

const deadline = <T>(p: Promise<T>, ms = 5000) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref())]);

test('session-commands: while a compaction waits on its dialog cancellation, sessions.new, a prompt, configure and another command are refused busy; the compaction reaches the session it named', { timeout: 20_000 }, async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const memory = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const w = await f.create();
    const host = f.hosts[0]!;
    host.emit('event', { type: 'extension_ui_request', id: 'native', method: 'confirm' });
    assert.equal(f.supervisor.interactionList(w.worker_id).length, 1, 'a live dialog');
    const held = holdCancel(host);
    const named = bind(f.supervisor.get(w.worker_id), 'compact-held');
    const compacting = memory.request('POST', `/b2/workers/${w.worker_id}/compact`, { json: named });
    await deadline(held.seen);
    const current = f.supervisor.get(w.worker_id);
    const moved = await memory.request('POST', `/b2/workers/${w.worker_id}/new`, { json: bind(current, 'new-during') });
    assert.deepEqual([moved.status, moved.body], [409, { error: 'binding_change_requires_idle', effect: 'no_effect' }], 'no binding move while a session command owns the binding');
    const prompt = await memory.request('POST', `/b2/workers/${w.worker_id}/prompt`, { json: { ...bind(current, 'prompt-during'), message: 'hi' } });
    assert.deepEqual(prompt.body, { error: 'worker_busy', effect: 'no_effect' }, 'no prompt while a session command runs');
    const configure = await memory.request('POST', `/b2/workers/${w.worker_id}/configure`, { json: { ...bind(current, 'configure-during'), name: 'x' } });
    assert.deepEqual(configure.body, { error: 'worker_busy', effect: 'no_effect' });
    const reload = await memory.request('POST', `/b2/workers/${w.worker_id}/reload`, { json: bind(current, 'reload-during') });
    assert.deepEqual(reload.body, { error: 'worker_busy', effect: 'no_effect' });
    for (const k of ['new-during', 'prompt-during', 'configure-during', 'reload-during']) assert.equal(f.supervisor.receipts.all.has(k), false, `${k} left no record`);
    held.release();
    const r = await deadline(compacting);
    assert.equal((r.body as { state: string }).state, 'delivered', JSON.stringify(r.body));
    const types = host.commands.map(c => c.type);
    assert.equal(types.includes('new_session'), false, 'the move never reached pi');
    assert.equal(types.includes('prompt'), false, 'the prompt never reached pi');
    assert.equal(types.at(-1), 'compact');
    const after = f.supervisor.get(w.worker_id);
    assert.deepEqual([after.session_id, after.binding_revision], [named.session_id, named.binding_revision], 'the compaction ran on the session and revision it named');
    // Once it has ended, the worker takes writes again.
    const fresh = await f.supervisor.newSession(w.worker_id, bind(after, 'new-after'));
    assert.equal(fresh.state, 'delivered');
  } finally {
    f.cleanup();
  }
});

for (const held of ['invoke', 'configure'] as const) {
  test(`session-commands: a prompt or a binding move while ${held === 'invoke' ? 'commands.invoke' : 'session.configure'} waits for its reply is refused busy and never reaches pi`, { timeout: 20_000 }, async () => {
    const f = fixture();
    try {
      const w = await f.create();
      const host = f.hosts[0]!;
      let release!: () => void;
      const gate = new Promise<void>(r => (release = r));
      let seen!: () => void;
      const reached = new Promise<void>(r => (seen = r));
      const original = host.request.bind(host);
      host.request = async c => {
        if (c.type === held) {
          seen();
          await gate;
        }
        return original(c);
      };
      const running = held === 'invoke' ? f.supervisor.invoke(w.worker_id, { ...bind(w, 'held'), name: 'deploy' }) : f.supervisor.configure(w.worker_id, { ...bind(w, 'held'), name: 'renamed' });
      await deadline(reached);
      const refusal = (code: string) => (e: Error & { effect?: string }) => e.message === code && e.effect === 'no_effect';
      await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'prompt-during'), message: 'hi' }), refusal('worker_busy'));
      await assert.rejects(f.supervisor.newSession(w.worker_id, bind(w, 'new-during')), refusal('binding_change_requires_idle'));
      assert.equal(f.supervisor.get(w.worker_id).foreground, 'idle');
      assert.deepEqual(host.commands.filter(c => c.type === 'prompt' || c.type === 'new_session'), [], 'no second write reached pi');
      if (held === 'invoke') {
        // An extension command may ask the person (ctx.ui.confirm) and waits for the answer before pi replies: its
        // dialog stays answerable while the command holds the worker, or the command could never finish.
        host.emit('event', { type: 'extension_ui_request', id: 'asked-by-command', method: 'confirm' });
        const i = f.supervisor.interactionList(w.worker_id).find(x => x.native_id === 'asked-by-command')!;
        const answered = await f.supervisor.answer(w.worker_id, { ...bind(w, 'answer-during'), answer_id: 'answer-during', interaction_id: i.interaction_id, revision: i.revision, kind: i.kind, outcome: 'answer', value: true } as never);
        assert.equal(answered.state, 'delivered', JSON.stringify(answered));
        assert.equal(host.commands.filter(c => c.type === 'answer_ui').length, 1, 'the answer reached the command waiting for it');
      }
      release();
      assert.equal((await deadline(running)).state, 'delivered');
      assert.equal((await f.supervisor.prompt(w.worker_id, { ...bind(w, 'prompt-after'), message: 'hi' })).state, 'delivered', 'free again after the reply');
    } finally {
      f.cleanup();
    }
  });
}

test('session-commands: pi refusing a compaction or reload after the command cancelled a live dialog is outcome_unknown and fences; with no dialog it stays no_effect', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    for (const op of ['compact', 'reload'] as const) {
      const call = (cmd: string) => (op === 'compact' ? f.supervisor.compact(w.worker_id, bind(f.supervisor.get(w.worker_id), cmd)) : f.supervisor.reload(w.worker_id, bind(f.supervisor.get(w.worker_id), cmd)));
      host.commandRefusal = 'nothing_to_compact';
      const plain = await call(`${op}-no-dialog`);
      assert.deepEqual([plain.state, plain.effect], ['rejected', 'no_effect'], `${op}: no dialog, pi's refusal is proof`);
      host.emit('event', { type: 'extension_ui_request', id: `native-${op}`, method: 'confirm' });
      assert.equal(f.supervisor.interactionList(w.worker_id).length, 1);
      const refused = await call(`${op}-dialog`);
      host.commandRefusal = null;
      assert.ok(host.cancelled.includes(`native-${op}`), `${op}: the command cancelled the dialog at its resolver`);
      assert.deepEqual([refused.state, refused.effect], ['outcome_unknown', 'unknown'], `${op}: a cancelled dialog is an effect pi's refusal does not cover`);
      const fenced = f.supervisor.get(w.worker_id);
      assert.ok(fenced.fence?.uncertain_command_ids?.includes(`${op}-dialog`), `${op}: fenced`);
      const records = parseJournal(readFileSync(f.journalFile)).records;
      assert.ok(records.some(r => r.kind === 'worker' && ((r.value.worker as { fence?: { uncertain_command_ids?: string[] } }).fence?.uncertain_command_ids ?? []).includes(`${op}-dialog`)), `${op}: the fence is durable`);
      await f.supervisor.resolveUnknown(w.worker_id, { ...bind(fenced, `resolve-${op}`), uncertain_command_id: `${op}-dialog`, fence_generation: fenced.fence!.fence_generation, disposition: 'keep' });
    }
  } finally {
    f.cleanup();
  }
});

test('session-commands: a native move while a compaction cancels its dialogs keeps the compaction from pi; outcome_unknown, fenced', { timeout: 20_000 }, async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    host.emit('event', { type: 'extension_ui_request', id: 'native', method: 'confirm' });
    const held = holdCancel(host);
    const compacting = f.supervisor.compact(w.worker_id, bind(w, 'compact-native'));
    await deadline(held.seen);
    // The dialog's continuation moves pi to another session.
    host.emit('event', { type: 'host_binding_changing' });
    const file = join(f.dir, 'native.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'native-session' })}\n`);
    host.emit('event', { type: 'host_binding', action: 'replace', sessionId: 'native-session', sessionFile: file, leafId: null });
    held.release();
    const r = await deadline(compacting);
    assert.deepEqual([r.state, r.effect], ['outcome_unknown', 'unknown'], JSON.stringify(r));
    assert.equal(host.commands.filter(c => c.type === 'compact').length, 0, 'the compaction never reached the session the request did not name');
    assert.ok(f.supervisor.get(w.worker_id).fence?.uncertain_command_ids?.includes('compact-native'));
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
