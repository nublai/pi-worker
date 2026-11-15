/** Independent deterministic verification on the VM, never trusts agent success text. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {safeGit,safeGitBuffer} from '/tmp/a0s6/supervisor/dist/git-safe.js';
assert.equal(hostname(),'a0-worker');process.umask(0o077);
const R='/tmp/a0s6/run1', work=R+'/workspace', V=process.env.VERIFY_DIR??'/tmp/a0s6/verify', out='/tmp/a0s6/out';
const base='409bd889289fa3601977411747e0aaccf9a73332';
const hash=x=>createHash('sha256').update(x).digest('hex');
// Security fix round: Git only after a launch-time pin check (A0_S6_PIN file).
// Slice 6 recorded no pin, so this historical verifier refuses to rerun without one.
let pinValue;try{pinValue=process.env.A0_S6_PIN?JSON.parse(process.env.A0_S6_PIN):undefined;}catch(cause){throw new Error('Invalid A0_S6_PIN',{cause});}
const pins=new Map(pinValue?[[work,pinValue]]:[]);
const git=(cwd,...args)=>safeGit(cwd,pins.get(cwd),args);
assert.equal(git(work,'branch','--show-current'),'fix/issue-1');assert.equal(git(work,'status','--porcelain'),'');
const head=git(work,'rev-parse','HEAD');assert.notEqual(head,base);
assert.equal(existsSync(V),false,'verification must use fresh checkout');mkdirSync(V);mkdirSync(out,{recursive:true});
const diff=safeGitBuffer(work,pins.get(work),['diff','--binary',base,head]);
const evidence={schema:'a0-verification-evidence-v1',job_id:'pi-worker-issue-1',producer:{name:'slice6-owner-deterministic-verifier',kind:'independent fresh-checkout command runner',model_family:null,independent_of_agent_success_text:true},subject:{commit_sha:head,base_sha:base,diff_digest:{algorithm:'sha256',definition:'exact git diff --binary BASE COMMIT bytes',value:hash(diff)}},started_at:new Date().toISOString(),environment:{host:'a0-worker',node:process.version},checks:[],limitations:['Throwaway Linux prototype, not production or a Gate 1 freeze.','Default npm test may skip kernel opt-in cases; counts are recorded, not presented as full kernel evidence.','Implementer and tester both use Anthropic Claude Sonnet; no independent-provider model review.','Verification is independent execution and artifact inspection, not hostile same-UID isolation.','No PR, push, merge, deployment or release is authorized. Test 13 draft-PR step remains for root.'],verdict:'incomplete'};
function run(label,cwd,command,args,expected=0){
  const started_at=new Date().toISOString(),t=Date.now();
  const r=spawnSync(command,args,{cwd,env:{...process.env,TMPDIR:'/tmp/a0s6/tmp',npm_config_cache:'/tmp/a0s6/verify-cache'},encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
  const output=(r.stdout??'')+(r.stderr??'');const path=out+'/'+label+'.log';writeFileSync(path,output);
  const row={name:label,command:[command,...args],cwd,started_at,finished_at:new Date().toISOString(),duration_seconds:(Date.now()-t)/1000,exit_code:r.status,signal:r.signal,error:r.error?String(r.error):undefined,expected_exit:expected,pass:r.status===expected,log:{path,sha256:hash(output)}};
  const counts={};for(const key of ['tests','pass','fail','cancelled','skipped','todo']){const m=output.match(new RegExp('^# '+key+' (\\d+)','m'));if(m)counts[key]=Number(m[1]);}if(Object.keys(counts).length)row.counts=counts;
  evidence.checks.push(row);writeFileSync(out+'/verification.json',JSON.stringify(evidence,null,2)+'\n');
  assert.equal(r.status,expected,label+' unexpected status; inspect '+path);return output;
}
try{
  run('clone-head',V,'git',['clone','--no-local',work,V+'/head']);
  run('checkout-head',V+'/head','git',['checkout','--detach',head]);
  run('head-npm-ci',V+'/head','npm',['ci','--ignore-scripts']);
  run('head-npm-test',V+'/head','npm',['test']);
  run('head-generated',V+'/head','npm',['run','check:generated']);
  run('head-npm-test-kernel',V+'/head','systemd-run',['--user','--unit=a0-s6-verify-kernel','--wait','--pipe','--collect','--service-type=exec','--property=Delegate=yes','--setenv=PATH=/home/exedev/.local/node/bin:/usr/bin:/bin','--setenv=A0_VERIFY_HEAD='+V+'/head','/bin/bash','/tmp/a0s6/kernel.sh']);
  assert.equal(git(V+'/head','status','--porcelain'),'','checks must not leave tracked changes');
  run('clone-base',V,'git',['clone','--no-local',work,V+'/base']);
  run('checkout-base',V+'/base','git',['checkout','--detach',base]);
  const test='src/test/issue1-stop.test.ts';assert.ok(existsSync(V+'/head/'+test));copyFileSync(V+'/head/'+test,V+'/base/'+test);
  run('base-npm-ci',V+'/base','npm',['ci','--ignore-scripts']);
  run('base-build-with-new-test',V+'/base','npm',['run','build']);
  const red=run('base-new-regression-red',V+'/base','node',['--test','dist/test/issue1-stop.test.js'],1);
  assert.match(red,/AssertionError|ERR_ASSERTION/,'base red must be assertion failure, not compile/module/timeout');
  assert.match(red,/^# fail [1-9]/m);
  run('head-new-regression-green',V+'/head','node',['--test','dist/test/issue1-stop.test.js']);
  evidence.verdict='verified';evidence.artifact_inspection={clean_fresh_checkout:true,new_regression_compiles_on_base:true,new_regression_fails_base_by_assertion:true,changed_files:git(work,'diff','--name-only',base,head).split('\n')};
}catch(error){evidence.verdict='failed';evidence.failure=String(error);process.exitCode=1;}
finally{evidence.finished_at=new Date().toISOString();writeFileSync(out+'/verification.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({verdict:evidence.verdict,head,checks:evidence.checks.map(c=>({name:c.name,pass:c.pass,counts:c.counts}))},null,2));}
