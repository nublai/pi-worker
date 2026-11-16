/**
 * Deterministic host-protocol child (ported from A0 `src/test/fixtures/fake-pi.mjs`): not pi and not a model. It
 * answers every command with a reply split inside a UTF-8 character and carrying U+2028/U+2029, never answers
 * `never_reply`, and can write an oversized line or start a grandchild in its process group.
 */
import { spawn } from 'node:child_process';

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
