/** Gate1 rerun: owner stop of the parent through B2 after the failed fan-out; records attention. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {Client} from '/tmp/a0g1/runtime/dist/client.js';
const R='/tmp/a0g1/run',parent=JSON.parse(readFileSync(R+'/parent.json','utf8'));
const client=new Client(R+'/state/worker.sock',R+'/state/grants/orchestrator.json');
const w=await client.call('workers.get',{id:parent.worker_id});assert.equal(w.foreground,'idle');
appendFileSync(R+'/attention.jsonl',JSON.stringify({clock:new Date().toISOString(),kind:'failure-stop',actor:'gate1-authorized-owner-driver',policy_revision:'gate1-owner-v1',worker_id:w.worker_id,reason:'child launches rejected profile_copy_too_many_entries; job shape failed'})+'\n');
const stop=await client.call('workers.stop',{id:w.worker_id,body:{command_id:'gate1-failure-stop',worker_epoch:w.worker_epoch,session_id:w.session_id,binding_revision:w.binding_revision}});
const after=await client.call('workers.list');
writeFileSync('/tmp/a0g1/out/stop.json',JSON.stringify({producer:'gate1-rerun-failure-stop',clock:new Date().toISOString(),stop:{state:stop.state,effect:stop.effect,stage:stop.stage},workers:after.map(x=>({worker_id:x.worker_id,parent_worker_id:x.parent_worker_id??null,status:x.status,cleanup:x.cleanup}))},null,2)+'\n');
console.log(readFileSync('/tmp/a0g1/out/stop.json','utf8'));
