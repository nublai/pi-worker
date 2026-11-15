"""Owner-Git follow-up reversions. Each one undoes part of the snapshot fix in an
isolated copy (git archive of HEAD), rebuilds, and runs src/test/owner-git.test.ts,
portable and with A0_TEST_BWRAP=1. A reversion is killed when a guard test fails
on an assertion. Usage: python3 owner-git-reversions.py OUT_DIR"""
import json, subprocess, os, sys, re, shutil
SRC = os.getcwd(); OUT = sys.argv[1]; BASE = '/tmp/a0s7g/rev'
os.makedirs(OUT, exist_ok=True)
OLD = subprocess.run(['git', 'show', 'a8d1357:src/git-safe.ts'], capture_output=True, text=True, check=True).stdout
R = []
def rev(name, tests, *patches): R.append(dict(name=name, tests=tests, patches=patches))
rev('owner-helper-a8d1357', ['racing a child admin', 'racing a planted commondir', 'refused, not run', 'not honoured', 'kernel owner Git'], ('src/git-safe.ts', None, OLD))
rev('snapshot-removed-git-reads-pinned-paths', ['racing a child admin', 'racing a planted commondir', 'kernel owner Git'],
    ('src/git-safe.ts', "`--git-dir=${dir}`", "`--git-dir=${pin.git_dir}`"),
    ('src/git-safe.ts', "env: cleanEnv(home, join(pin.common_dir, 'objects'))", "env: (({ GIT_OBJECT_DIRECTORY, ...e }) => (void GIT_OBJECT_DIRECTORY, e))(cleanEnv(home, ''))"))
rev('executing-config-allowed', ['refused, not run'],
    ('src/git-safe.ts', "if (key && EXECUTES.test(key))", "if (key && EXECUTES.test(key) && false)"))
rev('global-config-honoured', ['not honoured'],
    ('src/git-safe.ts', "  return { ...env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',", "  void env; void home; return { ...process.env,"))
for r in R:
    wt = os.path.join(BASE, r['name'])
    shutil.rmtree(wt, ignore_errors=True); os.makedirs(wt)
    subprocess.run(f'git archive HEAD | tar -x -C {wt}', shell=True, check=True)
    os.symlink(os.path.join(SRC, 'node_modules'), os.path.join(wt, 'node_modules'))
    for path, a, b in r['patches']:
        p = os.path.join(wt, path); s = open(p).read()
        if a is None: s = b
        else: assert s.count(a) == 1, (r['name'], a); s = s.replace(a, b)
        open(p, 'w').write(s)
    diff = subprocess.run(['git', 'diff', '--no-index', '--no-ext-diff', os.path.join(SRC, 'src/git-safe.ts'), os.path.join(wt, 'src/git-safe.ts')], capture_output=True, text=True).stdout
    open(os.path.join(OUT, r['name'] + '.diff'), 'w').write(diff)
    env = {**os.environ, 'TMPDIR': '/tmp/a0s7g/tmp', 'A0_TEST_BWRAP': '1'}
    build = subprocess.run(['npx', 'tsc', '-p', 'tsconfig.json'], cwd=wt, capture_output=True, text=True, env=env)
    run = subprocess.run(['node', '--test', 'dist/test/owner-git.test.js'], cwd=wt, capture_output=True, text=True, env=env)
    log = build.stdout + build.stderr + run.stdout + run.stderr
    open(os.path.join(OUT, r['name'] + '.log'), 'w').write(log)
    failed = re.findall(r'^✖ (.+?) \(\d', run.stdout, re.M)
    failed = sorted(set(failed))
    guards = [t for t in r['tests'] if any(t in f for f in failed)]
    r.update(compiled=build.returncode == 0, exit_code=run.returncode, failed_tests=failed, guards_failed=guards,
             assertion_failure='AssertionError' in log, killed=run.returncode != 0 and 'AssertionError' in log and len(guards) == len(r['tests']),
             log=r['name'] + '.log', diff=r['name'] + '.diff')
    tally = re.findall(r'tally (\{[^}]*\})', log); r['race_tallies'] = tally
    runs = re.findall(r"'(\d+) run\(s\)", log); r['payload_runs'] = [int(x) for x in runs]
    del r['patches']
    shutil.rmtree(wt, ignore_errors=True)
json.dump(R, open(os.path.join(OUT, 'owner-git-reversions-run.json'), 'w'), indent=2)
print(json.dumps([{k: r[k] for k in ('name', 'killed', 'guards_failed', 'payload_runs')} for r in R], indent=1))
