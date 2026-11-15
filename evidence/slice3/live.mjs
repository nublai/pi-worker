// Authored A0 live comparison. Run only on the authorized VM in /tmp/a0s3.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../dist/supervisor.js';
import { Journal } from '../../dist/journal.js';
import { Client } from '../../dist/client.js';
import { router, listenPrivate } from '../../dist/server.js';
const root = mkdtempSync('/tmp/a0s3/live-');
const state = join(root, 'state'); mkdirSync(state, { mode: 0o700 });
const journal = new Journal(join(state, 'journal'));
const schemas = await import(new URL('../schema/zod.gen.js', import.meta.resolve('@agentclientprotocol/sdk')).href);
const wire = { protocol: 'ACP v1', schema_package: '@agentclientprotocol/sdk@2.7.0 stable v1', validated: {}, extensions: {}, failures: [] };
const factory = Supervisor.rpcFactory('pi');
const s = new Supervisor(state, journal, '1.5.2', (c, dir) => {
  const h = factory(c, dir);
  if (c.host === 'acp') {
    const requests = new Map(); const encode = h.encode.bind(h), decode = h.decode.bind(h);
    const validate = (r, direction) => {
      if (r.jsonrpc !== '2.0') wire.failures.push('not-jsonrpc-2.0');
      let schema;
      const requestSchemas = { initialize: 'zInitializeRequest', 'session/new': 'zNewSessionRequest', 'session/prompt': 'zPromptRequest', 'session/request_permission': 'zRequestPermissionRequest', 'session/update': 'zSessionNotification' };
      if (r.method) {
        schema = requestSchemas[r.method]; if (r.id !== undefined) requests.set(r.id, r.method);
        if (r.method.startsWith('_pi/')) wire.extensions[r.method] = (wire.extensions[r.method] ?? 0) + 1;
      } else if ('result' in r) {
        schema = { initialize: 'zInitializeResponse', 'session/new': 'zNewSessionResponse', 'session/prompt': 'zPromptResponse', 'session/request_permission': 'zRequestPermissionResponse' }[requests.get(r.id)];
      }
      if (schema) {
        const ok = schemas[schema].safeParse(r.method ? r.params : r.result).success;
        if (!ok) wire.failures.push(direction + ':' + schema); else wire.validated[schema] = (wire.validated[schema] ?? 0) + 1;
      }
    };
    h.encode = command => { const r = encode(command); validate(r, 'worker_to_adapter'); return r; };
    h.decode = r => { validate(r, 'adapter_to_worker'); return decode(r); };
  }
  return h;
});
const server = router(s); const socket = join(state, 'worker.sock'); await listenPrivate(server, socket);
const client = new Client(socket);
const bind = (w, command_id) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision });
const report = { root, node: process.version, pi: '1.5.2', hosts: [] };
const wait = async (f, label, ms = 60000) => { const deadline = Date.now() + ms; for (;;) { const x = await f(); if (x) return x; if (Date.now() > deadline) throw new Error('timeout: ' + label); await delay(20); } };
const results = cwd => { try { return existsSync(join(cwd, '.a0-dialog-results')) ? readFileSync(join(cwd, '.a0-dialog-results'), 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : []; } catch { throw new Error('invalid_native_result_artifact'); } }; 
const setup = (name, startup = false) => { const cwd = join(root, name); mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true }); copyFileSync(resolve('evidence/slice3/dialog-extension.ts'), join(cwd, '.pi', 'extensions', 'dialog.ts')); if (startup) writeFileSync(join(cwd, '.a0-startup'), 'true'); return cwd; };
const answer = (w, i, command_id, data) => client.call('interactions.answer_if_current', { id: w.worker_id, body: { ...bind(w, command_id), answer_id: command_id, interaction_id: i.interaction_id, revision: i.revision, kind: i.kind, outcome: 'answer', ...data } });
try {
  for (const host of ['rpc', 'sdk', 'acp']) {
    const cwd = setup(host); const row = { host, dialogs: [], startup: {}, resources: {} }; report.hosts.push(row);
    const create = await client.call('workers.create', { body: { command_id: host + '-create', cwd, host, project_trusted: true, provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off' } });
    assert.equal(create.state, 'delivered', JSON.stringify(create)); let w = await client.call('workers.get', { id: create.worker_id });
    await wait(() => s.get(w.worker_id).resources, 'loaded resource inventory');
    const inventory = s.get(w.worker_id).resources ?? {};
    row.resources = { extensions: inventory.extensions, extension_errors: inventory.extension_errors, skills: inventory.skills, active_tools: inventory.active_tools, tools: inventory.tools?.map(t => ({ name: t.name, sourceInfo: t.sourceInfo })), commands: inventory.commands?.map(c => ({ name: c.name, source: c.source, sourceInfo: c.sourceInfo })) };
    const exercise = async (kind, mode, data, race = false) => {
      w = await client.call('workers.get', { id: w.worker_id }); const command_id = `${host}-${kind}-${mode}`;
      const pending = client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, command_id), message: `a0:dialog:${kind}:${mode}` } });
      const i = await wait(async () => (await client.call('interactions.list', { id: w.worker_id }))[0], command_id);
      let receipt, loser;
      if (mode === 'timeout') {
        await delay(250);
        try { await answer(w, i, command_id + '-late', data); throw new Error('late answer accepted'); } catch (error) { assert.match(error.message, /not_pending|deadline/); loser = error.message; }
      } else if (race) {
        const rr = await Promise.allSettled([answer(w, i, command_id + '-answer', data), answer(w, i, command_id + '-second', { ...data, value: 'loser' })]);
        assert.equal(rr.filter(r => r.status === 'fulfilled').length, 1); receipt = rr.find(r => r.status === 'fulfilled').value; loser = rr.find(r => r.status === 'rejected').reason.message;
      } else receipt = await answer(w, i, command_id + '-answer', data);
      assert.equal((await pending).state, 'delivered');
      const status = await client.call('interactions.status', { id: w.worker_id, query: { interaction_id: i.interaction_id } });
      const native = await wait(() => results(cwd).find(r => r.kind === kind + ':' + mode), 'native result');
      row.dialogs.push({ kind, mode, receipt_stage: receipt?.answer_stage, status: status.status, outcome: status.outcome, resolver_outcome: status.resolver_outcome, native_has_value: 'value' in native, native_false: native.value === false, race_loser: loser, prefill_observed: kind === 'editor' && i.prefill === 'prefilled\ntext' });
      if (receipt) assert.equal(receipt.answer_stage, host === 'rpc' ? 2 : 3);
      if (kind === 'confirm') assert.equal(native.value, false);
    };
    await exercise('select', 'answer', { option_id: '1' });
    await exercise('confirm', 'no', { value: false });
    await exercise('confirm', 'cancel', { outcome: 'cancel' });
    await exercise('confirm', 'timeout', { value: true });
    await exercise('input', 'answer', { value: 'A0 synthetic input' });
    await exercise('editor', 'answer', { value: 'prefilled\ntext' });
    await exercise('input', 'race', { value: 'winner' }, true);
    // Native custom UI: RPC observer emits an explicit refusal; SDK rejects directly.
    const events = [];
    const original = s.require(w.worker_id).hub.publish.bind(s.require(w.worker_id).hub);
    s.require(w.worker_id).hub.publish = (...args) => { events.push(args[0]); return original(...args); };
    const custom = await client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, host + '-custom'), message: 'a0:dialog:custom:answer' } });
    assert.equal(custom.state, 'delivered'); assert.ok(events.includes('unsupported_ui')); row.custom = 'explicit_unsupported_ui';
    // One real provider turn writes an artifact, supplies history and navigation targets.
    const turn = await client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, host + '-model'), message: 'Use bash once to run printf A0_REAL_PI > native-proof.txt. Do not delegate or launch agents. Reply done.' } });
    assert.equal(turn.state, 'delivered'); await wait(() => s.get(w.worker_id).execution?.state === 'settled', 'model settlement');
    assert.equal(readFileSync(join(cwd, 'native-proof.txt'), 'utf8'), 'A0_REAL_PI');
    const page = s.require(w.worker_id).index.page(null, 100); const target = page.entries.find(e => e.type === 'message'); assert.ok(target);
    w = s.get(w.worker_id);
    await client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, host + '-idle-dialog'), message: 'a0:dialog:background:answer' } });
    const pre = await wait(() => s.interactions.list(w.worker_id)[0], 'real idle dialog');
    w = s.get(w.worker_id);
    assert.equal(w.foreground, 'idle');
    const nav = await client.call('sessions.rebind', { id: w.worker_id, body: { ...bind(w, host + '-navigate'), action: 'navigate', entry_id: target.id, source_leaf_id: w.leaf_id } }).catch(error => { if (host !== 'rpc') throw error; return { state: 'rejected', effect: error.effect, error: error.message }; });
    if (host === 'rpc') assert.equal(nav.effect, 'no_effect');
    else { assert.equal(nav.state, 'delivered', JSON.stringify(nav)); const moved = s.get(w.worker_id); assert.equal(moved.binding_revision, w.binding_revision + 1); assert.equal(s.interactions.list(w.worker_id).length, 0); row.navigation = { receipt: nav.state, revision: moved.binding_revision, leaf: moved.leaf_id, native_leaf: (await s.require(w.worker_id).host.request({ type: 'get_state' })).data.leafId, stale_interaction: s.interactions.status(w.worker_id, pre.interaction_id).status }; assert.equal(row.navigation.leaf, row.navigation.native_leaf); }
    if (host === 'rpc') row.navigation = { receipt: nav.state, effect: nav.effect, error: nav.error };
    await client.call('workers.stop', { id: w.worker_id, body: bind(s.get(w.worker_id), host + '-stop') });
    // Startup binding is exposed before hook; RPC can't drain stdin until bind completes.
    const startupCwd = setup(host + '-startup', true);
    const startupPending = client.call('workers.create', { body: { command_id: host + '-startup-create', cwd: startupCwd, host, project_trusted: true, provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off' } });
    const sw = await wait(() => s.list().find(x => x.cwd === startupCwd && x.session_id && x.pending_interactions.length), 'startup dialog');
    const si = s.interactions.list(sw.worker_id)[0]; const sr = await answer(sw, si, host + '-startup-answer', { value: 'A0 startup answer' });
    const created = await startupPending; assert.equal(created.state, 'delivered', JSON.stringify(created));
    const native = await wait(() => results(startupCwd).find(r => r.kind === 'startup'), 'startup native result');
    row.startup = { stage: sr.answer_stage, native_answer_received: native.value === 'A0 startup answer', worker_ready: s.get(sw.worker_id).status === 'ready' };
    await client.call('workers.stop', { id: sw.worker_id, body: bind(s.get(sw.worker_id), host + '-startup-stop') });
    console.log(JSON.stringify({ completed: host, dialogs: row.dialogs.length, startup: row.startup, navigation: row.navigation }));
  }
  // Typed gate is an SDK-owned test extension; ordinary selectors never grant it.
  for (const host of ['sdk', 'acp']) for (const mode of ['allow', 'revoked', 'policy_changed', 'expired']) {
    const cwd = setup('gate-' + host + '-' + mode); const policy = { revision: 'p1', expiry: Date.now() + 60000, releaseDelayMs: 700 }; writeFileSync(join(cwd, '.a0-gate-policy'), JSON.stringify(policy));
    const r = await client.call('workers.create', { body: { command_id: host + '-gate-' + mode, cwd, host, project_trusted: true, provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off' } }); assert.equal(r.state, 'delivered', JSON.stringify(r)); const w = s.get(r.worker_id);
    const grant = s.grants.register('bridge', { worker_ids: [w.worker_id], cwd_roots: [] }, ['interactions.answer_if_current'], 'gate-' + host + '-' + mode); const controller = new Client(socket, grant);
    await client.call('sessions.prompt', { id: w.worker_id, body: { ...bind(w, host + '-gate-prompt-' + mode), message: 'Use bash once to run printf APPROVED > gate-proof.txt. Do not delegate or use any other tool or repeat a blocked call. Reply done.' } });
    const i = await wait(async () => (await client.call('interactions.list', { id: w.worker_id }))[0], 'tool approval'); assert.equal(i.kind, 'tool_approval'); assert.equal(existsSync(join(cwd, 'gate-proof.txt')), false);
    const command_id = host + '-gate-answer-' + mode; const ar = await controller.call('interactions.answer_if_current', { id: w.worker_id, body: { ...bind(w, command_id), answer_id: command_id, interaction_id: i.interaction_id, revision: i.revision, kind: i.kind, outcome: 'answer', value: true } }); assert.equal(ar.answer_stage, 3);
    if (mode === 'revoked') s.grants.revoke('gate-' + host + '-' + mode);
    if (mode === 'policy_changed') writeFileSync(join(cwd, '.a0-gate-policy'), JSON.stringify({ ...policy, revision: 'p2' }));
    if (mode === 'expired') writeFileSync(join(cwd, '.a0-gate-policy'), JSON.stringify({ ...policy, expiry: Date.now() - 1 }));
    const release = await wait(() => { const x = s.receipts.all.get(command_id + ':release'); return x?.state === 'delivered' && x; }, 'gate result');
    if (mode === 'allow') { assert.equal(release.answer_stage, 4); await wait(() => existsSync(join(cwd, 'gate-proof.txt')), 'protected tool artifact'); assert.equal(readFileSync(join(cwd, 'gate-proof.txt'), 'utf8'), 'APPROVED'); }
    else { assert.equal(release.result.released, false); assert.equal(existsSync(join(cwd, 'gate-proof.txt')), false); }
    report.hosts.find(h => h.host === host).gates ??= []; report.hosts.find(h => h.host === host).gates.push({ mode, answer_stage: ar.answer_stage, release_stage: release.answer_stage, released: release.result.released, artifact_exists: existsSync(join(cwd, 'gate-proof.txt')) });
    await client.call('workers.stop', { id: w.worker_id, body: bind(s.get(w.worker_id), host + '-gate-stop-' + mode) });
  }
  assert.deepEqual(wire.failures, []); report.acp_wire = wire;
  writeFileSync(join(root, 'summary.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ complete: true, summary: join(root, 'summary.json') }));
} catch (error) { writeFileSync(join(root, 'partial.json'), JSON.stringify(report, null, 2)); console.error('LIVE_FAILED', root, error); process.exitCode = 1; }
finally { await s.shutdown(); server.closeAllConnections(); await new Promise(r => server.close(r)); journal.close(); }
