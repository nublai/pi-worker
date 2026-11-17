/** Error mapping: the typed name, the effect, and the exit code that tells a script whether anything may have happened. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientFailure, ProtocolMismatch, ResyncRequired } from '@nublai/pi-worker-client';
import { UsageError } from '../src/commands.js';
import { EXIT, grantFailure, GrantCommandFailed, mapError, ReceiptRefusal } from '../src/errors.js';

test('cli errors: a worker refusal keeps its name, status, effect and details; no_effect exits 1, unknown exits 3', () => {
  const refused = new ClientFailure('session_fenced', 'no_effect', 'http', 409, { error: 'session_fenced', effect: 'no_effect', uncertain_command_id: 'c0' });
  assert.deepEqual(mapError(refused, { command_id: 'c1' }), {
    body: { error: 'session_fenced', status: 409, uncertain_command_id: 'c0', effect: 'no_effect', command_id: 'c1' },
    exitCode: EXIT.noEffect,
  });
  const unknown = new ClientFailure('dispatch_failed', 'unknown', 'http', 500, { error: 'dispatch_failed', effect: 'unknown' });
  assert.deepEqual(mapError(unknown, { command_id: 'c2' }), { body: { error: 'dispatch_failed', status: 500, effect: 'unknown', command_id: 'c2' }, exitCode: EXIT.unknown });
  assert.equal(mapError(new ClientFailure('operation_not_implemented', 'no_effect', 'http', 501, {})).exitCode, 1);
});

test('cli errors: transport failures are typed by phase; a typed client name is kept', () => {
  assert.deepEqual(mapError(new ClientFailure('connect ENOENT /s', 'no_effect', 'before_write')), {
    body: { error: 'transport_before_write', detail: 'connect ENOENT /s', effect: 'no_effect' },
    exitCode: EXIT.noEffect,
  });
  assert.deepEqual(mapError(new ClientFailure('socket hang up', 'unknown', 'after_write'), { command_id: 'c3', attachment_id: undefined }), {
    body: { error: 'transport_after_write', detail: 'socket hang up', effect: 'unknown', command_id: 'c3' },
    exitCode: EXIT.unknown,
  });
  assert.deepEqual(mapError(new ClientFailure('grant_file_unreadable', 'no_effect', 'before_write')).body, { error: 'grant_file_unreadable', effect: 'no_effect' });
});

test('cli errors: usage, protocol, resync, receipt and grant failures', () => {
  assert.deepEqual(mapError(new UsageError('x needs --y'), { command_id: 'c' }), { body: { error: 'usage', effect: 'no_effect', detail: 'x needs --y' }, exitCode: EXIT.usage });
  assert.equal(mapError(new ProtocolMismatch(1)).body.error, 'protocol_mismatch');
  assert.deepEqual(mapError(new ResyncRequired('overflow')).body, { error: 'resync_required', reason: 'overflow', effect: 'no_effect' });
  assert.deepEqual(mapError(new ReceiptRefusal('pi_refused', 'no_effect', 'rejected'), { command_id: 'c4' }), {
    body: { error: 'pi_refused', receipt_state: 'rejected', effect: 'no_effect', command_id: 'c4' },
    exitCode: EXIT.noEffect,
  });
  assert.equal(mapError(new ReceiptRefusal('outcome_unknown', 'unknown', 'outcome_unknown')).exitCode, EXIT.unknown);
  assert.deepEqual(mapError(new GrantCommandFailed('invalid_grant', 'no_effect')), { body: { error: 'invalid_grant', effect: 'no_effect' }, exitCode: EXIT.noEffect });
  assert.deepEqual(mapError(new Error('boom')), { body: { error: 'cli_failure', detail: 'boom', effect: 'unknown' }, exitCode: EXIT.unknown });
});

test('cli errors: the grant command fails by refusal (no effect), by usage, or by system error (unknown)', () => {
  const refusal = grantFailure("file:///x/store.js:87\n            throw new Refusal('invalid_grant');\n\nRefusal [Error]: invalid_grant\n    at GrantStore.read\n  effect: 'no_effect',\n", 1);
  assert.deepEqual([refusal.code, refusal.effect], ['invalid_grant', 'no_effect']);
  const system = grantFailure("Error: EEXIST: file already exists, open '/g.json'\n    at openSync\n  errno: -17,\n  code: 'EEXIST',\n  syscall: 'open',\n", 1);
  assert.deepEqual([system.code, system.effect], ['EEXIST', 'unknown']);
  assert.deepEqual([grantFailure('usage: grant register ...', 2).code, grantFailure('usage', 2).effect], ['grant_usage', 'no_effect']);
  assert.deepEqual([grantFailure('', null).code, grantFailure('', null).effect], ['grant_command_failed', 'unknown']);
});
