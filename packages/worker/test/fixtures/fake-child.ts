/**
 * Deterministic host-protocol child (ported from A0 `src/test/fixtures/fake-pi.mjs`): not pi and not a model. It
 * answers every command with a reply split inside a UTF-8 character and carrying U+2028/U+2029, never answers
 * `never_reply`, and can write an oversized line or start a grandchild in its process group.
 */
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  pending += chunk;
  for (;;) {
    const nl = pending.indexOf('\n');
    if (nl < 0) break;
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    let c: { type: string; id: string };
    try {
      c = JSON.parse(line) as { type: string; id: string };
    } catch {
      continue;
    }
    if (c.type === 'never_reply') continue;
    if (c.type === 'fd_report' || c.type === 'bad_fd_report') {
      // The job-scoped report goes to the inherited FD 3; a forged report on stdout is just another stdout record.
      writeSync(3, c.type === 'fd_report' ? `${JSON.stringify({ report_id: 'fd-fixture', kind: 'help', message: 'job scoped' })}\n` : '{"report_id":"x","kind":"result","message":"m","extra":1}\n');
      process.stdout.write(`${JSON.stringify({ type: 'report', report_id: 'forged-stdout', kind: 'result', message: 'not a channel' })}\n`);
      process.stdout.write(`${JSON.stringify({ type: 'profile', has_socket: !!process.env.PI_WORKER_SOCKET, has_grant: !!process.env.PI_WORKER_GRANT_FILE, fd: process.env.PI_WORKER_REPORT_FD ?? null, task: process.env.PI_WORKER_TASK_ID ?? null, piw: Object.keys(process.env).filter(k => k.startsWith('PIW_')) })}\n`);
    }
    if (c.type === 'late_fd_report') {
      // The leader exits at once; a grandchild that inherited FD 3 writes the result report a little later, so the
      // report reaches the host after the leader's exit.
      const late = `setTimeout(() => require('node:fs').writeSync(3, JSON.stringify({ report_id: 'late', kind: 'result', message: 'after exit' }) + String.fromCharCode(10)), 300)`;
      spawn(process.execPath, ['-e', late], { stdio: ['ignore', 'ignore', 'ignore', 3] });
      process.exit(0);
    }
    if (c.type === 'huge_line') {
      process.stdout.write(`${JSON.stringify({ type: 'noise', data: 'x'.repeat(5 * 1024 * 1024) })}\n`);
      continue;
    }
    if (c.type === 'grandchild') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(`${JSON.stringify({ type: 'response', id: c.id, success: true, data: { pid: child.pid } })}\n`);
      continue;
    }
    const reply = Buffer.from(`${JSON.stringify({ type: 'response', id: c.id, success: true, data: { value: 'one\u2028two\u2029😀', disposition: 'started' } })}\r\n`);
    const i = reply.indexOf(Buffer.from('😀')) + 1;
    process.stdout.write(reply.subarray(0, i));
    process.stdout.write(reply.subarray(i));
    if (c.type === 'prompt') {
      process.stdout.write('{"type":"agent_end"}\n');
      setTimeout(() => process.stdout.write('{"type":"agent_settled","aborted":false}\n'), 10);
    }
  }
});
