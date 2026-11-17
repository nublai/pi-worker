/**
 * Phone features (P1-14, contract 8.1, Shep's S-5): `models.list` and `commands.list` per worker and per cwd before
 * any worker exists, `session.configure` as a session write (fence, stale binding, busy, pi's refusal, a lost reply),
 * the command id pi's session file carries for `observed`, and the worker-owned interrupt marker. The real-pi cases
 * run pi 1.5.2 with HOME and PI_CODING_AGENT_DIR in the test directory and a local provider (no credential, no model).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { parseJournal } from '../src/journal/journal.js';
import { SessionIndex } from '../src/history/session-index.js';
import { INTERRUPT_MARKER } from '../src/history/session-file.js';
import { Host, bind, fixture, tick } from './supervisor-fixture.js';
import { ownerGrant } from './helpers.js';
import { fakeProvider, providerExtension, realPiSupervisor, until } from './real-pi.js';

test('features: models.list and commands.list answer from the worker or from an inventory process for a cwd, in scope', async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const app = createApp({ supervisor: f.supervisor, grants: owner.grants }).handle;
    const memory = createMemoryTransport(app, owner.headers);
    const w = await f.create();
    const models = await memory.request('GET', `/b2/models?worker_id=${w.worker_id}`);
    assert.equal(models.status, 200, JSON.stringify(models.body));
    assert.deepEqual((models.body as { current: unknown; evidence: string }).current, { provider: 'p', id: 'm' });
    assert.equal((models.body as { evidence: string }).evidence, 'pi_worker_process');
    const commands = (await memory.request('GET', `/b2/commands?worker_id=${w.worker_id}`)).body as { commands: { name: string; source: string; invocation: string; method: string | null }[] };
    const byName = new Map(commands.commands.map(c => [c.name, c]));
    assert.deepEqual([byName.get('new')!.invocation, byName.get('new')!.method], ['method', 'sessions.new'], 'a built-in with its own method names it');
    assert.deepEqual([byName.get('model')!.method, byName.get('name')!.method], ['session.configure', 'session.configure']);
    assert.equal(byName.get('login')!.invocation, 'unsupported', 'other built-ins are refused explicitly');
    assert.deepEqual([byName.get('deploy')!.source, byName.get('deploy')!.invocation], ['extension', 'commands.invoke'], 'pi’s own commands are listed');
    // By cwd, before any worker exists: a short-lived inventory process, stopped after it answers.
    const inventory = new Host(f.dir, 'none', join(f.dir, 'none.jsonl'));
    let asked: { cwd: string; trusted: boolean } | undefined;
    // The probe runs in its own test domain: cleaning the domain is what stops it.
    f.supervisor.features.inventory = f.domains.track(launch => {
      asked = { cwd: launch.cwd, trusted: launch.projectTrusted };
      return inventory;
    });
    const cwd = join(f.dir, 'fresh');
    mkdirSync(cwd);
    const byCwd = await memory.request('GET', `/b2/models?cwd=${encodeURIComponent(cwd)}&project_trusted=true`);
    assert.equal(byCwd.status, 200, JSON.stringify(byCwd.body));
    assert.equal((byCwd.body as { evidence: string }).evidence, 'pi_inventory_process');
    assert.deepEqual(asked, { cwd, trusted: true });
    assert.equal(inventory.stops, 1, 'the inventory process is stopped after it answers');
    // Exactly one target; the cwd must be in the grant's cwd scope; a worker outside scope is refused.
    assert.deepEqual((await memory.request('GET', `/b2/commands?worker_id=${w.worker_id}&cwd=${encodeURIComponent(cwd)}`)).body, { error: 'name_exactly_one_of_worker_id_or_cwd', effect: 'no_effect' });
    assert.deepEqual((await memory.request('GET', '/b2/commands')).body, { error: 'name_exactly_one_of_worker_id_or_cwd', effect: 'no_effect' });
    const scoped = owner.grants.register({ caller: 'scoped', scope: { worker_ids: [], cwd_roots: [join(f.dir, 'elsewhere')] }, methods: ['*'] });
    const other = createMemoryTransport(app, { authorization: `Bearer ${scoped.token}` });
    assert.deepEqual((await other.request('GET', `/b2/models?cwd=${encodeURIComponent(cwd)}`)).body, { error: 'grant_scope_denied', effect: 'no_effect' });
    assert.deepEqual((await other.request('GET', `/b2/commands?worker_id=${w.worker_id}`)).body, { error: 'grant_scope_denied', effect: 'no_effect' });
    assert.equal(inventory.stops, 1, 'a refused query never starts an inventory process');
  } finally {
    f.cleanup();
  }
});

test('features: session.configure changes model, thinking and name; refused no_effect under a fence, on a stale binding and while busy', async () => {
  const f = fixture();
  try {
    const owner = ownerGrant(f.dir);
    const memory = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const w = await f.create();
    const host = f.hosts[0]!;
    const configure = (body: Record<string, unknown>) => memory.request('POST', `/b2/workers/${w.worker_id}/configure`, { json: body });
    const ok = await configure({ ...bind(w, 'c1'), model: { provider: 'p', id: 'm2' }, thinking: 'high', name: 'Login bug' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((ok.body as { state: string; result: unknown }).result, { model: { provider: 'p', id: 'm2' }, thinking: 'high', name: 'Login bug' });
    const row = f.supervisor.get(w.worker_id);
    assert.deepEqual([row.model, row.thinking, row.title], [{ provider: 'p', id: 'm2' }, 'high', 'Login bug']);
    const sent = () => host.commands.filter(c => c.type === 'configure').length;
    assert.equal(sent(), 1);
    // Nothing to configure, a stale binding: no_effect, nothing reaches pi, no receipt.
    assert.deepEqual((await configure(bind(row, 'c-empty'))).body, { error: 'nothing_to_configure', effect: 'no_effect' });
    const stale = await configure({ ...bind(row, 'c-stale'), binding_revision: 7, name: 'x' });
    assert.deepEqual([stale.status, (stale.body as { error: string; effect: string }).error, (stale.body as { effect: string }).effect], [409, 'stale_binding', 'no_effect']);
    // Busy: an execution is running.
    const prompt = await f.supervisor.prompt(w.worker_id, { ...bind(row, 'p1'), message: 'hi' });
    assert.equal(prompt.state, 'delivered');
    assert.deepEqual((await configure({ ...bind(row, 'c-busy'), thinking: 'low' })).body, { error: 'worker_busy', effect: 'no_effect' });
    host.emit('event', { type: 'agent_settled' });
    await tick();
    // Fenced: a lost prompt reply; configure is refused naming the uncertain command.
    host.failure = true;
    const lost = await f.supervisor.prompt(w.worker_id, { ...bind(row, 'p-lost'), message: 'lost' });
    host.failure = false;
    assert.equal(lost.state, 'outcome_unknown');
    assert.deepEqual((await configure({ ...bind(row, 'c-fenced'), thinking: 'low' })).body, { error: 'session_fenced', effect: 'no_effect', uncertain_command_id: 'p-lost' });
    assert.equal(sent(), 1, 'no refused configure reached pi');
    for (const id of ['c-empty', 'c-stale', 'c-busy', 'c-fenced']) assert.equal(f.supervisor.receipts.all.has(id), false, `${id} left no receipt`);
  } finally {
    f.cleanup();
  }
});

test('features: a configure pi refused before any change is no_effect; a lost reply is outcome_unknown and fences durably before the receipt', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    host.configureRefusal = 'model_not_available';
    const refused = await f.supervisor.configure(w.worker_id, { ...bind(w, 'c-refused'), model: { provider: 'p', id: 'missing' } });
    host.configureRefusal = null;
    assert.deepEqual([refused.state, refused.effect], ['rejected', 'no_effect']);
    assert.equal(f.supervisor.get(w.worker_id).fence, null, 'pi’s refusal before any change does not fence');
    host.configureFailure = true;
    let journaled: unknown;
    const persist = f.supervisor.state.persist.bind(f.supervisor.state);
    f.supervisor.state.persist = (live, label) => {
      if (label === 'fence.latch') journaled = structuredClone(live.worker.fence);
      return persist(live, label);
    };
    const lost = await f.supervisor.configure(w.worker_id, { ...bind(w, 'c-lost'), thinking: 'low' });
    host.configureFailure = false;
    assert.deepEqual([lost.state, lost.effect], ['outcome_unknown', 'unknown']);
    assert.deepEqual((journaled as { uncertain_command_ids: string[] }).uncertain_command_ids, ['c-lost'], 'the fence is journaled before the receipt returns');
    const records = parseJournal(readFileSync(f.journalFile)).records;
    const fenceAt = records.findIndex(r => r.kind === 'worker' && (r.value.worker as { fence?: { command_id?: string } }).fence?.command_id === 'c-lost');
    const finalAt = records.findIndex(r => r.kind === 'receipt' && r.value.command_id === 'c-lost' && r.value.state === 'outcome_unknown');
    assert.ok(fenceAt >= 0 && finalAt >= 0, 'both records are durable');
    // Survives a restart; only resolve_unknown lifts it.
    await f.restart();
    assert.deepEqual(f.supervisor.get(w.worker_id).fence?.uncertain_command_ids, ['c-lost']);
  } finally {
    f.cleanup();
  }
});

test('features: observed resolution matches the command id and execution stamped in pi’s session file, never another command', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const host = f.hosts[0]!;
    host.failure = true;
    const lost = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'p-lost'), message: 'lost' });
    host.failure = false;
    assert.equal(lost.state, 'outcome_unknown');
    const prompt = host.commands.find(c => c.type === 'prompt')!;
    assert.equal(prompt.command_id, 'p-lost', 'the prompt carries its command id to pi');
    const execution = String(prompt.execution_id);
    assert.equal(execution, f.supervisor.get(w.worker_id).execution!.execution_id);
    const fenced = f.supervisor.get(w.worker_id);
    const resolve = (cmd: string) => f.supervisor.resolveUnknown(w.worker_id, { ...bind(fenced, cmd), uncertain_command_id: 'p-lost', fence_generation: fenced.fence!.fence_generation, disposition: 'observed' });
    // The child's stamps for ANOTHER command are not settlement evidence for this one.
    const file = f.supervisor.state.require(w.worker_id).sessionFile!;
    appendFileSync(file, `${JSON.stringify({ type: 'custom', id: 's0', parentId: null, customType: 'agent_settled', data: { execution_id: execution, command_id: 'someone-else' } })}\n`);
    await assert.rejects(resolve('r-wrong'), /execution_settlement_not_in_session_file_or_fsynced_record/);
    // The exact stamp pi wrote for (execution, command): observed is accepted from the session file alone.
    appendFileSync(file, `${JSON.stringify({ type: 'custom', id: 's1', parentId: 's0', customType: 'pi-worker.input', data: { command_id: 'p-lost', execution_id: execution, interrupt_marker: false } })}\n`);
    appendFileSync(file, `${JSON.stringify({ type: 'custom', id: 's2', parentId: 's1', customType: 'agent_settled', data: { execution_id: execution, command_id: 'p-lost' } })}\n`);
    const resolved = await resolve('r-ok');
    assert.equal(resolved.state, 'delivered', JSON.stringify(resolved));
    assert.equal(f.supervisor.get(w.worker_id).fence, null);
  } finally {
    f.cleanup();
  }
});

test('features (real pi): the child stamps the command id before the input and the settlement after it, in pi’s own file', { timeout: 60_000 }, async () => {
  const provider = await fakeProvider();
  const f = realPiSupervisor({ 'provider.ts': providerExtension(provider.url) });
  try {
    const id = await f.create();
    const r = await f.s.prompt(id, { ...bind(f.s.get(id), 'stamped'), message: 'hello there' });
    assert.equal(r.state, 'delivered', JSON.stringify(r));
    await until(() => f.s.get(id).foreground === 'idle', 20_000, 'settlement');
    const file = f.s.state.require(id).sessionFile!;
    const entries = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string; id: string; parentId: string; customType?: string; data?: Record<string, unknown>; message?: { role: string } });
    const stamp = entries.find(e => e.customType === 'pi-worker.input')!;
    assert.deepEqual(stamp.data, { command_id: 'stamped', execution_id: r.execution_id, interrupt_marker: false });
    const userAt = entries.findIndex(e => e.type === 'message' && e.message?.role === 'user');
    assert.ok(entries.indexOf(stamp) < userAt, 'the stamp precedes its input');
    const settled = entries.find(e => e.customType === 'agent_settled')!;
    assert.deepEqual(settled.data, { execution_id: r.execution_id, command_id: 'stamped' });
    // The fence's `observed` reader finds exactly this execution and command, nothing else.
    const index = new SessionIndex(file);
    assert.equal(index.hasSettlement(r.execution_id!, 'stamped'), true);
    assert.equal(index.hasSettlement(r.execution_id!, 'other'), false);
    assert.equal(f.s.get(id).settle_count, 1);
    assert.equal(f.s.get(id).preview, 'canned reply');
  } finally {
    await f.cleanup();
    await provider.close();
  }
});

test('features (real pi): the worker owns the interrupt marker: after an aborted turn the model gets it, the stamp keeps the typed text, once', { timeout: 60_000 }, async () => {
  const provider = await fakeProvider();
  const f = realPiSupervisor({ 'provider.ts': providerExtension(provider.url) });
  try {
    const id = await f.create();
    // A run the user stops: the provider holds the reply, then the worker interrupts.
    provider.hold = true;
    const first = await f.s.prompt(id, { ...bind(f.s.get(id), 'first'), message: 'start something long' });
    assert.equal(first.state, 'delivered');
    await until(() => provider.requests.length === 1, 20_000, 'the first model request');
    const stop = await f.s.control(id, bind(f.s.get(id), 'stop-run'), true);
    assert.equal(stop.state, 'delivered', JSON.stringify(stop));
    await until(() => f.s.get(id).foreground === 'idle', 20_000, 'the aborted run settles');
    provider.hold = false;
    // The next turn carries the marker to the model; the receipt says so; the stamp keeps what the user typed.
    const second = await f.s.prompt(id, { ...bind(f.s.get(id), 'second'), message: 'try again please' });
    assert.deepEqual(second.result, { interrupt_marker: true });
    await until(() => provider.requests.length === 2 && f.s.get(id).foreground === 'idle', 20_000, 'the second run');
    const sentMessages = provider.requests[1]!.messages as { role: string; content: { type: string; text?: string }[] }[];
    const lastUser = sentMessages.filter(m => m.role === 'user').at(-1)!;
    assert.equal(lastUser.content.find(c => c.type === 'text')!.text, `${INTERRUPT_MARKER}\ntry again please`, 'the model request carries the marker');
    const entries = readFileSync(f.s.state.require(id).sessionFile!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { customType?: string; data?: Record<string, unknown> });
    const stamps = entries.filter(e => e.customType === 'pi-worker.input').map(e => e.data);
    assert.deepEqual(stamps.at(-1), { command_id: 'second', execution_id: second.execution_id, interrupt_marker: true, display_text: 'try again please' });
    // Once: a turn after a completed run gets no marker.
    const third = await f.s.prompt(id, { ...bind(f.s.get(id), 'third'), message: 'and one more' });
    assert.deepEqual(third.result, { interrupt_marker: false });
    await until(() => provider.requests.length === 3, 20_000, 'the third request');
    const thirdUser = (provider.requests[2]!.messages as { role: string; content: { type: string; text?: string }[] }[]).filter(m => m.role === 'user').at(-1)!;
    assert.equal(thirdUser.content.find(c => c.type === 'text')!.text, 'and one more');
  } finally {
    await f.cleanup();
    await provider.close();
  }
});

test('features (real pi): models and commands for a cwd come from an inventory process that opens no session; configure goes through pi', { timeout: 60_000 }, async () => {
  const provider = await fakeProvider();
  const command = `export default pi => { pi.registerCommand('deploy', { description: 'Deploy it', handler: async () => {} }); };\n`;
  const f = realPiSupervisor({ 'provider.ts': providerExtension(provider.url), 'command.ts': command });
  try {
    const owner = ownerGrant(f.state);
    const memory = createMemoryTransport(createApp({ supervisor: f.s, grants: owner.grants }).handle, owner.headers);
    const models = await memory.request('GET', `/b2/models?cwd=${encodeURIComponent(f.cwd)}`);
    assert.equal(models.status, 200, JSON.stringify(models.body));
    const list = models.body as { models: { provider: string; id: string; input: string[] }[]; evidence: string };
    assert.equal(list.evidence, 'pi_inventory_process');
    assert.deepEqual(list.models.find(m => m.provider === 'piw-test'), { provider: 'piw-test', id: 'echo', name: 'Echo', reasoning: false, input: ['text', 'image'], context_window: 100000, max_tokens: 1000 });
    const commands = (await memory.request('GET', `/b2/commands?cwd=${encodeURIComponent(f.cwd)}`)).body as { commands: { name: string; source: string; description: string | null }[] };
    assert.deepEqual(commands.commands.find(c => c.name === 'deploy'), { name: 'deploy', description: 'Deploy it', source: 'extension', argument_hint: null, invocation: 'commands.invoke', method: null });
    const sessionFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter(n => n.endsWith('.jsonl')) : []);
    assert.deepEqual([...sessionFiles(f.agent), ...sessionFiles(join(f.state, 'sessions')), ...sessionFiles(f.home), ...sessionFiles(f.cwd)], [], 'the inventory process wrote no session file');
    // A worker: its own pi answers, with its current model; configure changes thinking and name through pi.
    const id = await f.create();
    const mine = (await memory.request('GET', `/b2/models?worker_id=${id}`)).body as { current: unknown; thinking: string; evidence: string };
    assert.deepEqual([mine.current, mine.thinking, mine.evidence], [{ provider: 'piw-test', id: 'echo' }, 'off', 'pi_worker_process']);
    const refused = await f.s.configure(id, { ...bind(f.s.get(id), 'c-missing'), model: { provider: 'piw-test', id: 'missing' } });
    assert.deepEqual([refused.state, refused.effect, refused.error], ['rejected', 'no_effect', 'pi_refused_configure: model_not_available'], 'an unavailable model is refused before any change');
    const named = await f.s.configure(id, { ...bind(f.s.get(id), 'c-name'), name: 'Real pi chat' });
    assert.equal(named.state, 'delivered', JSON.stringify(named));
    assert.equal(f.s.get(id).title, 'Real pi chat');
    assert.equal(f.s.get(id).fence, null);
  } finally {
    await f.cleanup();
    await provider.close();
  }
});
