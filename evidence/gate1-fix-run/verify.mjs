/** Task-owned independent fresh-checkout verifier. Does not trust model success. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {artifactSubject} from '/tmp/a0g1b/runtime/dist/artifact.js';
import {readGitPin,checkGitPin,safeGit,SAFE_GIT_CONFIG} from '/tmp/a0g1b/runtime/dist/git-safe.js';
const R=process.env.A0_G1_RUN??'/tmp/a0g1b/run',V=process.env.A0_G1_VERIFY??'/tmp/a0g1b/verify',out=process.env.A0_G1_OUT??'/tmp/a0g1b/out';mkdirSync(V,{recursive:true});mkdirSync(out,{recursive:true});
const json=s=>{try{return JSON.parse(s);}catch(cause){throw new Error('Invalid private verification JSON',{cause});}};
const frozen=json(readFileSync(R+'/freeze.json','utf8')),job=json(readFileSync(R+'/job.json','utf8'));
const subject=frozen.subject,checks=[];
// Launch-time pins: the owner's setup pin for the workspace; a fresh clone is
// pinned immediately after the owner creates it, before any of its code runs.
const pins=new Map([[R+'/workspace',json(readFileSync(R+'/workspace-pin.json','utf8'))]]);
const git=(cwd,...args)=>safeGit(cwd,pins.get(cwd),args);
assert.deepEqual(artifactSubject(R+'/workspace','HEAD',job.base,pins.get(R+'/workspace')),subject);
const changed=git(R+'/workspace','diff','--name-only',job.base,subject.commit_id).split('\n').sort();
assert.deepEqual(changed,['README.md','evidence/gate1-job/verify.mjs']);
assert.ok(readFileSync(R+'/workspace/README.md','utf8').includes('- '+job.note));
// Inspect, rather than execute, the model-authored checker. The independent
// owner check above reads exact bytes; npm suites below are user-authorized.
const script=readFileSync(R+'/workspace/evidence/gate1-job/verify.mjs','utf8');assert.ok(script.includes(job.note));assert.ok(script.includes('assert'));
function run(name,command,cwd,extra={}){
  const start=new Date(),p=spawnSync(command[0],command.slice(1),{cwd,env:{...process.env,...extra},encoding:'utf8',timeout:420000,maxBuffer:32*1024*1024});
  const text=(p.stdout??'')+(p.stderr??''),log=out+'/'+name+'.log';writeFileSync(log,text);
  const counts={};for(const key of ['tests','pass','fail','skipped']){const m=text.match(new RegExp('(?:#|ℹ) '+key+' (\\d+)'));if(m)counts[key]=Number(m[1]);}
  const row={producer:'gate1-owner-fresh-checkout-command-runner',subject,command,cwd,started_at:start.toISOString(),duration_seconds:(Date.now()-start.getTime())/1000,exit_code:p.status,signal:p.signal,pass:p.status===0,log:{path:log,sha256:createHash('sha256').update(text).digest('hex')},counts};checks.push(row);if(!row.pass)throw new Error(name+' failed; private log retained');
}
checkGitPin(R+'/workspace',pins.get(R+'/workspace'));// SAFE_GIT_CONFIG sets protocol.allow=never; re-allow only the local file transport for this one clone.
run('clone',['git',...SAFE_GIT_CONFIG,'-c','protocol.file.allow=always','clone','--no-local',R+'/workspace',V+'/head'],V);pins.set(V+'/head',readGitPin(V+'/head'));
checkGitPin(V+'/head',pins.get(V+'/head'));run('checkout',['git',...SAFE_GIT_CONFIG,'checkout','--detach',subject.commit_id],V+'/head');
run('npm-ci',['npm','ci','--ignore-scripts'],V+'/head');
run('npm-test',['npm','test'],V+'/head');
run('generated',['npm','run','check:generated'],V+'/head');
run('npm-test-kernel',['systemd-run','--user','--unit=a0-g1b-artifact-kernel','--wait','--pipe','--collect','--service-type=exec','--property=Delegate=yes','--setenv=PATH='+process.env.PATH,'--setenv=A0_G1_REPO='+V+'/head','--setenv=TMPDIR=/tmp/a0g1b/tmp','--setenv=npm_config_cache=/tmp/a0g1b/npm-cache','/bin/bash','/tmp/a0g1b/kernel.sh'],V+'/head');
assert.equal(git(V+'/head','status','--porcelain'),'');assert.deepEqual(artifactSubject(V+'/head','HEAD',job.base,pins.get(V+'/head')),subject);
const evidence={schema:'a0-verification-evidence-v2',job_id:'gate1-owner-git-snapshot-note',producer:{name:'gate1-owner-deterministic-verifier',kind:'fresh-checkout runner; exact README bytes and Git state inspected independently of agent text',model_family:null},subject,checks,result:'verified',limitations:['No PR/push/merge; same-family check author is not independent-provider review.','Model-authored checker inspected, not executed by owner; parent execution separately audited.','Process/SIGKILL and bwrap Linux evidence, not physical power-loss, network confinement, or hostile same-UID proof.']};
writeFileSync(out+'/verification.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({result:evidence.result,subject,checks:checks.map(c=>({name:c.command.join(' '),pass:c.pass,counts:c.counts}))}));
