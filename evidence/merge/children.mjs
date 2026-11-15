/** Fresh merged-build reproduction of the real pstack child journey, SDK parent. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '../../dist/client.js';
import { harness, binding, entries } from './common.mjs';
const h = await harness('children', true), { root, profile, state, socket, s, until } = h;
const repo = join(root, 'repo'); mkdirSync(repo);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'A0 Merge'); git(repo, 'config', 'user.email', 'a0@example.invalid');
writeFileSync(join(repo, 'README.md'), '# Merge verification repository\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
const base = git(repo, 'rev-parse', 'HEAD'), trap = join(root, 'terminal-calls'), bin = join(root, 'bin'); mkdirSync(bin);
for (const command of ['herdr', 'hc', 'herdr-core']) {
  const path = join(bin, command); writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${trap}'\nexit 97\n`); chmodSync(path, 0o700);
}
process.env.PATH = bin + ':' + process.env.PATH;
Object.assign(process.env, { PI_WORKER_BACKEND: '1', PI_WORKER_TERMINAL_TRAP: trap, PI_WORKER_SOCKET: socket, PI_WORKER_GRANT_FILE: join(state, 'grants/orchestrator.json'), PI_WORKER_WORKTREE_ROOT: join(root, 'worktrees') });
const methods = ['workers.create', 'workers.get', 'workers.list', 'workers.stop', 'sessions.prompt', 'events.subscribe', 'children.report'];
const grant = s.grants.register('merge-orchestrator', { worker_ids: [], cwd_roots: [root] }, methods, 'orchestrator');
const client = new Client(socket, grant), pstack = join(profile, 'npm/node_modules/pi-herdr-pstack');
// A prior probe parent tried to repair rejected launches by deleting test checkouts.
// Fail the probe and block that concrete destructive behavior, never hide it.
const guard = join(root, 'probe-guard.ts'), violation = join(root, 'probe-violation.json');
writeFileSync(guard, `import { writeFileSync } from 'node:fs';
export default function(pi) {
  let launches = 0;
  pi.on('tool_call', event => {
    const launchViolation = event.toolName === 'subagent' && (++launches > 3 || event.input.tools !== undefined);
    const destructive = event.toolName === 'bash' && /worktree\\s+(remove|unlock|prune)|branch\\s+.*-[dD]|\\brm\\s|\\bunlink\\b/.test(event.input.command);
    const credentialRead = event.toolName === 'read' && /\\/(grants|auth\\.json)(\\/|$)/.test(event.input.path ?? '');
    if (launchViolation || destructive || credentialRead) {
      writeFileSync(${JSON.stringify(violation)}, JSON.stringify({ tool: event.toolName, launchViolation, destructive, credentialRead }));
      return { block: true, reason: 'outside bounded merge probe authorization; stop, do not retry' };
    }
  });
}`);
const skill = join(pstack, 'skills/pstack/poteto-mode/SKILL.md'), playbook = join(pstack, 'skills/pstack/poteto-mode/playbooks/prototype.md');
const launch_spec = { environment: { id: repo, revision: 1, base_sha: base, allowed_methods: ['workers.create', 'children.report'] }, role: 'merge coordinator', tools: ['read', 'bash', 'edit', 'write', 'subagent', 'subagent_send', 'subagent_cancel', 'caller_ping'], denied_tools: [], resources: { extensions: [guard, join(profile, 'extensions/exe-dev/index.ts'), join(profile, 'npm/node_modules/pi-herdr-agents/pi-extension/subagents/index.ts'), join(pstack, 'pi-extension/pstack/index.ts')], skills: [join(pstack, 'skills/pstack/poteto-mode')] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
const summary = { outcome: 'running', root, base, node: process.version, parent_host: 'sdk', child_hosts: [], direct_native_calls: [], parent_grant: { id: 'orchestrator', methods, owner: false }, model: 'exe-dev-anthropic/claude-sonnet-4-6@llm' };
let subscription;
try {
  const r = await client.call('workers.create', { body: { command_id: 'parent', cwd: repo, host: 'sdk', provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off', launch_spec } });
  assert.equal(r.state, 'delivered', JSON.stringify(r)); const parent = s.get(r.worker_id), live = s.require(parent.worker_id);
  assert.equal(parent.host, 'sdk'); assert.equal(parent.grant_source_id, 'orchestrator'); assert.ok(!s.grants.active('orchestrator').methods.includes('*'));
  const direct = async (command, purpose) => { summary.direct_native_calls.push({ type: command.type, purpose }); return live.host.request(command); };
  const catalog = await direct({ type: 'get_available_models' }, 'read-only model availability; outside B2');
  assert.equal(catalog.success, true); assert.ok(JSON.stringify(catalog.data).includes('claude-sonnet-4-6@llm'));
  const mode = await direct({ type: 'prompt', message: '/poteto-mode on' }, 'setup-only slash command, unsupported at B2');
  assert.equal(mode.success, true); assert.equal(mode.data.disposition, 'handled');
  const cancelSnapshots = [];
  subscription = s.events.subscribe(() => s.list(), null, event => {
    if (event.worker_id === parent.worker_id && event.type === 'tool_execution_end' && event.data.toolName === 'subagent_cancel') cancelSnapshots.push(s.list());
  });
  const transcript = () => existsSync(live.sessionFile) ? entries(live.sessionFile) : [];
  const delivered = () => transcript().filter(e => e.type === 'custom_message' && ['subagent_result', 'subagent_ping'].includes(e.customType)).map(e => JSON.parse(e.content));
  const complete = until(() => {
    assert.equal(existsSync(violation), false, 'probe authorization violation');
    const failedTool = transcript().find(e => e.message?.role === 'toolResult' && e.message.isError);
    assert.ok(!failedTool, 'probe stops at first failed tool: ' + (failedTool?.message.toolName ?? ''));
    const all = delivered(), text = transcript().flatMap(e => e.message?.role === 'assistant' ? e.message.content ?? [] : []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return all.filter(d => d.kind === 'result').length === 2 && all.filter(d => d.kind === 'termination').length === 2 && all.some(d => d.kind === 'cancelled') && all.some(d => d.kind === 'help' && d.name === 'writer-a') && s.get(parent.worker_id).execution?.state === 'settled' && text.includes('A0_MERGE_VERIFIED') && all;
  }, 'SDK parent child journey', 360000);
  // Observe rejection immediately while B2 admission itself is still pending.
  complete.catch(() => {});
  const exactCalls = [
    { name: 'writer-a', model: 'exe-dev-anthropic/claude-sonnet-4-6@llm', thinking: 'off', fork: false, worktree: { branch: 'a0-writer-a', base }, task: 'Bare leaf. First caller_ping asking what to write to alpha.txt, then end your turn and wait. Do not write until answered. After the answer, write exactly the specified content, verify with Node, commit locally, report HEAD. No delegates, pushes, merges, deletion or worktree cleanup.' },
    { name: 'writer-b', model: 'exe-dev-anthropic/claude-sonnet-4-6@llm', thinking: 'off', fork: false, worktree: { branch: 'a0-writer-b', base }, task: 'Bare leaf. Write beta.txt exactly BETA plus one newline. Check with Node. Commit locally and report HEAD. No delegates, pushes, merges, deletion or worktree cleanup.' },
    { name: 'cancel-probe', model: 'exe-dev-anthropic/claude-sonnet-4-6@llm', thinking: 'off', fork: false, worktree: { branch: 'a0-cancel-probe', base }, task: 'Bare leaf. Only caller_ping asking whether to continue, then end your turn and wait. Do nothing else.' },
  ];
  const task = `Use exactly these three subagent argument objects, with no changes to thinking or other fields. Each is already valid JSON; use its parsed values directly as tool arguments. First two calls together, third only after their acknowledgements. Do NOT serialize a field value again.\\n${exactCalls.map(c => JSON.stringify(c)).join('\\n')}\\nThis is the authorized throwaway A0 merged-worker verification. First read ${skill} and ${playbook} using the read tool, then show the prototype checklist. Skip independent review and publication: neither is authorized. Use the experimental subagent tools, with no terminal provider. All branches must start from exact base ${base} in source repo ${repo}. Every child uses model exe-dev-anthropic/claude-sonnet-4-6@llm, thinking off, fork false, standalone bare leaf. The thinking argument must contain only the three letters off, with no embedded quote characters. OMIT the tools field entirely (not a JSON string, not an array); defaults already supply child tools and caller_ping. Do not use named agents, routing, accept, persistence or nested delegates. Exactly three subagent tool calls are authorized. If ANY launch fails, stop and report the failure; do not retry, change a branch, unlock/remove a worktree or delete anything.\n1. Launch writer-a in branch a0-writer-a and writer-b in branch a0-writer-b, both in separate worktrees. Writer-a's task MUST first caller_ping asking what to write to alpha.txt, then wait without writing. Writer-b writes beta.txt exactly BETA plus newline, checks it with Node, commits locally, reports HEAD. No pushing, merging or removal.\n2. After both launches launch cancel-probe in branch a0-cancel-probe. It only caller_pings asking whether to continue, then waits. Immediately cancel it using subagent_cancel. Do not answer writer-a until cancellation is confirmed. Ignore any late cancel-probe help.\n3. Wait for BOTH confirmed cancellation AND writer-a's help message, then call subagent_send EXACTLY ONCE in the entire journey, with id from writer-a's launch acknowledgement and message: write alpha.txt exactly ALPHA plus newline, check it with Node, commit locally and report HEAD. Send no name field. After that successful call, never send writer-a another message, even if a delayed help notification arrives: it is stale. No pushing, merging or removal.\n4. Results arrive automatically: do not poll, loop, sleep or inspect progress. End your turn if waiting. Wait for both writer results, their two separate kind:termination messages and the probe cancellation. Termination messages are stop evidence, NOT extra child results. After both results inspect both retained files, heads and clean status yourself. Say A0_MERGE_VERIFIED only once both outputs and commits are verified. Parent must not write into child checkouts. Leave all three worktrees retained. Do not change default agent configuration. These three children are the test workload; do not launch reviewers or other agents.`;
  const prompted = await client.call('sessions.prompt', { id: parent.worker_id, body: { ...binding(parent, 'journey'), message: task } });
  assert.equal(prompted.state, 'delivered'); const all = await complete, native = transcript();
  const counts = {};
  for (const d of all) counts[d.id + ':' + d.kind] = (counts[d.id + ':' + d.kind] ?? 0) + 1;
  assert.ok(Object.values(counts).every(n => n === 1), 'native parent deliveries exactly once');
  assert.equal(all.filter(d => d.kind === 'cancelled').length, 1);
  const readers = native.flatMap(e => e.message?.role === 'assistant' ? (e.message.content ?? []).filter(c => c.type === 'toolCall' && c.name === 'read' && [skill, playbook].includes(c.arguments?.path)).map(c => ({ path: c.arguments.path, successful: native.some(r => r.message?.role === 'toolResult' && r.message.toolCallId === c.id && !r.message.isError) })) : []);
  for (const path of [skill, playbook]) assert.ok(readers.some(r => r.path === path && r.successful));
  assert.ok(native.some(e => e.type === 'custom' && e.customType === 'pi-herdr-pstack:poteto-mode' && e.data.active));
  const checklists = native.flatMap(e => e.message?.role === 'assistant' ? (e.message.content ?? []).filter(c => c.type === 'text' && /checklist|skip|prototype/i.test(c.text)).map(c => c.text) : []); assert.ok(checklists.length);
  const worktrees = all.filter(d => d.kind === 'result').map(d => {
    const path = d.evidence.path, w = s.get(d.evidence.worker_id), filename = d.name === 'writer-a' ? 'alpha.txt' : 'beta.txt';
    assert.equal(readFileSync(join(path, filename), 'utf8'), d.name === 'writer-a' ? 'ALPHA\n' : 'BETA\n');
    assert.equal(git(path, 'rev-parse', 'HEAD^'), base); assert.equal(git(path, 'rev-parse', 'HEAD'), d.evidence.head); assert.equal(git(path, 'status', '--porcelain'), '');
    const stanza = git(repo, 'worktree', 'list', '--porcelain').split('\n\n').find(s => s.startsWith('worktree ' + path + '\n')); assert.match(stanza, /^locked(?: |$)/m);
    assert.equal(w.grant_source_id, 'orchestrator'); assert.deepEqual(w.launch_spec.grant_methods, ['children.report']); assert.ok(w.launch_spec.grant_methods.length < methods.length);
    summary.child_hosts.push(w.host);
    return { name: d.name, path, head: d.evidence.head, locked: true, retained: existsSync(path), clean: true, content_verified: true, grant_methods: w.launch_spec.grant_methods };
  });
  const probe = all.find(d => d.kind === 'cancelled'), probeStanza = git(repo, 'worktree', 'list', '--porcelain').split('\n\n').find(s => s.startsWith('worktree ' + probe.evidence.path + '\n')); assert.match(probeStanza, /^locked(?: |$)/m);
  const writer = all.find(d => d.kind === 'help' && d.name === 'writer-a'); assert.ok(cancelSnapshots.flat().some(w => w.worker_id === writer.evidence.worker_id && w.status === 'ready'));
  assert.equal(s.get(parent.worker_id).status, 'ready'); assert.equal(s.list().length, 4);
  assert.equal(readdirSync(join(root, 'worktrees')).filter(n => n.endsWith('.jsonl')).length, 3);
  assert.equal(existsSync(trap) ? readFileSync(trap, 'utf8') : '', '');
  assert.equal(existsSync(violation), false, 'no blocked out-of-scope probe action');
  assert.equal(native.flatMap(e => e.message?.role === 'assistant' ? e.message.content ?? [] : []).filter(c => c.type === 'toolCall' && c.name === 'subagent').length, 3);
  assert.equal(native.flatMap(e => e.message?.role === 'assistant' ? e.message.content ?? [] : []).filter(c => c.type === 'toolCall' && c.name === 'subagent_send').length, 1);
  Object.assign(summary, { outcome: 'pass', worktrees, cancellation: { confirmed: true, locked: true, retained: existsSync(probe.evidence.path), sibling_ready: true }, help_roundtrip: true, delivery_counts: counts, terminal_provider_calls: 0, parent_ready: true, playbook_reads: readers, checklist_observed: true, pstack_mode_persisted: true });
} catch (error) { summary.outcome = 'failed'; summary.error = error.message; process.exitCode = 1; console.error(error); }
finally { subscription?.close(); await h.close(summary); console.log(JSON.stringify({ root, outcome: summary.outcome })); }
