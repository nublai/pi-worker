/** Owner acceptance of an exact verified artifact, not merge/deploy authority. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const started=Date.now(),R='/tmp/a0s6/run1',O='/tmp/a0s6/out';
function json(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch(cause){throw Error('invalid acceptance input',{cause});}}
const e=json(O+'/verification.json'),p=json(R+'/owner-policy.json');
assert.equal(e.verdict,'verified');assert.ok(e.checks.every(c=>c.pass));assert.ok(Date.now()<Date.parse(p.expiry));
const git=(...args)=>execFileSync('git',['-C',R+'/workspace',...args],{encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'),e.subject.commit_sha);assert.equal(git('status','--porcelain'),'');
const diff=execFileSync('git',['-C',R+'/workspace','diff','--binary',e.subject.base_sha,e.subject.commit_sha]);
assert.equal(createHash('sha256').update(diff).digest('hex'),e.subject.diff_digest.value);
const a={clock:new Date().toISOString(),kind:'accept',actor:p.actor,policy_revision:p.revision,job_id:p.job_id,artifact:e.subject,decision:'accept_verified_artifact_for_root_review',scope:'local verified change only; NOT push, PR, merge, release or deployment authorization',expiry:p.expiry,revocation:p.revocation,evidence_record_sha256:createHash('sha256').update(readFileSync(O+'/verification.json')).digest('hex'),scripted_action_seconds:(Date.now()-started)/1000};
writeFileSync(O+'/acceptance.json',JSON.stringify(a,null,2)+'\n');appendFileSync(R+'/attention.jsonl',JSON.stringify(a)+'\n');
const touches=readFileSync(R+'/attention.jsonl','utf8').trim().split('\n').map(s=>{try{return JSON.parse(s);}catch(cause){throw Error('invalid attention log',{cause});}});
const parent=json(R+'/parent.json'),freeze=json(R+'/freeze.json');
const ownerWriteActions=[{clock:parent.created,operation:'workers.create',class:'provisioning',clock_evidence:'post-create observation'},...touches.map(t=>({clock:t.clock,operation:t.kind==='accept'?'artifact.accept':t.command_id==='slice6-job'?'sessions.prompt':'sessions.follow_up',class:'authorization_intervention'})),{clock:freeze.clock,operation:'workers.stop',class:'cleanup_control'}].sort((a,b)=>a.clock.localeCompare(b.clock));
const summary={schema:'a0-attention-baseline-v1',owner_write_actions:ownerWriteActions,total_owner_write_actions:ownerWriteActions.length,non_intervention_write_actions:ownerWriteActions.filter(t=>t.class!=='authorization_intervention').length,job_id:p.job_id,verified_changes:1,verified_prs:0,touches,interventions:touches.length,prompts:touches.filter(t=>t.kind==='prompt').length,answers:touches.filter(t=>t.kind==='answer').length,accepts:touches.filter(t=>t.kind==='accept').length,first_touch:touches[0].clock,last_touch:a.clock,elapsed_minutes_per_verified_change:(Date.parse(a.clock)-Date.parse(touches[0].clock))/60000,verified_at:json(O+'/verification.json').finished_at,founder_human_touches_during_job:0,human_attention_minutes:null,limitations:['Interventions are explicit scripted owner decisions, not a measured human-attention study.','Elapsed minutes are job wall time between first prompt and exact-artifact acceptance, not active human minutes.','Harness authoring, VM setup, read-only observation, independent verification and cleanup are automation/operator overhead outside the prompt/answer/accept count; disclosed in the run report.','No verified PR exists yet; minutes per verified PR cannot be reported until root opens and verifies the draft PR.']};
writeFileSync(O+'/attention.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({accepted:e.subject.commit_sha,interventions:summary.interventions,elapsed_minutes:summary.elapsed_minutes_per_verified_change,human_attention_minutes:null}));
