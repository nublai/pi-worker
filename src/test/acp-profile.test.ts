/** ACP vocabulary checked against the pinned official v1 schemas, not a community
 * adapter. Prototype-only codec objects avoid creating a real Pi or reading auth. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpHost } from '../library-host.js';
import type { PiRecord } from '../host.js';
const schemas = await import(new URL('../schema/zod.gen.js', import.meta.resolve('@agentclientprotocol/sdk')).href);
const codec = () => Object.assign(Object.create(AcpHost.prototype) as { encode(c: PiRecord): Record<string, unknown>; decode(c: Record<string, unknown>): PiRecord | null }, { sessionId: 'session-1', agentCwd: '/workspace' });
test('ACP v1 initialize/new/prompt/permission answer frames match official pinned schemas', () => {
  const h = codec();
  for (const [command, method, schema] of [
    [{ type: 'acp_initialize', id: 'init' }, 'initialize', 'zInitializeRequest'],
    [{ type: 'acp_new', id: 'new' }, 'session/new', 'zNewSessionRequest'],
    [{ type: 'prompt', id: 'prompt', message: 'one\u2028two\u2029😀' }, 'session/prompt', 'zPromptRequest'],
  ] as const) {
    const wire = h.encode(command); assert.equal(wire.jsonrpc, '2.0'); assert.equal(wire.method, method); assert.equal(wire.id, command.id); assert.ok(schemas[schema].safeParse(wire.params).success, schema);
  }
  const answer = h.encode({ type: 'answer_ui', id: 'ack', nativeId: 'permission-request', answer: { outcome: 'answer', value: true } });
  assert.equal(answer.id, 'permission-request'); assert.ok(schemas.zRequestPermissionResponse.safeParse(answer.result).success);
  assert.equal((answer.result as { _meta: { ackId: string } })._meta.ackId, 'ack');
});
test('ACP profile preserves exact resolver ack, early admission and distinct native ids', () => {
  const h = codec();
  const admitted = h.decode({ jsonrpc: '2.0', method: '_pi/admitted', params: { id: 'prompt', data: { disposition: 'started' } } });
  assert.equal(admitted?.type, 'response'); assert.equal(admitted.id, 'prompt');
  const consumed = h.decode({ jsonrpc: '2.0', method: '_pi/consumed', params: { id: 'ack', data: { consumed: true, outcome: 'no' } } });
  assert.deepEqual(consumed?.data, { consumed: true, outcome: 'no' });
  assert.equal(h.decode({ type: 'response', id: 'not-jsonrpc' }), null);
  const event = { type: 'extension_ui_request', id: 'native', method: 'input', deadline: 123, placeholder: 'hint' };
  assert.deepEqual(h.decode({ jsonrpc: '2.0', id: 'native', method: '_pi/dialog', params: { _meta: { piEvent: event } } }), event);
});
