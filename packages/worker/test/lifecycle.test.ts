/**
 * Worker lifecycle (P1-4): create, list, get and stop over B2; one live writer per session and one worker per cwd,
 * refused naming the holder; a restart kills the old pi process group and records cleanup_pending. Ported cases from
 * A0 `src/test/fix-round.test.ts` (m-1) and `src/test/supervisor.test.ts` (history pages) keep every assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, ClientFailure } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { Refusal } from '../src/b2/errors.js';
import { SessionIndex } from '../src/history/session-index.js';
import { LineHost, SdkHost } from '../src/host/host.js';
import { procInfo } from '../src/host/process.js';
import { parseJournal } from '../src/journal/journal.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import type { Live, Worker } from '../src/supervisor/state.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { ownerGrant, privateTmp } from './helpers.js';
import { bind, fixture, Host } from './supervisor-fixture.js';

const create = (cwd: string, command_id = 'create') => ({ command_id, cwd, provider: 'test', model: 'test', thinking: 'off' as const });
const latestWorker = (file: string, id: string): Worker =>
  parseJournal(readFileSync(file)).records.filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === id).at(-1)!.value.worker as Worker;

test('lifecycle: create, duplicate create, list, get and stop over the B2 socket; the stopped cwd stays reserved', async () => {
  const f = fixture();
  const owner = ownerGrant(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle);
  const socketPath = join(f.dir, 'b2.sock');
  try {
    await listenPrivate(server, socketPath);
    const client = new Client({ socketPath, grantFile: owner.file });
    const cwd = join(f.dir, 'work');
    mkdirSync(cwd);
    const created = await client.call('workers.create', { body: create(cwd) });
    assert.equal(created.state, 'delivered');
    assert.deepEqual(await client.call('workers.create', { body: create(cwd) }), created, 'a duplicate command returns the stored receipt');
    assert.equal(f.hosts.length, 1, 'and launches nothing');
    const id = created.worker_id!;
    const w = await client.call('workers.get', { path: { worker_id: id } });
    assert.equal(w.status, 'ready');
    assert.equal(w.session_id, 'session-0');
    assert.equal(w.session_identity_evidence, 'pi_session_file', 'the session file header confirms the identity');
    assert.equal(w.binding_revision, 1);
    assert.equal(w.host, 'sdk');
    assert.deepEqual(
      (await client.call('workers.list')).map(x => x.worker_id),
      [id],
    );
    await assert.rejects(
      client.call('workers.stop', { path: { worker_id: id }, body: { ...bind(w, 'stale-stop'), binding_revision: 2 } }),
      (e: unknown) => e instanceof ClientFailure && e.message === 'stale_binding' && e.effect === 'no_effect' && e.details.received_binding_revision === 2,
    );
    const stopped = await client.call('workers.stop', { path: { worker_id: id }, body: bind(w, 'stop') });
    assert.equal(stopped.state, 'delivered');
    assert.equal(stopped.result?.termination, 'observed_stopped');
    assert.equal(f.hosts[0]!.stops, 1);
    const after = await client.call('workers.get', { path: { worker_id: id } });
    assert.equal(after.status, 'stopped');
    assert.match(after.cleanup, /escaped_descendants_unproven/);
    await assert.rejects(
      client.call('workers.create', { body: create(cwd, 'replacement') }),
      (e: unknown) => e instanceof ClientFailure && e.message === 'exclusive_environment_already_bound' && e.effect === 'no_effect' && e.details.holder_worker_id === id,
    );
    assert.equal(f.supervisor.receipts.all.has('replacement'), false, 'a refusal before dispatch leaves no receipt');
    await assert.rejects(client.call('workers.get', { path: { worker_id: 'nobody' } }), /unknown_worker/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    f.cleanup();
  }
});

test('lifecycle: one live writer per session; a duplicate open is refused naming the holder, before any spawn', async () => {
  const f = fixture();
  try {
    const a = await f.create();
    const other = join(f.dir, 'other');
    mkdirSync(other);
    const before = readFileSync(f.journalFile);
    await assert.rejects(
      f.supervisor.create({ ...create(other, 'duplicate-open'), resume_session_id: a.session_id! }),
      (e: unknown) => e instanceof Refusal && e.message === 'session_already_bound' && e.effect === 'no_effect' && e.details.holder_worker_id === a.worker_id,
    );
    assert.deepEqual(readFileSync(f.journalFile), before, 'nothing journaled');
    assert.equal(f.hosts.length, 1, 'nothing spawned');
    await assert.rejects(f.supervisor.create({ ...create(other, 'unknown-session'), resume_session_id: 'never-seen' }), /unknown_session/);
    // Once the holder moves to another session (its process group live and accounted for), another worker in
    // another cwd may resume the archived session. A stopped holder's session is not resumable in P1: see below.
    assert.equal((await f.supervisor.newSession(a.worker_id, bind(a, 'archive-a'))).state, 'delivered');
    const resumed = await f.supervisor.create({ ...create(other, 'resume'), resume_session_id: a.session_id! });
    assert.equal(resumed.state, 'delivered', JSON.stringify(resumed));
    const b = f.supervisor.get(resumed.worker_id!);
    assert.equal(b.session_id, a.session_id);
    assert.equal(b.binding_revision, 1);
    assert.deepEqual(
      f.hosts[1]!.commands.filter(c => c.type === 'switch_session').map(c => c.sessionPath),
      [join(f.dir, 'session-0.jsonl')],
    );
  } finally {
    f.cleanup();
  }
});

test('lifecycle: create-with-resume over B2 applies the session gates: unproven cleanup and an unresolved fence refuse before any spawn', async () => {
  const f = fixture();
  const grant = ownerGrant(f.dir);
  const server = createB2Server(createApp({ supervisor: f.supervisor, grants: grant.grants }).handle);
  const socketPath = join(f.dir, 'b2.sock');
  const dir = (name: string) => {
    const cwd = join(f.dir, name);
    mkdirSync(cwd);
    return cwd;
  };
  try {
    await listenPrivate(server, socketPath);
    const client = new Client({ socketPath, grantFile: grant.file });
    const resume = (name: string, session: string) => client.call('workers.create', { body: { ...create(dir(name), name), resume_session_id: session } });
    const refused = (message: string, uncertain?: string) => (e: unknown) =>
      e instanceof ClientFailure && e.message === message && e.effect === 'no_effect' && (uncertain === undefined || e.details.uncertain_command_id === uncertain);

    // A stopped holder: its process group was observed gone, its escaped descendants are unproven (invariant 2).
    const stopped = await f.create();
    assert.equal((await f.supervisor.stop(stopped.worker_id, bind(stopped, 'stop'))).state, 'delivered');
    assert.match(f.supervisor.get(stopped.worker_id).cleanup, /escaped_descendants_unproven/);
    await assert.rejects(resume('after-stop', stopped.session_id!), refused('target_cleanup_unproven'));

    // A fenced holder that is still live and accounted for: its session stays fenced until resolve_unknown.
    const fenced = await f.create();
    const h = f.hosts.at(-1)!;
    h.failure = true;
    assert.equal((await f.supervisor.prompt(fenced.worker_id, { ...bind(fenced, 'lost'), message: 'x' })).state, 'outcome_unknown');
    h.failure = false;
    // pi moves natively to a new session; the fenced one is archived in the catalog, owned by the fenced worker.
    const file = join(f.dir, 'moved.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'moved' })}\n`);
    h.emit('event', { type: 'host_binding', action: 'replace', sessionId: 'moved', sessionFile: file, leafId: null });
    const owner = f.supervisor.get(fenced.worker_id);
    assert.deepEqual([owner.status, owner.cleanup, owner.session_id, owner.fence?.command_id], ['ready', 'live_process_group', 'moved', 'lost']);
    await assert.rejects(resume('after-fence', fenced.session_id!), refused('target_session_fenced', 'lost'));

    // The review's journey: an unknown prompt, a clean stop, then a resume elsewhere and a new prompt.
    const both = await f.create();
    const hb = f.hosts.at(-1)!;
    hb.failure = true;
    assert.equal((await f.supervisor.prompt(both.worker_id, { ...bind(both, 'lost-2'), message: 'x' })).state, 'outcome_unknown');
    assert.equal((await f.supervisor.stop(both.worker_id, bind(both, 'stop-2'))).state, 'delivered');
    await assert.rejects(resume('after-fence-and-stop', both.session_id!), refused('target_cleanup_unproven'));

    const spawned = f.hosts.length;
    for (const id of ['after-stop', 'after-fence', 'after-fence-and-stop']) assert.equal(f.supervisor.receipts.all.has(id), false, `${id} left no receipt`);
    assert.equal(spawned, 3, 'no refused resume spawned a host');
    assert.equal(f.supervisor.get(fenced.worker_id).fence?.command_id, 'lost', 'the fence is not lifted');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    f.cleanup();
  }
});

test('lifecycle: create-with-resume reserves its target before any open; concurrent creates and rebinds share the reservation', async () => {
  // Every switch_session waits at a gate, so a second open could only be refused before it reaches pi.
  const opens: { host: number; path: unknown }[] = [];
  let release!: () => void;
  let gate = Promise.resolve();
  const hold = () => {
    gate = new Promise<void>(r => (release = r));
  };
  const f = fixture({
    initHost: h => {
      const index = f.hosts.length;
      const native = h.request.bind(h);
      h.request = async c => {
        if (c.type === 'switch_session') {
          opens.push({ host: index, path: c.sessionPath });
          await gate;
        }
        return native(c);
      };
    },
  });
  const dir = (name: string) => {
    const cwd = join(f.dir, name);
    mkdirSync(cwd);
    return cwd;
  };
  const refusedBy = (holder: () => string | undefined) => (e: unknown) =>
    e instanceof Refusal && e.message === 'session_already_bound' && e.effect === 'no_effect' && e.details.holder_worker_id === holder();
  try {
    const a = await f.create();
    // Archive a's first session: its catalog owner stays a live, unfenced worker, so it is resumable.
    assert.equal((await f.supervisor.newSession(a.worker_id, bind(a, 'archive-1'))).state, 'delivered');
    const first = a.session_id!;

    // Two concurrent creates resume the same archived session.
    hold();
    const one = f.supervisor.create({ ...create(dir('resume-1'), 'resume-1'), resume_session_id: first });
    const two = f.supervisor.create({ ...create(dir('resume-2'), 'resume-2'), resume_session_id: first });
    const twoSettled = two.then(
      () => 'delivered',
      () => 'refused',
    );
    // Wait until the second create is refused or has opened the target too.
    for (let i = 0; i < 50 && opens.length < 2; i++) if (await Promise.race([twoSettled, delay(5).then(() => undefined)])) break;
    const holder = () => f.supervisor.receipts.all.get('resume-1')?.worker_id;
    assert.equal(opens.length, 1, 'only one host opened the target session');
    await assert.rejects(two, refusedBy(holder));
    assert.equal(f.supervisor.receipts.all.has('resume-2'), false, 'the losing create left no receipt');
    assert.equal(f.hosts.length, 2, 'and spawned nothing');
    release();
    const won = await one;
    assert.equal(won.state, 'delivered', JSON.stringify(won));
    assert.equal(f.supervisor.get(won.worker_id!).session_id, first);

    // A create in flight holds its target against a rebind.
    const b = await f.create();
    let current = f.supervisor.get(a.worker_id);
    assert.equal((await f.supervisor.newSession(a.worker_id, bind(current, 'archive-2'))).state, 'delivered');
    const second = current.session_id!;
    hold();
    const creating = f.supervisor.create({ ...create(dir('resume-3'), 'resume-3'), resume_session_id: second });
    for (let i = 0; i < 50 && opens.length < 2; i++) await delay(5);
    await assert.rejects(
      f.supervisor.rebind(b.worker_id, { ...bind(b, 'rebind-vs-create'), action: 'resume', target_session_id: second }),
      refusedBy(() => f.supervisor.receipts.all.get('resume-3')?.worker_id),
    );
    release();
    assert.equal((await creating).state, 'delivered');

    // A rebind in flight holds its target against a create.
    current = f.supervisor.get(a.worker_id);
    assert.equal((await f.supervisor.newSession(a.worker_id, bind(current, 'archive-3'))).state, 'delivered');
    const third = current.session_id!;
    hold();
    const rebinding = f.supervisor.rebind(b.worker_id, { ...bind(b, 'rebind-first'), action: 'resume', target_session_id: third });
    for (let i = 0; i < 50 && opens.length < 3; i++) await delay(5);
    const spawned = f.hosts.length;
    await assert.rejects(f.supervisor.create({ ...create(dir('resume-4'), 'create-vs-rebind'), resume_session_id: third }), refusedBy(() => b.worker_id));
    assert.equal(f.hosts.length, spawned, 'the refused create spawned nothing');
    release();
    assert.equal((await rebinding).state, 'delivered');
    assert.deepEqual(
      opens.map(o => o.host),
      [1, 3, 2],
      'exactly one open per reservation: resume-1, resume-3, then b',
    );
  } finally {
    release?.();
    f.cleanup();
  }
});

test('lifecycle: a create whose resume fails after the open keeps its target from other writers while cleanup is unproven', async () => {
  let failOpen = false;
  const f = fixture({
    initHost: h => {
      const native = h.request.bind(h);
      h.request = async c => {
        const reply = await native(c);
        return c.type === 'switch_session' && failOpen ? { ...reply, data: { cancelled: true } } : reply;
      };
      h.stopOk = !failOpen;
    },
  });
  try {
    const a = await f.create();
    assert.equal((await f.supervisor.newSession(a.worker_id, bind(a, 'archive'))).state, 'delivered');
    failOpen = true;
    const cwd = join(f.dir, 'resume-fails');
    mkdirSync(cwd);
    const failed = await f.supervisor.create({ ...create(cwd, 'resume-fails'), resume_session_id: a.session_id! });
    assert.deepEqual([failed.state, failed.effect], ['outcome_unknown', 'unknown']);
    const loser = f.supervisor.get(failed.worker_id!);
    assert.equal(loser.status, 'cleanup_pending');
    assert.equal(loser.session_id, a.session_id, 'the session pi may have opened stays with the uncleaned worker');
    const other = join(f.dir, 'other');
    mkdirSync(other);
    await assert.rejects(
      f.supervisor.create({ ...create(other, 'after-failure'), resume_session_id: a.session_id! }),
      (e: unknown) => e instanceof Refusal && e.message === 'session_already_bound' && e.details.holder_worker_id === loser.worker_id,
    );
    assert.equal(f.hosts.length, 2);
  } finally {
    f.cleanup();
  }
});

/** Stands in for P2's confirmed cleanup (group and every descendant observed gone). */
function confirmCleanup(live: Live): void {
  live.worker.status = 'stopped';
  live.worker.cleanup = 'test_stand_in_for_confirmed_cleanup';
  live.pid = null;
}

const fencedBy = (command: string) => (e: unknown) => e instanceof Refusal && e.message === 'target_session_fenced' && e.effect === 'no_effect' && e.uncertain_command_id === command;

test('lifecycle: an outcome_unknown create-with-resume fences its target durably; only resolve_unknown lifts it, across restarts and after confirmed cleanup', async () => {
  let failOpen = false;
  const f = fixture({
    initHost: h => {
      const native = h.request.bind(h);
      h.request = async c => {
        const reply = await native(c);
        return c.type === 'switch_session' && failOpen ? { ...reply, data: { cancelled: true } } : reply;
      };
      h.stopOk = !failOpen;
    },
  });
  const dir = (name: string) => {
    const cwd = join(f.dir, name);
    mkdirSync(cwd);
    return cwd;
  };
  try {
    const a = await f.create();
    const target = a.session_id!;
    assert.equal((await f.supervisor.newSession(a.worker_id, bind(a, 'archive'))).state, 'delivered');
    failOpen = true;
    const failed = await f.supervisor.create({ ...create(dir('resume-fails'), 'resume-fails'), resume_session_id: target });
    assert.deepEqual([failed.state, failed.effect], ['outcome_unknown', 'unknown']);
    const id = failed.worker_id!;
    const fence = { command_id: 'resume-fails', fence_generation: 1, uncertain_command_ids: ['resume-fails'] };
    let row = f.supervisor.get(id);
    assert.equal(row.session_id, target, 'the worker holds the target pi may have touched');
    assert.deepEqual(row.fence, fence, 'the unknown create-with-resume fences its target, naming the create');
    assert.deepEqual(latestWorker(f.journalFile, id).fence, fence, 'the fence is durable before the reply');

    // Restarts keep it at the same generation; nothing relatches or releases it.
    for (const n of [1, 2]) {
      await f.restart();
      assert.deepEqual(f.supervisor.get(id).fence, fence, `restart ${n}`);
    }
    // A durably confirmed cleanup, then another restart (a factory that can launch): the fence still holds.
    const confirmed = f.supervisor.state.require(id);
    confirmCleanup(confirmed);
    f.supervisor.state.persist(confirmed, 'worker.recover');
    failOpen = false;
    const launched: Host[] = [];
    await f.restart(() => {
      const sid = `relaunched-${launched.length}`;
      const file = join(f.dir, `${sid}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid, version: 3 })}\n`);
      const host = new Host(f.dir, sid, file);
      launched.push(host);
      return host;
    });
    row = f.supervisor.get(id);
    assert.deepEqual([row.status, row.cleanup, row.fence], ['stopped', 'test_stand_in_for_confirmed_cleanup', fence]);
    await assert.rejects(
      f.supervisor.create({ ...create(dir('resume-before-resolve'), 'resume-before-resolve'), resume_session_id: target }),
      fencedBy('resume-fails'),
      'confirmed cleanup alone does not release a fenced target',
    );
    assert.equal(launched.length, 0, 'the refused resume spawned nothing');
    assert.equal(f.supervisor.receipts.all.has('resume-before-resolve'), false);

    // sessions.resolve_unknown names the create and the generation; observed needs execution settlement evidence.
    const resolve = (command_id: string, disposition: 'keep' | 'abandon' | 'observed', fence_generation = 1) =>
      f.supervisor.resolveUnknown(id, { ...bind(row, command_id), uncertain_command_id: 'resume-fails', fence_generation, disposition });
    await assert.rejects(resolve('resolve-wrong', 'abandon', 2), (e: unknown) => e instanceof Refusal && e.message === 'wrong_fence_generation' && e.effect === 'no_effect');
    await assert.rejects(resolve('resolve-observed', 'observed'), (e: unknown) => e instanceof Refusal && e.message === 'execution_settlement_not_in_session_file_or_fsynced_record');
    const resolved = await resolve('resolve-abandon', 'abandon');
    assert.deepEqual([resolved.state, resolved.effect], ['delivered', 'observed'], JSON.stringify(resolved));
    assert.equal(f.supervisor.get(id).fence, null);
    assert.equal(f.supervisor.receipts.all.get('resume-fails')?.state, 'outcome_unknown', 'resolving never rewrites the unknown receipt');

    // The resolution is durable: a restart does not relatch. Only now the target resumes and takes a prompt.
    await f.restart(() => {
      throw new Error('no launch during recovery');
    });
    assert.equal(f.supervisor.get(id).fence, null, 'a resolved create stays unfenced after a restart');
    f.supervisor.state.require(id).worker.status = 'stopped'; // recovery keeps the confirmed stop
    await f.restart(() => {
      const sid = `relaunched-${launched.length}`;
      const file = join(f.dir, `${sid}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid, version: 3 })}\n`);
      const host = new Host(f.dir, sid, file);
      launched.push(host);
      return host;
    });
    const released = await f.supervisor.create({ ...create(dir('resume-after-resolve'), 'resume-after-resolve'), resume_session_id: target });
    assert.equal(released.state, 'delivered', JSON.stringify(released));
    const next = f.supervisor.get(released.worker_id!);
    assert.equal(next.session_id, target);
    assert.equal((await f.supervisor.prompt(next.worker_id, { ...bind(next, 'prompt-after-resolve'), message: 'x' })).state, 'delivered');
  } finally {
    f.cleanup();
  }
});

test('lifecycle (real pi): a session_before_switch hook that ran and cancelled a create-with-resume leaves the target fenced until resolve_unknown', { timeout: 90_000 }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const state = join(root, 'state');
  const agent = join(root, 'agent');
  const home = join(root, 'home');
  for (const d of [cwd, state, home, join(agent, 'extensions')]) mkdirSync(d, { recursive: true });
  // pi runs session_before_switch before it opens the target: an observable effect, then a cancel (first time only).
  writeFileSync(
    join(agent, 'extensions', 'switch-effect.ts'),
    `import {existsSync, writeFileSync} from 'node:fs';\nexport default pi => { pi.on('session_before_switch', e => { if (e.reason !== 'resume') return; const marker = e.targetSessionFile + '.switch-effect'; if (existsSync(marker)) return; writeFileSync(marker, 'hook-ran'); return { cancel: true }; }); };\n`,
  );
  const opened = openState(state);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PI_CODING_AGENT_DIR: agent };
  const s = new Supervisor({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: state,
    factory: launch =>
      new SdkHost(
        { cwd: launch.cwd, sessionDir: launch.sessionDir, provider: launch.create.provider, model: launch.create.model, thinking: launch.create.thinking, projectTrusted: false },
        { env },
      ),
  });
  const pi = (command_id: string, at: string, resume_session_id?: string) => {
    const dirPath = join(root, at);
    mkdirSync(dirPath, { recursive: true });
    return s.create({ command_id, cwd: dirPath, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', ...(resume_session_id ? { resume_session_id } : {}) });
  };
  try {
    const created = await pi('create', 'workspace');
    assert.equal(created.state, 'delivered', JSON.stringify(created));
    const a = s.get(created.worker_id!);
    const target = a.session_id!;
    assert.equal((await s.newSession(a.worker_id, bind(a, 'archive'))).state, 'delivered');
    const targetFile = s.state.sessionFiles.get(target)!.file;

    const failed = await pi('resume-fails', 'resume-fails', target);
    assert.equal(existsSync(`${targetFile}.switch-effect`), true, 'the switch hook ran: an effect happened before pi cancelled');
    assert.deepEqual([failed.state, failed.effect, failed.error], ['outcome_unknown', 'unknown', 'resume_session_open_failed'], JSON.stringify(failed));
    const id = failed.worker_id!;
    const fence = { command_id: 'resume-fails', fence_generation: 1, uncertain_command_ids: ['resume-fails'] };
    let row = s.get(id);
    assert.equal(row.session_id, target);
    assert.deepEqual(row.fence, fence, 'the unknown create-with-resume fences its target');
    assert.deepEqual(latestWorker(opened.journal.file, id).fence, fence, 'durable');

    // Cleanup confirmed (stand-in for P2's proof): the fence alone still refuses the target, naming the create.
    confirmCleanup(s.state.require(id));
    await assert.rejects(pi('resume-before-resolve', 'resume-before-resolve', target), fencedBy('resume-fails'));
    assert.equal(s.receipts.all.has('resume-before-resolve'), false);

    row = s.get(id);
    const resolved = await s.resolveUnknown(id, { ...bind(row, 'resolve-keep'), uncertain_command_id: 'resume-fails', fence_generation: 1, disposition: 'keep' });
    assert.deepEqual([resolved.state, resolved.effect], ['delivered', 'observed'], JSON.stringify(resolved));
    assert.equal(s.get(id).fence, null);
    // Every resume gate now passes. pi writes a session file only once it holds a conversation, so this unseeded
    // target cannot be reopened under its id; the delivered resume and its prompt are covered on the deterministic
    // host above.
    assert.equal(s.state.resumable(target, ''), targetFile);
  } finally {
    await s.shutdown();
    opened.close();
    tmp.cleanup();
  }
});

test('lifecycle: create refuses before any record: not a directory, a typed launch it cannot run', async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.journalFile);
    writeFileSync(join(f.dir, 'file'), '');
    await assert.rejects(f.supervisor.create(create(join(f.dir, 'file'))), /cwd_not_directory/);
    await assert.rejects(f.supervisor.create(create(join(f.dir, 'missing'))), /cwd_not_directory/);
    mkdirSync(join(f.dir, 'typed'));
    // Typed launches run from P1-11, unsandboxed; a sandboxed spec waits for P2-4 and is refused before any record.
    const spec = { environment: { id: 'e', revision: 1, allowed_methods: [], filesystem: 'bwrap' as const }, role: 'r', tools: [], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: [], seed_mode: 'standalone' as const };
    await assert.rejects(f.supervisor.create({ ...create(join(f.dir, 'typed')), launch_spec: spec }), /sandboxed_children_not_supported_before_p2/);
    // A typed child of a parent that does not exist is refused the same way.
    const orphan = { worker_id: 'missing', worker_epoch: 'e', session_id: 's', binding_revision: 1, execution_id: 'x', task_id: 't', generation_id: 'g' };
    await assert.rejects(f.supervisor.create({ ...create(join(f.dir, 'typed')), launch_spec: { ...spec, environment: { id: 'e', revision: 1, allowed_methods: [] } }, parent: orphan }), /unknown_worker/);
    assert.deepEqual(readFileSync(f.journalFile), before);
    assert.equal(f.hosts.length, 0);
  } finally {
    f.cleanup();
  }
});

test('failed create preserves the same group-only cleanup and cwd reservation as stop (m-1)', async () => {
  const f = fixture({
    initHost: h => {
      const native = h.request.bind(h);
      h.request = async c => (c.type === 'get_state' ? { type: 'response', id: 'x', success: false } : native(c));
    },
  });
  try {
    const cwd = join(f.dir, 'failed-cwd');
    mkdirSync(cwd);
    const c = { command_id: 'failed-create', cwd, provider: 'p', model: 'm', thinking: 'off' as const };
    assert.equal((await f.supervisor.create(c)).state, 'outcome_unknown');
    const w = f.supervisor.list()[0]!;
    assert.equal(w.status, 'failed');
    assert.match(w.cleanup, /escaped_descendants_unproven/);
    await assert.rejects(f.supervisor.create({ ...c, command_id: 'replacement' }), /exclusive_environment_already_bound/);
    assert.equal(f.hosts.length, 1);
  } finally {
    f.cleanup();
  }
});

test('lifecycle: the starting row, dispatch record and process identity are durable before pi is asked anything', async () => {
  const f = fixture({
    initHost: h => {
      h.pid = 4242;
      h.token = 'fixture-token';
      h.before = c => {
        if (c.type !== 'get_state' || h.commands.length > 1) return;
        const records = parseJournal(readFileSync(f.journalFile)).records;
        const receipt = records.filter(r => r.kind === 'receipt').at(-1)!.value;
        assert.equal(receipt.state, 'accepted');
        const worker = records.filter(r => r.kind === 'worker').at(-1)!.value as { worker: Worker; pid: number; token: string };
        assert.equal(worker.worker.status, 'starting');
        assert.deepEqual([worker.pid, worker.token], [4242, 'fixture-token']);
      };
    },
  });
  try {
    await f.create();
  } finally {
    f.cleanup();
  }
});

test('lifecycle: a restart records cleanup_pending, kills the old pi process group and launches nothing', async () => {
  const fakeChild = fileURLToPath(new URL('./fixtures/fake-child.js', import.meta.url));
  let real: LineHost | undefined;
  const f = fixture({
    launch: launch => {
      if (!launch.cwd.endsWith('/real-cwd')) return undefined;
      // A real process speaking the host protocol; the fixture serves the session identity and inventory.
      const host = new LineHost(process.execPath, [fakeChild], { cwd: launch.cwd, env: process.env });
      const file = join(launch.sessionDir, 'real.jsonl');
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'real-session' })}\n`);
      const request = host.request.bind(host);
      host.request = async c =>
        c.type === 'get_state'
          ? { type: 'response', id: 'x', success: true, data: { sessionId: 'real-session', sessionFile: file } }
          : c.type === 'inventory'
            ? { type: 'response', id: 'x', success: true, data: { extensions: [], extension_errors: [] } }
            : request(c);
      real = host;
      return host;
    },
  });
  try {
    const idle = await f.create();
    const cwd = join(f.dir, 'real-cwd');
    mkdirSync(cwd);
    const r = await f.supervisor.create(create(cwd, 'create-real'));
    assert.equal(r.state, 'delivered', JSON.stringify(r));
    const pid = real!.pid!;
    assert.ok(procInfo(pid), 'pi process alive before the restart');
    const next = await f.restart();
    for (let i = 0; i < 50 && procInfo(pid) && procInfo(pid)?.state !== 'Z'; i++) await delay(20);
    assert.ok(!procInfo(pid) || procInfo(pid)?.state === 'Z', 'the old pi process is gone');
    const realRow = next.get(r.worker_id!);
    assert.equal(realRow.status, 'cleanup_pending');
    assert.match(realRow.cleanup, /process_group_killed_at_restart/);
    const idleRow = next.get(idle.worker_id);
    assert.equal(idleRow.status, 'cleanup_pending', 'no process identity: cleanup stays pending');
    assert.equal(idleRow.fence, null);
    assert.equal(latestWorker(f.journalFile, r.worker_id!).status, 'cleanup_pending', 'durable');
    // Still the holder: neither the session nor the cwd is released, and a second restart changes nothing.
    await assert.rejects(next.create({ ...create(cwd, 'reuse') }), /exclusive_environment_already_bound/);
    const again = await f.restart();
    assert.equal(again.get(r.worker_id!).status, 'cleanup_pending');
  } finally {
    f.cleanup();
  }
});

test('lifecycle: a pi exit is leader evidence only: cleanup_pending until stop observes the group gone', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.emit('exit');
    assert.equal(f.supervisor.get(w.worker_id).status, 'cleanup_pending');
    assert.equal(f.supervisor.get(w.worker_id).cleanup, 'leader_exit_only');
    assert.equal(latestWorker(f.journalFile, w.worker_id).cleanup, 'leader_exit_only');
    const stopped = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(stopped.result?.termination, 'observed_stopped');
    assert.equal(f.supervisor.get(w.worker_id).status, 'stopped');
    assert.deepEqual(await f.supervisor.stop(w.worker_id, bind(w, 'stop')), stopped);
    assert.equal((await f.supervisor.stop(w.worker_id, bind(w, 'stop-again'))).result?.termination, 'observed_stopped');
  } finally {
    f.cleanup();
  }
});

test('lifecycle: a stop whose kill is not observed is outcome_unknown and leaves cleanup pending', async () => {
  const f = fixture({
    initHost: h => {
      h.stopOk = false;
    },
  });
  try {
    const w = await f.create();
    const r = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.deepEqual([r.state, r.effect, r.result?.termination], ['outcome_unknown', 'unknown', 'unknown']);
    assert.equal(f.supervisor.get(w.worker_id).status, 'cleanup_pending');
  } finally {
    f.cleanup();
  }
});

test('lifecycle: a changed session header faults only that worker; others stay ready', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const healthy = await f.create();
    // A rewritten file (a new inode) whose header names another session.
    writeFileSync(`${f.hosts[0]!.file}.new`, `${JSON.stringify({ type: 'session', id: 'wrong-header' })}\n`);
    renameSync(`${f.hosts[0]!.file}.new`, f.hosts[0]!.file);
    f.hosts[0]!.emit('event', { type: 'host_leaf', leafId: null });
    await delay(10);
    assert.equal(f.supervisor.get(w.worker_id).status, 'failed');
    assert.equal(f.supervisor.get(healthy.worker_id).status, 'ready');
    assert.equal(f.hosts[1]!.stops, 0);
  } finally {
    f.cleanup();
  }
});

test('history pages pin a branch watermark and ignore partial final JSONL', () => {
  const f = fixture();
  try {
    const file = join(f.dir, 'session.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: 'native-header' })}\n`);
    const records = [
      { type: 'message', id: 'a', parentId: null },
      { type: 'message', id: 'b', parentId: 'a' },
      { type: 'message', id: 'branch', parentId: 'a' },
    ];
    writeFileSync(file, readFileSync(file, 'utf8') + records.map(r => `${JSON.stringify(r)}\n`).join('') + '{"partial":');
    const index = new SessionIndex(file);
    const page = index.page({ watermark: 'b', after: null }, 1);
    assert.ok(!('error' in page));
    assert.equal(page.entries[0]?.id, 'a');
    const next = index.page(page.next!, 1);
    assert.ok(!('error' in next));
    assert.equal(next.entries[0]?.id, 'b');
    assert.equal(next.leafId, 'branch');
    assert.equal(index.headerId, 'native-header');
  } finally {
    f.cleanup();
  }
});
