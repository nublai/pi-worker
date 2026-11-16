/**
 * Kernel tier smoke tests (plan P0-8): the host facilities P2's containment and sandbox need. They run only under
 * `harness/ci/kernel.sh`, which starts the suite in a delegated systemd user service (`Delegate=yes`), moves it into
 * the service's `runner` leaf and sets PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT (the delegated cgroup). Elsewhere they
 * skip, and kernel.sh fails on any skip. With PIW_TEST_KERNEL=1 a missing facility is a failure, never a skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 in a delegated user service (harness/ci/kernel.sh)';

function delegatedRoot(): string {
  const root = process.env.PIW_CGROUP_ROOT ?? '';
  assert.ok(root.startsWith('/sys/fs/cgroup/'), 'PIW_CGROUP_ROOT names the delegated cgroup (kernel.sh sets it)');
  const own = readFileSync('/proc/self/cgroup', 'utf8').trim();
  assert.match(own, /^0::\/[^\n]*$/, 'pure cgroup v2');
  assert.ok(join('/sys/fs/cgroup', own.slice(3)).startsWith(`${root}/`), `this process (${own}) runs inside ${root}`);
  return root;
}

const populated = (dir: string) => /^populated 1$/m.test(readFileSync(join(dir, 'cgroup.events'), 'utf8'));

test('kernel: a delegated cgroup v2 domain is created, gets memory and pids, is killed with a setsid descendant, and removed', { skip }, async t => {
  const root = delegatedRoot();
  for (const file of ['cgroup.procs', 'cgroup.subtree_control']) accessSync(join(root, file), constants.W_OK);
  const controllers = readFileSync(join(root, 'cgroup.controllers'), 'utf8').trim().split(/\s+/);
  assert.ok(['memory', 'pids'].every(c => controllers.includes(c)), `memory and pids delegated (got: ${controllers.join(' ')})`);
  writeFileSync(join(root, 'cgroup.subtree_control'), '+memory +pids\n');
  const domain = join(root, `piw-smoke-${process.pid}`);
  t.diagnostic(`cgroup: ${domain}`);
  mkdirSync(domain);
  try {
    assert.ok(existsSync(join(domain, 'cgroup.kill')), 'cgroup.kill (Linux 5.14+)');
    assert.deepEqual(readFileSync(join(domain, 'cgroup.controllers'), 'utf8').trim().split(/\s+/).sort(), ['memory', 'pids']);
    writeFileSync(join(domain, 'pids.max'), '64\n');
    // The fixed shell joins the domain before anything else runs; its setsid grandchild escapes the process group.
    const child = spawn('/bin/sh', ['-c', 'echo $$ > "$1/cgroup.procs" || exit 125; setsid sleep 300 & exec sleep 300', 'piw-join', domain], {
      stdio: 'ignore',
      detached: true,
    });
    const deadline = Date.now() + 5000;
    while (readFileSync(join(domain, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean).length < 2) {
      assert.ok(Date.now() < deadline, 'both processes joined the domain');
      await delay(20);
    }
    assert.equal(populated(domain), true);
    writeFileSync(join(domain, 'cgroup.kill'), '1\n');
    while (populated(domain)) {
      assert.ok(Date.now() < deadline + 5000, 'populated 0 after cgroup.kill');
      await delay(20);
    }
    assert.equal(readFileSync(join(domain, 'cgroup.procs'), 'utf8').trim(), '');
    assert.equal(child.signalCode ?? 'SIGKILL', 'SIGKILL');
  } finally {
    if (existsSync(domain)) {
      try {
        writeFileSync(join(domain, 'cgroup.kill'), '1\n');
      } catch {}
      for (let i = 0; i < 100 && populated(domain); i++) await delay(20);
      rmdirSync(domain);
    }
  }
  assert.equal(existsSync(domain), false, 'the domain is removed');
});

test('kernel: bwrap --unshare-user runs a command in a new user namespace with a cleared environment', { skip }, t => {
  const version = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, `bwrap --version: ${version.error ?? version.stderr}`);
  t.diagnostic(version.stdout.trim());
  const run = spawnSync(
    'bwrap',
    ['--unshare-user', '--uid', '4242', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '--clearenv', '--',
      '/bin/sh', '-c', 'id -u; readlink /proc/self/ns/user; env | wc -l'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `bwrap: ${run.stderr.trim()} (Ubuntu 24.04 needs kernel.apparmor_restrict_unprivileged_userns=0 or a bwrap AppArmor profile)`);
  const [uid, ns, envCount] = run.stdout.trim().split('\n');
  assert.equal(uid, '4242');
  assert.notEqual(ns, readlinkSync('/proc/self/ns/user'), 'a new user namespace');
  assert.ok(Number(envCount) <= 3, `cleared environment (${envCount} variables)`);
});

