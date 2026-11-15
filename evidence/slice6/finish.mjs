/** Final proof joins and scoped cleanup. Never exports raw sessions/grant values. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {GrantStore} from '/tmp/a0s6/supervisor/dist/grants.js';
const R='/tmp/a0s6/run1',O='/tmp/a0s6/out',work=R+'/workspace';
function json(s){try{return JSON.parse(s);}catch(cause){throw Error('invalid evidence input',{cause});}}
const file=p=>json(readFileSync(p,'utf8')),git=(...args)=>execFileSync('git',['-C',work,...args],{encoding:'utf8'}).trim();
const evidence=file(O+'/verification.json'),audit=file(O+'/native-audit.json');
assert.equal(evidence.verdict,'verified');assert.equal(git('rev-parse','HEAD'),evidence.subject.commit_sha);assert.equal(audit.fix_head,evidence.subject.commit_sha);
const spec=file(work+'/openapi.json'),old=json(git('show',evidence.subject.base_sha+':openapi.json'));
const op=Object.values(spec.paths).flatMap(p=>Object.values(p)).find(o=>o.operationId==='workers.stop');
assert.equal(op.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/StopReceipt');
assert.ok(spec.components.schemas.StopReceipt.allOf.some(x=>x.properties?.result?.$ref==='#/components/schemas/StopResult'));
const normalized=structuredClone(spec);delete normalized.components.schemas.StopResult;delete normalized.components.schemas.StopReceipt;
Object.values(normalized.paths).flatMap(p=>Object.values(p)).find(o=>o.operationId==='workers.stop').responses['200'].content['application/json'].schema.$ref='#/components/schemas/Receipt';
assert.deepEqual(normalized,old,'no unrelated OpenAPI semantic change');
const testChanges=git('diff','--name-status',evidence.subject.base_sha,evidence.subject.commit_sha,'--','src/test');assert.ok(testChanges.split('\n').every(x=>x.startsWith('A\t')),'no existing test changed');
assert.equal(audit.workers.length,3);assert.equal(audit.workers.find(w=>!w.parent_worker_id).host,'sdk');
const children=audit.workers.filter(w=>w.parent_worker_id);assert.equal(children.length,2);
for(const w of children){assert.equal(w.git.locked,true);assert.equal(w.git.retained,true);assert.equal(w.git.status,'');assert.equal(w.git.base,evidence.subject.base_sha);assert.deepEqual(w.grant_methods,['children.report']);assert.equal(w.grant_source_id,'orchestrator');assert.equal(w.status,'stopped');}
assert.equal(audit.deliveries.filter(d=>d.kind==='result').length,2);assert.equal(audit.deliveries.filter(d=>d.kind==='termination').length,2);assert.ok(Object.values(audit.delivery_counts).every(n=>n===1));
assert.ok(audit.playbook_reads.some(x=>x.path.endsWith('/SKILL.md')&&x.success));assert.ok(audit.playbook_reads.some(x=>x.path.endsWith('/bug-fix.md')&&x.success));assert.ok(audit.checklists.length);
assert.ok(audit.recorded_pi_leaders.every(p=>p.state===null||p.state==='Z'));assert.ok(audit.all_recorded_domains.every(u=>u.removed));assert.equal(audit.terminal_calls_present,false);
const disconnected=file(R+'/disconnect.json'),reconnects=readdirSync(R).filter(n=>/^reconnect-\d+\.json$/.test(n)).sort(),reconnected=file(R+'/'+reconnects[0]);
assert.ok(reconnected.disconnected_seconds>=60);assert.equal(reconnected.snapshot.type,'snapshot');assert.equal(reconnected.snapshot.resync_reason,'gap');assert.ok(reconnected.snapshot.cursor.seq>disconnected.cursor.seq);
const parentBefore=file(R+'/parent.json'),parentAfter=reconnected.snapshot.workers.find(w=>w.worker_id===parentBefore.worker_id);assert.equal(parentAfter.worker_epoch,parentBefore.epoch);assert.equal(parentAfter.session_id,parentBefore.session_id);assert.equal(parentAfter.foreground,'running');
const records=readFileSync(R+'/state/journal.jsonl','utf8').trim().split('\n').map(json).map(x=>x.record);const parentRecord=records.findLast(r=>r.kind==='worker'&&r.value.worker.worker_id===parentBefore.worker_id);
const native=readFileSync(parentRecord.value.sessionFile,'utf8').trim().split('\n').map(json);
const during=native.filter(e=>Date.parse(e.timestamp)>Date.parse(disconnected.clock)&&Date.parse(e.timestamp)<Date.parse(reconnected.clock));
const toolCalls=during.flatMap(e=>(e.message?.role==='assistant'?e.message.content??[]:[]).filter(c=>c.type==='toolCall'));assert.ok(toolCalls.length>0,'native work occurred with no external clients');
const supervisorPid=file(R+'/state/supervisor.lock/owner.json').pid;
const grants=new GrantStore(R+'/state');grants.revoke('orchestrator');assert.throws(()=>grants.active('orchestrator'),/revoked/);
const cleanup={clock:new Date().toISOString(),scoped_grant_revoked:true,pi_leaders:audit.recorded_pi_leaders,worker_domains:audit.all_recorded_domains,stopped_units:[]};
const keeper='a0-'+createHash('sha256').update(realpathSync(R+'/state')).digest('hex').slice(0,20)+'.service';
for(const unit of ['a0-s6-supervisor.service',keeper]){execFileSync('systemctl',['--user','stop',unit],{timeout:30000});cleanup.stopped_units.push(unit);}
cleanup.supervisor_pid=supervisorPid;cleanup.supervisor_absent=!existsSync('/proc/'+supervisorPid);assert.equal(cleanup.supervisor_absent,true);
cleanup.service_states=cleanup.stopped_units.map(unit=>{const r=spawnSync('systemctl',['--user','is-active',unit],{encoding:'utf8'});return {unit,state:r.stdout.trim(),inactive:r.status!==0};});assert.ok(cleanup.service_states.every(s=>s.inactive));
// Positive control is deliberately AFTER job zero-call evidence and domain cleanup.
const terminalPositive=[];for(const name of ['herdr','hc','herdr-core']){const r=spawnSync(R+'/bin/'+name,[],{encoding:'utf8'});assert.equal(r.status,97);terminalPositive.push({name,exit_code:r.status});}
assert.deepEqual(readFileSync(R+'/terminal-calls','utf8').trim().split('\n'),['herdr','hc','herdr-core']);cleanup.terminal_executable_positive_controls=terminalPositive;
writeFileSync(O+'/cleanup.json',JSON.stringify(cleanup,null,2)+'\n');
evidence.checks.push({name:'owner-artifact-and-journey-assertions',producer:'slice6-finish deterministic assertions',pass:true,result:{stop_result_schema_wired:true,no_unrelated_openapi_semantics:true,no_existing_tests_changed:true,real_typed_children:2,retained_locked_clean_worktrees:2,result_deliveries_once:2,separate_termination_deliveries_once:2,successful_pstack_guidance_reads:2,external_client_disconnect_seconds:reconnected.disconnected_seconds,native_tool_calls_during_disconnect:toolCalls.length,same_parent_epoch_and_session_after_reconnect:true,reattach_resync_reason:'gap',all_pi_leaders_nonexecuting:true,all_worker_domains_removed:true,task_scoped_bearer_revoked:true}});
evidence.limitations.push('Unsandboxed parent read its scoped B2 grant despite an explicit instruction not to; private transcript retained on VM only; grant revoked after stop. No GitHub credential was transferred.','Six invalid thinking launch attempts were refused before acquisition; exactly two real children launched with thinking off.','Pstack guidance was read and followed from a B2 prompt; unsupported slash-mode activation was not bypassed.');
evidence.finished_at=new Date().toISOString();writeFileSync(O+'/verification.json',JSON.stringify(evidence,null,2)+'\n');
const journey={job_id:evidence.job_id,subject:evidence.subject,disconnect:{clock:disconnected.clock,cursor:disconnected.cursor},reconnect:{clock:reconnected.clock,seconds:reconnected.disconnected_seconds,cursor:reconnected.snapshot.cursor,resync_reason:'gap',same_epoch_and_session:true,native_tool_calls:toolCalls.length},children:children.map(w=>({worker_id:w.worker_id,host:w.host,git:w.git,grant_methods:w.grant_methods})),delivery_counts:audit.delivery_counts,attempted_child_calls:audit.launch_attempts.length,real_children:2,refused_preacquisition_calls:audit.launch_attempts.filter(a=>a.isError).length,parent_host:'sdk',driver_direct_native_calls:[],sandbox_preflight:file(R+'/sandbox-preflight.json'),pstack:{guidance_reads:audit.playbook_reads,checklist_observed:true,slash_activation:false},terminal_calls_during_job:0,authorization_deviations:audit.authorization_deviations,cleanup:'cleanup.json',evidence_verdict:evidence.verdict,root_actions_remaining:['Review artifact and evidence','Push fix/issue-1 if accepted','Open and verify draft PR; no PR was authorized to this leaf'],limitations:evidence.limitations};
writeFileSync(O+'/run-summary.json',JSON.stringify(journey,null,2)+'\n');console.log(JSON.stringify({subject:evidence.subject.commit_sha,verdict:evidence.verdict,cleanup:true,disconnect_seconds:reconnected.disconnected_seconds,native_tools_during_disconnect:toolCalls.length}));
