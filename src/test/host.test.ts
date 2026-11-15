import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { RpcHost } from '../host.js';
const executable = fileURLToPath(new URL('../../src/test/fixtures/fake-pi.mjs', import.meta.url));
test('child report is an inherited FD, not spoofable RPC stdout; no socket or grant environment inherited', async () => {
  const oldSocket = process.env.PI_WORKER_SOCKET, oldGrant = process.env.PI_WORKER_GRANT_FILE;
  process.env.PI_WORKER_SOCKET = '/fixture/socket'; process.env.PI_WORKER_GRANT_FILE = '/fixture/grant';
  const host = new RpcHost(executable, process.cwd(), '/tmp/a0-test-unused', 'fixture', 'fixture', 'off', 2000, { worker_id: 'child', launch_command_id: 'launch', parent: { worker_id: 'parent', worker_epoch: 'epoch', session_id: 'session', binding_revision: 1, execution_id: 'run', task_id: 'task', generation_id: 'g' }, launch_spec: { environment: { id: 'worktree', revision: 1, allowed_methods: ['children.report'] }, role: 'leaf', tools: ['read'], denied_tools: ['bash'], resources: { extensions: ['/fixture/extension.ts'], skills: ['/fixture/skill'] }, grant_methods: ['children.report'], seed_mode: 'standalone' } });
  if (oldSocket === undefined) delete process.env.PI_WORKER_SOCKET; else process.env.PI_WORKER_SOCKET = oldSocket;
  if (oldGrant === undefined) delete process.env.PI_WORKER_GRANT_FILE; else process.env.PI_WORKER_GRANT_FILE = oldGrant;
  try {
    const reports: string[] = []; host.on('report', report => reports.push(report.report_id));
    const report = once(host, 'report');
    const profile = new Promise<Record<string, unknown>>(resolve => host.on('event', e => { if (e.type === 'profile') resolve(e); }));
    await host.request({ type: 'fd_report' }); await report;
    const seen = await profile;
    assert.deepEqual(reports, ['fd-fixture']); assert.equal(seen.has_socket, false); assert.equal(seen.has_grant, false); assert.equal(seen.fd, '3');
    const argv = seen.argv as string[];
    assert.ok(argv.includes('--no-mcp')); assert.ok(argv.includes('--no-context-files')); assert.ok(argv.includes('/fixture/extension.ts'));
    assert.equal(argv[argv.indexOf('--tools') + 1], 'read'); assert.equal(argv[argv.indexOf('--exclude-tools') + 1], 'bash');
  } finally { await host.stop(); }
});
test('RPC host keeps LF framing across Unicode separators and split UTF8; drains events independently', async () => {
  const host = new RpcHost(executable, process.cwd(), '/tmp/a0-test-unused', 'fixture', 'fixture', 'off', 2000);
  try {
    const state = await host.request({ type: 'get_state' });
    assert.equal(state.data?.value, 'one\u2028two\u2029😀');
    const events: string[] = []; host.on('event', event => events.push(event.type));
    const settled = new Promise<void>(resolve => host.on('event', e => { if (e.type === 'agent_settled') resolve(); }));
    await host.request({ type: 'prompt', message: 'test' }); await settled;
    assert.deepEqual(events, ['agent_end', 'agent_settled']);
  } finally { assert.equal(await host.stop(), true); }
});
test('unsupported UI cancellation uses the native ID and no RPC response waiter', async () => {
  const host = new RpcHost(executable, process.cwd(), '/tmp/a0-test-unused', 'fixture', 'fixture', 'off', 50);
  try {
    const event = once(host, 'event');
    await host.cancelUI('native-dialog');
    const [seen] = await event;
    assert.deepEqual(seen, { type: 'ui_cancel_seen', native_id: 'native-dialog', cancelled: true });
    assert.equal((await host.request({ type: 'get_state' })).success, true);
  } finally { await host.stop(); }
});
test('RPC timeout is an error, never a resend; process exit rejects pending requests', async () => {
  const host = new RpcHost(executable, process.cwd(), '/tmp/a0-test-unused', 'fixture', 'fixture', 'off', 50);
  try {
    await assert.rejects(host.request({ type: 'never_reply' }), /response timeout/);
    const pending = assert.rejects(host.request({ type: 'never_reply' }), /pi exited|response timeout/);
    const exited = once(host, 'exit'); await host.stop(); await pending; await exited;
  } finally { await host.stop(); }
});
