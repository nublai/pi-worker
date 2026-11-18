// Tests for tools/reversions.mjs timeouts, in a throwaway git repo with a fake diff group; no real reversion group runs.
//   node --test harness/test/reversions-timeout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../tools/reversions.mjs', import.meta.url));

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-timeout-'));
  const sh = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  sh('init', '-q');
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  sh('add', 'f.txt');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'f.txt'), 'two\n');
  writeFileSync(join(dir, 'fake.diff'), sh('diff'));
  sh('checkout', '-q', 'f.txt');
  return dir;
};
const run = (dir, command, env = {}) =>
  spawnSync(process.execPath, [runner, '--command', command, 'fake.diff'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, ...env },
    timeout: 60_000,
  });
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a command that outlives the timeout is timed_out, its process tree is gone, and the run fails', () => {
  const dir = fixture();
  try {
    // sh -> sh -> node, plus a background sleep: all must die with the group. The ✖ line must not make it "caught".
    const command = `echo '✖ some test'; sleep 300 & echo $! > ${dir}/bg.pid; sh -c 'node -e "require(\\"fs\\").writeFileSync(\\"${dir}/node.pid\\", String(process.pid)); setInterval(()=>{},1000)"'`;
    const started = Date.now();
    const out = run(dir, command, { PIW_REVERSION_TIMEOUT_S: '2' });
    assert.ok(Date.now() - started < 30_000, 'the runner returned promptly');
    assert.equal(out.status, 1, out.stderr);
    const report = JSON.parse(out.stdout);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].result, 'timed_out');
    assert.equal(report.results[0].timeout_s, 2);
    for (const f of ['bg.pid', 'node.pid']) {
      assert.ok(existsSync(join(dir, f)), `${f} was written`);
      const pid = Number(readFileSync(join(dir, f), 'utf8'));
      assert.equal(alive(pid), false, `${f} process ${pid} is gone`);
    }
    assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'one\n', 'the diff was reverted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a command that finishes inside the timeout is classified as before', () => {
  const dir = fixture();
  try {
    const caught = run(dir, `echo '✖ named test'; exit 1`, { PIW_REVERSION_TIMEOUT_S: '30' });
    assert.equal(caught.status, 0, caught.stderr);
    assert.equal(JSON.parse(caught.stdout).results[0].result, 'caught');
    const passing = run(dir, 'exit 0', { PIW_REVERSION_TIMEOUT_S: '30' });
    assert.equal(passing.status, 1);
    assert.equal(JSON.parse(passing.stdout).results[0].result, 'NOT_CAUGHT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad PIW_REVERSION_TIMEOUT_S is a usage error', () => {
  const dir = fixture();
  try {
    assert.equal(run(dir, 'exit 0', { PIW_REVERSION_TIMEOUT_S: 'soon' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
