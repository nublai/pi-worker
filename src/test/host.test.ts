import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { RpcHost } from '../host.js';
const executable = fileURLToPath(new URL('../../src/test/fixtures/fake-pi.mjs', import.meta.url));
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
test('RPC answers honestly stop at stage 2 even without any native resolver acknowledgement', async () => {
  const host = new RpcHost(executable, process.cwd(), '/tmp/a0s3-unused', 'fixture', 'fixture', 'off', 1000);
  try {
    const event = once(host, 'event');
    const receipt = await host.answerUI('native-confirm', { outcome: 'answer', value: false });
    assert.deepEqual(receipt, { stage: 2 });
    assert.equal((await event)[0].native_id, 'native-confirm');
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
