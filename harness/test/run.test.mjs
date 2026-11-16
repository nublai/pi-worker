// No-network tests for harness/run.sh VM ownership and teardown. `ssh` is a stub on PATH that keeps a fake exe.dev
// VM list in a state file and logs every call; no VM or network is touched.
//   node --test harness/test/run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = fileURLToPath(new URL('..', import.meta.url));

const STUB = `#!/usr/bin/env bash
# args: [options...] host command...   (options start with -)
echo "$*" >> "$STUB_DIR/calls.log"
while [ $# -gt 0 ] && [ "\${1#-}" != "$1" ]; do
  case "$1" in -o) shift 2 ;; *) shift ;; esac
done
host=$1; shift
if [ "$host" = exe.dev ]; then
  case "$1" in
    new)
      name=\${2#--name=}
      if [ -n "\${STUB_NEW_FAIL:-}" ] || grep -qx "$name" "$STUB_DIR/vms" 2>/dev/null; then echo "name already exists" >&2; exit 17; fi
      echo "$name" >> "$STUB_DIR/vms" ;;
    rm)
      [ -z "\${STUB_RM_FAIL:-}" ] || exit 42
      grep -vx "$2" "$STUB_DIR/vms" > "$STUB_DIR/vms.new"; mv "$STUB_DIR/vms.new" "$STUB_DIR/vms" ;;
  esac
  exit 0
fi
# a VM host
[ -z "\${STUB_SSH_DOWN:-}" ] || exit 255
case "$*" in
  *tailscale*) exit 1 ;;
  "cat > piw.bundle") cat >/dev/null ;;
  *journey.sh*) mkdir -p "$STUB_DIR" ;;
esac
exit 0
`;

function setup(vmsInitial = []) {
  const root = mkdtempSync(join(tmpdir(), 'piw-harness-test-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'harness', 'journeys', 'px-test'), { recursive: true });
  for (const d of ['lib', 'vm']) cpSync(join(harnessDir, d), join(repo, 'harness', d), { recursive: true });
  cpSync(join(harnessDir, 'run.sh'), join(repo, 'harness', 'run.sh'));
  writeFileSync(join(repo, 'harness', 'journeys', 'px-test', 'journey.sh'), '#!/bin/sh\n');
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'x');
  const stubDir = join(root, 'stub');
  mkdirSync(join(stubDir, 'bin'), { recursive: true });
  writeFileSync(join(stubDir, 'bin', 'ssh'), STUB);
  chmodSync(join(stubDir, 'bin', 'ssh'), 0o755);
  writeFileSync(join(stubDir, 'vms'), vmsInitial.map(v => `${v}\n`).join(''));
  const run = env =>
    spawnSync('bash', [join(repo, 'harness', 'run.sh'), 'px-test'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(stubDir, 'bin')}:${process.env.PATH}`, STUB_DIR: stubDir, PIW_READY_TRIES: '2', PIW_READY_SLEEP: '0', ...env },
    });
  const calls = () => (existsSync(join(stubDir, 'calls.log')) ? readFileSync(join(stubDir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
  const vms = () => readFileSync(join(stubDir, 'vms'), 'utf8').split('\n').filter(Boolean);
  const evidence = () => {
    const base = join(repo, 'docs', 'evidence', 'px');
    const runs = existsSync(base) ? readdirSync(base) : [];
    return runs.length ? JSON.parse(readFileSync(join(base, runs[0], 'checks.json'), 'utf8')) : null;
  };
  return { root, run, calls, vms, evidence };
}

test('duplicate VM name: creation is refused and the other run VM is left untouched', () => {
  const t = setup(['piw-other-run']);
  try {
    const r = t.run({ PIW_VM_NAME: 'piw-other-run' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(t.vms(), ['piw-other-run']);
    assert.equal(t.calls().filter(c => /exe\.dev rm/.test(c)).length, 0, 'must not delete a VM this run did not create');
    assert.equal(t.evidence().vm_teardown, 'not_created');
    assert.equal(t.evidence().counted, false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('VM names are unique per run', () => {
  const t = setup();
  try {
    t.run({ STUB_RM_FAIL: '1' });
    t.run({ STUB_RM_FAIL: '1' });
    const names = t.vms();
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('readiness failure after a successful create still deletes our VM', () => {
  const t = setup();
  try {
    const r = t.run({ STUB_SSH_DOWN: '1' });
    assert.notEqual(r.status, 0);
    assert.equal(t.calls().filter(c => /exe\.dev rm piw-px-test-/.test(c)).length, 1);
    assert.deepEqual(t.vms(), []);
    assert.equal(t.evidence().vm_teardown, 'deleted');
    assert.equal(t.evidence().status, 'fail');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('a teardown failure fails the run and is recorded in the evidence', () => {
  const t = setup();
  try {
    const r = t.run({ STUB_RM_FAIL: '1' });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    const e = t.evidence();
    assert.equal(e.vm_teardown, 'failed');
    assert.equal(e.status, 'fail');
    assert.equal(e.counted, false);
    assert.match(e.note, /teardown failed/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('successful create and clean teardown: VM deleted, recorded', () => {
  const t = setup();
  try {
    const r = t.run({});
    assert.equal(t.evidence().vm_teardown, 'deleted');
    assert.deepEqual(t.vms(), []);
    assert.match(r.stdout, /vm deleted/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
