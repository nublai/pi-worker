# Historical slice-1 specimen, not executed by slice 2. Failures remain fatal.
import os,subprocess,json,signal
os.environ['PATH']=os.path.expanduser('~/.local/bin:~/.local/node/bin:')+os.environ['PATH']
os.environ['A0_SOCKET']='/tmp/a0/state/worker.sock'
os.chdir('/tmp/a0/repo')
w='51aaf702-e108-4fa9-8492-f0bf95dbf43c'
watch=subprocess.Popen(['node','dist/cli.js','watch',w],stdout=subprocess.PIPE,text=True)
assert watch.stdout is not None  # stdout=PIPE; narrow for static analysis.
first=json.loads(watch.stdout.readline()); assert first['type']=='snapshot'
message='Do not delegate. Use bash to execute exactly this command and wait for it: node -e \'require("fs").appendFileSync("/tmp/a0/workspace-final/crash-start.txt","ONCE\\n");console.log("CRASH_BLOCK_STARTED");setTimeout(()=>{require("fs").writeFileSync("/tmp/a0/workspace-final/crash-finished.txt","DONE\\n")},120000)\'. Set the tool timeout to 180 seconds. After it finishes, reply CRASH_TURN_DONE.'
open('/tmp/a0/final-crash-message.txt','w').write(message)
receipt=subprocess.check_output(['node','dist/cli.js','prompt',w,'--command-id','final-crash','--message',message],text=True)
open('/tmp/a0/final-crash-receipt-before.json','w').write(receipt)
print('ADMISSION_BEFORE_CRASH',receipt.strip(),flush=True)
with open('/tmp/a0/final-crash-events.jsonl','w') as events:
 events.write(json.dumps(first)+'\n')
 for line in watch.stdout:
  event=json.loads(line); events.write(line);events.flush()
  # Critical: match actual partial result text, NEVER the echoed command/args.
  content=event.get('data',{}).get('partialResult',{}).get('content',[])
  if event['type']=='tool_execution_update' and any(p.get('type')=='text' and p.get('text','').strip()=='CRASH_BLOCK_STARTED' for p in content):
   assert open('/tmp/a0/workspace-final/crash-start.txt').read()=='ONCE\n'
   pid=int(open('/tmp/a0/supervisor.pid').read()); os.kill(pid,signal.SIGKILL)
   print('SUPERVISOR_SIGKILL_AFTER_ACTUAL_TOOL_OUTPUT_AND_VERIFIED_FILE',pid,flush=True)
   break
 else: raise RuntimeError('SSE ended before observed blocking tool output')
watch.terminate();watch.wait()
print('START_EFFECT_COUNT=1; supervisor dead; restart must not replay',flush=True)
