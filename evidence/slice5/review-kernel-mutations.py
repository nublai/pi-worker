"""Task-authored kernel-only reversions, with isolated temp state and keeper teardown."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

repo = pathlib.Path(__file__).resolve().parents[2]
base = pathlib.Path(tempfile.mkdtemp(prefix='a0-review5-kernel-mutations-'))
cases = [
    ('keeper-stop-removed', 'src/test/sandbox.test.ts', "execFileSync('systemctl', ['--user', 'stop', unit], { timeout: 15000 });", '', 'sandbox'),
    ('default-delegation-not-owned', 'src/containment.ts', "new CgroupContainment(join('/sys/fs/cgroup', group), 5000, true)", "new CgroupContainment(join('/sys/fs/cgroup', group), 5000, false)", 'containment'),
]
results = []
for name, file, old, new, suite in cases:
    root = base / name
    root.mkdir()
    shutil.copytree(repo / 'src', root / 'src')
    for f in ['package.json', 'package-lock.json', 'tsconfig.json', 'openapi.json']:
        shutil.copy2(repo / f, root / f)
    (root / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    path = root / file
    text = path.read_text()
    assert text.count(old) == 1
    path.write_text(text.replace(old, new))
    tmp = root / 'tmp'
    tmp.mkdir()
    env = dict(os.environ, TMPDIR=str(tmp))
    try:
        build = subprocess.run(['npm', 'run', 'build'], check=False, cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        assert build.returncode == 0, build.stdout
        run = subprocess.run(['node', '--test', f'dist/test/{suite}.test.js'], check=False, cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        (root / 'result.txt').write_text(run.stdout)
        results.append({'mutation': name, 'exit': run.returncode, 'assertion_failure': 'AssertionError' in run.stdout, 'log': str(root / 'result.txt')})
    finally:
        # The mutated keeper test intentionally fails before removing its temp
        # root. Derive only services belonging to THIS test's isolated TMPDIR.
        for state in tmp.glob('a0s5-sandbox-*/state'):
            unit = 'a0-' + hashlib.sha256(str(state.resolve()).encode()).hexdigest()[:20] + '.service'
            subprocess.run(['systemctl', '--user', 'stop', unit], check=True, timeout=15)
report = {'source_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(), 'results': results}
(repo / 'evidence/slice5/review-kernel-mutations.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
assert all(r['exit'] != 0 and r['assertion_failure'] for r in results)
