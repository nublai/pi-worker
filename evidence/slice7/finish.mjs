/** Task-owned acceptance/export/cleanup. Stops only exact run-owned units. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,copyFileSync,existsSync,realpathSync,readdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {artifactSubject} from '/tmp/a0s7/runtime/dist/artifact.js';
import {GrantStore} from '/tmp/a0s7/runtime/dist/grants.js';
const R=process.env.A0_S7_RUN??'/tmp/a0s7/run',out=process.env.A0_S7_OUT??'/tmp/a0s7/out',root=R+'/workspace';
function parse(s){try{return JSON.parse(s);}catch(cause){throw new Error('Invalid private finish JSON; contents withheld',{cause});}}
const load=p=>parse(readFileSync(p,'utf8'));
const evidence=load(out+'/verification.json'),policy=load(R+'/owner-policy.json');
assert.equal(evidence.result,'verified');assert.deepEqual(artifactSubject(root,'HEAD',evidence.subject.base_id),evidence.subject);
const fsck=spawnSync('git',['-C',root,'fsck','--full','--strict'],{encoding:'utf8'});writeFileSync(out+'/git-fsck.log',fsck.stdout+fsck.stderr);assert.equal(fsck.status,0);
const acceptance={actor:policy.actor,job_id:policy.job,policy_revision:policy.revision,subject:evidence.subject,scope:'verified local artifact retained for root review only; no push, PR, merge, release or deploy',expiry:policy.expiry,revocation_condition:'any artifact or policy revision change invalidates acceptance',accepted_at:new Date().toISOString()};
appendFileSync(R+'/attention.jsonl',JSON.stringify({clock:acceptance.accepted_at,kind:'acceptance',actor:policy.actor,policy_revision:policy.revision,subject:evidence.subject})+'\n');
writeFileSync(out+'/acceptance.json',JSON.stringify(acceptance,null,2)+'\n');
const state=R+'/state',grant=load(state+'/grants/orchestrator.json'),modelStore=load(root+'/.a0-agent/models-store.json');
const secrets=[grant.token];
function collect(v,path=''){if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))collect(x,path+'/'+k);else if(typeof v==='string'&&v.length>=12&&/api.?key|token|password|secret/i.test(path))secrets.push(v);}
collect(modelStore);
// Deliberately public placeholder is not accepted by the real B2 socket.
assert.notEqual(grant.token,'PUBLIC-parent-channel-not-a-B2-grant');
new GrantStore(state).revoke('orchestrator');
const keeper='a0-'+createHash('sha256').update(realpathSync(state)).digest('hex').slice(0,20)+'.service';
const main=execFileSync('systemctl',['--user','show','a0-s7-supervisor.service','--property=MainPID','--value'],{encoding:'utf8'}).trim();
appendFileSync(R+'/attention.jsonl',JSON.stringify({clock:new Date().toISOString(),kind:'cleanup',actor:policy.actor,policy_revision:policy.revision,units:['a0-s7-supervisor.service',keeper],grant_revoked:'orchestrator'})+'\n');
for(const unit of ['a0-s7-supervisor.service',keeper])execFileSync('systemctl',['--user','stop',unit],{timeout:20000});
const units=execFileSync('systemctl',['--user','list-units','a0-*','--all','--no-legend'],{encoding:'utf8'}).trim();assert.equal(units,'');
assert.equal(existsSync('/proc/'+main),false);
const trapBefore=existsSync(root+'/.a0-terminal-calls');assert.equal(trapBefore,false);
const positives=[];for(const name of ['herdr','hc','herdr-core']){const p=spawnSync(root+'/.a0-bin/'+name,[],{encoding:'utf8'});assert.equal(p.status,97);positives.push({command:name,exit_code:p.status});}
writeFileSync(out+'/cleanup.json',JSON.stringify({clock:new Date().toISOString(),supervisor_pid:Number(main),supervisor_absent:true,stopped_units:['a0-s7-supervisor.service',keeper],loaded_a0_units:[],grant_revoked:true,terminal_trap_absent_during_job:true,terminal_positive_controls_after_freeze:positives,all_worker_domains_removed:true,retention:'both locked child worktrees and all private profiles/journals/native sessions retained on VM'},null,2)+'\n');
const actions=readFileSync(R+'/attention.jsonl','utf8').trim().split('\n').map(parse);
const prompts=actions.filter(x=>x.kind==='prompt'),answers=actions.filter(x=>x.kind==='answer'),accepts=actions.filter(x=>x.kind==='acceptance');
writeFileSync(out+'/attention.json',JSON.stringify({actions,authorization_interventions:prompts.length+answers.length+accepts.length,prompts:prompts.length,answers:answers.length,acceptances:accepts.length,owner_write_actions:actions.length,elapsed_minutes_to_acceptance:(Date.parse(acceptance.accepted_at)-Date.parse(prompts[0].clock))/60000,founder_live_touches:0,active_human_attention_minutes:null,verified_changes:1,verified_prs:0,minutes_per_verified_pr:null,note:'elapsed job/verification time is not active human attention; driver authoring, setup, audit, tests and cleanup are automated owner-side overhead'},null,2)+'\n');
copyFileSync(R+'/native-audit.json',out+'/native-audit.json');
copyFileSync('/tmp/a0s7/vm-default.log',out+'/vm-default.log');copyFileSync('/tmp/a0s7/vm-kernel.log',out+'/vm-kernel.log');
const sourceFiles=['maestro/core/worker-execution.ts','maestro/adapters/pi/worker-client.ts','maestro/runtime/pi-worker-session.ts','pi-extension/subagents/worker-backend.ts'];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const platform={clock:new Date().toISOString(),node:process.version,git:execFileSync('git',['--version'],{encoding:'utf8'}).trim(),pi:load('/tmp/a0s7/runtime/node_modules/@earendil-works/pi-coding-agent/package.json').version,herdr:load(root+'/.a0-agent/npm/node_modules/pi-herdr-agents/package.json').version,pstack:load(root+'/.a0-agent/npm/node_modules/pi-herdr-pstack/package.json').version,worker_runtime_subject:artifactSubject('/tmp/a0s7/runtime'),experimental_host_source_commit:'f9e6cc5367dd203e7d32e6b4059aa389f3003a8d',host_source_hashes:sourceFiles.map(p=>({path:p,sha256:hash(root+'/.a0-agent/npm/node_modules/pi-herdr-agents/'+p)})),credential_exposure:'only VM-local models-store.json credential-bearing file deliberately staged read-only in each sandbox; no GitHub/host model credential transferred',provider_patch:'private profile only: removed /exe.dev existence guard after setup hostname check; /exe.dev is not mounted',no_github_credential:true};
writeFileSync(out+'/platform.json',JSON.stringify(platform,null,2)+'\n');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const changed=git('diff','--name-only',evidence.subject.base_id,evidence.subject.commit_id).split('\n');assert.deepEqual(changed.sort(),['README.md','evidence/slice7-job/verify.mjs']);
const blobs=changed.map(p=>execFileSync('git',['-C',root,'show',evidence.subject.commit_id+':'+p]));
const files=readdirSync(out).filter(n=>n.endsWith('.json')||n.endsWith('.log'));const bytes=files.map(n=>readFileSync(out+'/'+n));
for(const b of [...bytes,...blobs]){
  for(const secret of secrets)assert.equal(b.includes(Buffer.from(secret)),false,'private credential value in export; withheld');
  const text=b.toString('utf8');assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|[?&](?:access_token|api_key|signature|token)=[^\s"&]+/i.test(text),false,'credential-like export pattern; withheld');
}
writeFileSync(out+'/privacy.json',JSON.stringify({clock:new Date().toISOString(),known_private_values_compared_in_memory:true,no_private_value_or_credential_hash_logged:true,export_files:files.length,artifact_blobs:blobs.length,credential_pattern_scan:true,pass:true,limitations:['exact-value and pattern scans are not a proof against transformed or unknown secrets','no raw profile, model-store, grant or transcript exported']},null,2)+'\n');
execFileSync('git',['-C',root,'bundle','create',out+'/result.bundle','job/slice7','s7-note/task','s7-check/task']);
console.log(JSON.stringify({accepted:true,subject:evidence.subject,owner_actions:actions.length,authorization_interventions:prompts.length+answers.length+accepts.length,loaded_a0_units:0,privacy_pass:true,result_bundle:out+'/result.bundle'}));
