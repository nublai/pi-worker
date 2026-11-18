/**
 * The release wrapper, bin/pi-worker (harness/release/pi-worker.sh with build.sh's floor substituted): it runs
 * dist/main.js on the host's node only when that node meets the floor, and otherwise refuses with one typed JSON line
 * on stderr and exit 1 before anything runs. A fake `node` on a synthetic PATH reports a chosen version and, when
 * executed on the entry, prints what it was given.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('../../../../harness/release/pi-worker.sh', import.meta.url));
const FLOOR = '26.12.1';

function release() {
  const dir = mkdtempSync(join(tmpdir(), 'piw-wrapper-'));
  const top = join(dir, 'versions', 'pi-worker-1.0.0');
  mkdirSync(join(top, 'bin'), { recursive: true });
  mkdirSync(join(top, 'dist'));
  const wrapper = join(top, 'bin', 'pi-worker');
  writeFileSync(wrapper, readFileSync(TEMPLATE, 'utf8').replaceAll('@NODE_FLOOR@', FLOOR), { mode: 0o755 });
  const nodeDir = join(dir, 'nodebin');
  mkdirSync(nodeDir);
  // Only the tools the wrapper uses, so no host node on /usr/bin can stand in for the fake one.
  const toolDir = join(dir, 'tools');
  mkdirSync(toolDir);
  for (const tool of ['readlink', 'dirname']) symlinkSync(join('/usr/bin', tool), join(toolDir, tool));
  const node = (version: string | undefined) => {
    rmSync(join(nodeDir, 'node'), { force: true });
    if (version === undefined) return;
    // `-p` answers the version; any other call is the exec of the entry, which reports its arguments.
    writeFileSync(join(nodeDir, 'node'), `#!/bin/sh\nif [ "$1" = -p ]; then echo '${version}'; exit 0; fi\necho "RAN $*"\n`, { mode: 0o755 });
  };
  const exec = (path = wrapper, ...args: string[]) => spawnSync(path, args, { env: { PATH: `${nodeDir}:${toolDir}` }, encoding: 'utf8' });
  return { dir, top, wrapper, node, exec, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('wrapper: a node at or above the floor runs dist/main.js with the arguments, also through a symlink', () => {
  const r = release();
  try {
    for (const version of [FLOOR, '26.13.1', '26.12.10', '27.0.0', '100.0.0', '26.12.1-pre']) {
      r.node(version);
      const result = r.exec(r.wrapper, 'hello', '--socket', 'x');
      assert.equal(result.status, 0, `node ${version} meets the floor`);
      assert.equal(result.stdout.trim(), `RAN ${join(r.top, 'dist', 'main.js')} hello --socket x`, `node ${version} runs the entry`);
      assert.equal(result.stderr, '');
    }
    const link = join(r.dir, 'pi-worker');
    symlinkSync(r.wrapper, link);
    r.node('26.13.1');
    assert.equal(r.exec(link).stdout.trim(), `RAN ${join(r.top, 'dist', 'main.js')}`, 'the entry is found through a symlink to the wrapper');
  } finally {
    r.cleanup();
  }
});

test('wrapper: a node below the floor, or one that reports no version, is refused with node_unsupported, exit 1', () => {
  const r = release();
  try {
    for (const [version, found] of [
      ['26.12.0', '26.12.0'],
      ['26.11.9', '26.11.9'],
      ['25.99.99', '25.99.99'],
      ['22.19.0', '22.19.0'],
      ['8.0.0', '8.0.0'],
      ['garbage', 'unknown'],
      ['', 'unknown'],
    ] as const) {
      r.node(version);
      const result = r.exec();
      assert.equal(result.status, 1, `node ${version || '(empty)'} is refused`);
      assert.equal(result.stdout, '', `node ${version || '(empty)'}: the entry never runs`);
      assert.deepEqual(JSON.parse(result.stderr), { error: 'node_unsupported', effect: 'no_effect', required: `>=${FLOOR}`, found }, `node ${version || '(empty)'}: one typed line`);
    }
  } finally {
    r.cleanup();
  }
});

test('wrapper: no node on PATH is refused with node_missing, exit 1', () => {
  const r = release();
  try {
    r.node(undefined);
    const result = r.exec();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: 'node_missing', effect: 'no_effect', required: `>=${FLOOR}` });
  } finally {
    r.cleanup();
  }
});
