/**
 * Binding changes (P1-7): sessions.rebind (new, fork, resume, navigate) and sessions.new on the deterministic host
 * seam; native moves announced, bound or reconciled; ported A0 cases (`slice2-fix` post-write rebind, `security-fix`
 * m4, `gate1-native-binding` for the SDK host) and `security-fix` m3 rewritten for the SDK host. The real-pi cases
 * use pi 1.5.2 with an empty agent directory and no credentials: no model is ever called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/b2/errors.js';
import { SdkHost } from '../src/host/host.js';
import { parseJournal } from '../src/journal/journal.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { CLEANED } from '../src/supervisor/lifecycle.js';
import type { Worker } from '../src/supervisor/state.js';
import { privateTmp } from './helpers.js';
import { bind, fixture, tick } from './supervisor-fixture.js';
import { domained } from './domains.js';

const noEffect = (message: string) => (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.message === message;

test('binding: new, resume, fork and navigate each move the revision; the old binding is refused no_effect', async () => {
  const f = fixture();
  try {
    const original = await f.create();
    const id = original.worker_id;
    const h = f.hosts[0]!;
    const r = await f.supervisor.rebind(id, { ...bind(original, 'new'), action: 'new' });
    assert.equal(r.state, 'delivered');
    let current = f.supervisor.get(id);
    assert.equal(current.binding_revision, 2);
    assert.notEqual(current.session_id, original.session_id);
    await assert.rejects(
      f.supervisor.prompt(id, { ...bind(original, 'delayed'), message: 'no' }),
      (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.details.received_binding_revision === 1,
    );
    await f.supervisor.rebind(id, { ...bind(current, 'resume'), action: 'resume', target_session_id: original.session_id! });
    current = f.supervisor.get(id);
    assert.equal(current.session_id, original.session_id);
    assert.equal(current.binding_revision, 3);
    appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'user', parentId: null, message: { role: 'user', content: [] } })}\n`);
    current = f.supervisor.get(id);
    await assert.rejects(f.supervisor.rebind(id, { ...bind(current, 'stale-leaf'), action: 'fork', source_leaf_id: 'old', entry_id: 'user' }), /stale_source_leaf/);
    await assert.rejects(f.supervisor.rebind(id, { ...bind(current, 'no-entry'), action: 'fork', source_leaf_id: current.leaf_id, entry_id: 'missing' }), /unknown_fork_entry/);
    await f.supervisor.rebind(id, { ...bind(current, 'fork'), action: 'fork', source_leaf_id: current.leaf_id, entry_id: 'user' });
    current = f.supervisor.get(id);
    assert.equal(current.binding_revision, 4);
    // The forked session (the fixture's fork starts an empty file): two entries, then a tree move back to the first.
    appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'n1', parentId: null, message: { role: 'user', content: [] } })}\n`);
    appendFileSync(h.file, `${JSON.stringify({ type: 'message', id: 'n2', parentId: 'n1', message: { role: 'user', content: [] } })}\n`);
    h.emit('event', { type: 'host_leaf', leafId: 'n2' }); // pi reports its leaf after appends (SDK leaf authority)
    current = f.supervisor.get(id);
    assert.equal(current.leaf_id, 'n2');
    await f.supervisor.rebind(id, { ...bind(current, 'navigate'), action: 'navigate', source_leaf_id: current.leaf_id, entry_id: 'n1' });
    assert.equal(f.supervisor.get(id).binding_revision, 5);
    assert.deepEqual(
      h.commands.filter(c => ['new_session', 'switch_session', 'fork', 'navigate'].includes(c.type)).map(c => c.type),
      ['new_session', 'switch_session', 'fork', 'navigate'],
    );
    assert.equal(h.prompts, 0);
  } finally {
    f.cleanup();
  }
});

test('binding: sessions.new is the /new move under its own operation and command', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const r = await f.supervisor.newSession(w.worker_id, bind(w, 'fresh'));
    assert.deepEqual([r.operation, r.state, r.result?.binding_revision], ['sessions.new', 'delivered', 2]);
    assert.deepEqual(await f.supervisor.newSession(w.worker_id, bind(w, 'fresh')), r);
    await assert.rejects(f.supervisor.rebind(w.worker_id, { ...bind(w, 'fresh'), action: 'new' }), /command_id_conflict/);
    await assert.rejects(f.supervisor.newSession(w.worker_id, bind(w, 'stale')), /stale_binding/);
  } finally {
    f.cleanup();
  }
});

test('binding: refusals before any record: busy, fenced, held target, fenced target, unknown session, cleanup pending', async () => {
  // No domain is proven clean: a's exit leaves it holding its session (P2-1 would otherwise confirm and release it).
  const f = fixture({ unconfirmedIdentity: true });
  try {
    const a = await f.create();
    const b = await f.create();
    await assert.rejects(
      f.supervisor.rebind(b.worker_id, { ...bind(b, 'duplicate-open'), action: 'resume', target_session_id: a.session_id! }),
      (e: unknown) => e instanceof Refusal && e.effect === 'no_effect' && e.details.holder_worker_id === a.worker_id,
    );
    await assert.rejects(f.supervisor.rebind(b.worker_id, { ...bind(b, 'unknown'), action: 'resume', target_session_id: 'never' }), noEffect('unknown_session'));
    await assert.rejects(f.supervisor.rebind(b.worker_id, { ...bind(b, 'no-target'), action: 'resume' }), noEffect('target_session_id_required'));
    await f.supervisor.prompt(a.worker_id, { ...bind(a, 'run'), message: 'run' });
    await assert.rejects(f.supervisor.rebind(a.worker_id, { ...bind(a, 'busy'), action: 'new' }), noEffect('binding_change_requires_idle'));
    f.hosts[0]!.emit('exit');
    await assert.rejects(f.supervisor.rebind(a.worker_id, { ...bind(a, 'fenced'), action: 'new' }), (e: unknown) => noEffect('session_fenced')(e) && (e as Refusal).uncertain_command_id === 'run');
    // b may not resume a's session either: its holder is cleanup_pending after the exit.
    await assert.rejects(f.supervisor.rebind(b.worker_id, { ...bind(b, 'pending-target'), action: 'resume', target_session_id: a.session_id! }), /session_already_bound/);
    for (const id of ['duplicate-open', 'unknown', 'no-target', 'busy', 'fenced', 'pending-target']) assert.equal(f.supervisor.receipts.all.has(id), false, id);
    const restarted = await f.restart(() => assert.fail('no relaunch'));
    await assert.rejects(restarted.rebind(b.worker_id, { ...bind(b, 'resume-own'), action: 'resume', target_session_id: b.session_id! }), noEffect('cleanup_pending_or_worker_not_ready'));
  } finally {
    f.cleanup();
  }
});

for (const failure of ['collision', 'resume-mismatch', 'cancelled'] as const) {
  test(`post-write rebind ${failure} is unknown and fenced`, async () => {
    const f = fixture();
    try {
      const a = await f.create();
      const b = await f.create();
      const h = f.hosts[1]!;
      // Catalog a prior session owned by b for the resume case.
      await f.supervisor.rebind(b.worker_id, { ...bind(b, 'setup-new'), action: 'new' });
      const current = f.supervisor.get(b.worker_id);
      const native = h.request.bind(h);
      h.request = async c => {
        const reply = await native(c);
        if (c.type === 'new_session' || c.type === 'switch_session') {
          if (failure === 'collision') h.sid = a.session_id!;
          if (failure === 'resume-mismatch') {
            h.sid = 'unexpected-target';
            h.file = join(f.dir, 'unexpected.jsonl');
            writeFileSync(h.file, `${JSON.stringify({ type: 'session', id: h.sid })}\n`);
          }
          if (failure === 'cancelled') return { ...reply, data: { cancelled: true } };
        }
        return reply;
      };
      const r = await f.supervisor.rebind(b.worker_id, {
        ...bind(current, 'bad-bind'),
        action: failure === 'resume-mismatch' ? 'resume' : 'new',
        ...(failure === 'resume-mismatch' ? { target_session_id: b.session_id! } : {}),
      });
      assert.equal(r.state, 'outcome_unknown');
      assert.equal(r.effect, 'unknown');
      assert.ok(f.supervisor.get(b.worker_id).fence?.uncertain_command_ids?.includes('bad-bind'));
      await tick();
    } finally {
      f.cleanup();
    }
  });
}

test('binding: a rebind resume records its target before its dispatch; an unknown one keeps the target with the worker until its cleanup is confirmed and the fence resolved (issue #6)', async () => {
  const f = fixture();
  const dir = (name: string) => {
    const cwd = join(f.dir, name);
    mkdirSync(cwd);
    return cwd;
  };
  const resume = (name: string, target: string) => f.supervisor.create({ command_id: name, cwd: dir(name), provider: 'p', model: 'm', thinking: 'off', resume_session_id: target });
  try {
    const a = await f.create();
    const target = a.session_id!;
    assert.equal((await f.supervisor.newSession(a.worker_id, bind(a, 'archive'))).state, 'delivered');
    const b = await f.create();
    const h = f.hosts[1]!;
    // pi opens the target (its switch hooks ran), then the move is reported cancelled: the outcome is unknown.
    const native = h.request.bind(h);
    let atOpen: { resume?: unknown; receipt?: string } | undefined;
    h.request = async c => {
      if (c.type === 'switch_session') {
        const rows = parseJournal(readFileSync(f.journalFile)).records;
        const row = rows.filter(x => x.kind === 'worker' && (x.value.worker as Worker).worker_id === b.worker_id).at(-1)!;
        atOpen = { resume: (row.value as { resume?: unknown }).resume, receipt: rows.filter(x => x.kind === 'receipt' && x.value.command_id === 'resume-b').at(-1)?.value.state as string };
      }
      const reply = await native(c);
      return c.type === 'switch_session' ? { ...reply, data: { ...reply.data, cancelled: true } } : reply;
    };
    const r = await f.supervisor.rebind(b.worker_id, { ...bind(b, 'resume-b'), action: 'resume', target_session_id: target });
    assert.deepEqual([r.state, r.effect], ['outcome_unknown', 'unknown']);
    assert.deepEqual(atOpen, { resume: { session_id: target, file: join(f.dir, 'session-0.jsonl') }, receipt: 'accepted' }, 'the target is durable in the row before the dispatch record, both before pi opens it');
    await tick();
    const row = f.supervisor.get(b.worker_id);
    assert.equal(row.session_id, target, 'the worker holds the target pi may have opened');
    assert.deepEqual(row.fence?.uncertain_command_ids, ['resume-b']);
    assert.deepEqual([row.status, row.cleanup], ['failed', CLEANED], 'the faulted worker was cleaned');
    // Its cleanup is confirmed, so only its fence still refuses the target, naming the rebind; no host is spawned.
    const hosts = f.hosts.length;
    await assert.rejects(resume('again', target), (e: unknown) => e instanceof Refusal && e.message === 'target_session_fenced' && e.effect === 'no_effect' && e.uncertain_command_id === 'resume-b');
    assert.equal(f.hosts.length, hosts);
    const resolved = await f.supervisor.resolveUnknown(b.worker_id, { ...bind(row, 'resolve-b'), uncertain_command_id: 'resume-b', fence_generation: row.fence!.fence_generation, disposition: 'abandon' });
    assert.equal(resolved.state, 'delivered', JSON.stringify(resolved));
    assert.equal((await resume('released', target)).state, 'delivered');
  } finally {
    f.cleanup();
  }
});

test('binding: a native move is announced, refuses writes while in flight, then binds at a new revision', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const h = f.hosts[0]!;
    h.emit('event', { type: 'host_binding_changing' });
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'during'), message: 'x' }), noEffect('binding_change_in_progress'));
    const file = join(f.dir, 'native.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'native-session' })}\n`);
    h.sid = 'native-session';
    h.file = file;
    h.emit('event', { type: 'host_binding', action: 'replace', sessionId: 'native-session', sessionFile: file, leafId: null });
    const after = f.supervisor.get(w.worker_id);
    assert.deepEqual([after.session_id, after.binding_revision], ['native-session', 2]);
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(w, 'stale'), message: 'x' }), /stale_binding/);
    assert.equal((await f.supervisor.prompt(w.worker_id, { ...bind(after, 'fresh'), message: 'x' })).state, 'delivered');
  } finally {
    f.cleanup();
  }
});

test('m4: a native move that never completes reconciles from host state instead of refusing writes forever', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const live = f.supervisor.state.require(w.worker_id);
    live.worker.execution = null;
    f.supervisor.nativeMoveTimeoutMs = 50;
    const before = f.supervisor.get(w.worker_id);
    f.hosts[0]!.emit('event', { type: 'host_binding_changing' });
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(before, 'during'), message: 'x' }), /binding_change_in_progress/);
    await new Promise(r => setTimeout(r, 300));
    const after = f.supervisor.get(w.worker_id);
    assert.equal(after.binding_revision, before.binding_revision + 1, 'reconciled as a binding change');
    await assert.rejects(f.supervisor.prompt(w.worker_id, { ...bind(before, 'stale'), message: 'x' }), /stale_binding/);
    const ok = await f.supervisor.prompt(w.worker_id, { ...bind(after, 'fresh'), message: 'x' });
    assert.equal(ok.state, 'delivered', JSON.stringify(ok));
  } finally {
    f.cleanup();
  }
});

// ---- real pi 1.5.2 SDK host, no credentials, no model call ----

function realPi(extensionSource: string) {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const state = join(root, 'state');
  const agent = join(root, 'agent');
  for (const dir of [cwd, state, agent, join(agent, 'extensions')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agent, 'extensions', 'fixture.ts'), extensionSource);
  const opened = openState(state);
  const s = new Supervisor(domained({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: state,
    factory: launch =>
      new SdkHost(
        { cwd: launch.cwd, sessionDir: launch.sessionDir, provider: launch.create.provider, model: launch.create.model, thinking: launch.create.thinking, projectTrusted: false },
        { env: { ...process.env, PI_CODING_AGENT_DIR: agent } },
      ),
  }));
  return {
    cwd,
    s,
    async create() {
      const receipt = await s.create({ command_id: 'create', cwd, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off' });
      assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
      return receipt.worker_id!;
    },
    async cleanup() {
      await s.shutdown();
      opened.close();
      tmp.cleanup();
    },
  };
}

const NATIVE = `import {writeFileSync,readFileSync} from 'node:fs';
export default pi => {
  pi.on('input', e => e.text === 'noop' ? {action:'handled'} : undefined);
  pi.registerCommand('native', {handler: async (args, ctx) => {
    const cwd = ctx.cwd;
    if(args === 'seed') { await ctx.newSession({setup: async sm => {
      sm.appendMessage({role:'user',content:'fixture',timestamp:Date.now()});
      sm.appendMessage({role:'assistant',content:[{type:'text',text:'fixture'}],api:'anthropic-messages',provider:'anthropic',model:'claude-sonnet-4-5',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
      sm.appendCustomEntry('after',{});
      writeFileSync(cwd+'/seed-file', sm.getSessionFile());
    }}); }
    if(args === 'tree' || args === 'fork') {
      const target=ctx.sessionManager.getEntries().find(e=>e.type==='message' && e.message.role==='assistant').id;
      if(args==='tree') await ctx.navigateTree(target,{summarize:false}); else await ctx.fork(target,{position:'at'});
    }
    if(args === 'append') pi.appendEntry('native-append', {});
    if(args === 'new') await ctx.newSession();
    if(args === 'resume') await ctx.switchSession(readFileSync(ctx.cwd+'/seed-file','utf8'));
  }});
};`;

test('sdk: extension native tree/new/fork/resume bumps binding without B2 rebind', { timeout: 45000 }, async () => {
  const f = realPi(NATIVE);
  try {
    const id = await f.create();
    const native = f.s.state.require(id).host!;
    const pid = native.pid;
    for (const action of ['seed', 'tree', 'append', 'fork', 'new', 'resume']) {
      const before = f.s.get(id);
      const reply = await native.request({ type: 'prompt', message: `/native ${action}` });
      assert.equal(reply.success, true, 'native command runs without model call');
      await native.request({ type: 'get_state' }); // stdout barrier after the native command finishes
      const after = f.s.get(id);
      assert.equal(after.status, 'ready', action);
      assert.equal(after.binding_revision, before.binding_revision + (action === 'append' ? 0 : 1), action);
      assert.equal(native.pid, pid);
      if (action !== 'append') await assert.rejects(f.s.prompt(id, { ...bind(before, `stale-${action}`), message: 'noop' }), /stale_binding/);
      const current = await native.request({ type: 'get_state' });
      assert.equal(after.session_id, current.data?.sessionId);
      assert.equal(after.leaf_id, current.data?.leafId);
    }
  } finally {
    await f.cleanup();
  }
});

test('m3 (SDK): a stale-binding prompt is refused while a native move is in progress, then the fresh binding works', { timeout: 45000 }, async () => {
  const f = realPi(`import {writeFileSync,existsSync} from 'node:fs';
export default pi => {
  pi.on('input', e => e.text === 'noop' ? {action:'handled'} : undefined);
  pi.registerCommand('slow', {handler: async (_args, ctx) => {
    const cwd = ctx.cwd;
    await ctx.newSession({setup: async () => { writeFileSync(cwd+'/started','1'); while(!existsSync(cwd+'/release')) await new Promise(r=>setTimeout(r,20)); }});
  }});
};`);
  try {
    const id = await f.create();
    const native = f.s.state.require(id).host!;
    const before = f.s.get(id);
    const moving = native.request({ type: 'prompt', message: '/slow' });
    for (let i = 0; i < 200 && !existsSync(join(f.cwd, 'started')); i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(existsSync(join(f.cwd, 'started')), true);
    await new Promise(r => setTimeout(r, 200)); // let the stdout notification arrive
    await assert.rejects(f.s.prompt(id, { ...bind(before, 'stale-during'), message: 'noop' }), /binding_change_in_progress|stale_binding/);
    assert.equal(f.s.receipts.all.has('stale-during'), false, 'stale write was never dispatched to Pi');
    writeFileSync(join(f.cwd, 'release'), '1');
    await moving;
    await native.request({ type: 'get_state' });
    const after = f.s.get(id);
    assert.equal(after.binding_revision, before.binding_revision + 1);
    const ok = await f.s.prompt(id, { ...bind(after, 'fresh'), message: 'noop' });
    assert.equal(ok.state, 'delivered', JSON.stringify(ok));
  } finally {
    await f.cleanup();
  }
});
