// p0-hello, TypeScript side: hello and one unsupported mutation through @nublai/pi-worker-client (built dist).
// Prints one JSON line with what the journey checks; no secrets, no request text.
import { Client, ClientFailure } from '../../../packages/client-ts/dist/src/index.js';

const client = new Client({ socketPath: process.argv[2] });
const hello = await client.hello();
let status = null;
let effect = null;
try {
  await client.call('sessions.prompt', {
    path: { worker_id: 'w1' },
    body: { command_id: 'p0-hello-ts', worker_epoch: 'e1', session_id: 's1', binding_revision: 1, message: 'p0' },
  });
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
