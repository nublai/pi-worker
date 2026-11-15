"""Read-only audit of the task-owned real-Pi journey. Commands are compared as data."""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
latest = {}
leaders = set()
domains = {}
for line in (root / 'state/journal.jsonl').read_text().splitlines():
    record = json.loads(line)['record']
    if record['kind'] != 'worker':
        continue
    value = record['value']
    latest[value['worker']['worker_id']] = value
    if value['pid']:
        leaders.add(value['pid'])
    if value.get('unit'):
        unit = value['unit']
        domains[unit['name']] = pathlib.Path(unit['root']) / unit['name']
parent = next(v for v in latest.values() if not v['worker'].get('parent'))
child = next(v for v in latest.values() if v['worker'].get('parent'))


def tools(file):
    result = []
    for line in pathlib.Path(file).read_text().splitlines():
        row = json.loads(line)
        message = row.get('message', {})
        if message.get('role') == 'assistant':
            result.extend(c for c in message.get('content', []) if c.get('type') == 'toolCall')
    return result


pc, cc = tools(parent['sessionFile']), tools(child['sessionFile'])
assert len(pc) == 4 and len(cc) == 1
assert all(c['name'] == 'bash' for c in pc + cc)
commands = [c['arguments']['command'] for c in pc]
checks = []
for kind, seconds in [('stop', 20), ('restart', 6), ('pi-exit', 6)]:
    pid_file = root / 'parent' / f'{kind}.pid'
    marker = root / 'parent' / f'{kind}.escaped'
    expected = f'setsid nohup sh -c \'echo $$ > "{pid_file}"; sleep {seconds}; printf ESCAPED > "{marker}"\' >/dev/null 2>&1 </dev/null & printf DETACHED_STARTED'
    assert commands.count(expected) == 1, 'native detached command mismatch'
    assert not marker.exists()
    checks.append({'kind': kind, 'exact_native_bash_command': True, 'marker_absent': True, 'command_sha256': hashlib.sha256(expected.encode()).hexdigest()})
expected = 'printf "ONCE\\n" >> recovered-effect.txt'
assert commands.count(expected) == 1
assert (root / 'parent/recovered-effect.txt').read_text() == 'ONCE\n'
checks.append({'kind': 'owner-kept-append', 'exact_native_bash_command': True, 'append_count': 1})
command = cc[0]['arguments']['command']
for path in [root / 'outside-sentinel', root / 'state', root / 'state/worker.sock', root / 'state/grants/owner.json']:
    assert str(path) in command
for part in ['existsSync', 'readFileSync', 'allowed.txt', 'writeFileSync', 'sandbox-proof.txt', 'SANDBOX_TOOL_OK']:
    assert part in command
assert (root / 'child/sandbox-proof.txt').read_text() == 'SANDBOX_TOOL_OK\n'
for pid in leaders:
    path = pathlib.Path(f'/proc/{pid}/stat')
    assert not path.exists() or path.read_text().rsplit(')', 1)[1].split()[0] == 'Z'
assert all(not path.exists() for path in domains.values())
print(json.dumps({'run': str(root), 'parent_bash_calls': len(pc), 'child_bash_calls': len(cc), 'other_tool_calls': 0, 'native_checks': checks, 'child_denied_paths_and_allowed_read_write_checked': True, 'leaders_absent_or_zombie': len(leaders), 'worker_domains_removed': len(domains)}, indent=2))
