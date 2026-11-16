/**
 * The SDK host seam. Fake-child cases are ported from A0 `src/test/host.test.ts` (LF framing, correlation, timeout
 * without resend, rejection on exit); the RPC-only cases are recorded as dropped in PORTED.md. Real-pi cases run
 * pi 1.5.2's SDK in the production child with an empty agent directory and no credentials: no model is ever called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnv, LineHost, pinnedPiVersion, SdkHost, type PiRecord } from '../src/host/host.js';
import { killGroup, procInfo, processToken } from '../src/host/process.js';
import { privateTmp } from './helpers.js';

const fakeChild = fileURLToPath(new URL('./fixtures/fake-child.js', import.meta.url));
const fake = (timeoutMs = 2000) => new LineHost(process.execPath, [fakeChild], { cwd: process.cwd(), env: process.env, timeoutMs });

test('host keeps LF framing across Unicode separators and split UTF8; drains events independently', async () => {
  const host = fake();
  try {
    const state = await host.request({ type: 'get_state' });
    assert.equal(state.data?.value, 'one\u2028two\u2029😀');
    const events: string[] = [];
    host.on('event', event => events.push(event.type));
    const settled = new Promise<void>(resolve =>
      host.on('event', e => {
        if (e.type === 'agent_settled') resolve();
      }),
    );
    await host.request({ type: 'prompt', message: 'test' });
    await settled;
    assert.deepEqual(events, ['agent_end', 'agent_settled']);
  } finally {
    assert.equal(await host.stop(), true);
  }
});

test('host timeout is an error, never a resend; process exit rejects pending requests', async () => {
  const host = fake(50);
  try {
    await assert.rejects(host.request({ type: 'never_reply' }), /response timeout/);
    const pending = assert.rejects(host.request({ type: 'never_reply' }), /pi exited|response timeout/);
    const exited = once(host, 'exit');
    await host.stop();
    await pending;
    await exited;
  } finally {
    await host.stop();
  }
});

test('host: an oversized stdout line fails the host and kills it; nothing is buffered without bound', async () => {
  const host = fake(5000);
  const exited = once(host, 'exit');
  const pending = host.request({ type: 'never_reply' });
  await host.request({ type: 'huge_line' }).catch(() => {});
  await exited;
  await assert.rejects(pending, /line exceeds limit/);
  await assert.rejects(host.request({ type: 'get_state' }), /not running/);
});

test('host: stop kills the whole process group, and a recycled pid (token mismatch) is never signalled', async () => {
  const host = fake();
  const grandchild = Number((await host.request({ type: 'grandchild' })).data?.pid);
  assert.ok(procInfo(grandchild), 'grandchild alive');
  assert.equal(procInfo(grandchild)?.group, host.pid, 'grandchild in the host group');
  assert.equal(await killGroup(host.pid!, 'not-this-boot:0'), true, 'a token from another boot proves the old group gone');
  assert.equal(await killGroup(host.pid!, `${processToken(host.pid!)!}0`), false, 'a different start time is a different process');
  assert.ok(procInfo(grandchild), 'nothing was signalled on a mismatch');
  assert.equal(await killGroup(host.pid!, null), false, 'no token, no signal');
  assert.equal(await host.stop(), true);
  for (let i = 0; i < 50 && procInfo(grandchild) && procInfo(grandchild)?.state !== 'Z'; i++) await delay(20);
  assert.ok(!procInfo(grandchild) || procInfo(grandchild)?.state === 'Z', 'grandchild killed with the group');
});

test('host: hello reports the pinned pi SDK version, 1.5.2', () => {
  assert.equal(pinnedPiVersion(), '1.5.2');
});

test('host: the child environment drops the supervisor PIW_* configuration', () => {
  assert.deepEqual(childEnv({ PATH: '/bin', PIW_SOCKET: '/s', PIW_STATE_DIR: '/d', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
});

// ---- real pi 1.5.2 SDK child, no credentials, no model call ----

const NATIVE_EXTENSION = `import { writeFileSync, readFileSync } from 'node:fs';
export default pi => {
  pi.on('input', e => e.text === 'noop' ? { action: 'handled' } : undefined);
  pi.registerCommand('native', { handler: async (args, ctx) => {
    const cwd = ctx.cwd;
    if (args === 'seed') await ctx.newSession({ setup: async sm => {
      sm.appendMessage({ role: 'user', content: 'fixture', timestamp: Date.now() });
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
      sm.appendCustomEntry('after', {});
      writeFileSync(cwd + '/seed-file', sm.getSessionFile());
    } });
    if (args === 'tree' || args === 'fork') {
      const target = ctx.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'assistant').id;
      if (args === 'tree') await ctx.navigateTree(target, { summarize: false }); else await ctx.fork(target, { position: 'at' });
    }
    if (args === 'new') await ctx.newSession();
    if (args === 'resume') await ctx.switchSession(readFileSync(cwd + '/seed-file', 'utf8'));
    if (args === 'ask') writeFileSync(cwd + '/answer', JSON.stringify(await ctx.ui.confirm('fixture question', 'yes or no?')));
  } });
};
`;

function realPi() {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const agent = join(root, 'agent');
  const sessions = join(root, 'sessions');
  for (const dir of [cwd, agent, join(agent, 'extensions'), sessions]) mkdirSync(dir, { recursive: true });
  const extension = join(agent, 'extensions', 'native.ts');
  writeFileSync(extension, NATIVE_EXTENSION);
  const host = new SdkHost(
    { cwd, sessionDir: sessions, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', projectTrusted: false },
    { env: { ...process.env, PI_CODING_AGENT_DIR: agent } },
  );
  const events: PiRecord[] = [];
  host.on('event', e => events.push(e));
  return {
    cwd,
    extension,
    host,
    events,
    cleanup: async () => {
      await host.stop();
      tmp.cleanup();
    },
  };
}

/** The binding events between two points of the event log. */
const bindings = (events: PiRecord[], from: number) => events.slice(from).filter(e => ['host_identity', 'host_binding', 'host_binding_changing'].includes(e.type));

test('real pi: start, ready, inventory with no loader errors, and the initial identity at the host seam', { timeout: 60_000 }, async () => {
  const f = realPi();
  try {
    const state = await f.host.request({ type: 'get_state' });
    assert.equal(state.success, true);
    assert.equal(typeof state.data?.sessionId, 'string');
    const identity = f.events.find(e => e.type === 'host_identity');
    assert.equal(identity?.sessionId, state.data?.sessionId);
    assert.equal(identity?.sessionFile, state.data?.sessionFile);
    const inventory = await f.host.request({ type: 'inventory' });
    assert.equal(inventory.success, true);
    assert.deepEqual(inventory.data?.extension_errors, []);
    assert.ok((inventory.data?.extensions as string[]).includes(f.extension), 'the agent-dir extension is loaded');
    assert.ok((inventory.data?.active_tools as string[]).length > 0);
    const handled = await f.host.request({ type: 'prompt', message: 'noop' });
    assert.deepEqual(handled.data, { disposition: 'handled' }, 'admission without a model call');
  } finally {
    await f.cleanup();
  }
});

test('real pi: native /new, tree, fork and resume are observed at the host seam with the identity get_state reports', { timeout: 90_000 }, async () => {
  const f = realPi();
  try {
    await f.host.request({ type: 'get_state' });
    for (const action of ['seed', 'tree', 'fork', 'new', 'resume']) {
      const before = (await f.host.request({ type: 'get_state' })).data!;
      const mark = f.events.length;
      const reply = await f.host.request({ type: 'prompt', message: `/native ${action}` });
      assert.equal(reply.success, true, action);
      const after = (await f.host.request({ type: 'get_state' })).data!; // stdout barrier after the command
      const seen = bindings(f.events, mark);
      const moved = seen.filter(e => e.type === 'host_binding');
      assert.equal(moved.length, 1, `${action}: one native binding event (${JSON.stringify(seen.map(e => e.type))})`);
      assert.equal(moved[0]!.sessionId, after.sessionId, action);
      assert.equal(moved[0]!.leafId, after.leafId, action);
      if (action === 'tree') {
        assert.equal(moved[0]!.action, 'tree');
        assert.equal(after.sessionId, before.sessionId, 'tree keeps the session');
        assert.notEqual(after.leafId, before.leafId, 'tree moves the leaf');
      } else {
        assert.equal(moved[0]!.action, 'replace');
        assert.ok(seen.some(e => e.type === 'host_binding_changing'), `${action}: announced before the old session is invalidated`);
        if (action === 'resume') assert.equal(after.sessionFile, readFileSync(join(f.cwd, 'seed-file'), 'utf8'));
        else assert.notEqual(after.sessionId, before.sessionId, action);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('real pi: host-driven new_session, fork, navigate and switch_session report the new identity', { timeout: 90_000 }, async () => {
  const f = realPi();
  try {
    await f.host.request({ type: 'prompt', message: '/native seed' });
    const seeded = (await f.host.request({ type: 'get_state' })).data!;
    const tree = (await f.host.request({ type: 'get_tree' })).data!.tree as { entry: { id: string; type: string } }[];
    assert.ok(Array.isArray(tree) && tree.length > 0);
    const file = String(seeded.sessionFile);
    const entries = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string; id: string; message?: { role: string } });
    const assistant = entries.find(e => e.type === 'message' && e.message?.role === 'assistant')!.id;
    const navigated = await f.host.request({ type: 'navigate', entryId: assistant });
    assert.equal(navigated.success, true);
    assert.equal((await f.host.request({ type: 'get_state' })).data!.leafId, assistant);
    const forked = await f.host.request({ type: 'fork', entryId: assistant });
    assert.equal(forked.success, true);
    assert.notEqual((await f.host.request({ type: 'get_state' })).data!.sessionId, seeded.sessionId);
    assert.equal((await f.host.request({ type: 'new_session' })).success, true);
    const resumed = await f.host.request({ type: 'switch_session', sessionPath: file });
    assert.equal(resumed.success, true);
    assert.equal((await f.host.request({ type: 'get_state' })).data!.sessionId, seeded.sessionId);
  } finally {
    await f.cleanup();
  }
});

test('real pi: a dialog goes through an exact resolver; a second answer is not consumed; stop ends the process', { timeout: 60_000 }, async () => {
  const f = realPi();
  try {
    await f.host.request({ type: 'get_state' });
    const asked = new Promise<PiRecord>(resolve =>
      f.host.on('event', e => {
        if (e.type === 'extension_ui_request' && e.method === 'confirm') resolve(e);
      }),
    );
    const command = f.host.request({ type: 'prompt', message: '/native ask' });
    const dialog = await asked;
    assert.equal(typeof dialog.deadline, 'number');
    const first = await f.host.request({ type: 'answer_ui', nativeId: dialog.id, answer: { outcome: 'answer', value: true } });
    assert.deepEqual(first.data, { consumed: true, outcome: 'answered' });
    const second = await f.host.request({ type: 'answer_ui', nativeId: dialog.id, answer: { outcome: 'answer', value: false } });
    assert.deepEqual(second.data, { consumed: false, outcome: 'not_pending' });
    await command;
    for (let i = 0; i < 100 && !existsSync(join(f.cwd, 'answer')); i++) await delay(20);
    assert.equal(readFileSync(join(f.cwd, 'answer'), 'utf8'), 'true');
    const pid = f.host.pid!;
    assert.equal(await f.host.stop(), true);
    assert.ok(!procInfo(pid) || procInfo(pid)?.state === 'Z');
  } finally {
    await f.cleanup();
  }
});
