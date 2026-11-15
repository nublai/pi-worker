/** One bounded event wait, not polling. */
import {Client} from '/tmp/a0s6/supervisor/dist/client.js';
const R='/tmp/a0s6/run1',c=new Client(R+'/state/worker.sock',R+'/state/grants/orchestrator.json'),workers=new Map();
const t=setTimeout(()=>{console.error('bounded event wait expired');process.exit(2);},Number(process.env.WAIT_MS??600000));
const phase=process.argv[2]??'children';
let doneClaim=false;
try{await c.watch(null,f=>{
 if(f.type==='snapshot')for(const w of f.workers)workers.set(w.worker_id,w);
 if(f.type==='worker_changed')workers.set(f.data.worker.worker_id,f.data.worker);
 if(f.type==='message_end'&&f.data.message?.role==='assistant'&&f.data.message.content?.some(x=>x.type==='text'&&x.text.includes('A0_SLICE6_JOB_COMPLETE')))doneClaim=true;
 if((phase==='children'&&[...workers.values()].filter(w=>w.parent_worker_id).length===2)||(phase==='complete'&&doneClaim&&f.type==='agent_settled')){
  console.log(JSON.stringify({clock:new Date().toISOString(),phase,workers:[...workers.values()].map(w=>({id:w.worker_id,parent:w.parent_worker_id,status:w.status,foreground:w.foreground,role:w.launch_spec?.role}))},null,2));return false;
 }return true;
});}finally{clearTimeout(t);}
