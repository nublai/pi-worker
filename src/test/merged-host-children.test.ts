/** Real Pi subprocesses, no provider calls: typed launch + FD report through B2. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Journal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import { Client } from '../client.js';
import { listenPrivate, router } from '../server.js';
import type { Create } from '../types.js';

for (const host of ['rpc', 'sdk', 'acp'] as const) for (const tools of [['read'], []]) test(`merged ${host} tools=${tools.length}: typed resources/tools, child lineage and job-bound FD report`, { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'merged-host-'));
  const agent = join(root, 'agent'), cwd = join(root, 'parent'), childCwd = join(root, 'child'), state = join(root, 'state');
  for (const dir of [agent, cwd, childCwd, state]) mkdirSync(dir, { mode: 0o700 });
  const extension = join(root, 'explicit.ts');
  writeFileSync(extension, `import { writeSync, writeFileSync } from 'node:fs';
export default function(pi) {
  pi.on('input', (event, ctx) => {
    if (event.text === 'parent-probe') return { action: 'handled' };
    if (event.text !== 'merged-probe') return;
    const data = { systemPrompt: ctx.getSystemPrompt(), tools: pi.getActiveTools(), socket: !!process.env.PI_WORKER_SOCKET, grant: !!process.env.PI_WORKER_GRANT_FILE, fd: process.env.PI_WORKER_REPORT_FD, task: process.env.PI_WORKER_TASK_ID, worker: process.env.PI_WORKER_ID };
    writeFileSync(ctx.cwd + '/profile.json', JSON.stringify(data));
    writeSync(Number(process.env.PI_WORKER_REPORT_FD), JSON.stringify({ report_id: 'probe', kind: 'result', message: 'inherited FD' }) + '\\n');
    return { action: 'handled' };
  });
}`);
  // Both discovered extension and context must stay out of the explicit profile.
  for (const dir of [agent, join(childCwd, '.pi')]) {
    mkdirSync(join(dir, 'extensions'), { recursive: true });
    writeFileSync(join(dir, 'extensions', 'forbidden.ts'), `throw new Error('discovered_extension_must_not_load');`);
  }
  writeFileSync(join(childCwd, 'AGENTS.md'), 'MERGE_FORBIDDEN_CONTEXT');
  const old = { agent: process.env.PI_CODING_AGENT_DIR, socket: process.env.PI_WORKER_SOCKET, grant: process.env.PI_WORKER_GRANT_FILE };
  process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_WORKER_SOCKET = '/must/not/inherit'; process.env.PI_WORKER_GRANT_FILE = '/must/not/inherit';
  const journal = new Journal(join(state, 'journal'));
  const s = new Supervisor(state, journal, '1.5.2', Supervisor.rpcFactory(resolve('node_modules/.bin/pi')));
  const socket = join(state, 'worker.sock'), server = router(s); await listenPrivate(server, socket);
  const client = new Client(socket);
  const launch_spec: NonNullable<Create['launch_spec']> = { environment: { id: root, revision: 1, allowed_methods: ['workers.create', 'children.report'] }, role: 'parent', tools: ['read'], denied_tools: ['bash'], resources: { extensions: [extension], skills: [] }, grant_methods: ['workers.create', 'children.report'], seed_mode: 'standalone' };
  try {
    const parentReceipt = await client.call('workers.create', { body: { command_id: 'parent', cwd, host, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec } });
    assert.equal(parentReceipt.state, 'delivered');
    const parent = s.get(parentReceipt.worker_id!);
    const bind = { worker_epoch: parent.worker_epoch, session_id: parent.session_id!, binding_revision: parent.binding_revision };
    // An input hook provides a settled execution through B2, without a provider call.
    const started = await client.call('sessions.prompt', { id: parent.worker_id, body: { ...bind, command_id: 'parent-run', message: 'parent-probe' } });
    assert.equal(started.state, 'delivered');
    const executionId = s.get(parent.worker_id).execution!.execution_id;
    const childSpec = structuredClone(launch_spec); childSpec.grant_methods = ['children.report']; childSpec.role = 'leaf'; childSpec.tools = tools;
    const childReceipt = await client.call('workers.create', { body: { command_id: 'child', cwd: childCwd, host, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: childSpec, parent: { worker_id: parent.worker_id, ...bind, execution_id: executionId, task_id: 'task', generation_id: 'generation' } } });
    assert.equal(childReceipt.state, 'delivered', JSON.stringify(childReceipt));
    const child = s.get(childReceipt.worker_id!);
    assert.equal(child.host, host); assert.equal(child.parent_worker_id, parent.worker_id); assert.equal(child.parent_launch_command_id, 'child');
    const report = new Promise<void>(resolve => s.require(child.worker_id).host!.on('report', () => resolve()));
    const receipt = await client.call('sessions.prompt', { id: child.worker_id, body: { command_id: 'probe', worker_epoch: child.worker_epoch, session_id: child.session_id!, binding_revision: child.binding_revision, message: 'merged-probe' } });
    assert.equal(receipt.state, 'delivered'); await report;
    const profile = JSON.parse(readFileSync(join(childCwd, 'profile.json'), 'utf8'));
    assert.ok(!profile.systemPrompt.includes('MERGE_FORBIDDEN_CONTEXT'));
    assert.deepEqual(profile.tools, tools); assert.equal(profile.socket, false); assert.equal(profile.grant, false); assert.equal(profile.fd, '3'); assert.equal(profile.task, 'task'); assert.equal(profile.worker, child.worker_id);
    assert.equal(s.get(child.worker_id).child_reports?.[0]?.message, 'inherited FD');
    const records = journal.records.filter(r => r.kind === 'worker' && (r.value.worker as { worker_id?: string })?.worker_id === child.worker_id);
    assert.ok(records.length); assert.equal((records[0]!.value.worker as { parent_launch_command_id?: string }).parent_launch_command_id, 'child');
    if (host !== 'rpc') {
      const inventory = (await s.require(child.worker_id).host!.request({ type: 'inventory' })).data!;
      assert.deepEqual(inventory.extension_errors, []);
      assert.ok(!(inventory.extensions as string[]).some(p => p.includes('forbidden') || p === 'builtin:mcp'));
    }
    assert.ok(existsSync(join(childCwd, 'profile.json')));
  } finally {
    await s.shutdown(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); journal.close();
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: old.agent, PI_WORKER_SOCKET: old.socket, PI_WORKER_GRANT_FILE: old.grant })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
