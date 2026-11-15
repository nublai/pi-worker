/** Additional acceptance audit. The original zero-refusal audit FAILED and is
 * retained unchanged. This checks two actual acquisitions plus four exact,
 * pre-acquisition thinking refusals; it does not mark zero-refusals as passed. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseJournal} from '/tmp/a0s7/runtime/dist/journal.js';
import {artifactSubject} from '/tmp/a0s7/runtime/dist/artifact.js';
const R=process.env.A0_S7_RUN??'/tmp/a0s7/run',root=R+'/workspace';
function parse(s){try{return JSON.parse(s);}catch(cause){throw new Error('Invalid private audit JSON; contents withheld',{cause});}}
const load=n=>parse(readFileSync(R+'/'+n,'utf8'));
const entries=path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(parse);
const records=parseJournal(readFileSync(R+'/state/journal.jsonl')).records;
const rows=records.filter(r=>r.kind==='worker'),latest=new Map(rows.map(r=>[r.value.worker.worker_id,r.value]));
const parent=latest.get(load('parent.json').worker_id), children=[...latest.values()].filter(v=>v.worker.parent_worker_id===parent.worker.worker_id);
assert.equal(children.length,2);assert.equal(latest.size,3,'no extra worker generation');
assert.equal(readdirSync(root+'/.a0-worktrees').filter(n=>n.endsWith('.jsonl')).length,2,'only two provisioning manifests');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
const native=entries(parent.sessionFile);
const calls=es=>es.flatMap(e=>e.message?.role==='assistant'&&Array.isArray(e.message.content)?e.message.content.filter(c=>c.type==='toolCall'):[]);
const parentCalls=calls(native), launches=parentCalls.filter(c=>c.name==='subagent');
assert.equal(launches.length,6,'count all refused and successful attempts');
const launchResults=launches.map(c=>native.find(e=>e.message?.role==='toolResult'&&e.message.toolCallId===c.id)?.message);
assert.deepEqual(launchResults.map(r=>r?.isError),[true,true,true,true,false,false]);
for(let i=0;i<launches.length;i++){
  const c=launches[i];assert.equal(c.arguments.model,'exe-dev-anthropic/claude-sonnet-4-6@llm');
  if(i<4){assert.ok(['disabled','none'].includes(c.arguments.thinking));assert.ok(JSON.stringify(launchResults[i].content).includes('unsupported thinking level'));}
  else assert.equal(c.arguments.thinking,'off');
}
const deliveries=native.filter(e=>e.type==='custom_message'&&e.customType==='subagent_result').map(e=>parse(e.content));
const deliveryCounts={};for(const d of deliveries)deliveryCounts[d.id+':'+d.kind]=(deliveryCounts[d.id+':'+d.kind]??0)+1;
for(const d of Object.values(deliveryCounts))assert.equal(d,1);
assert.equal(deliveries.filter(d=>d.kind==='result').length,2);assert.equal(deliveries.filter(d=>d.kind==='termination').length,2);
const stanzas=git(root,'worktree','list','--porcelain').split('\n\n');
const workers=[parent,...children].map(v=>{
  const w=v.worker, es=entries(v.sessionFile),tools=calls(es),types={};for(const c of tools)types[c.name]=(types[c.name]??0)+1;
  assert.equal(es[0].id,w.session_id);assert.equal(w.launch_spec.environment.filesystem,'bwrap');assert.equal(w.host,'sdk');assert.equal(w.status,'stopped');assert.equal(w.cleanup,'cgroup_empty_removed');assert.equal(existsSync(v.unit.root+'/'+v.unit.name),false);assert.equal(existsSync(w.cwd+'/.a0-terminal-calls'),false);
  const deniedReads=tools.filter(c=>c.name==='read'&&/(grants\/|models-store\.json|auth\.json)/.test(c.arguments?.path??''));assert.equal(deniedReads.length,0);
  const out={worker_id:w.worker_id,worker_epoch:w.worker_epoch,parent_worker_id:w.parent_worker_id,session_id:w.session_id,host:w.host,filesystem:w.launch_spec.environment.filesystem,status:w.status,cleanup:w.cleanup,domain:v.unit.name,domain_removed:true,tool_counts:types,grant_source_id:w.grant_source_id,grant_methods:w.launch_spec.grant_methods,credential_read_tools:deniedReads.length,terminal_trap_present:false};
  if(w.parent_worker_id){
    const stanza=stanzas.find(x=>x.startsWith('worktree '+w.cwd+'\n'));assert.ok(stanza&&/^locked(?: |$)/m.test(stanza));assert.equal(git(w.cwd,'status','--porcelain'),'');assert.equal(git(w.cwd,'rev-list','--count',load('job.json').base+'..HEAD'),'1');
    const reported=records.filter(r=>r.kind==='receipt'&&r.value.operation==='children.report'&&r.value.worker_id===w.worker_id&&r.value.state==='delivered'&&r.value.result?.kind==='result');assert.equal(reported.length,1);
    out.git={cwd:w.cwd,branch:git(w.cwd,'branch','--show-current'),subject:artifactSubject(w.cwd,'HEAD',load('job.json').base),clean:true,locked:true,retained:true};out.fd_result_reports=reported.length;
    for(const verb of ['status','add','commit'])assert.ok(tools.some(c=>c.name==='bash'&&new RegExp('git[^\\n]*'+verb).test(c.arguments.command)),'real child Git '+verb);
  }
  return out;
});
const refsBefore=new Map(load('base-refs.json').map(x=>x.split(' '))),refsAfter=new Map(git(root,'for-each-ref','--format=%(refname) %(objectname)').split('\n').map(x=>x.split(' ')));
const allowed=new Set(['refs/heads/job/slice7','refs/heads/s7-note/task','refs/heads/s7-check/task']);
for(const [ref,sha] of refsBefore)if(!allowed.has(ref))assert.equal(refsAfter.get(ref),sha,'unrelated ref changed');
for(const [ref]of refsAfter)if(!refsBefore.has(ref))assert.ok(allowed.has(ref),'undeclared new ref');
const changedRefs=[...refsAfter].filter(([ref,sha])=>refsBefore.get(ref)!==sha).map(([ref,sha])=>({ref,commit_id:sha}));
assert.equal(changedRefs.length,3);
const reads=parentCalls.filter(c=>c.name==='read'&&/poteto-mode\/(SKILL.md|playbooks\/prototype.md)$/.test(c.arguments?.path??''));assert.equal(reads.length,2);
for(const c of reads)assert.equal(native.find(e=>e.message?.role==='toolResult'&&e.message.toolCallId===c.id)?.message.isError,false);
const denied=parentCalls.find(c=>c.name==='bash'&&String(c.arguments.command).includes('PARENT_GRANT_AND_STATE_DENIED'));assert.ok(denied);
const denialResult=native.find(e=>e.message?.role==='toolResult'&&e.message.toolCallId===denied.id);assert.equal(denialResult.message.isError,false);assert.ok(JSON.stringify(denialResult.message.content).includes('PARENT_GRANT_AND_STATE_DENIED'));
const disconnected=load('disconnect.json'),reconnected=load('reconnect.json');
const during=parentCalls.filter(c=>{const e=native.find(e=>e.message?.role==='assistant'&&e.message.content?.some(x=>x.id===c.id));return e&&Date.parse(e.timestamp)>=Date.parse(disconnected.clock)&&Date.parse(e.timestamp)<Date.parse(reconnected.clock);}).length;
assert.ok(during>0);assert.equal(reconnected.snapshot.workers.find(w=>w.worker_id===parent.worker.worker_id).worker_epoch,disconnected.parent_epoch);
const proc=pid=>{try{const s=readFileSync('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[0];}catch{return null;}};
const leaders=[...new Set(rows.map(r=>r.value.pid).filter(Boolean))].map(pid=>({pid,state:proc(pid)}));for(const p of leaders)assert.equal(p.state,null);
assert.equal(git(root,'status','--porcelain'),'');
const note=load('job.json').note;assert.ok(readFileSync(root+'/README.md','utf8').includes('- '+note));
const summary={producer:'slice7-additional-native-git-acceptance-audit',workflow_zero_refusal_criterion:{pass:false,original_audit_log:'audit2-zero-refusal-failed.log',attempts:6,refused_before_acquisition:4,actual_acquisitions:2,refusal:'unsupported thinking level',supported_thinking_of_both_actual_children:'off'},clock:new Date().toISOString(),subject:artifactSubject(root,'HEAD',load('job.json').base),workers,launch_attempts:launches.map(c=>({name:c.arguments.name,model:c.arguments.model,thinking:c.arguments.thinking,branch:c.arguments.worktree.branch,isError:launchResults[launches.indexOf(c)].isError})),delivery_counts:deliveryCounts,changed_refs:changedRefs,unrelated_refs_unchanged:true,unexpected_refs_absent:true,parent_grant_and_state_read_denied:true,playbook_reads:reads.map(c=>({tool_call_id:c.id,path:c.arguments.path,success:true})),native_calls_during_disconnect:during,reconnect:{disconnected_seconds:reconnected.disconnected_seconds,resync_reason:reconnected.snapshot.resync_reason,parent_epoch_unchanged:true,session_id_unchanged:reconnected.snapshot.workers.find(w=>w.worker_id===parent.worker.worker_id).session_id===disconnected.session_id},recorded_leaders:leaders,driver_direct_native_calls:[],result_claims_are_not_verification:true,limitations:['SDK/ACP only bwrap; network shared; deliberately staged VM model-store readable read-only.','Shared Git objects and own ref namespace writable; owner compared complete refs map.','No cross-provider review; two authorized leaves use same family.','Original zero-refusal audit failed; four unsupported thinking aliases were refused before acquisition. Job-owned parent observer stayed connected.','No syscall audit or crash-durable parent delivery claim.']};
writeFileSync(R+'/native-audit.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({subject:summary.subject,workers:workers.length,launches:launches.length,changed_refs:changedRefs.map(x=>x.ref),delivery_counts:deliveryCounts,disconnected_tool_calls:during}));
