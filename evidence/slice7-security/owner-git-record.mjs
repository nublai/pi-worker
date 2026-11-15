/** Packages the owner-Git follow-up records. Git only through the pinned helper.
 * Usage (owner source checkout): node evidence/slice7-security/owner-git-record.mjs RUNTIME_COMMIT */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {artifactSubject} from '../../dist/artifact.js';
import {readGitPin} from '../../dist/git-safe.js';
const E='evidence/slice7-security',code=process.argv[2],pin=readGitPin(process.cwd());
if(!code)throw new Error('usage: owner-git-record.mjs RUNTIME_COMMIT');
const subject=artifactSubject(process.cwd(),code,'a8d1357',pin);
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const counts=p=>{const t=readFileSync(p,'utf8'),c={};for(const k of ['tests','pass','fail','skipped'])c[k]=Number(t.match(new RegExp('ℹ '+k+' (\\d+)'))?.[1]);return c;};
const log=(name,command)=>({host:'local',name,command,log:name,sha256:sha(E+'/'+name),counts:counts(E+'/'+name)});
let runs;try{runs=JSON.parse(readFileSync(E+'/reversions/owner-git-reversions-run.json','utf8'));}catch(cause){throw new Error('Invalid owner-git reversion record',{cause});}
for(const r of runs){r.log='reversions/'+r.log;r.diff='reversions/'+r.diff;r.log_sha256=sha(E+'/'+r.log);}
const before='before-fix/owner-git-before-a8d1357.log';
const record={producer:'slice7-security-owner-git-follow-up',review:'nubl/.pi/plan/research/a0-slice7-security-delta.md (local planning file)',subject,
  checks:[log('owner-git-local-default.log','npm test (TMPDIR=/tmp/a0s7g/tmp)'),log('owner-git-local-kernel.log','systemd-run --user --unit=a0-s7g-kernel --property=Delegate=yes ... evidence/slice7/kernel.sh (A0_TEST_BWRAP=1, A0_TEST_CGROUP_DIR, TMPDIR=/tmp/a0s7g/tmp)')],
  before_fix:{log:before,sha256:sha(E+'/'+before),runtime:'a8d1357 src/git-safe.ts with the new owner-git tests',counts:counts(E+'/'+before)},
  reversions:runs,killed:runs.filter(r=>r.killed).length,total:runs.length,
  platform:{node:process.version,bwrap:'0.11.1',git:subject.diff_digest.git_version},final_a0_units:0};
writeFileSync(E+'/owner-git-checks.json',JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({subject:{commit_id:subject.commit_id,tree_id:subject.tree_id},checks:record.checks.map(c=>c.counts),before:record.before_fix.counts,killed:record.killed,total:record.total}));
