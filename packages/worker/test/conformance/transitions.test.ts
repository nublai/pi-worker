/**
 * Contract revision 8, section 0.1: one replay per frozen fixture row, over the public B2 socket. Ported from A0
 * `src/test/conformance.test.ts`; every row assertion is kept. No model-success assertions. A row runs as `todo`
 * until the PR that completes its prerequisites (GREEN below); P1 turns all eleven green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientFailure, type OperationId } from '@nublai/pi-worker-client';
import { routes } from '../../src/generated/routes.js';
import { expand, get, semanticHash, substitute, transitions, type Step } from './fixture.js';
import { startTarget, type Worker } from './target.js';

/** Pinned: the frozen fields of the eleven rows. A change needs a new contract revision approved by the founder. */
const FROZEN_SEMANTIC_HASH = '290168fc3c49bbe536b31f575f05b1f5330bbe9c55080eeeeee3a1c2c2726b51';
const ROW_IDS = ['01-binding', '02-unknown', '03-fenced-write', '04-paused', '05-keep', '06-abandon', '07-observed', '08-generation', '09-restart', '10-cleanup-resume', '11-control'];

test('conformance: the section 0.1 fixture is revision 8, eleven rows, and its semantic hash is pinned', () => {
  assert.equal(transitions.contract_revision, 8);
  assert.deepEqual(
    transitions.rows.map(r => r.id),
    ROW_IDS,
  );
  assert.equal(semanticHash(transitions.rows), FROZEN_SEMANTIC_HASH);
});

test('conformance: the semantic hash covers every frozen field and ignores step wire data', () => {
  const rows = structuredClone(transitions.rows);
  for (const field of ['from', 'event', 'to'] as const) {
    const changed = structuredClone(rows);
    changed[0]![field] = `${changed[0]![field]} `;
    assert.notEqual(semanticHash(changed), FROZEN_SEMANTIC_HASH, field);
  }
  const assertion = structuredClone(rows);
  assertion[2]!.expect[0]!.equals = 'unknown';
  assert.notEqual(semanticHash(assertion), FROZEN_SEMANTIC_HASH);
  const wire = structuredClone(rows);
  wire[0]!.steps[1]!.fields = { message: 'renamed field in a catalog change' };
  assert.equal(semanticHash(wire), FROZEN_SEMANTIC_HASH);
});

/** A synthetic binding and state, so every `@` reference in a call body resolves to a well-formed value. */
const synthetic = {
  initial: { worker_id: 'w-fixture', session_id: 's-fixture', worker_epoch: 'e-fixture', binding_revision: 1 },
  worker: { worker_id: 'w-fixture', session_id: 's-fixture', worker_epoch: 'e-fixture', binding_revision: 1, execution: { execution_id: 'x-fixture' }, fence: { fence_generation: 1 } },
  child_cwd: '/tmp/piw-fixture-child',
};

function callBody(step: Step, context: { initial: Pick<Worker, 'session_id' | 'worker_epoch' | 'binding_revision'>; worker: Pick<Worker, 'session_id' | 'worker_epoch' | 'binding_revision'> }): Record<string, unknown> {
  const source = step.binding === 'worker' ? context.worker : context.initial;
  return {
    command_id: step.command_id,
    session_id: source.session_id,
    worker_epoch: source.worker_epoch,
    binding_revision: source.binding_revision,
    ...(substitute(step.fields ?? {}, context) as Record<string, unknown>),
  };
}

test('conformance: every call body in the fixture validates against the B2 spec', () => {
  let calls = 0;
  for (const row of transitions.rows) {
    for (const step of expand(row.steps)) {
      if (step.kind !== 'call' && step.kind !== 'begin') continue;
      calls++;
      const route = routes[step.method as keyof typeof routes];
      assert.ok(route, `${row.id}: ${step.method} is not a B2 operation`);
      assert.ok(route.validateBody, `${row.id}: ${step.method} takes no body`);
      const body = callBody(step, synthetic);
      assert.equal(JSON.stringify(body).includes('null'), false, `${row.id}: an @ reference did not resolve`);
      assert.equal(route.validateBody(body), true, `${row.id} ${step.method}: ${JSON.stringify(route.validateBody.errors)}`);
    }
  }
  assert.ok(calls >= 20, `only ${calls} calls found`);
});

/**
 * Every row is green from P1-11 on (plan section 5.1): 02, 03, 07, 08, 09 and 11 at P1-6; 01 and 10 at P1-7; 04, 05
 * and 06 at P1-11. No row may be `todo` any more: the runner fails if one is (below), so all eleven run on every PR.
 */
const TODO_ROWS: ReadonlySet<string> = new Set();

test('conformance: no frozen row is todo; all eleven run', () => {
  assert.deepEqual([...TODO_ROWS], [], 'a frozen row marked todo');
  assert.deepEqual(
    transitions.rows.map(r => r.id).filter(id => TODO_ROWS.has(id)),
    [],
  );
});

for (const row of transitions.rows) {
  test(`contract 0.1 fixture ${row.id}`, async () => {
    const session = await startTarget(row.profile ? { profile: row.profile } : {});
    const { client, initial, host } = session;
    try {
      let worker = initial;
      let result: unknown = null;
      let inflight: Promise<unknown> | undefined;
      const context = () => ({ initial, worker, child_cwd: session.childCwd });
      const invoke = async (step: Step): Promise<unknown> => {
        try {
          // SAFETY: the method and body come from the fixture; the previous test validates every body against the spec.
          return await client.call(step.method as OperationId, { path: { worker_id: initial.worker_id }, body: callBody(step, context()) } as never);
        } catch (error) {
          if (error instanceof ClientFailure) return { error: error.message, effect: error.effect, ...error.details };
          throw error;
        }
      };
      for (const step of expand(row.steps)) {
        if (step.kind === 'host_reply') {
          if (step.mode === 'drop') host.dropNextPromptReply();
          else host.holdNextPromptReply();
        } else if (step.kind === 'call') result = await invoke(step);
        else if (step.kind === 'begin') {
          const started = host.nextAgentStart();
          inflight = invoke(step);
          await started;
        } else if (step.kind === 'drop_reply') {
          host.releaseHeldReply();
          result = await inflight;
        } else if (step.kind === 'host_event') host.emit(step.event!);
        else if (step.kind === 'drain') await host.drain();
        else if (step.kind === 'restart') await session.restart();
        else throw new Error(`unknown fixture step ${step.kind}`);
        worker = await client.call('workers.get', { path: { worker_id: initial.worker_id } });
      }
      const actual = { worker, disk: session.disk(initial.worker_id), result, effects: { prompts: host.prompts, hosts: session.hosts() } };
      for (const check of row.expect) assert.deepEqual(get(actual, check.path), check.equals, `${row.id}: ${check.path}`);
    } finally {
      await session.close();
    }
  });
}
