/** Authorized real-Pi A0 probe. Run only on a0-worker; private per-run profile. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Journal } from '../dist/journal.js';
import { Supervisor } from '../dist/supervisor.js';
import { listenPrivate, router } from '../dist/server.js';
import { Client } from '../dist/client.js';
const root = mkdtempSync('/tmp/a0s4fix/live-');
const profile = join(root, 'agent'); mkdirSync(profile, { mode: 0o700 });
for (const file of ['auth.json', 'models-store.json', 'exe-dev-llm-integration.json']) {
  const from = join('/home/exedev/.pi/agent', file);
  if (existsSync(from)) { copyFileSync(from, join(profile, file)); chmodSync(join(profile, file), 0o600); }
}
mkdirSync(join(profile, 'extensions')); cpSync('/home/exedev/.pi/agent/extensions/exe-dev', join(profile, 'extensions/exe-dev'), { recursive: true });
mkdirSync(join(profile, 'npm'));
cpSync('/tmp/a0s4fix/installed/node_modules', join(profile, 'npm/node_modules'), { recursive: true });
cpSync('/home/exedev/.pi/agent/npm/node_modules/pi-herdr-pstack', join(profile, 'npm/node_modules/pi-herdr-pstack'), { recursive: true });
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ packages: [], enableSkillCommands: true }));
const repo = join(root, 'repo'); mkdirSync(repo);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'A0'); git(repo, 'config', 'user.email', 'a0@example.invalid');
writeFileSync(join(repo, 'README.md'), '# Disposable A0 writers\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); const base = git(repo, 'rev-parse', 'HEAD');
const bin = join(root, 'bin'); mkdirSync(bin);
for (const name of ['herdr', 'hc', 'herdr-core']) { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${root}/terminal-calls'\nexit 97\n`); chmodSync(file, 0o700); }
const state = join(root, 'state'); mkdirSync(state, { mode: 0o700 });
const socket = join(state, 'worker.sock');
process.env.PATH = bin + ':' + process.env.PATH;
for (const name of Object.keys(process.env)) if (/^(HERDR_|HC_|PI_SUBAGENT_)/.test(name)) delete process.env[name];
Object.assign(process.env, { PI_CODING_AGENT_DIR: profile, PI_WORKER_BACKEND: '1', PI_WORKER_TERMINAL_TRAP: join(root, 'terminal-calls'), PI_WORKER_SOCKET: socket, PI_WORKER_GRANT_FILE: join(state, 'grants/orchestrator.json'), PI_WORKER_WORKTREE_ROOT: join(root, 'worktrees') });
const journal = new Journal(join(state, 'journal'));
const rpcCounts = {};
const factory = Supervisor.rpcFactory('/home/exedev/.local/bin/pi');
const s = new Supervisor(state, journal, '1.5.2', (...args) => {
  const host = factory(...args), request = host.request.bind(host);
  host.request = (command, ...rest) => { rpcCounts[command.type] = (rpcCounts[command.type] ?? 0) + 1; return request(command, ...rest); };
  return host;
});
const grantMethods = ['workers.create', 'workers.get', 'workers.list', 'workers.stop', 'sessions.prompt', 'events.subscribe', 'children.report'];
const grantFile = s.grants.register('scoped-orchestrator', { worker_ids: [], cwd_roots: [root] }, grantMethods, 'orchestrator');
const server = router(s); await listenPrivate(server, socket);
const client = new Client(socket, grantFile);
const host = join(profile, 'npm/node_modules/pi-herdr-agents/pi-extension/subagents/index.ts');
const pstack = join(profile, 'npm/node_modules/pi-herdr-pstack');
const launch_spec = { environment: { id: repo, revision: 1, base_sha: base, allowed_methods: ['workers.create', 'children.report'] }, role: 'pstack coordinator', tools: ['read', 'bash', 'edit', 'write', 'subagent', 'subagent_send', 'subagent_cancel', 'caller_ping'], denied_tools: [], resources: { extensions: [join(profile, 'extensions/exe-dev/index.ts'), host, join(pstack, 'pi-extension/pstack/index.ts')], skills: [join(pstack, 'skills/pstack/poteto-mode')] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
const playbook = join(pstack, 'skills/pstack/poteto-mode/playbooks/prototype.md');
const pstackSkill = join(pstack, 'skills/pstack/poteto-mode/SKILL.md');
const directRpcCalls = [];
const summary = { root, profile, base, pi: '1.5.2', model: 'exe-dev-anthropic/claude-sonnet-4-6@llm', thinking: 'off', host_backend: 'pi-worker', terminal_provider_calls: null, outcome: 'running' };
writeFileSync(join(root, 'location.json'), JSON.stringify({ root, profile })); console.log(JSON.stringify({ root, phase: 'starting' }));
let timer; let detach;
try {
  const receipt = await client.call('workers.create', { body: { command_id: 'parent-create', cwd: repo, provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off', launch_spec } });
  assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
  const parent = s.get(receipt.worker_id); const parentLive = s.require(parent.worker_id);
  assert.equal(parent.grant_source_id, 'orchestrator');
  assert.ok(!s.grants.active('orchestrator').methods.includes('*'));
  const direct = (command, purpose) => { directRpcCalls.push({ type: command.type, purpose }); return parentLive.host.request(command); };
  const native = await direct({ type: 'get_available_models' }, 'read-only authenticated model catalog check; bypasses B2');
  assert.ok(JSON.stringify(native).includes('claude-sonnet-4-6@llm'), 'live authenticated model available');
  // Setup only: slice 2 refuses slash commands at B2; no model run or child launch.
  const mode = await direct({ type: 'prompt', message: '/poteto-mode on' }, 'setup-only /poteto-mode on; B2 slice 2 does not support slash commands');
  assert.equal(mode.success, true); assert.equal(mode.data?.disposition, 'handled');
  const bind = () => ({ worker_epoch: parent.worker_epoch, session_id: parent.session_id, binding_revision: parent.binding_revision });
  const events = []; const deliveries = new Map(); const cancellation = [];
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('live fanout timed out')), 360000);
    detach = s.events.subscribe(() => s.list(), null, event => {
      if (event.type === 'snapshot') return;
      if (event.type === 'child_report') events.push({ type: event.type, worker_id: event.worker_id, kind: event.data.receipt?.result?.kind });
      if (event.worker_id === parent.worker_id && event.type === 'tool_execution_end' && event.data.toolName === 'subagent_cancel') cancellation.push({ type: 'cancel_tool_return', workers: s.list().map(w => ({ worker_id: w.worker_id, status: w.status, foreground: w.foreground, role: w.launch_spec?.role })) });
      if (event.worker_id === parent.worker_id && event.type === 'agent_settled') setTimeout(() => {
        try {
          const entries = readFileSync(parentLive.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          const messages = entries.filter(e => e.type === 'message').map(e => e.message);
          const resultMessages = entries.filter(e => e.type === 'custom_message' && ['subagent_result', 'subagent_ping'].includes(e.customType));
          for (const m of resultMessages) { const data = typeof m.content === 'string' ? JSON.parse(m.content) : null; if (data) deliveries.set(data.id + ':' + data.kind, data); }
          const done = [...deliveries.values()].filter(d => d.kind === 'result');
          const cancelled = [...deliveries.values()].filter(d => d.kind === 'cancelled');
          const helped = [...deliveries.values()].filter(d => d.kind === 'help' && d.name === 'writer-a');
          if (done.length === 2 && cancelled.length === 1 && helped.length === 1 && [...deliveries.values()].filter(d => d.kind === 'termination').length === 2 && messages.some(m => m.role === 'assistant' && m.content?.some(c => c.type === 'text' && c.text.includes('A0_S4_VERIFIED')))) resolve({ entries, messages, resultMessages, done, cancelled, helped });
        } catch (e) { reject(e); }
      }, 100);
    }).close;
  });
  const task = `This is a bounded throwaway A0 prototype, not a production feature. First use the read tool to read ${pstackSkill} and ${playbook}; this run asserts those actual read calls and their successful results in your transcript. Use that installed pstack prototype/fan-out playbook; show the checklist and explicitly skip independent review and publication because this probe authorizes neither. Then perform this exact journey autonomously with the experimental subagent tools.\nSource repo: ${repo}, exact base ${base}. Model for EVERY child: exe-dev-anthropic/claude-sonnet-4-6@llm, thinking off, fork false. No named agent, no task: routing, no accept parameter, no persistent mode. Three launches total, never retry uncertain calls. All branches start at the exact base.\n1. Launch two independent writers, name writer-a branch a0-writer-a and name writer-b branch a0-writer-b, each in a worktree. Tasks: writer-a MUST first call caller_ping asking which literal to write to alpha.txt, and must not write before your answer. writer-b writes beta.txt containing exactly BETA and a newline, checks it with Node, commits locally and reports the HEAD SHA; no push/merge/removal.\n2. After both launches, launch a third cancellation probe named cancel-probe branch a0-cancel-probe. Its task is to call caller_ping asking whether to continue and do nothing else. Cancel it with subagent_cancel immediately after its launch acknowledgement. Keep writer-a waiting until cancellation is confirmed; ignore any late help from cancel-probe.\n3. After cancellation is confirmed, answer writer-a via subagent_send: write alpha.txt containing exactly ALPHA and a newline, check using Node, commit locally, report HEAD, never push/merge/remove.\n4. Results arrive automatically. Do not poll, loop, or sleep. If waiting, end your turn. Wait for exactly two writer completion messages and one cancelled message. Separate kind: termination messages are host stop evidence, not extra child results; confirm both writers' termination evidence also arrives. Inspect both retained checkout files and git heads yourself after completion. Say A0_S4_VERIFIED after confirming both contents and commits. Never touch the default ~/.pi agent configuration. Parent must not write into either child checkout.\nOnly these three child launches are authorized; no reviewers or nested delegations.`;
  const p = await client.call('sessions.prompt', { id: parent.worker_id, body: { ...bind(), command_id: 'pstack-fanout', message: task } });
  assert.equal(p.state, 'delivered', JSON.stringify(p));
  const result = await completed;
  const resultCounts = {};
  for (const m of result.resultMessages) { const d = JSON.parse(m.content); resultCounts[d.id + ':' + d.kind] = (resultCounts[d.id + ':' + d.kind] ?? 0) + 1; }
  assert.ok(Object.values(resultCounts).every(n => n === 1), 'parent native transcript contains each delivery exactly once');
  assert.equal(result.done.length, 2);
  const worktrees = result.done.map(d => {
    const path = d.evidence.path; const filename = d.name === 'writer-a' ? 'alpha.txt' : 'beta.txt';
    assert.equal(readFileSync(join(path, filename), 'utf8'), d.name === 'writer-a' ? 'ALPHA\n' : 'BETA\n');
    assert.equal(git(path, 'rev-parse', 'HEAD^'), base); assert.equal(git(path, 'status', '--porcelain'), '');
    assert.equal(git(path, 'rev-parse', 'HEAD'), d.evidence.head);
    const stanza = git(path, 'worktree', 'list', '--porcelain').split('\n\n').find(s => s.startsWith(`worktree ${path}\n`));
    assert.ok(stanza && /^locked(?: |$)/m.test(stanza), 'writer checkout actually Git-locked');
    const worker = s.get(d.evidence.worker_id);
    assert.equal(worker.grant_source_id, 'orchestrator');
    assert.deepEqual(worker.launch_spec.grant_methods, ['children.report']);
    assert.ok(worker.launch_spec.grant_methods.every(method => grantMethods.includes(method)));
    assert.ok(worker.launch_spec.grant_methods.length < grantMethods.length);
    return { name: d.name, path, base, locked: true, grant_source_id: worker.grant_source_id, grant_methods: worker.launch_spec.grant_methods, head: d.evidence.head, clean: true, content_verified: true, retained: existsSync(path), report_id: d.evidence.report_id };
  });
  assert.equal(s.get(parent.worker_id).status, 'ready');
  assert.ok(result.entries.some(e => e.type === 'custom' && e.customType === 'pi-herdr-pstack:poteto-mode' && e.data.active), 'real pstack mode persisted');
  const reads = result.entries.flatMap(e => (e.message?.role === 'assistant' ? e.message.content ?? [] : []).filter(c => c.type === 'toolCall' && c.name === 'read' && [pstackSkill, playbook].includes(c.arguments?.path)).map(c => ({ entry_id: e.id, tool_call_id: c.id, path: c.arguments.path, successful: result.entries.some(r => r.message?.role === 'toolResult' && r.message.toolCallId === c.id && !r.message.isError) })));
  for (const path of [pstackSkill, playbook]) assert.ok(reads.some(r => r.path === path && r.successful), 'parent actually read pstack guidance: ' + path);
  const checklist = result.entries.filter(e => e.message?.role === 'assistant').flatMap(e => e.message.content?.filter(c => c.type === 'text' && /checklist|skip|prototype/i.test(c.text)).map(c => ({ entry_id: e.id, text: c.text })) ?? []);
  assert.ok(checklist.length, 'parent followed guidance with visible checklist/skip decisions');
  writeFileSync(join(root, 'pstack-evidence.json'), JSON.stringify({ reads, checklist }, null, 2) + '\n');
  const cancelPath = result.cancelled[0].evidence.path;
  const cancelStanza = git(repo, 'worktree', 'list', '--porcelain').split('\n\n').find(s => s.startsWith(`worktree ${cancelPath}\n`));
  assert.ok(cancelStanza && /^locked(?: |$)/m.test(cancelStanza), 'cancel probe checkout actually Git-locked');
  assert.equal([...deliveries.values()].filter(d => d.kind === 'termination').length, 2);
  const helpEvents = events.filter(e => e.kind === 'help');
  assert.ok(helpEvents.length >= 1);
  const terminalCalls = existsSync(join(root, 'terminal-calls')) ? readFileSync(join(root, 'terminal-calls'), 'utf8') : '';
  assert.equal(terminalCalls, '');
  const cancelProof = cancellation.flatMap(c => c.workers).find(w => w.worker_id === result.helped[0].evidence.worker_id && w.status === 'ready');
  assert.ok(cancelProof, 'writer-a stayed live at cancellation return');
  Object.assign(summary, { outcome: 'pass', direct_rpc_calls: directRpcCalls, native_rpc_counts: rpcCounts, parent_grant: { grant_id: 'orchestrator', methods: grantMethods, cwd_roots: [root], owner: false }, pstack_evidence: { reads, checklist_file: join(root, 'pstack-evidence.json') }, worktrees, parent: { worker_id: parent.worker_id, session_id: parent.session_id, pstack_mode_persisted: true, still_ready_after_children: true }, delivery_counts: resultCounts, reports: events, cancel: { status: 'confirmed', sibling_ready: true, locked: true, retained: existsSync(result.cancelled[0].evidence.path) }, help_roundtrip: true, terminal_provider_calls: 0, terminal_evidence: 'instrumented legacy/Core provider constructors and PATH traps for herdr/hc/herdr-core never called; typed backend selected', child_count: s.list().length - 1, manifest_count: readdirSync(join(root, 'worktrees')).filter(n => n.endsWith('.jsonl')).length });
} catch (error) {
  summary.outcome = 'failed'; summary.error = error.message;
  summary.workers = s.list().map(w => ({ worker_id: w.worker_id, parent: w.parent_worker_id, status: w.status, foreground: w.foreground, role: w.launch_spec?.role, reports: w.child_reports?.map(r => ({ kind: r.kind, command_id: r.command_id })) }));
  console.error(JSON.stringify({ root, outcome: 'failed', error: error.message })); process.exitCode = 1;
} finally {
  clearTimeout(timer); detach?.();
  summary.direct_rpc_calls = directRpcCalls;
  summary.native_rpc_counts = rpcCounts;
  const owned = [...s.workers.values()].filter(live => live.host?.pid).map(live => ({ worker_id: live.worker.worker_id, pid: live.host.pid }));
  await s.shutdown();
  summary.process_check = owned.map(p => ({ ...p, absent: !existsSync(`/proc/${p.pid}`) }));
  assert.ok(summary.process_check.every(p => p.absent), 'all test-owned Pi leaders gone');
  await new Promise(resolve => server.close(resolve));
  journal.close();
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ root, outcome: summary.outcome }));
}
