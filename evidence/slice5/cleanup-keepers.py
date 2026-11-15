"""Task-owned final cleanup: exact delegates observed being started by these probes.
Not a general cleanup command. Never discovers targets by process-name matching.
"""
import json
import os
import pathlib
import subprocess

assert os.uname().nodename == 'a0-worker'
env=dict(os.environ, XDG_RUNTIME_DIR='/run/user/1000', DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus')
# Final verification recreated the test delegation and started one live-run
# delegation. Both invocations are explicit; earlier keepers were already stopped.
targets={
 'a0-9af4fe582692eb7e7720.service':'2026-11-15 12:38:59',
 'a0-b7678315dbe1f35b6099.service':'2026-11-15 12:41:09',
}
records=[]
for unit, timestamp in targets.items():
 raw=subprocess.check_output(['systemctl','--user','show',unit,'--property=MainPID,ActiveEnterTimestamp,ControlGroup,ExecStart'],env=env,text=True)
 fields=dict(line.split('=',1) for line in raw.strip().splitlines())
 assert timestamp in fields['ActiveEnterTimestamp'],(unit,'unexpected invocation')
 assert 'argv[]=/bin/sleep infinity' in fields['ExecStart'],(unit,'not our delegate keeper')
 pid=int(fields['MainPID'])
 root=pathlib.Path('/sys/fs/cgroup'+fields['ControlGroup'])
 pids=set()
 for path, _dirs, _files in os.walk(root):
  pids.update(int(p) for p in (pathlib.Path(path)/'cgroup.procs').read_text().split())
 assert pids=={pid},(unit,'contains a live non-keeper process; refusing cleanup')
 records.append({'unit':unit,'keeper_pid':pid,'worker_processes':0,'invocation_matches_probe':True,'cgroup':str(root)})
# Signal only the exact validated units above, never the user manager or sibling services.
subprocess.run(['systemctl','--user','stop',*targets],env=env,check=True)
for r in records:
 r['stopped']=not pathlib.Path('/proc/'+str(r['keeper_pid'])).exists()
 r['cgroup_removed']=not pathlib.Path(r.pop('cgroup')).exists()
 assert r['stopped'] and r['cgroup_removed']
print(json.dumps({'test_delegate_keepers':records,'unrelated_units_signalled':0},indent=2))
