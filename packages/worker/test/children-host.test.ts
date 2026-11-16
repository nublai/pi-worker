/**
 * The child report channel (P1-11). The fake-child case is ported from A0 `src/test/host.test.ts` › "child report is
 * an inherited FD, not spoofable RPC stdout; no socket or grant environment inherited"; A0's argv assertions were RPC
 * flags (dropped with RPC), so the typed launch spec is proved instead by a real-pi child below: pi 1.5.2's SDK in the
 * production child, no credentials, no model call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, LineHost, SdkHost, type ChildReport, type PiRecord } from '../src/host/host.js';
import { privateTmp } from './helpers.js';

const fakeChild = fileURLToPath(new URL('./fixtures/fake-child.js', import.meta.url));

test('children: a child report is an inherited FD, not spoofable stdout; no socket or grant environment inherited', { timeout: 30_000 }, async () => {
  const env = { ...process.env, PI_WORKER_SOCKET: '/fixture/socket', PI_WORKER_GRANT_FILE: '/fixture/grant', PI_WORKER_REPORT_FD: '9', PIW_STATE_DIR: '/fixture/state' };
  const host = new LineHost(process.execPath, [fakeChild], { cwd: process.cwd(), env: childEnv(env, 'task'), timeoutMs: 5000, report: true });
  try {
    const reports: string[] = [];
    host.on('report', report => reports.push(report.report_id));
    const report = once(host, 'report');
    const profile = new Promise<PiRecord>(resolve =>
      host.on('event', e => {
        if (e.type === 'profile') resolve(e);
      }),
    );
    await host.request({ type: 'fd_report' });
    await report;
    const seen = await profile;
    assert.deepEqual(reports, ['fd-fixture']);
    assert.equal(seen.has_socket, false);
    assert.equal(seen.has_grant, false);
    assert.equal(seen.fd, '3');
    assert.equal(seen.task, 'task');
    assert.deepEqual(seen.piw, [], 'no supervisor configuration reaches the child');
  } finally {
    await host.stop();
  }
  // A root worker gets no report descriptor, whatever its caller's environment says.
  assert.equal(childEnv(env).PI_WORKER_REPORT_FD, undefined);
  assert.equal(childEnv(env).PI_WORKER_SOCKET, undefined);
});

test('children: a typed child environment is an allowlisted subset of the parent environment: no loader variables, nothing unlisted', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp/x',
    PI_CODING_AGENT_DIR: '/agent',
    ANTHROPIC_API_KEY: 'fixture-not-a-key',
    NODE_OPTIONS: '--require /tmp/x.js',
    NODE_PATH: '/tmp/modules',
    LD_PRELOAD: '/tmp/x.so',
    LD_LIBRARY_PATH: '/tmp/lib',
    DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
    UNRELATED_SETTING: 'x',
    PI_WORKER_SOCKET: '/sock',
    PI_WORKER_GRANT_FILE: '/grant',
    PIW_STATE_DIR: '/state',
  };
  const env = childEnv(parent, 'task');
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_SUBAGENT_ID', 'PI_WORKER_REPORT_FD', 'PI_WORKER_TASK_ID', 'TMPDIR']);
  for (const [k, v] of Object.entries(env)) if (!['PI_SUBAGENT_ID', 'PI_WORKER_REPORT_FD', 'PI_WORKER_TASK_ID'].includes(k)) assert.equal(v, parent[k as keyof typeof parent], `${k} is the parent's value`);
});

test('children: reports still in the FD 3 pipe when the leader exits are delivered before the host says its reports settled', { timeout: 30_000 }, async () => {
  const host = new LineHost(process.execPath, [fakeChild], { cwd: process.cwd(), env: childEnv(process.env, 'task'), timeoutMs: 5000, report: true });
  try {
    const reports: string[] = [];
    host.on('report', r => reports.push(r.report_id));
    const exited = once(host, 'exit');
    await host.request({ type: 'late_fd_report' }).catch(() => {});
    await exited;
    assert.deepEqual(reports, [], 'the report is written after the leader exit');
    await host.reportsSettled();
    assert.deepEqual(reports, ['late'], 'the live missing-report check waits for the report channel to drain');
  } finally {
    await host.stop();
  }
});

test('children: a malformed record on the report channel fails the host and stops the child', { timeout: 30_000 }, async () => {
  const host = new LineHost(process.execPath, [fakeChild], { cwd: process.cwd(), env: childEnv(process.env, 'task'), timeoutMs: 5000, report: true });
  const reports: ChildReport[] = [];
  host.on('report', r => reports.push(r));
  const exited = once(host, 'exit');
  await host.request({ type: 'bad_fd_report' }).catch(() => {});
  await exited;
  assert.deepEqual(reports, []);
  await assert.rejects(host.request({ type: 'get_state' }), /not running/);
});

const EXPLICIT = `import { writeSync, writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('input', (event, ctx) => {
    if (event.text !== 'child-probe') return;
    writeFileSync(ctx.cwd + '/profile.json', JSON.stringify({ tools: pi.getActiveTools(), socket: !!process.env.PI_WORKER_SOCKET, grant: !!process.env.PI_WORKER_GRANT_FILE, fd: process.env.PI_WORKER_REPORT_FD ?? null, task: process.env.PI_WORKER_TASK_ID ?? null }));
    writeSync(Number(process.env.PI_WORKER_REPORT_FD), JSON.stringify({ report_id: 'probe', kind: 'result', message: 'inherited FD' }) + '\\n');
    return { action: 'handled' };
  });
}
`;

test('children (real pi): a typed child loads only its spec, reports through FD 3, and inherits no socket or grant', { timeout: 90_000 }, async () => {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'child');
  const agent = join(root, 'agent');
  for (const dir of [cwd, join(agent, 'extensions'), join(cwd, '.pi', 'extensions'), join(root, 'sessions')]) mkdirSync(dir, { recursive: true });
  const extension = join(root, 'explicit.ts');
  writeFileSync(extension, EXPLICIT);
  // Discovered extensions (agent directory, project) must stay out of an explicit profile: loading either fails.
  for (const dir of [agent, join(cwd, '.pi')]) writeFileSync(join(dir, 'extensions', 'forbidden.ts'), `throw new Error('discovered_extension_must_not_load');`);
  const host = new SdkHost(
    {
      cwd,
      sessionDir: join(root, 'sessions'),
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      thinking: 'off',
      projectTrusted: true,
      launchSpec: { environment: { id: 'e', revision: 1, allowed_methods: ['children.report'] }, role: 'leaf', tools: ['read'], denied_tools: ['bash'], resources: { extensions: [extension], skills: [] }, grant_methods: ['children.report'], seed_mode: 'standalone' },
      taskId: 'task-1',
    },
    { env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WORKER_SOCKET: '/fixture/socket', PI_WORKER_GRANT_FILE: '/fixture/grant' } },
  );
  try {
    const report = once(host, 'report') as Promise<[ChildReport]>;
    const inventory = await host.request({ type: 'inventory' });
    assert.equal(inventory.success, true);
    assert.deepEqual(inventory.data?.extension_errors, [], 'no discovered extension was loaded');
    assert.ok((inventory.data?.extensions as string[]).includes(extension));
    const handled = await host.request({ type: 'prompt', message: 'child-probe' });
    assert.deepEqual(handled.data, { disposition: 'handled' }, 'no model call');
    const [received] = await report;
    assert.deepEqual(received, { report_id: 'probe', kind: 'result', message: 'inherited FD' });
    const profile = JSON.parse(readFileSync(join(cwd, 'profile.json'), 'utf8')) as { tools: string[]; socket: boolean; grant: boolean; fd: string; task: string };
    assert.deepEqual(profile.tools, ['read'], 'only the spec tools are active');
    assert.equal(profile.socket, false);
    assert.equal(profile.grant, false);
    assert.equal(profile.fd, '3');
    assert.equal(profile.task, 'task-1');
  } finally {
    await host.stop();
    tmp.cleanup();
  }
});
