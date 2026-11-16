// No-systemd tests for harness/ci/units.sh, the leftover piw-* unit check in kernel.sh. `systemctl` is a stub on PATH
// that answers each `list-units` call with the next scripted listing (the last one repeats) and logs every call.
//   node --test harness/test/kernel-units.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const units = fileURLToPath(new URL('../ci/units.sh', import.meta.url));

const STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls.log"
[ "$2" = list-units ] || exit 0
n=$(($(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$STUB_DIR/count"
f="$STUB_DIR/list.$n"
[ -f "$f" ] || f=$(ls "$STUB_DIR"/list.* | sort -t. -k2 -n | tail -1)
cat "$f"
`;

/** Runs piw_leftover_units against scripted listings; returns its output lines and the number of listings read. */
function check(listings, tries = 5) {
  const dir = mkdtempSync(join(tmpdir(), 'piw-units-'));
  try {
    writeFileSync(join(dir, 'systemctl'), STUB);
    chmodSync(join(dir, 'systemctl'), 0o755);
    listings.forEach((l, i) => writeFileSync(join(dir, `list.${i + 1}`), l ? `${l}\n` : ''));
    const r = spawnSync('bash', ['-c', `set -euo pipefail; . "$1"; piw_leftover_units ${tries} 0.01`, 'check', units], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    assert.ok(calls.every(c => c === '--user list-units --all --plain --no-legend piw-*'), `only listings, never a stop: ${calls}`);
    return { left: r.stdout.split('\n').filter(Boolean), listings: calls.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WRAPPER = 'piw-kernel-1794841751-2713.service';

test('kernel units: the wrapper service systemd still lists while it unloads is not a leftover (run 43893196124)', () => {
  const r = check([`${WRAPPER} loaded deactivating stop-sigterm /bin/sh -c ...`, `${WRAPPER} loaded inactive dead /bin/sh -c ...`, '']);
  assert.deepEqual(r.left, []);
  assert.equal(r.listings, 3, 'it waited for the unit to go, then stopped polling');
});

test('kernel units: a listed unit that is not loaded is gone', () => {
  assert.deepEqual(check([`${WRAPPER} not-found inactive dead ${WRAPPER}`]), { left: [], listings: 1 });
  assert.deepEqual(check([`● ${WRAPPER} not-found inactive dead ${WRAPPER}`]), { left: [], listings: 1 });
});

test('kernel units: nothing listed is no leftover, checked once', () => {
  assert.deepEqual(check(['']), { left: [], listings: 1 });
});

test('kernel units: a unit still active after the bound is a leftover', () => {
  const r = check(['piw-smoke-2750.scope loaded active running piw-smoke-2750.scope'], 4);
  assert.deepEqual(r.left, ['piw-smoke-2750.scope:loaded/active/running']);
  assert.equal(r.listings, 4, 'reported at the bound, not before');
});

test('kernel units: a failed unit (with its status bullet) that stays is a leftover', () => {
  assert.deepEqual(check([`● ${WRAPPER} loaded failed failed /bin/sh -c ...`]).left, [`${WRAPPER}:loaded/failed/failed`]);
});

test('kernel units: a unit stuck unloading past the bound is a leftover', () => {
  assert.deepEqual(check([`${WRAPPER} loaded deactivating stop-sigterm /bin/sh -c ...`]).left, [`${WRAPPER}:loaded/deactivating/stop-sigterm`]);
});

test('kernel units: a transient unit that goes is dropped; a real leftover beside it is still reported', () => {
  const real = 'piw-smoke-2750.scope loaded active running piw-smoke-2750.scope';
  const r = check([`${WRAPPER} loaded inactive dead /bin/sh -c ...\n${real}`, real]);
  assert.deepEqual(r.left, ['piw-smoke-2750.scope:loaded/active/running']);
});
