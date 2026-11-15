"""Newly authored follow-up probes. Mutate disposable copies, never the checkout."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
out = Path(args.output_dir).resolve()
out.mkdir(parents=True, exist_ok=True)

cleanup_guard = '    if (live.unit !== unit) return gone && durable;\n'
fault_guard = '      if (live.unit !== unit) return;\n'
capture = "live.intentBindings[r.command_id] ??= { ...old, command_id: r.command_id };"
bind_target = "        for (const kept of Object.values(live.intentBindings)) if (!kept.relaunch_epoch && kept.session_id === w.session_id && kept.binding_revision === w.binding_revision) kept.relaunch_epoch = w.worker_epoch;\n"
protected_condition = 'inside(root, path) || inside(path, root)'
runtime_dirs = "  const userRuntimeDirs = [`/run/user/${process.getuid!()}`, ...(process.env.XDG_RUNTIME_DIR ? [process.env.XDG_RUNTIME_DIR] : [])];"
protected_paths = "  const protectedPaths = ['/sys/fs/cgroup', '/proc', '/dev', ...userRuntimeDirs.flatMap(path => [path, join(path, 'bus')]), ...(process.env.PI_WORKER_SOCKET ? [realpathSync(dirname(process.env.PI_WORKER_SOCKET))] : []), ...(process.env.PI_WORKER_GRANT_FILE ? [realpathSync(process.env.PI_WORKER_GRANT_FILE)] : [])]\n    .map(path => existsSync(path) ? realpathSync(path) : resolve(path));"
old_paths = "  const protectedPaths = ['/sys/fs/cgroup', ...(process.env.PI_WORKER_SOCKET ? [realpathSync(dirname(process.env.PI_WORKER_SOCKET))] : []), ...(process.env.PI_WORKER_GRANT_FILE ? [realpathSync(process.env.PI_WORKER_GRANT_FILE)] : [])];"

# Each replacement must occur exactly once; all resulting code must compile.
cases = [
    ('n1-cleanup', 'src/supervisor.ts', [(cleanup_guard, '')], 'late ', 'slice5-followups'),
    ('n1-stop', 'src/supervisor.ts', [('      if (live.unit === unit) {', '      {')], 'late ', 'slice5-followups'),
    ('n1-fault', 'src/supervisor.ts', [(fault_guard, '')], 'late ', 'slice5-followups'),
    ('n2-eager-target', 'src/supervisor.ts', [(capture, capture.replace('r.command_id };', 'r.command_id, relaunch_epoch: w.worker_epoch };')), (bind_target, '')], 'owner-kept prompt binds|second successful', 'slice5-followups'),
    ('n2-retarget-success', 'src/supervisor.ts', [(bind_target, bind_target.replace('!kept.relaunch_epoch && ', ''))], 'owner-kept prompt binds|second successful', 'slice5-followups'),
    ('n3-old-protected-set', 'src/sandbox.ts', [(protected_paths, old_paths)], 'sandbox refuses', 'sandbox'),
    ('n3-no-containing-root-check', 'src/sandbox.ts', [(protected_condition, 'inside(path, root)')], 'sandbox .*root|sandbox refuses', 'sandbox'),
    ('n3-no-nested-root-check', 'src/sandbox.ts', [(protected_condition, 'inside(root, path)')], 'sandbox .*root|sandbox refuses', 'sandbox'),
    ('n3-no-fixed-runtime', 'src/sandbox.ts', [(runtime_dirs, "  const userRuntimeDirs = process.env.XDG_RUNTIME_DIR ? [process.env.XDG_RUNTIME_DIR] : [];")], 'sandbox refuses', 'sandbox'),
    ('n3-no-xdg-runtime', 'src/sandbox.ts', [(runtime_dirs, "  const userRuntimeDirs = [`/run/user/${process.getuid!()}`];")], 'sandbox refuses', 'sandbox'),
    ('n3-no-bus-target', 'src/sandbox.ts', [("...userRuntimeDirs.flatMap(path => [path, join(path, 'bus')])", '...userRuntimeDirs')], 'sandbox refuses', 'sandbox'),
    ('n3-no-private-kernel-mounts', 'src/sandbox.ts', [("'/sys/fs/cgroup', '/proc', '/dev',", "'/sys/fs/cgroup',")], 'sandbox refuses', 'sandbox'),
]
results = []
for name, path, replacements, pattern, test_file in cases:
    with tempfile.TemporaryDirectory(prefix='a0s5f-mut-') as tmp:
        copy = Path(tmp)
        shutil.copytree(repo / 'src', copy / 'src')
        for file in ['package.json', 'package-lock.json', 'tsconfig.json']:
            shutil.copy2(repo / file, copy / file)
        (copy / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
        target = copy / path
        original = target.read_text()
        mutated = original
        for before, after in replacements:
            assert mutated.count(before) == 1, (name, before)
            mutated = mutated.replace(before, after)
        assert mutated != original
        target.write_text(mutated)
        build = subprocess.run(['npm', 'run', 'build'], cwd=copy, capture_output=True, text=True, timeout=90)
        (out / f'{name}-build.log').write_text(build.stdout + build.stderr)
        assert build.returncode == 0, f'{name}: build failure does not count'
        run = subprocess.run(['node', '--test', '--test-reporter=tap', f'--test-name-pattern={pattern}', f'dist/test/{test_file}.test.js'], cwd=copy, capture_output=True, text=True, timeout=90)
        output = run.stdout + run.stderr
        (out / f'{name}.log').write_text(output)
        failure_count = re.search(r'^# fail (\d+)$', output, re.M)
        assert failure_count is not None, f'{name}: missing test summary'
        failures = int(failure_count[1])
        assertion_failures = output.count("code: 'ERR_ASSERTION'")
        result = {'name': name, 'path': path, 'original_sha256': hashlib.sha256(original.encode()).hexdigest(), 'mutant_sha256': hashlib.sha256(mutated.encode()).hexdigest(), 'build_exit': build.returncode, 'test_exit': run.returncode, 'failures': failures, 'assertion_failures': assertion_failures}
        results.append(result)
        assert run.returncode == 1 and failures > 0 and failures == assertion_failures, result
summary = {'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(), 'isolation': 'disposable source copies; shared read-only node_modules symlink; no kernel flags or services', 'results': results}
(out / 'reversions.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
