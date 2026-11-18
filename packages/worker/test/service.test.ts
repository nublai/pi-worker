/**
 * The installed unit's entry (src/service.ts): the supervisor moves itself into the unit cgroup's `supervisor` leaf and
 * uses the unit cgroup as its delegation, and refuses anywhere but a `.service` cgroup it can write. A fake
 * /proc/self/cgroup and a plain directory stand in for cgroupfs; the real move runs in the p4-install journey.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterServiceLeaf, ServiceDelegationRefused, SUPERVISOR_LEAF } from '../src/service.js';

const UNIT = '/user.slice/user-1000.slice/user@1000.service/app.slice/pi-worker.service';

function fixture(cgroupLine: string) {
  const dir = mkdtempSync(join(tmpdir(), 'piw-service-'));
  const proc = join(dir, 'cgroup');
  writeFileSync(proc, `${cgroupLine}\n`);
  const mount = join(dir, 'fs');
  mkdirSync(join(mount, UNIT), { recursive: true });
  return { dir, proc, mount, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('service: the supervisor enters the unit leaf and the unit cgroup is its delegation', () => {
  const f = fixture(`0::${UNIT}`);
  try {
    const root = enterServiceLeaf(f.proc, f.mount);
    assert.equal(root, join(f.mount, UNIT));
    assert.equal(readFileSync(join(root, SUPERVISOR_LEAF, 'cgroup.procs'), 'utf8'), '0\n', 'the process wrote itself into the leaf');
    // A restarted unit finds the leaf it made before.
    assert.equal(enterServiceLeaf(f.proc, f.mount), root);
  } finally {
    f.cleanup();
  }
});

test("service: outside pi-worker.service's cgroup, or on cgroup v1, the daemon refuses to start and makes no leaf", () => {
  const other = '/user.slice/user-1000.slice/user@1000.service/app.slice/other.service';
  const lines = ['0::/user.slice/user-1000.slice/session-3.scope', `0::${other}`, `1:name=systemd:${UNIT}\n0::${UNIT}`, `0::${UNIT}/../x.service/..`];
  for (const [i, line] of lines.entries()) {
    const f = fixture(line);
    mkdirSync(join(f.mount, other), { recursive: true });
    try {
      assert.throws(() => enterServiceLeaf(f.proc, f.mount), ServiceDelegationRefused, `case ${i} refused`);
      assert.equal(existsSync(join(f.mount, other, SUPERVISOR_LEAF)), false, `case ${i}: another service's cgroup is left as it was`);
    } finally {
      f.cleanup();
    }
  }
});

test('service: a unit cgroup the user cannot write (no Delegate=yes) refuses', () => {
  const f = fixture(`0::${UNIT}`);
  try {
    chmodSync(join(f.mount, UNIT), 0o500);
    assert.throws(
      () => enterServiceLeaf(f.proc, f.mount),
      (error: unknown) => error instanceof ServiceDelegationRefused && error.code === 'no_service_delegation' && /Delegate=yes/.test(error.message),
    );
  } finally {
    chmodSync(join(f.mount, UNIT), 0o700);
    f.cleanup();
  }
});
