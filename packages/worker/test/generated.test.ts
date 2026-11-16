import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routes, operationIds } from '../src/generated/routes.js';
import { createPublishers, eventManifest, EventSchemaError, validateEventFrame, type EventFrame, type JournalAppended } from '../src/generated/events.js';
import * as v from '../src/generated/validators.js';

const spec = JSON.parse(readFileSync(new URL('../../../../api/generated/b2.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string; 'x-piw-mutation'?: boolean; 'x-piw-status'?: string }>>;
  components: { schemas: Record<string, { 'x-piw-event'?: { type: string } }> };
};
const specOps = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => ['get', 'put', 'post', 'delete', 'patch'].includes(method))
    .map(([method, op]) => ({ path, method: method.toUpperCase(), ...op })),
);
const binding = { command_id: 'c1', worker_epoch: 'e1', session_id: 's1', binding_revision: 1 };

test('generated: the route table has exactly the spec operations, with method, path and flags', () => {
  assert.deepEqual([...operationIds].sort(), specOps.map(o => o.operationId).sort());
  for (const op of specOps) {
    const route = routes[op.operationId as keyof typeof routes];
    assert.equal(route.method, op.method, op.operationId!);
    assert.equal(route.path, op.path, op.operationId!);
    assert.equal(route.mutation, op['x-piw-mutation'], op.operationId!);
    assert.equal(route.supported, op['x-piw-status'] !== 'unsupported', op.operationId!);
  }
});

test('generated: the event manifest has exactly the schemas that declare x-piw-event', () => {
  const declared = Object.values(spec.components.schemas).flatMap(s => (s['x-piw-event'] ? [s['x-piw-event'].type] : []));
  assert.deepEqual(Object.keys(eventManifest).sort(), declared.sort());
});

test('generated: request validators accept the schema and refuse missing, extra and mistyped fields', () => {
  assert.equal(v.request_sessions_prompt({ ...binding, message: 'hi' }), true);
  assert.equal(v.request_sessions_prompt({ ...binding }), false);
  assert.equal(v.request_sessions_prompt({ ...binding, message: 'hi', extra: 1 }), false);
  assert.equal(v.request_sessions_prompt({ ...binding, binding_revision: '1', message: 'hi' }), false);
  assert.equal(v.request_sessions_prompt({ ...binding, command_id: 'x'.repeat(129), message: 'hi' }), false);
  // String lengths count code points, as JSON Schema says: 128 astral characters are 128, not 256.
  assert.equal(v.request_sessions_prompt({ ...binding, command_id: '\u{1F600}'.repeat(128), message: 'hi' }), true);
  assert.equal(v.request_workers_create({ command_id: 'c', cwd: 'relative', provider: 'p', model: 'm', thinking: 'off' }), false);
  assert.equal(v.request_workers_create({ command_id: 'c', cwd: '/abs', provider: 'p', model: 'm', thinking: 'off', host: 'rpc' }), false);
});

test('generated: parameter validators refuse unknown query parameters and out-of-range values', () => {
  assert.equal(v.params_history_page({ path: { worker_id: 'w' }, query: { limit: 50 }, header: {} }), true);
  assert.equal(v.params_history_page({ path: { worker_id: 'w' }, query: { limit: 101 }, header: {} }), false);
  assert.equal(v.params_history_page({ path: { worker_id: 'w' }, query: { nope: 'x' }, header: {} }), false);
  assert.equal(v.params_workers_get({ path: { worker_id: '' }, query: {}, header: {} }), false);
  assert.equal(v.params_interactions_status({ path: { worker_id: 'w' }, query: {}, header: {} }), false);
});

test('generated: publishers stamp, label evidence from the journal result and validate every frame', () => {
  const frames: EventFrame[] = [];
  let seq = 0;
  const publish = createPublishers({
    stamp: () => ({ cursor: { transport_epoch: 't1', seq: ++seq }, event_id: `ev-${seq}` }),
    deliver: frame => frames.push(frame),
  });
  const appended: JournalAppended = { fsynced: true, label: 'fence.resolve' };
  publish['fence.resolved']({
    worker_id: 'w1',
    execution_id: null,
    appended,
    data: { command_id: 'c1', disposition: 'keep', fence_generation: 1, external_effects_undone: false, fence: null },
  });
  publish['execution.settled']({ worker_id: 'w1', execution_id: 'x1', data: { disposition: 'handled' } });
  publish['worker.updated']({ worker_id: 'w1', execution_id: null, data: { worker: worker() } });
  publish['worker.updated']({ worker_id: 'w1', execution_id: null, appended, data: { worker: worker() } });
  assert.deepEqual(
    frames.map(f => [f.type, 'evidence' in f ? f.evidence : null, f.cursor.seq]),
    [
      ['fence.resolved', 'supervisor_journal_fsynced', 1],
      ['execution.settled', 'observed_memory', 2],
      ['worker.updated', 'observed_memory', 3],
      ['worker.updated', 'supervisor_journal_fsynced', 4],
    ],
  );
  for (const frame of frames) assert.equal(validateEventFrame(frame), true);
  assert.throws(
    () => publish['execution.settled']({ worker_id: 'w1', execution_id: 'x1', data: { disposition: '' } }),
    (e: unknown) => e instanceof EventSchemaError && e.eventType === 'execution.settled',
  );
  assert.equal(frames.length, 4);
  if (false as boolean) {
    // A journal-durable event cannot be published without the append result (compile-time check).
    // @ts-expect-error appended is required for durability journal
    publish['session.rebound']({ worker_id: 'w1', execution_id: null, data: { session_id: 's', binding_revision: 2, action: 'new' } });
  }
});

function worker() {
  return {
    worker_id: 'w1',
    worker_epoch: 'e1',
    supervisor_epoch: 'se1',
    session_id: 's1',
    session_identity_evidence: 'pi_session_file' as const,
    binding_revision: 1,
    leaf_id: null,
    cwd: '/work',
    status: 'ready' as const,
    foreground: 'idle' as const,
    execution: null,
    fence: null,
    history: { last_entry_id: null, lag: false, evidence: 'pi_session_file' as const },
    cleanup: 'none',
    pending_interactions: [],
  };
}
