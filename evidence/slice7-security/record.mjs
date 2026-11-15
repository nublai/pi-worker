/** Packages the security-fix-round records. Git only through the pinned helper. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {artifactSubject} from '../../dist/artifact.js';
import {readGitPin} from '../../dist/git-safe.js';
const E='evidence/slice7-security',code=process.argv[2],pin=readGitPin(process.cwd()); // owner source checkout
const subject=artifactSubject(process.cwd(),code,'1f38036',pin),base=artifactSubject(process.cwd(),'1f38036',undefined,pin);
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const counts=p=>{const t=readFileSync(p,'utf8'),c={};for(const k of ['tests','pass','fail','skipped'])c[k]=Number(t.match(new RegExp('(?:#|ℹ) '+k+' (\\d+)'))?.[1]);return c;};
const log=(host,name,command)=>({host,name,command,log:name,sha256:sha(E+'/'+name),counts:name.includes('generated')?undefined:counts(E+'/'+name)});
const checks={producer:'slice7-security-fix-round-owner-runner',subject,base_subject:base,checks:[
  log('local','local-default.log','npm test (TMPDIR=/tmp/a0s7f/tmp)'),
  log('local','local-kernel.log','systemd-run --user --property=Delegate=yes ... evidence/slice7/kernel.sh (A0_TEST_BWRAP=1, A0_TEST_CGROUP_DIR)'),
  log('local','local-generated.log','npm run check:generated'),
  log('a0-worker','vm-default.log','npm test (git archive of subject, /tmp/a0s7f/src2)'),
  log('a0-worker','vm-kernel.log','systemd-run --user --property=Delegate=yes ... kernel.sh'),
],platform:{local:{node:'v26.13.0',bwrap:'0.11.1',git:'2.53.0'},vm:{node:'v22.21.1',bwrap:'0.9.0',git:'2.43.0'}},final_a0_units:{local:0,vm:0}};
writeFileSync(E+'/checks.json',JSON.stringify(checks,null,2)+'\n');
const parse=p=>{try{return JSON.parse(readFileSync(p,'utf8'));}catch(cause){throw new Error('Invalid reversion run record: '+p,{cause});}};
const runs=[...parse('/tmp/a0s7f/rev/final/reversions-run.json'),...parse('/tmp/a0s7f/rev/final-git/reversions-run.json')];
for(const r of runs){r.log='reversions/'+r.log;r.diff='reversions/'+r.diff;r.log_sha256=sha(E+'/'+r.log);}
const before=[['before-fix/before-1f38036.log','channel B1 symlink, B1 grant/receipts, B2 refused-copy+race, m1 retry'],['before-fix/probe-a-before-1f38036.log','real bwrap parent symlink escape (PROBE A)'],['before-fix/m1-before-1f38036.log','planted core.fsmonitor via commondir vs pre-fix owner check']].map(([p,what])=>({log:p,sha256:sha(E+'/'+p),what,runtime:base,counts:counts(E+'/'+p)}));
writeFileSync(E+'/reversions.json',JSON.stringify({producer:'slice7-security-isolated-reversion-runner',subject,reversions:runs,killed:runs.filter(r=>r.killed).length,total:runs.length,cross_version_before_fix:before},null,2)+'\n');
console.log(JSON.stringify({subject:{commit_id:subject.commit_id,tree_id:subject.tree_id},killed:runs.filter(r=>r.killed).length,total:runs.length,before:before.map(b=>b.counts)}));
