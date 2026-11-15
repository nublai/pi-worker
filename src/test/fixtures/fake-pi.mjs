#!/usr/bin/env node
// Deterministic RPC fixture: not Pi or model verification.
import { writeSync } from 'node:fs';
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  for (;;) {
    const nl = pending.indexOf('\n'); if (nl < 0) break;
    const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
    let c; try { c = JSON.parse(line); } catch { continue; }
    if (c.type === 'never_reply') continue;
    if (c.type === 'fd_report') {
      writeSync(3, JSON.stringify({ report_id: 'fd-fixture', kind: 'help', message: 'job scoped' }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'report', report_id: 'forged-stdout', kind: 'result', message: 'not a channel' }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'profile', has_socket: !!process.env.PI_WORKER_SOCKET, has_grant: !!process.env.PI_WORKER_GRANT_FILE, fd: process.env.PI_WORKER_REPORT_FD, argv: process.argv.slice(2) }) + '\n');
    }
    if (c.type === 'extension_ui_response') {
      process.stdout.write(JSON.stringify({ type: 'ui_cancel_seen', native_id: c.id, cancelled: c.cancelled }) + '\n');
      continue; // One-way UI response: never emit a correlated RPC reply.
    }
    const reply = JSON.stringify({ type: 'response', id: c.id, success: true, data: { value: 'one\u2028two\u2029😀', disposition: 'started' } }) + '\r\n';
    const b = Buffer.from(reply);
    const i = b.indexOf(Buffer.from('😀')) + 1;
    process.stdout.write(b.subarray(0, i)); process.stdout.write(b.subarray(i));
    if (c.type === 'prompt') {
      process.stdout.write('{"type":"agent_end"}\n');
      setTimeout(() => process.stdout.write('{"type":"agent_settled","aborted":false}\n'), 10);
    }
  }
});
