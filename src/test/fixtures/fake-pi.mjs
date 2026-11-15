#!/usr/bin/env node
// Deterministic RPC fixture: not Pi or model verification.
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  for (;;) {
    const nl = pending.indexOf('\n'); if (nl < 0) break;
    const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
    let c; try { c = JSON.parse(line); } catch { continue; }
    if (c.type === 'never_reply') continue;
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
