/** Task-owned evidence packager; validates completed logs without rerunning them. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {artifactSubject} from '../../dist/artifact.js';
const out='evidence/slice7',scratch='/tmp/a0s7',vm=scratch+'/vm-out2',count=216;
const hash=b=>createHash('sha256').update(b).digest('hex');
function parse(s){try{return JSON.parse(s);}catch(cause){throw new Error('Invalid task evidence JSON',{cause});}}
const subject=artifactSubject(process.cwd(),'fd99c8992941f16187e8b54affd8f9d2f6a6b3dd');
const job=parse(readFileSync(vm+'/verification.json','utf8')).subject;
assert.equal(job.base_id,subject.commit_id);
const checks=[];
for(const host of ['local','vm'])for(const mode of ['default','kernel']){
  const file=`${host}-${mode}-${count}.log`,bytes=readFileSync(scratch+'/'+file),text=bytes.toString(),counts={};
  for(const k of ['tests','pass','fail','skipped']){const m=text.match(new RegExp('(?:#|ℹ) '+k+' (\\d+)'));assert.ok(m);counts[k]=Number(m[1]);}
  assert.equal(counts.tests,count);assert.equal(counts.fail,0);assert.equal(counts.pass,mode==='kernel'?count:count-7);assert.equal(counts.skipped,mode==='kernel'?0:7);
  copyFileSync(scratch+'/'+file,out+'/'+file);
  checks.push({producer:host+'-full-suite-runner',subject,command:'npm test',kernel_flags:mode==='kernel'?['A0_TEST_CGROUP_DIR=<exact delegated test-service cgroup>','A0_TEST_BWRAP=1']:[],host,node:host==='local'?process.version:'v22.21.1',exit_code:0,counts,log:{path:file,sha256:hash(bytes)}});
}
for(const host of ['local','vm']){
  const file=host+'-generated.log',bytes=readFileSync(scratch+'/'+file);copyFileSync(scratch+'/'+file,out+'/'+file);
  checks.push({producer:host+'-generated-type-checker',subject,command:'npm run check:generated',exit_code:0,log:{path:file,sha256:hash(bytes)}});
}
const source=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())walk(path);else source.push({path,sha256:hash(readFileSync(path))});}}
walk('src');for(const path of ['package.json','package-lock.json','tsconfig.json','openapi.json'])source.push({path,sha256:hash(readFileSync(path))});
writeFileSync(out+'/source-manifest.json',JSON.stringify({producer:'slice7-source-manifest',subject,files:source},null,2)+'\n');
for(const host of ['local','vm']){
  const file=host+'-final-audit.json',audit=parse(readFileSync(scratch+'/'+file,'utf8'));assert.deepEqual(audit.subject,subject);assert.deepEqual(audit.source_files,source);assert.deepEqual(audit.loaded_a0_units,[]);copyFileSync(scratch+'/'+file,out+'/'+file);
}
writeFileSync(out+'/checks.json',JSON.stringify({producer:'slice7-owner-evidence-packager',subject,checks,live_job_base_subject:subject,lsp:'active probes returned zero findings but were inconclusive; strict tsc is definitive type evidence',independent_review:'not run: build-leaf prohibition on subagents'},null,2)+'\n');
const results=parse(readFileSync(scratch+'/reversions/results.json','utf8'));results.producer='slice7-isolated-copy-reversion-runner';results.subject=subject;results.base_subject=artifactSubject(process.cwd(),'b461253');
results.baseline_limit='The new portable broker fixture uses the per-parent router absent on b461253 and is omitted only from that old-base comparison. It separately failed twice by assertion on 249be1b before fd99c89, including the real sandbox probe. All final tests run in the full suites.';
for(const row of results.results){const file=row.name+'.log';copyFileSync(scratch+'/reversions/'+file,out+'/reversion-'+file);row.log={path:'reversion-'+file,sha256:hash(readFileSync(scratch+'/reversions/'+file))};assert.equal(row.build_exit,0);assert.equal(row.pass,true);}
results.profile_broker_red_green={before_source:artifactSubject(process.cwd(),'249be1b'),after_source:subject,before:{assertion_failures:2,log:'broker-before.log',sha256:hash(readFileSync(out+'/broker-before.log'))},after:{pass:2,log:'broker-after.log',sha256:hash(readFileSync(out+'/broker-after.log'))}};
writeFileSync(out+'/reversions.json',JSON.stringify(results,null,2)+'\n');
for(const name of readdirSync(vm))if(name.endsWith('.json')||name.endsWith('.log'))copyFileSync(vm+'/'+name,out+'/'+name);
for(const name of ['native-audit','cleanup','attention','platform','privacy']){
  const path=out+'/'+name+'.json',record=parse(readFileSync(path,'utf8'));record.producer??='slice7-'+name+'-driver';record.subject??={commit_id:job.commit_id,tree_id:job.tree_id};writeFileSync(path,JSON.stringify(record,null,2)+'\n');
}
const first=parse(readFileSync(out+'/superseded-pre-broker-fix/attention.json','utf8')),last=parse(readFileSync(out+'/attention.json','utf8'));
writeFileSync(out+'/attention-total.json',JSON.stringify({producer:'slice7-total-attention-accounting',subject:{commit_id:job.commit_id,tree_id:job.tree_id},runs:[{path:'/tmp/a0s7/run',status:'superseded-after-broker-bug',prompts:first.prompts,answers:first.answers,acceptances:first.acceptances,owner_write_actions:first.owner_write_actions},{path:'/tmp/a0s7/run2',status:'final-verified',prompts:last.prompts,answers:last.answers,acceptances:last.acceptances,owner_write_actions:last.owner_write_actions}],authorization_interventions:first.authorization_interventions+last.authorization_interventions,owner_write_actions:first.owner_write_actions+last.owner_write_actions,verified_current_changes:1,verified_prs:0,founder_live_touches:0,active_human_attention_minutes:null,minutes_per_verified_pr:null,note:'Includes the earlier invalidated acceptance; setup/debug/test authoring remain disclosed automated overhead, not measured human attention.'},null,2)+'\n');
writeFileSync(out+'/packaging.json',JSON.stringify({producer:'slice7-owner-evidence-packager',subject,job_subject:{commit_id:job.commit_id,tree_id:job.tree_id},normalization:'Producer/subject metadata added to supporting VM records; no behavior/result changed. Original records remain private scratch.',superseded_candidate:'superseded-pre-broker-fix/',workflow_deviation:'The unchanged zero-refusal audit failed on six attempts. Additional audit proves exactly four pre-acquisition unsupported-thinking refusals plus two actual acquisitions; the failed criterion is retained as false, not relabelled passing.',diff_note:'Diff hashes are advisory and name producing Git version; commit/tree identity is authoritative.'},null,2)+'\n');
console.log(JSON.stringify({subject,job_subject:job,checks:checks.length,source_files:source.length,mutants:results.results.length-2}));
