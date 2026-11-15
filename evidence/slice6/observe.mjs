/** Event-driven B2 observer; no polling, native RPC, model prompts or terminal. */
import {Client} from '/tmp/a0s6/supervisor/dist/client.js';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const R='/tmp/a0s6/run1';
let parent;try{parent=JSON.parse(readFileSync(R+'/parent.json','utf8')).worker_id;}catch(cause){throw Error('missing parent identity',{cause});}
const client=new Client(R+'/state/worker.sock',R+'/state/grants/orchestrator.json');
const stamp=()=>new Date().toISOString();
let marker=false;const states=new Map();let count=0;
const timer=setTimeout(()=>{writeFileSync(R+'/observe-timeout.json',JSON.stringify({clock:stamp(),events:count,workers:[...states.values()]},null,2));process.exit(2);},1200000);
try{
 await client.watch(null,f=>{
  count++;
  if(f.type==='snapshot')for(const w of f.workers)states.set(w.worker_id,w);
  const w=f.type==='worker_changed'?f.data.worker:undefined;if(w)states.set(w.worker_id,w);
  if(['snapshot','child_report','agent_settled','extension_error','worker_fault','worker_exit','interaction_opened','tool_execution_end'].includes(f.type)){
   const d=f.data;const record={clock:stamp(),type:f.type,worker_id:f.worker_id,cursor:f.cursor,toolName:d?.toolName,isError:d?.isError,claim_kind:d?.receipt?.result?.kind};
   appendFileSync(R+'/observed.jsonl',JSON.stringify(record)+'\n');
  }
  if(f.worker_id===parent&&f.type==='message_end'&&f.data?.message?.role==='assistant'){
   const text=f.data?.message?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??'';
   if(text.includes('A0_SLICE6_JOB_COMPLETE'))marker=true;
   if(text)writeFileSync(R+'/parent-latest-text.txt',text+'\n');
  }
  if(marker&&f.worker_id===parent&&f.type==='agent_settled'&&[...states.values()].filter(w=>w.parent_worker_id===parent&&w.status==='stopped').length===2){
   const result={clock:stamp(),marker_claim_observed:true,events:count,workers:[...states.values()].map(w=>({worker_id:w.worker_id,parent:w.parent_worker_id,status:w.status,foreground:w.foreground,role:w.launch_spec?.role,reports:w.child_reports?.map(r=>({kind:r.kind,command_id:r.command_id,message:r.message}))}))};
   writeFileSync(R+'/job-claim.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({complete:true,clock:stamp(),events:count}));return false;
  }
  return true;
 });
}catch(error){writeFileSync(R+'/observe-error.json',JSON.stringify({clock:stamp(),error:String(error)}));process.exitCode=1;}
finally{clearTimeout(timer);}
