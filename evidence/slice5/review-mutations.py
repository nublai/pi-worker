"""Task-authored guard reversions in disposable copies; no checkout mutation."""
import concurrent.futures
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

repo = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(tempfile.mkdtemp(prefix='a0-review5-mutations-'))
supervisor = (repo / 'src/supervisor.ts').read_text()
sandbox = (repo / 'src/sandbox.ts').read_text()
containment = (repo / 'src/containment.ts').read_text()
guard = "if (live.worker.status === 'cleanup_pending' || live.worker.cleanup !== 'cgroup_empty_removed' || !live.unit) throw new Refusal('cleanup_pending_or_cleanup_unproven');"
mutants = [
 ('intent-target-binding', 'src/supervisor.ts', " && live.worker.worker_epoch === old.relaunch_epoch && live.worker.session_id === old.session_id && live.worker.binding_revision === old.binding_revision", ''),
 ('intent-target-revision', 'src/supervisor.ts', ' && live.worker.binding_revision === old.binding_revision', ''),
 ('relaunch-no-cleanup-gate', 'src/supervisor.ts', guard, ''),
 ('relaunch-status-only', 'src/supervisor.ts', guard, "if (live.worker.status === 'cleanup_pending') throw new Refusal('cleanup_pending_or_cleanup_unproven');"),
 ('sandbox-host-root', 'src/sandbox.ts', sandbox, sandbox.replace("root === '/' ? '/' : root + '/'", "root + '/'").replace("if (root === '/') throw new Refusal('sandbox_root_is_host_root');", '')),
 ('sandbox-protected-paths', 'src/sandbox.ts', "if (protectedPaths.some(path => inside(root, path) || inside(path, root))) throw new Refusal('sandbox_overlaps_protected_control_path');", ''),
 ('sandbox-inherited-env', 'src/host.ts', 'env = sandbox.env;', 'env = { ...process.env, ...sandbox.env };'),
 ('sandbox-no-private-pid', 'src/sandbox.ts', "'--unshare-pid', ", ''),
 ('relaunch-no-session-identity', 'src/supervisor.ts', "!state.success || state.data?.sessionId !== originalId || state.data?.sessionFile !== originalFile || live.faulted", '!state.success || !state.data || live.faulted'),
 ('child-filesystem-widen', 'src/supervisor.ts', "if (p?.environment.filesystem === 'bwrap' && spec.environment.filesystem !== 'bwrap') throw new Refusal('child_filesystem_cannot_widen');", ''),
 ('startup-no-sweep', 'src/supervisor.ts', 'await this.containment.sweepUnknown?.([...this.workers.values()].flatMap(live => live.unit ? [live.unit] : []));', ''),
 ('startup-sweep-no-kill', 'src/containment.ts', "if (!await this.clean({ root: this.root, name: entry.name, boot: bootId() })) throw new Error('orphan_cleanup_unproven');", ''),
 ('exit-no-cleanup', 'src/supervisor.ts', 'if (live.unit && !cleaning) void this.cleanup(live).catch(error => this.fault(live, error));', ''),
]
def run(m):
 name, file, old, new = m
 root = out / name
 root.mkdir()
 shutil.copytree(repo / 'src', root / 'src')
 for f in ['package.json', 'package-lock.json', 'tsconfig.json', 'openapi.json']:
  shutil.copy2(repo / f, root / f)
 (root / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
 path = root / file
 text = path.read_text()
 assert text.count(old) == 1, name
 path.write_text(text.replace(old, new))
 env = dict(os.environ)
 env.pop('A0_TEST_CGROUP_DIR', None)
 env.pop('A0_TEST_BWRAP', None)
 result = subprocess.run(['npm', 'test'], check=False, cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=100)
 (root / 'result.txt').write_text(result.stdout)
 failed = [line for line in result.stdout.splitlines() if line.startswith('✖ ') and not line.startswith('✖ failing')]
 counts = [line for line in result.stdout.splitlines() if re.search(r'(tests|pass|fail|skipped) \d+$', line)]
 return {'mutation': name, 'command': 'npm test (kernel flags unset)', 'exit': result.returncode, 'assertion_failure': 'AssertionError' in result.stdout, 'failed_tests': list(dict.fromkeys(failed)), 'counts': counts, 'log': str(root / 'result.txt')}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(run, mutants))
report = {'source_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(), 'root': str(out), 'results': results}
(repo / 'evidence/slice5/review-mutations.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
assert all(r['exit'] != 0 and r['assertion_failure'] for r in results)
