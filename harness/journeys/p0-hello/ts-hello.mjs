// p0-hello, TypeScript side: hello and one unsupported mutation through @nublai/pi-worker-client (built dist).
// Prints one JSON line with what the journey checks; no secrets, no request text.
import { Client, ClientFailure } from '../../../packages/client-ts/dist/src/index.js';

// The client reads its bearer grant from PIW_GRANT_FILE (P1-9), which the journey sets.
const client = new Client({ socketPath: process.argv[2] });
const hello = await client.hello();
let status = null;
let effect = null;
try {
  // files.read stays unsupported until P2-4 (sessions.prompt is served from P1-5).
  await client.call('files.read', { path: { worker_id: 'w1' }, body: { path: '/r/file', roots: ['/r'] } });
} catch (error) {
  if (!(error instanceof ClientFailure)) throw error;
  status = error.status ?? null;
  effect = error.effect;
}
console.log(
  JSON.stringify({
    client: 'ts',
    hello: 'ok',
    protocol_major: hello.protocol.major,
    supervisor_epoch: hello.supervisor_epoch,
    limits: hello.limits,
    prompt_status: status,
    prompt_effect: effect,
  }),
);
