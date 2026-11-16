import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaths, ConfigError } from '../src/config.js';

test('config: XDG defaults place state and socket under the user directories', () => {
  assert.deepEqual(resolvePaths({ XDG_STATE_HOME: '/home/u/.state', XDG_RUNTIME_DIR: '/run/user/1000' }), {
    stateDir: '/home/u/.state/pi-worker',
    socketPath: '/run/user/1000/pi-worker/b2.sock',
  });
  assert.equal(resolvePaths({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' }).stateDir, '/home/u/.local/state/pi-worker');
});

test('config: PIW_* overrides win', () => {
  assert.deepEqual(resolvePaths({ PIW_STATE_DIR: '/s', PIW_SOCKET: '/r/b2.sock', XDG_STATE_HOME: '/x', XDG_RUNTIME_DIR: '/y' }), {
    stateDir: '/s',
    socketPath: '/r/b2.sock',
  });
});

test('config: no runtime directory and no PIW_SOCKET refuses instead of falling back to /tmp', () => {
  assert.throws(() => resolvePaths({ HOME: '/home/u' }), ConfigError);
});

test('config: relative paths are refused', () => {
  assert.throws(() => resolvePaths({ PIW_STATE_DIR: 'state', XDG_RUNTIME_DIR: '/run/user/1' }), /absolute/);
  assert.throws(() => resolvePaths({ HOME: '/h', PIW_SOCKET: 'b2.sock' }), /absolute/);
});
