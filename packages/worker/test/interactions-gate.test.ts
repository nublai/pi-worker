/**
 * The production stage-4 gate (P1-10, review F2): pi 1.5.2's SDK in the production child, no credentials and no
 * model. A fixture extension registers pi's scripted faux provider, so a prompt yields a real `write` tool call, and
 * gates that call through the child's opt-in tool gate seam (sdk-child/main.ts). Through public B2 and a real
 * supervisor: the approval is consumed by its exact resolver (stage 3), the supervisor releases it (stage 4) and the
 * tool writes its artifact; a second call whose answering grant is revoked between the answer and the release check
 * is denied and the tool never runs. A series of approvals answered No or cancelled, more than the worker's live
 * capacity, each closes its gate and frees its slot (re-review R1): the worker stays ready, and the next Allow releases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { GrantStore } from '../src/grants/store.js';
import { SdkHost } from '../src/host/host.js';
import type { Interaction } from '../src/interactions/interactions.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import type { Worker } from '../src/supervisor/state.js';
import { privateTmp } from './helpers.js';

/** Scripted turns, each a `write` tool call the gate holds; the extension owns the policy (which tool, digest). */
const gated = (responses: string) => `import { createHash } from 'node:crypto';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
export default pi => {
  const core = createFauxCore({ provider: 'faux', models: [{ id: 'faux-1' }] });
  const call = name => fauxAssistantMessage([fauxToolCall('write', { path: name, content: 'released' })], { stopReason: 'toolUse' });
  core.setResponses(${responses});
  pi.registerProvider('faux', { baseUrl: 'http://127.0.0.1:9', apiKey: 'faux', api: core.api, streamSimple: core.streamSimple,
    models: [{ id: 'faux-1', name: 'faux', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'write') return;
    const digest = createHash('sha256').update(JSON.stringify(event.input)).digest('hex');
    const released = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 45000);
      pi.events.emit('pi-worker:tool-gate', {
        approval: { digest, policy_revision: 'fixture-1', expiry: Date.now() + 60000, operation: 'write', resource: String(event.input.path), environment: ctx.cwd, offered_scope: 'once' },
        title: 'write ' + event.input.path,
        recheck: () => createHash('sha256').update(JSON.stringify(event.input)).digest('hex') === digest,
        respond: value => { clearTimeout(timer); resolve(value); },
      });
    });
    if (!released) return { block: true, reason: 'tool_not_released' };
  });
};
`;
/** Two scripted turns: the first released, the second denied by a revoked grant. */
const GATED = gated(`[call('first.txt'), fauxAssistantMessage('one'), call('second.txt'), fauxAssistantMessage('two')]`);
/** The worker's live interaction capacity (interactions.ts); one more denial than it would hold if denials leaked. */
const CAPACITY = 32;
const DENIALS = CAPACITY + 1;
/** DENIALS turns answered No or cancelled, then one more turn that is allowed. */
const GATED_SERIES = gated(`[...Array.from({ length: ${DENIALS} }, (_, i) => [call('denied-' + i + '.txt'), fauxAssistantMessage('denied')]).flat(), call('allowed.txt'), fauxAssistantMessage('allowed')]`);

/** A receipt once it is final (the release runs after the answer's reply). */
const final = <T extends { state: string }>(r: T | undefined): T | undefined => (r && !['intent', 'accepted'].includes(r.state) ? r : undefined);

async function until<T>(read: () => T | undefined, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

test('interactions (real pi): an extension-gated tool call reaches consumption and release; a revoked answering grant denies the release', { timeout: 120_000 }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const state = join(root, 'state');
  const agent = join(root, 'agent');
  for (const dir of [cwd, state, join(agent, 'extensions')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agent, 'extensions', 'gated.ts'), GATED);
  const opened = openState(state);
  const grants = new GrantStore(state);
  const s = new Supervisor({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: state,
    grants,
    factory: launch =>
      new SdkHost(
        { cwd: launch.cwd, sessionDir: launch.sessionDir, provider: launch.create.provider, model: launch.create.model, thinking: launch.create.thinking, projectTrusted: false },
        { env: { PATH: process.env.PATH, HOME: agent, PI_CODING_AGENT_DIR: agent } },
      ),
  });
  const client = (id: string, methods: string[], person = false) => {
    const { token } = grants.register({ caller: id, grant_id: id, scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods, answers_for_person: person });
    return createMemoryTransport(createApp({ supervisor: s, grants }).handle, { authorization: `Bearer ${token}` });
  };
  try {
    const owner = client('owner', ['*']);
    const created = await owner.request('POST', '/b2/workers', { json: { command_id: 'create', cwd, provider: 'faux', model: 'faux-1', thinking: 'off' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = (created.body as { worker_id: string }).worker_id;
    const row = async () => (await owner.request('GET', `/b2/workers/${id}`)).body as Worker;
    const bind = (w: Worker, command_id: string) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision });
    // The approval card, or the artifact if the tool ran without one (then the assertion below names the failure).
    const card = async (path: string) => {
      const seen = await until(() => s.interactionList(id).find(i => i.kind === 'tool_approval' && i.approval?.resource === path) ?? (existsSync(join(cwd, path)) ? 'ran' : undefined), `${path} approval`);
      assert.notEqual(seen, 'ran', `${path}: the tool ran without an approval`);
      return seen as Interaction;
    };
    const answer = (api: ReturnType<typeof client>, w: Worker, i: Interaction, command: string) =>
      api.request('POST', `/b2/workers/${id}/interactions/answer`, { json: { ...bind(w, command), answer_id: command, interaction_id: i.interaction_id, revision: i.revision, kind: 'tool_approval', outcome: 'answer', value: true } });
    const settled = (n: number) => until(() => (s.state.require(id).worker.execution?.state === 'settled' && s.receipts.all.size >= n ? true : undefined), 'settlement');

    // 1. Consumption and release: stage 3 at the exact resolver, stage 4 at the gate, then the tool runs.
    const first = client('bridge-1', ['interactions.answer_if_current', 'interactions.list'], true);
    let w = await row();
    assert.equal((await owner.request('POST', `/b2/workers/${id}/prompt`, { json: { ...bind(w, 'prompt-1'), message: 'write one' } })).status, 200);
    const one = await card('first.txt');
    assert.equal(existsSync(join(cwd, 'first.txt')), false, 'the tool call is held until its release');
    w = await row();
    const consumed = await answer(first, w, one, 'approve-1');
    assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
    assert.equal((consumed.body as { answer_stage: number }).answer_stage, 3);
    const released = await until(() => final(s.receipts.all.get('approve-1:release')), 'release receipt');
    assert.equal(released.state, 'delivered');
    assert.equal(released.answer_stage, 4);
    assert.equal(released.result?.released, true);
    assert.equal(s.interactionStatus(id, one.interaction_id).status, 'tool_released');
    await until(() => (existsSync(join(cwd, 'first.txt')) ? true : undefined), 'the released tool to write');
    assert.equal(readFileSync(join(cwd, 'first.txt'), 'utf8'), 'released');
    await settled(0);

    // 2. Revocation denial: the answering grant is revoked after its answer is consumed, before the release check.
    const second = client('bridge-2', ['interactions.answer_if_current', 'interactions.list'], true);
    const check = s.interactions.gate.bind(s.interactions);
    s.interactions.gate = (worker, event, writable) => {
      grants.revoke('bridge-2');
      return check(worker, event, writable);
    };
    w = await row();
    assert.equal((await owner.request('POST', `/b2/workers/${id}/prompt`, { json: { ...bind(w, 'prompt-2'), message: 'write two' } })).status, 200);
    const two = await card('second.txt');
    w = await row();
    const consumedTwo = await answer(second, w, two, 'approve-2');
    assert.equal((consumedTwo.body as { answer_stage: number }).answer_stage, 3);
    const denied = await until(() => final(s.receipts.all.get('approve-2:release')), 'denied release receipt');
    assert.equal(denied.state, 'delivered');
    assert.equal(denied.answer_stage, 3);
    assert.equal(denied.result?.released, false);
    assert.equal(s.interactionStatus(id, two.interaction_id).status, 'release_denied');
    await settled(0);
    assert.equal(existsSync(join(cwd, 'second.txt')), false, 'a denied release never runs the tool');
    assert.equal((await row()).fence, null);
  } finally {
    await s.shutdown();
    opened.close();
    tmp.cleanup();
  }
});

test('interactions (real pi): gate_release for no live gate is a correlated denial, not a failed command', { timeout: 60_000 }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  for (const dir of ['cwd', 'agent', 'sessions']) mkdirSync(join(root, dir));
  const host = new SdkHost(
    { cwd: join(root, 'cwd'), sessionDir: join(root, 'sessions'), provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', projectTrusted: false },
    { env: { PATH: process.env.PATH, HOME: join(root, 'agent'), PI_CODING_AGENT_DIR: join(root, 'agent') } },
  );
  try {
    assert.equal((await host.request({ type: 'inventory' })).success, true);
    const reply = await host.request({ type: 'gate_release', gate_token: 'none', digest: 'd', allowed: true });
    assert.equal(reply.success, true);
    assert.deepEqual(reply.data, { released: false });
  } finally {
    await host.stop();
    tmp.cleanup();
  }
});

test('interactions (real pi): more approvals answered No or cancelled than the live capacity each close their gate; the worker stays ready and the next Allow releases', { timeout: 300_000 }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const state = join(root, 'state');
  const agent = join(root, 'agent');
  for (const dir of [cwd, state, join(agent, 'extensions')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agent, 'extensions', 'gated.ts'), GATED_SERIES);
  const opened = openState(state);
  const grants = new GrantStore(state);
  const s = new Supervisor({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: state,
    grants,
    factory: launch =>
      new SdkHost(
        { cwd: launch.cwd, sessionDir: launch.sessionDir, provider: launch.create.provider, model: launch.create.model, thinking: launch.create.thinking, projectTrusted: false },
        { env: { PATH: process.env.PATH, HOME: agent, PI_CODING_AGENT_DIR: agent } },
      ),
  });
  const { token } = grants.register({ caller: 'owner', grant_id: 'owner', scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods: ['*'], answers_for_person: true });
  const api = createMemoryTransport(createApp({ supervisor: s, grants }).handle, { authorization: `Bearer ${token}` });
  try {
    const created = await api.request('POST', '/b2/workers', { json: { command_id: 'create', cwd, provider: 'faux', model: 'faux-1', thinking: 'off' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = (created.body as { worker_id: string }).worker_id;
    const row = async () => (await api.request('GET', `/b2/workers/${id}`)).body as Worker;
    const bind = (w: Worker, command_id: string) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision });
    // The approval card; a worker that faulted instead (a leaked slot) or a tool that ran without one names the failure.
    const card = async (path: string) => {
      const seen = await until(
        () => s.interactionList(id).find(i => i.kind === 'tool_approval' && i.approval?.resource === path) ?? (existsSync(join(cwd, path)) ? 'ran' : s.get(id).status !== 'ready' ? 'faulted' : undefined),
        `${path} approval`,
      );
      assert.notEqual(seen, 'ran', `${path}: the tool ran without an approval`);
      const w = s.get(id);
      assert.notEqual(seen, 'faulted', `${path}: worker ${w.status}, failure ${JSON.stringify(w.failure ?? null)}`);
      return seen as Interaction;
    };
    const turn = async (n: string, path: string) => {
      const w = await row();
      assert.equal((await api.request('POST', `/b2/workers/${id}/prompt`, { json: { ...bind(w, `prompt-${n}`), message: `write ${path}` } })).status, 200);
      return card(path);
    };
    const settled = (n: string) => until(() => (s.receipts.all.get(`prompt-${n}`) && s.state.require(id).worker.execution?.command_id === `prompt-${n}` && s.state.require(id).worker.execution?.state === 'settled' ? true : undefined), `turn ${n} settlement`);

    const denials: string[] = [];
    for (let n = 0; n < DENIALS; n++) {
      const path = `denied-${n}.txt`;
      const i = await turn(String(n), path);
      const cancel = n % 2 === 1;
      const w = await row();
      const command = `deny-${n}`;
      const answered = await api.request('POST', `/b2/workers/${id}/interactions/answer`, {
        json: { ...bind(w, command), answer_id: command, interaction_id: i.interaction_id, revision: i.revision, kind: 'tool_approval', outcome: cancel ? 'cancel' : 'answer', ...(cancel ? {} : { value: false }) },
      });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      assert.equal((answered.body as { answer_stage: number }).answer_stage, 3, `${path}: consumed by the exact resolver, honestly stage 3`);
      // The child sends the gate's terminal notification before the denial reaches the tool, so by the turn's
      // settlement it has settled the approval: closed, still stage 3, no release command.
      await settled(String(n));
      const ended = s.interactionStatus(id, i.interaction_id);
      assert.equal(ended.status, 'gate_closed', `${path}: the ended gate still holds a live slot`);
      assert.equal(ended.outcome, cancel ? 'cancel' : 'no');
      assert.equal(ended.answer_stage, 3, 'a denial never becomes stage 4');
      assert.equal(s.receipts.all.has(`${command}:release`), false, 'a gate that was never allowed asks for no release');
      assert.equal(existsSync(join(cwd, path)), false, `${path}: a denied tool never runs`);
      denials.push(i.interaction_id);
    }
    let w = await row();
    assert.equal(w.status, 'ready', `after ${DENIALS} denials: ${JSON.stringify(w.failure ?? null)}`);
    assert.equal(w.fence, null);
    assert.deepEqual(s.interactionList(id), []);
    for (const interaction of denials) assert.equal(s.interactionStatus(id, interaction).status, 'gate_closed');

    // The next approval still opens, and an Allow still reaches stage 4 and the tool's artifact.
    const allowed = await turn('allowed', 'allowed.txt');
    w = await row();
    const consumed = await api.request('POST', `/b2/workers/${id}/interactions/answer`, {
      json: { ...bind(w, 'allow'), answer_id: 'allow', interaction_id: allowed.interaction_id, revision: allowed.revision, kind: 'tool_approval', outcome: 'answer', value: true },
    });
    assert.equal((consumed.body as { answer_stage: number }).answer_stage, 3);
    const released = await until(() => final(s.receipts.all.get('allow:release')), 'release receipt');
    assert.equal(released.answer_stage, 4);
    await until(() => (existsSync(join(cwd, 'allowed.txt')) ? true : undefined), 'the released tool to write');
    assert.equal(s.interactionStatus(id, allowed.interaction_id).status, 'tool_released');
    await settled('allowed');
    assert.equal((await row()).status, 'ready');
  } finally {
    await s.shutdown();
    opened.close();
    tmp.cleanup();
  }
});
