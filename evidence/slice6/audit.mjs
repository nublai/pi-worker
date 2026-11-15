/** Whitelist-only native/Git audit. Private profiles and transcripts never leave VM. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {safeGit} from '/tmp/a0s6/supervisor/dist/git-safe.js';
const R='/tmp/a0s6/run1', out='/tmp/a0s6/out';
function json(s){try{return JSON.parse(s);}catch(cause){throw Error('invalid audit input',{cause});}}
const entries=p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(json);
const rows=entries(R+'/state/journal.jsonl').map(e=>e.record).filter(r=>r.kind==='worker');
const latest=new Map(rows.map(r=>[r.value.worker.worker_id,r.value]));
// Security fix round: Git only after the launch-time pin check. Slice-6 worker
// records predate git_pin, so this historical audit now refuses to rerun.
const pinOf=cwd=>[...latest.values()].find(v=>v.worker.cwd===cwd)?.worker.git_pin;
const git=(cwd,...args)=>safeGit(cwd,pinOf(cwd),args);
const proc=pid=>{if(!pid)return null;try{const s=readFileSync('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[0];}catch{return null;}};
const parentId=json(readFileSync(R+'/parent.json','utf8')).worker_id;
const parent=latest.get(parentId);assert.ok(parent);
const native=entries(parent.sessionFile), calls=native.flatMap(e=>(e.message?.role==='assistant'?e.message.content??[]:[]).filter(c=>c.type==='toolCall'));
const deliveries=native.filter(e=>e.type==='custom_message'&&['subagent_result','subagent_ping'].includes(e.customType)).map(e=>json(e.content));
const counts={};for(const d of deliveries)counts[d.id+':'+d.kind]=(counts[d.id+':'+d.kind]??0)+1;
const playbookReads=calls.filter(c=>c.name==='read'&&/poteto-mode\/(SKILL.md|playbooks\/bug-fix.md)$/.test(c.arguments?.path??'')).map(c=>({path:c.arguments.path,tool_call_id:c.id,success:native.some(e=>e.message?.role==='toolResult'&&e.message.toolCallId===c.id&&!e.message.isError)}));
const checklists=native.flatMap(e=>(e.message?.role==='assistant'?e.message.content??[]:[]).filter(c=>c.type==='text'&&/Checklist|skip:/.test(c.text)).map(c=>c.text));
const treeListing=git(R+'/workspace','worktree','list','--porcelain').split('\n\n');
const workers=[...latest.values()].map(v=>{
 const w=v.worker, transcript=existsSync(v.sessionFile??'')?entries(v.sessionFile):[];
 const tools=transcript.flatMap(e=>(e.message?.role==='assistant'?e.message.content??[]:[]).filter(c=>c.type==='toolCall'));
 const record={worker_id:w.worker_id,worker_epoch:w.worker_epoch,parent_worker_id:w.parent_worker_id,session_id:w.session_id,host:w.host,role:w.launch_spec?.role,cwd:w.cwd,status:w.status,cleanup:w.cleanup,grant_source_id:w.grant_source_id,grant_methods:w.launch_spec?.grant_methods,filesystem:w.launch_spec?.environment.filesystem??'none',unit:v.unit?{name:v.unit.name,removed:!existsSync(v.unit.root+'/'+v.unit.name)}:null,pid:v.pid,pid_state:proc(v.pid),tool_counts:{},reports:w.child_reports?.map(r=>({kind:r.kind,command_id:r.command_id})),native_result_entries:transcript.filter(e=>e.type==='custom_message'&&e.customType==='subagent_result').length};
 for(const c of tools)record.tool_counts[c.name]=(record.tool_counts[c.name]??0)+1;
 if(w.parent_worker_id){const stanza=treeListing.find(s=>s.startsWith('worktree '+w.cwd+'\n'));record.git={head:git(w.cwd,'rev-parse','HEAD'),base:w.launch_spec?.environment.base_sha,branch:git(w.cwd,'branch','--show-current'),status:git(w.cwd,'status','--porcelain'),retained:existsSync(w.cwd),locked:!!stanza&&/^locked(?: |$)/m.test(stanza)};}
 return record;
});
const sensitiveReads=calls.filter(c=>((c.name==='bash'&&/\/(?:grants|auth\.json|models-store\.json)/.test(c.arguments?.command??''))||(c.name==='read'&&/\/(?:grants|auth\.json|models-store\.json)/.test(c.arguments?.path??'')))).map(c=>({tool_call_id:c.id,tool:c.name,task_scoped_grant_file_read:/\/grants\/orchestrator\.json/.test(c.arguments?.command??c.arguments?.path??''),model_store_read:/models-store\.json/.test(c.arguments?.command??c.arguments?.path??''),raw_output_exported:false}));
const launches=calls.filter(c=>c.name==='subagent').map(c=>({name:c.arguments.name,model:c.arguments.model,thinking:c.arguments.thinking,branch:c.arguments.worktree?.branch,tool_call_id:c.id,isError:native.find(e=>e.message?.role==='toolResult'&&e.message.toolCallId===c.id)?.message.isError??false}));
const summary={clock:new Date().toISOString(),base:'409bd889289fa3601977411747e0aaccf9a73332',fix_head:git(R+'/workspace','rev-parse','HEAD'),parent_branch:git(R+'/workspace','branch','--show-current'),parent_clean:git(R+'/workspace','status','--porcelain')==='',workers,playbook_reads:playbookReads,checklists,launch_attempts:launches,delivery_counts:counts,authorization_deviations:{sensitive_file_reads:sensitiveReads,scope:'Parent ignored explicit no-credential-file-read instruction while investigating refused thinking arguments. Its task-scoped B2 bearer entered its private native transcript. Revoke after stopping; never export raw transcript or grant values.'},deliveries:deliveries.map(d=>({id:d.id,name:d.name,kind:d.kind,worker_id:d.evidence?.worker_id,report_id:d.evidence?.report_id,head:d.evidence?.head,claim_not_verified:d.evidence?.claim_not_verified,termination:d.evidence?.termination})),recorded_pi_leaders:[...new Set(rows.map(r=>r.value.pid).filter(Boolean))].map(pid=>({pid,state:proc(pid)})),all_recorded_domains:[...new Map(rows.filter(r=>r.value.unit).map(r=>[r.value.unit.name,r.value.unit])).values()].map(u=>({name:u.name,removed:!existsSync(u.root+'/'+u.name)})),terminal_calls_present:existsSync(R+'/terminal-calls'),driver_direct_native_calls:[],credential_transfer:'Only Git bundles, issue text and authored harness files transferred from ms-a2; provider config copied VM-locally only; all Git remotes are local bundle/workspace paths.',limitations:['No syscall audit; terminal absence is supported by executable/provider traps and typed backend evidence.','Same-family tester is not independent-provider review.','Pstack guidance followed from B2 prompt; slash-mode activation unsupported and not bypassed.','Job-owned orchestration observer remains connected inside parent when external owner clients close.']};
writeFileSync(out+'/native-audit.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({fix_head:summary.fix_head,parent_clean:summary.parent_clean,workers:workers.map(w=>({id:w.worker_id,parent:w.parent_worker_id,status:w.status,git:w.git})),launch_attempts:launches,delivery_counts:counts},null,2));
