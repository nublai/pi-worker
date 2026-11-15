"""Owner-Git follow-up reversions. Each one undoes part of the snapshot fix in an
isolated copy (git archive of HEAD), rebuilds, and runs src/test/owner-git.test.ts,
portable and with A0_TEST_BWRAP=1. A reversion is killed when every guard test
it names fails on an assertion. Copies live in a fresh private directory under
$TMPDIR (the task-owned /tmp/a0s7g/tmp in the recorded run).
Usage: TMPDIR=... python3 owner-git-reversions.py OUT_DIR"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile


def read(path):
    with open(path, encoding='utf8') as f:
        return f.read()


def write(path, text):
    with open(path, 'w', encoding='utf8') as f:
        f.write(text)


def reversions():
    old = subprocess.run(['git', 'show', 'a8d1357:src/git-safe.ts'], capture_output=True, text=True, check=True).stdout
    return [
        {'name': 'owner-helper-a8d1357', 'tests': ['racing a child admin', 'racing a planted commondir', 'refused, not run', 'not honoured', 'kernel owner Git'],
         'patches': [('src/git-safe.ts', None, old)]},
        {'name': 'snapshot-removed-git-reads-pinned-paths', 'tests': ['racing a child admin', 'racing a planted commondir', 'kernel owner Git'],
         'patches': [('src/git-safe.ts', "`--git-dir=${dir}`", "`--git-dir=${pin.git_dir}`"),
                      ('src/git-safe.ts', "env: cleanEnv(home, join(pin.common_dir, 'objects'))",
                       "env: (({ GIT_OBJECT_DIRECTORY, ...e }) => (void GIT_OBJECT_DIRECTORY, e))(cleanEnv(home, ''))")]},
        {'name': 'executing-config-allowed', 'tests': ['refused, not run'],
         'patches': [('src/git-safe.ts', "if (key && EXECUTES.test(key))", "if (key && EXECUTES.test(key) && false)")]},
        {'name': 'global-config-honoured', 'tests': ['not honoured'],
         'patches': [('src/git-safe.ts', "  return { ...env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',",
                       "  void env; void home; return { ...process.env,")]},
    ]


def run_one(src, out, r):
    wt = tempfile.mkdtemp(prefix='a0-owner-git-rev-')
    try:
        archive = subprocess.run(['git', 'archive', 'HEAD'], cwd=src, capture_output=True, check=True).stdout
        subprocess.run(['tar', '-x', '-C', wt], input=archive, check=True)
        os.symlink(os.path.join(src, 'node_modules'), os.path.join(wt, 'node_modules'))
        for path, a, b in r.pop('patches'):
            p = os.path.join(wt, path)
            s = read(p)
            if a is None:
                s = b
            else:
                if s.count(a) != 1:
                    raise ValueError(f"{r['name']}: patch anchor not unique: {a[:60]}")
                s = s.replace(a, b)
            write(p, s)
        diff = subprocess.run(['git', 'diff', '--no-index', '--no-ext-diff', os.path.join(src, 'src/git-safe.ts'), os.path.join(wt, 'src/git-safe.ts')], capture_output=True, text=True).stdout
        write(os.path.join(out, r['name'] + '.diff'), diff)
        env = {**os.environ, 'A0_TEST_BWRAP': '1'}
        build = subprocess.run(['npx', 'tsc', '-p', 'tsconfig.json'], cwd=wt, capture_output=True, text=True, env=env)
        run = subprocess.run(['node', '--test', 'dist/test/owner-git.test.js'], cwd=wt, capture_output=True, text=True, env=env)
        log = build.stdout + build.stderr + run.stdout + run.stderr
        write(os.path.join(out, r['name'] + '.log'), log)
        failed = sorted(set(re.findall(r'^✖ (.+?) \(\d', run.stdout, re.M)))
        guards = [t for t in r['tests'] if any(t in f for f in failed)]
        r.update(compiled=build.returncode == 0, exit_code=run.returncode, failed_tests=failed, guards_failed=guards,
                 assertion_failure='AssertionError' in log,
                 killed=run.returncode != 0 and 'AssertionError' in log and len(guards) == len(r['tests']),
                 race_tallies=re.findall(r'tally (\{[^}]*\})', log),
                 payload_runs=[int(x) for x in re.findall(r"'(\d+) run\(s\)", log)],
                 log=r['name'] + '.log', diff=r['name'] + '.diff')
    finally:
        shutil.rmtree(wt, ignore_errors=True)
    return r


def main():
    src, out = os.getcwd(), sys.argv[1]
    os.makedirs(out, exist_ok=True)
    results = [run_one(src, out, r) for r in reversions()]
    write(os.path.join(out, 'owner-git-reversions-run.json'), json.dumps(results, indent=2) + '\n')
    print(json.dumps([{k: r[k] for k in ('name', 'killed', 'guards_failed', 'payload_runs')} for r in results]))
    return 0 if all(r['killed'] for r in results) else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f'reversion run failed: {error}', file=sys.stderr)
        sys.exit(2)
