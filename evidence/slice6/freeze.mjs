/** End authorized work only after the correction run actually settles; freeze verification subject. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {Client} from '/tmp/a0s6/supervisor/dist/client.js';
const R='/tmp/a0s6/run1';let id;try{id=JSON.parse(readFileSync(R+'/parent.json','utf8')).worker_id;}catch(cause){throw Error('invalid parent identity',{cause});}
const c=new Client(R+'/state/worker.sock',R+'/state/grants/orchestrator.json');let settled;
const t=setTimeout(()=>{console.error('corrected run did not settle');process.exit(2);},600000);
try{
 await c.watch(id,f=>{
 const w=f.type==='snapshot'?f.worker:f.type==='worker_changed'?f.data.worker:undefined;
 if(w&&w.execution?.command_id==='slice6-review-correction'&&w.execution.state==='settled'&&w.foreground==='idle'&&!(w.queued??[]).some(x=>x.state==='queued')){settled=w;return false;}return true;
 });
 const clock=new Date().toISOString();appendFileSync(R+'/control-actions.jsonl',JSON.stringify({clock,kind:'stop-after-authorized-work-settled',worker_id:id,policy_revision:'slice6-owner-v1',scope:'owned parent only; freeze Git subject for independent verification'})+'\n');
 const receipt=await c.call('workers.stop',{id,body:{command_id:'slice6-freeze-parent',worker_epoch:settled.worker_epoch,session_id:settled.session_id,binding_revision:settled.binding_revision}});assert.equal(receipt.state,'delivered');
 const final=await c.call('workers.get',{id});assert.equal(final.status,'stopped');writeFileSync(R+'/freeze.json',JSON.stringify({clock,settled_execution:settled.execution,receipt,final_status:final.status},null,2)+'\n');console.log(JSON.stringify({clock,stopped:true,execution:settled.execution.command_id}));
}finally{clearTimeout(t);}
