#!/usr/bin/env python3
"""THROWAWAY fix-round mutation gate. Reviewer script is parsed as DATA, never run.
Each mutant uses a disposable source copy, its own TMPDIR, and a read-only-use
node_modules symlink. Only our fixed build/test commands execute. No checkout edits.
Usage: python3 evidence/mutate-slice2-fix.py COPIED_REVIEWER_SCRIPT SCRATCH
"""
import ast
import concurrent.futures
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from pathlib import Path

source, scratch = map(Path, sys.argv[1:3])
selected = sys.argv[3:]
repo = Path(__file__).resolve().parent.parent
scratch.mkdir(parents=True, exist_ok=True)
# literal_eval accepts literals only; no imports/calls from the reviewer execute.
assignment = next(n for n in ast.parse(source.read_text()).body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'M' for t in n.targets))
mutations = ast.literal_eval(assignment.value)
holder_line = next(line for line in (repo / 'src/supervisor.ts').read_text().splitlines(keepends=True) if 'if (holder) throw' in line)
mutations['M13_no_holder_check'] = ('src/supervisor.ts', holder_line, '')
mutations['M07_observed_without_evidence'] = ('src/supervisor.ts', "if (!settlementEvidence && !(execution && live.index.hasSettlement(execution, uncertain))) throw", "if (false) throw")
spec = list(mutations['M08c_rebind_dispatch_after_pi'])
spec[3] = spec[3].replace("new Refusal('pi_binding_change_cancelled')", "new Refusal('pi_binding_change_cancelled', 'unknown')")
spec[4] = spec[4].replace("new Refusal('pi_binding_change_cancelled')", "new Refusal('pi_binding_change_cancelled', 'unknown')")
mutations['M08c_rebind_dispatch_after_pi'] = tuple(spec)
mutations['F2_auto_flush_as_owner_ready'] = ('src/supervisor.ts', '          this.receipts.readyQueued(id);', "          this.receipts.resolveIntent(id, 'keep');")
mutations['F2_queue_ready_survives_recovery'] = ('src/receipts.ts', " || r.state === 'queue_ready'", '')
mutations['F8_admission_counts_as_settlement'] = ('src/supervisor.ts', 'if (!settlementEvidence && !(execution && live.index.hasSettlement(execution, uncertain))) throw', "if (target?.state !== 'delivered' && !settlementEvidence && !(execution && live.index.hasSettlement(execution, uncertain))) throw")
# Test the matrix's own fencing oracle in addition to the two individual mutants.
mutations['F4_recovery_without_fencing'] = ('src/supervisor.ts', mutations['M01_recover_no_fence_active'][1], mutations['M01_recover_no_fence_active'][2], mutations['M02_recover_no_fence_unknown_receipts'][1], mutations['M02_recover_no_fence_unknown_receipts'][2])

def run(name, spec):
    root = scratch / name
    root.mkdir(exist_ok=True)
    for path in ['src', 'package.json', 'package-lock.json', 'tsconfig.json', 'openapi.json']:
        origin = repo / path
        if origin.is_dir():
            shutil.copytree(origin, root / path, dirs_exist_ok=True)
        else:
            shutil.copy2(origin, root / path)
    if not (root / 'node_modules').exists():
        (root / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    tmp = root / 'tmp'
    tmp.mkdir(exist_ok=True)
    env = dict(os.environ, TMPDIR=str(tmp), npm_config_cache=str(scratch / 'npm-cache'))
    path = root / spec[0]
    text = path.read_text()
    for old, new in zip(spec[1::2], spec[2::2], strict=True):
        count = text.count(old)
        if count != 1:
            return name, {'error': f'mutation match count {count}', 'killed': False}
        text = text.replace(old, new)
    path.write_text(text)
    build = subprocess.run(['npm', 'run', 'build'], cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
    if build.returncode:
        (scratch / (name + '.log')).write_text(build.stdout)
        return name, {'error': 'build failed; not a behavioural kill', 'killed': False}
    tests = sorted(str(p.relative_to(root)) for p in (root / 'dist/test').glob('*.test.js'))
    process = subprocess.Popen(['node', '--test', '--test-timeout=60000', *tests], cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        log, _ = process.communicate(timeout=150)
        code = process.returncode
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        log, _ = process.communicate()
        log += '\nTIMEOUT: killed entire test process group\n'
        code = 124
    (scratch / (name + '.log')).write_text(log)
    failing = sorted(set(re.findall(r'^✖ (.+?) \(', log, re.M)))
    if not failing:
        failing = sorted(set(re.findall(r'^not ok \d+ - (.+)$', log, re.M)))
    result = {'killed': code != 0, 'exit': code, 'failing_tests': failing}
    try:
        shutil.rmtree(root)
    except OSError as error:
        result['cleanup_error'] = str(error)
    return name, result

results = {}
if selected:
    try:
        results = json.loads((scratch / 'results.json').read_text())
    except (OSError, ValueError) as error:
        raise SystemExit(f'Cannot resume mutation results: {error}') from error
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    jobs = [pool.submit(run, name, spec) for name, spec in mutations.items() if not selected or name in selected]
    for job in concurrent.futures.as_completed(jobs):
        name, result = job.result()
        results[name] = result
        print(json.dumps({'mutation': name, **result}), flush=True)
(scratch / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
required = ['M01_recover_no_fence_active', 'M02_recover_no_fence_unknown_receipts', 'M08b_dispatch_record_after_write_issued', 'M08c_rebind_dispatch_after_pi', 'M08d_create_dispatch_after_spawn', 'M08e_child_dispatch_after_create', 'M09_no_dispatch_grant_recheck', 'M17_rebind_no_cleanup_or_ready_check', 'F2_auto_flush_as_owner_ready', 'F2_queue_ready_survives_recovery', 'F8_admission_counts_as_settlement', 'F4_recovery_without_fencing']
assert all(results[n]['killed'] and 'error' not in results[n] for n in required), 'required mutant survived or failed to build'
assert not any('error' in result for result in results.values()), 'invalid mutation experiment'
