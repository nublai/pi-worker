/** @nublai/pi-worker-client against the real B2 server over its Unix socket. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client, ClientFailure } from '@nublai/pi-worker-client';
import { createApp } from '../src/b2/app.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { response_hello_200 } from '../src/generated/validators.js';
import { privateTmp } from './helpers.js';

test('client-ts: hello succeeds and an unsupported operation is an HTTP 501 no_effect refusal', async () => {
  const tmp = privateTmp();
  const server = createB2Server(createApp().handle);
  try {
    const socketPath = join(tmp.dir, 'b2.sock');
    await listenPrivate(server, socketPath);
    const client = new Client({ socketPath });
    const hello = await client.hello();
    assert.equal(response_hello_200(hello), true);
    await assert.rejects(
      client.call('sessions.prompt', {
        path: { worker_id: 'w1' },
        body: { command_id: 'c1', worker_epoch: 'e1', session_id: 's1', binding_revision: 1, message: 'm' },
      }),
      (e: unknown) => e instanceof ClientFailure && e.phase === 'http' && e.status === 501 && e.effect === 'no_effect',
    );
    await assert.rejects(
      client.call('sessions.prompt', {
        path: { worker_id: 'w1' },
        // SAFETY: deliberately invalid body (missing message) to see the server's 400.
        body: { command_id: 'c1', worker_epoch: 'e1', session_id: 's1', binding_revision: 1 } as never,
      }),
      (e: unknown) => e instanceof ClientFailure && e.status === 400 && e.effect === 'no_effect' && e.message === 'request_schema_mismatch',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    tmp.cleanup();
  }
});
