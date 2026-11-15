import hashlib
import json
import pathlib

root=pathlib.Path('/tmp/a0s5/live-ug9ddB')
workers={}
for line in (root/'state/journal.jsonl').read_text().splitlines():
 r=json.loads(line)['record']
 if r['kind']=='worker':
  workers[r['value']['worker']['worker_id']]=r['value']
parent=next(v for v in workers.values() if not v['worker'].get('parent'))
child=next(v for v in workers.values() if v['worker'].get('parent'))
def calls(file):
 result=[]
 for line in pathlib.Path(file).read_text().splitlines():
  r=json.loads(line)
  if r.get('message',{}).get('role')!='assistant':
   continue
  for c in r['message'].get('content',[]):
   if c.get('type')=='toolCall':
    result.append(c)
 return result
pc=calls(parent['sessionFile'])
cc=calls(child['sessionFile'])
assert len(pc)==3,(len(pc),'unexpected parent tool count')
assert len(cc)==1,(len(cc),'unexpected child tool count')
assert all(c['name']=='bash' for c in pc+cc)
commands=[c['arguments']['command'] for c in pc]
checks=[]
for kind,seconds in [('stop',20),('restart',6)]:
 pid=root/'parent'/f'{kind}.pid'
 marker=root/'parent'/f'{kind}.escaped'
 expected=f'setsid nohup sh -c \'echo $$ > "{pid}"; sleep {seconds}; printf ESCAPED > "{marker}"\' >/dev/null 2>&1 </dev/null & printf DETACHED_STARTED'
 assert commands.count(expected)==1,(kind,'native command differs from the requested fixture')
 checks.append({'kind':kind,'native_tool_count':1,'exact_requested_command':True,'command_sha256':hashlib.sha256(expected.encode()).hexdigest()})
expected=r'printf "ONCE\n" >> recovered-effect.txt'
assert commands.count(expected)==1,'native recovered append command differs'
checks.append({'kind':'recovered-append','native_tool_count':1,'exact_requested_command':True,'command_sha256':hashlib.sha256(expected.encode()).hexdigest()})
# Child command must include the actual denied host paths and expected writes.
command=cc[0]['arguments']['command']
for path in [str(root/'outside-sentinel'),str(root/'state'),str(root/'state/worker.sock'),str(root/'state/grants/owner.json')]:
 assert path in command
for check in ['existsSync','readFileSync','allowed.txt','writeFileSync','sandbox-proof.txt','SANDBOX_TOOL_OK']:
 assert check in command
checks.append({'kind':'sandbox-tool','native_tool_count':1,'denied_paths_and_allowed_read_write_present':True,'command_sha256':hashlib.sha256(command.encode()).hexdigest()})
print(json.dumps({'run':str(root),'parent_bash_calls':len(pc),'child_bash_calls':len(cc),'other_tool_calls':0,'checks':checks},indent=2))
