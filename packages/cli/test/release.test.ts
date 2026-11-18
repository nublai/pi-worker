/**
 * harness/release/build.sh builds only from the committed HEAD: it refuses a checkout with tracked changes, and it
 * takes engines.node and the wrapper template from the archived tree, never the working tree. It runs here in a small
 * synthetic repository holding this checkout's build.sh and wrapper (the working-tree copies, so a reversion applied
 * to build.sh is what runs), with a fake `npm` first on PATH that writes the files build.sh copies: no network, no
 * real dependency install. Every run uses a synthetic environment under its own scratch directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const FLOOR = '1.2.3';

// The npm calls build.sh makes, faked: `ci` makes a node_modules as npm does (workspace links, the CLI's .bin link
// into its workspace package, an inner .bin link; FAKE_NPM_LINK_OUT adds a link out of the tree), `run build` the
// compiled files build.sh copies.
const FAKE_NPM = `#!/bin/sh
case "$1" in
  ci)
    mkdir -p node_modules/dep node_modules/@nublai node_modules/.bin
    echo '{"name":"dep","version":"1.0.0"}' > node_modules/dep/package.json
    echo '' > node_modules/dep/cli.js
    for p in client-ts:pi-worker-client worker:pi-worker cli:pi-worker-cli; do ln -s ../../packages/\${p%%:*} node_modules/@nublai/\${p#*:}; done
    ln -s ../@nublai/pi-worker-cli/dist/src/main.js node_modules/.bin/pi-worker
    ln -s ../dep/cli.js node_modules/.bin/dep
    [ -z "\${FAKE_NPM_LINK_OUT:-}" ] || ln -s /etc node_modules/dep/out ;;
  run)
    for p in client-ts worker cli; do mkdir -p packages/$p/dist/src; done
    mkdir -p packages/worker/dist/src/b2
    echo 'export const PROTOCOL = { major: 0, minor: 1 };' > packages/worker/dist/src/b2/hello.js
    : > packages/worker/dist/src/service.js
    : > packages/client-ts/dist/src/index.js
    echo 'process.exit(0);' > packages/cli/dist/src/main.js ;;
  *) echo "fake npm: unexpected $*" >&2; exit 97 ;;
esac
`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'piw-release-'));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'tmp'));
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'pi-worker-repo', private: true, engines: { node: `>=${FLOOR}` } }, null, 2)}\n`,
    LICENSE: 'MIT\n',
    'packages/client-ts/package.json': '{"name":"@nublai/pi-worker-client","version":"0.0.0"}\n',
    'packages/worker/package.json': '{"name":"@nublai/pi-worker","version":"0.0.0","dependencies":{"@nublai/pi-worker-client":"0.0.0"}}\n',
    'packages/cli/package.json': '{"name":"@nublai/pi-worker-cli","version":"0.0.0"}\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  mkdirSync(join(repo, 'harness', 'release'), { recursive: true });
  for (const file of ['build.sh', 'pi-worker.sh']) copyFileSync(join(ROOT, 'harness', 'release', file), join(repo, 'harness', 'release', file));
  chmodSync(join(repo, 'harness', 'release', 'build.sh'), 0o755);
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(dir, 'home'),
    TMPDIR: join(dir, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args[0]} in the scratch repository`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'scratch');
  const out = join(dir, 'out');
  const build = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(repo, 'harness', 'release', 'build.sh'), ARCH], { cwd: repo, env: { ...env, ...extra, PIW_RELEASE_OUT: out }, encoding: 'utf8' });
  /** The built tarball, unpacked: its wrapper text, release.json and its node_modules/.bin entries. */
  const unpacked = () => {
    const tarball = readdirSync(out).find(f => f.endsWith('.tar.gz'))!;
    const into = mkdtempSync(join(dir, 'unpacked-'));
    assert.equal(spawnSync('tar', ['-xzf', join(out, tarball), '-C', into], { env }).status, 0, 'the artifact unpacks');
    const top = join(into, readdirSync(into)[0]!);
    return {
      wrapper: readFileSync(join(top, 'bin', 'pi-worker'), 'utf8'),
      release: JSON.parse(readFileSync(join(top, 'release.json'), 'utf8')) as Record<string, unknown>,
      bins: readdirSync(join(top, 'node_modules', '.bin')).sort(),
    };
  };
  return { dir, repo, out, git, build, unpacked, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('build.sh: a clean checkout builds; one with a tracked change (wrapper or package.json) is refused and builds nothing', () => {
  const s = scratch();
  try {
    const clean = s.build();
    assert.equal(clean.status, 0, 'a clean checkout builds');
    const built = s.unpacked();
    assert.equal(built.release.commit, s.git('rev-parse', 'HEAD'), 'release.json names HEAD');
    assert.deepEqual(built.bins, ['dep'], "the CLI's npm bin link into the removed workspace package is not shipped; an inner one is");
    rmSync(s.out, { recursive: true, force: true });
    for (const file of ['harness/release/pi-worker.sh', 'package.json']) {
      const path = join(s.repo, file);
      const before = readFileSync(path, 'utf8');
      appendFileSync(path, file.endsWith('.json') ? '\n' : '# uncommitted\n');
      const dirty = s.build();
      assert.equal(dirty.status, 2, `a tracked change to ${file} is refused`);
      assert.match(dirty.stderr, /build: refused: the checkout has tracked changes/);
      assert.equal(existsSync(s.out) && readdirSync(s.out).length > 0, false, `${file}: no artifact was written`);
      writeFileSync(path, before);
    }
  } finally {
    s.cleanup();
  }
});

test('build.sh: a release tree with a link that resolves out of it is refused and nothing is packed', () => {
  const s = scratch();
  try {
    const r = s.build({ FAKE_NPM_LINK_OUT: '1' });
    assert.equal(r.status, 1, 'refused');
    assert.match(r.stderr, /node_modules\/dep\/out resolves to nothing or out of the release/);
    assert.equal(existsSync(s.out) && readdirSync(s.out).some(f => f.endsWith('.tar.gz')), false, 'no artifact was written');
  } finally {
    s.cleanup();
  }
});

test("build.sh: engines.node and the wrapper come from the archived HEAD, not the working tree's copies", () => {
  const s = scratch();
  try {
    // Changes git status does not show (assume-unchanged): only reading from the archive keeps them out.
    s.git('update-index', '--assume-unchanged', 'harness/release/pi-worker.sh', 'package.json');
    appendFileSync(join(s.repo, 'harness', 'release', 'pi-worker.sh'), '# uncommitted wrapper line\n');
    writeFileSync(join(s.repo, 'package.json'), JSON.stringify({ name: 'pi-worker-repo', private: true, engines: { node: '>=9.9.9' } }));
    assert.equal(s.git('status', '--porcelain', '--untracked-files=no'), '', 'git status shows no change');
    const r = s.build();
    assert.equal(r.status, 0, 'the build runs');
    const { wrapper, release } = s.unpacked();
    assert.equal(wrapper.includes('uncommitted wrapper line'), false, 'the wrapper is the committed one');
    assert.ok(wrapper.includes(`floor='${FLOOR}'`), "the wrapper's floor is the committed engines.node");
    assert.equal(release.node_engine, `>=${FLOOR}`, "release.json's node_engine is the committed engines.node");
    assert.equal(release.commit, s.git('rev-parse', 'HEAD'));
  } finally {
    s.cleanup();
  }
});
