/**
 * `workers.create` with `first_prompt` (Shep P5-3, nubl decisions 2026-11-17): one command, one receipt. The create's
 * receipt names the worker and either the first execution (admission, execution id, disposition) or the prompt's
 * typed refusal with the worker still created; an uncertain create reconciles through `receipts.get` and pi gets the
 * prompt once; a lost pi reply fences the new session on the create, also after a restart. The text is never journaled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import type { EventFrame } from '../src/generated/events.js';
import type { Receipt } from '../src/receipts/receipts.js';
import type { Create, Worker } from '../src/supervisor/state.js';
import { GrantStore, writeBearerFile } from '../src/grants/store.js';
import { bind, fixture, tick, type Fixture, type Host } from './supervisor-fixture.js';
import { ownerGrant, socketCall } from './helpers.js';

const TEXT = 'first words of a new chat, never journaled';

/** The spec's FirstPrompt, text only (declared here so that this file also builds on the revision before it). */
interface FirstPrompt {
  message: string;
}

function createRequest(f: Fixture, commandId: string, firstPrompt: FirstPrompt | undefined): Create {
  const cwd = join(f.dir, `cwd-${commandId}`);
  mkdirSync(cwd);
  const extra = firstPrompt ? { first_prompt: firstPrompt } : {};
  return { command_id: commandId, cwd, provider: 'p', model: 'm', thinking: 'off', ...extra };
}

const prompts = (host: Host) => host.commands.filter(c => c.type === 'prompt');

async function serve(f: Fixture): Promise<{ socket: string; headers: Record<string, string>; grants: GrantStore; close: () => Promise<void> }> {
  const owner = ownerGrant(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, piVersion: '1.5.2', grants: owner.grants }).handle);
  const socket = join(f.dir, `b2-${Math.random().toString(16).slice(2)}.sock`);
  await listenPrivate(server, socket);
  return {
    socket,
    headers: owner.headers,
    grants: owner.grants,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Polls `check` every 10 ms; fails by assertion (never hangs) after `ms`. */
async function eventually<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

test('first_prompt: admitted, the create receipt names the worker and its first execution, under the create command; the text is never journaled', async () => {
  const f = fixture();
  try {
    const frames: EventFrame[] = [];
    const sub = f.supervisor.subscribe(frame => {
      frames.push(frame);
    });
    const receipt = await f.supervisor.create(createRequest(f, 'new-chat', { message: TEXT }));
    sub.close();
    assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
    assert.equal(receipt.effect, 'observed');
    assert.equal(receipt.admission, 'accepted');
    assert.equal(receipt.disposition, 'started');
    assert.equal(receipt.error, undefined);
    const w = f.supervisor.get(receipt.worker_id!);
    assert.equal(w.status, 'ready');
    assert.deepEqual(receipt.result?.worker_id, w.worker_id);
    assert.deepEqual([receipt.result?.worker_epoch, receipt.result?.session_id, receipt.result?.binding_revision], [w.worker_epoch, w.session_id, w.binding_revision]);
    // The receipt names the execution the worker runs; the execution's command is the create.
    assert.ok(receipt.execution_id);
    assert.deepEqual([w.execution?.execution_id, w.execution?.command_id], [receipt.execution_id, 'new-chat']);
    const host = f.hosts[0]!;
    assert.equal(host.prompts, 1);
    assert.deepEqual(
      prompts(host).map(c => [c.message, c.command_id, c.execution_id]),
      [[TEXT, 'new-chat', receipt.execution_id]],
    );
    const admitted = frames.filter(x => x.type === 'execution.admitted');
    assert.deepEqual(
      admitted.map(x => [x.execution_id, (x.data as { command_id: string }).command_id]),
      [[receipt.execution_id, 'new-chat']],
    );
    // It settles like any execution: the settlement names the create.
    host.emit('event', { type: 'agent_settled' });
    assert.deepEqual(
      f.supervisor.get(w.worker_id).recent_settlements!.map(x => [x.execution_id, x.command_id]),
      [[receipt.execution_id, 'new-chat']],
    );
    // A worker record keeps the create without its prompt; the receipt keeps only the request hash.
    assert.equal(readFileSync(f.journalFile, 'utf8').includes(TEXT), false, 'the first prompt text is in the journal');
  } finally {
    f.cleanup();
  }
});

test('first_prompt: refused at admission, the worker is still created and the create receipt names the typed refusal; no execution, nothing reaches pi', async () => {
  const f = fixture();
  try {
    const cases: [string, FirstPrompt, string][] = [
      ['slash-chat', { message: '/compact' }, 'slash_commands_use_typed_methods'],
    ];
    for (const [id, first, error] of cases) {
      const receipt = await f.supervisor.create(createRequest(f, id, first));
      assert.equal(receipt.state, 'delivered', `${id}: ${JSON.stringify(receipt)}`);
      assert.equal(receipt.effect, 'observed', id);
      assert.equal(receipt.admission, 'rejected', id);
      assert.equal(receipt.error, error, id);
      assert.equal(receipt.execution_id, undefined, id);
      assert.equal(receipt.disposition, undefined, id);
      const w = f.supervisor.get(receipt.worker_id!);
      assert.deepEqual([w.status, w.foreground, w.execution, w.fence], ['ready', 'idle', null, null], id);
      assert.equal(receipt.result?.worker_id, w.worker_id, id);
      const host = f.hosts.at(-1)!;
      assert.equal(host.prompts, 0, `${id}: nothing reached pi`);
    }
    // The caller keeps the draft and sends it as an ordinary prompt.
    const w = f.supervisor.get(f.supervisor.receipts.all.get('slash-chat')!.worker_id!);
    const retry = await f.supervisor.prompt(w.worker_id, { ...bind(w, 'draft-again'), message: 'look again' });
    assert.equal(retry.state, 'delivered');
    assert.equal(f.hosts.at(-1)!.prompts, 1);
  } finally {
    f.cleanup();
  }
});

test('first_prompt: refused by pi before any input hook, the create receipt names the refusal and no execution (PR #20 GPT 7)', async () => {
  const f = fixture({
    initHost: host => {
      const answer = host.request.bind(host);
      // The SDK child refuses a busy pi before its input hooks (sdk-child main.ts `pi_busy`): proof nothing ran.
      host.request = async c => (c.type === 'prompt' ? { type: 'response', id: 'x', success: false, error: 'pi_busy', refused: 'before_input' } : answer(c));
    },
  });
  try {
    const receipt = await f.supervisor.create(createRequest(f, 'busy-chat', { message: TEXT }));
    assert.deepEqual([receipt.state, receipt.effect, receipt.admission], ['delivered', 'observed', 'rejected'], JSON.stringify(receipt));
    assert.match(receipt.error ?? '', /pi_busy/);
    assert.equal(receipt.execution_id, undefined, 'no execution exists, so the receipt names none');
    assert.equal(receipt.disposition, undefined);
    const w = f.supervisor.get(receipt.worker_id!);
    assert.deepEqual([w.status, w.foreground, w.execution, w.fence], ['ready', 'idle', null, null]);
    assert.equal(receipt.result?.worker_id, w.worker_id);
    // The durable receipt and a duplicate create say the same.
    assert.deepEqual(f.supervisor.receipts.all.get('busy-chat'), receipt);
    const records = f.state.journal.records.filter(r => r.kind === 'receipt' && (r.value as Receipt).command_id === 'busy-chat');
    assert.equal((records.at(-1)!.value as Receipt).execution_id, undefined, 'the journaled final record names no execution');
  } finally {
    f.cleanup();
  }
});

test('first_prompt: an uncertain create (its reply lost after the write) reconciles through receipts.get, and pi gets the prompt once', async () => {
  let release!: () => void;
  const held = new Promise<void>(r => (release = r));
  const f = fixture({
    initHost: host => {
      const answer = host.request.bind(host);
      // pi takes its time with the first prompt: the create is still in flight when the caller gives up.
      host.request = async c => {
        if (c.type === 'prompt') await held;
        return answer(c);
      };
    },
  });
  const s = await serve(f);
  try {
    const body = createRequest(f, 'lost-reply', { message: TEXT });
    const data = JSON.stringify(body);
    // The caller writes the create, then loses the connection: after the write its outcome is unknown.
    const req = request({
      socketPath: s.socket,
      method: 'POST',
      path: '/b2/workers',
      agent: false,
      headers: { ...s.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    });
    req.on('error', () => {});
    req.end(data);
    const get = async () => {
      const r = await socketCall(s.socket, 'GET', '/b2/receipts/lost-reply', undefined, s.headers);
      return r.status === 200 ? (r.body as Receipt) : undefined;
    };
    // It reads the receipt: the execution is named before pi has answered.
    const pending = await eventually('the receipt to name the execution', async () => {
      const r = await get();
      return r?.execution_id ? r : undefined;
    });
    req.destroy();
    assert.equal(pending.state, 'accepted');
    assert.ok(pending.worker_id);
    // A duplicate of the in-flight create joins it; nothing is sent twice.
    const duplicate = socketCall(s.socket, 'POST', '/b2/workers', body, s.headers);
    release();
    const done = await eventually('the receipt to be final', async () => {
      const r = await get();
      return r?.state === 'delivered' ? r : undefined;
    });
    assert.deepEqual([done.worker_id, done.execution_id, done.admission, done.disposition], [pending.worker_id, pending.execution_id, 'accepted', 'started']);
    assert.deepEqual((await duplicate).body, done);
    // A duplicate after it is final returns the same receipt.
    assert.deepEqual((await socketCall(s.socket, 'POST', '/b2/workers', body, s.headers)).body, done);
    await tick();
    assert.equal(f.hosts.length, 1, 'one worker');
    assert.equal(f.hosts[0]!.prompts, 1, 'pi got the first prompt once');
    assert.equal(prompts(f.hosts[0]!).length, 1);
  } finally {
    release();
    await s.close();
    f.cleanup();
  }
});

test('first_prompt: a lost pi reply ends the create outcome_unknown with the worker and execution, and fences the new session on the create, also after a restart', async () => {
  const f = fixture({
    initHost: host => {
      host.failure = true;
    },
  });
  try {
    const body = createRequest(f, 'unknown-chat', { message: TEXT });
    const receipt = await f.supervisor.create(body);
    assert.deepEqual([receipt.state, receipt.stage, receipt.effect], ['outcome_unknown', 'unknown', 'unknown'], JSON.stringify(receipt));
    assert.ok(receipt.worker_id && receipt.execution_id, 'the receipt names the worker and the execution');
    assert.equal(receipt.result?.worker_id, receipt.worker_id);
    const id = receipt.worker_id;
    const check = (w: Worker, where: string) => {
      assert.equal(w.fence?.command_id, 'unknown-chat', `${where}: fenced on the create`);
      assert.deepEqual(w.fence?.uncertain_command_ids, ['unknown-chat'], where);
    };
    const w = f.supervisor.get(id);
    assert.equal(w.status, 'ready', 'the worker is created');
    assert.deepEqual([w.execution?.execution_id, w.execution?.state], [receipt.execution_id, 'outcome_unknown']);
    check(w, 'live');
    // The fence is durable: the worker's latest journaled row carries it.
    const rows = f.state.journal.records.filter(r => r.kind === 'worker').map(r => (r.value as { worker: Worker }).worker);
    check(rows.filter(x => x.worker_id === id).at(-1)!, 'journal');
    // A session write is refused naming the create.
    await assert.rejects(f.supervisor.prompt(id, { ...bind(w, 'next'), message: 'next' }), (e: Error & { uncertain_command_id?: string }) => e.message === 'session_fenced' && e.uncertain_command_id === 'unknown-chat');
    // The receipt is readable and a duplicate create never prompts again.
    assert.deepEqual(f.supervisor.receipts.all.get('unknown-chat'), receipt);
    assert.deepEqual(await f.supervisor.create(body), receipt);
    assert.equal(f.hosts.length, 1);
    assert.equal(f.hosts[0]!.prompts, 1);
    // pi settles the execution later; the create's outcome stays unknown, and a restart fences the session again.
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    assert.equal(f.supervisor.get(id).execution?.state, 'settled');
    await f.restart();
    check(f.supervisor.get(id), 'after restart');
    assert.equal(f.supervisor.receipts.all.get('unknown-chat')?.state, 'outcome_unknown');
  } finally {
    f.cleanup();
  }
});

test('first_prompt: a crash after pi settled the first prompt but before its reply: recovery fences the new session on the create', async () => {
  let release!: () => void;
  const held = new Promise<void>(r => (release = r));
  const f = fixture({
    initHost: host => {
      const answer = host.request.bind(host);
      // pi runs and settles the prompt; its reply has not come back when the supervisor dies.
      host.request = async c => {
        if (c.type === 'prompt') {
          host.emit('event', { type: 'agent_start' });
          host.emit('event', { type: 'agent_settled' });
          await held;
        }
        return answer(c);
      };
    },
  });
  try {
    void f.supervisor.create(createRequest(f, 'crash-chat', { message: TEXT })).catch(() => {});
    const pending = await eventually('the first prompt to settle', () => {
      const r = f.supervisor.receipts.all.get('crash-chat');
      return r?.execution_id && f.supervisor.get(r.worker_id!).execution?.state === 'settled' ? r : undefined;
    });
    assert.equal(pending.state, 'accepted');
    // The supervisor dies here: its journal is closed and a new one recovers from the records.
    await f.restart();
    assert.equal(f.supervisor.receipts.all.get('crash-chat')?.state, 'outcome_unknown');
    const w = f.supervisor.get(pending.worker_id!);
    assert.equal(w.execution?.state, 'settled', 'pi settled it; the create outcome is still unknown');
    assert.equal(w.fence?.command_id, 'crash-chat', 'recovery fences the session on the create');
  } finally {
    release();
    f.cleanup();
  }
});

test('first_prompt: text only, a first prompt with attachments is refused by the schema and creates nothing (P1-19 follow-up 4)', async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const body = { ...createRequest(f, 'photo-chat', { message: 'look at this' }), first_prompt: { message: 'look at this', attachments: [{ attachment_id: 'photo-1' }] } };
    const refused = await socketCall(s.socket, 'POST', '/b2/workers', body, s.headers);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal((refused.body as { effect?: string }).effect, 'no_effect');
    assert.equal(f.hosts.length, 0, 'nothing was created');
    assert.equal(f.supervisor.receipts.all.has('photo-chat'), false);
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('first_prompt: a grant that may create workers but not prompt them sends none', async () => {
  const f = fixture();
  const s = await serve(f);
  try {
    const { token } = s.grants.register({ caller: 'creator', scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods: ['workers.create', 'children.launch', 'receipts.get'], grant_id: 'creator' });
    writeBearerFile(join(f.dir, 'creator.grant.json'), token);
    const headers = { authorization: `Bearer ${token}` };
    const refused = await socketCall(s.socket, 'POST', '/b2/workers', createRequest(f, 'creator-chat', { message: TEXT }), headers);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: 'grant_method_denied', effect: 'no_effect' });
    assert.equal(f.hosts.length, 0, 'nothing was created');
    assert.equal(f.supervisor.receipts.all.has('creator-chat'), false);
    // The same grant creates a worker without one.
    const plain = await socketCall(s.socket, 'POST', '/b2/workers', createRequest(f, 'creator-plain', undefined), headers);
    const parent = f.supervisor.get((plain.body as Receipt).worker_id!);
    assert.equal((plain.body as Receipt).state, 'delivered');
    // An untyped child launch carries a create too: its first prompt needs sessions.prompt as well.
    const run = await f.supervisor.prompt(parent.worker_id, { ...bind(parent, 'parent-run'), message: 'work' });
    const launch = { ...bind(parent, 'child-chat'), execution_id: run.execution_id!, launch: createRequest(f, 'child-create', { message: TEXT }) };
    const child = await socketCall(s.socket, 'POST', `/b2/workers/${parent.worker_id}/children`, launch, headers);
    assert.deepEqual([child.status, child.body], [409, { error: 'grant_method_denied', effect: 'no_effect' }]);
    assert.equal(f.supervisor.receipts.all.has('child-chat'), false);
  } finally {
    await s.close();
    f.cleanup();
  }
});
