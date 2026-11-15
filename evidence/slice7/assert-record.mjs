/** Regression checker for revision-7 evidence shape, independent of capture code. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
let record;try{record=JSON.parse(readFileSync(process.argv[2],'utf8'));}catch(cause){throw new Error('Invalid evidence input; contents withheld',{cause});}
const subject=record.subject,commit=subject.commit_id??subject.commit_sha;
assert.match(commit,/^[a-f0-9]{40,64}$/);
assert.match(subject.tree_id??'',/^[a-f0-9]{40,64}$/,'evidence must bind a native Git tree ID, not diff bytes');
const tree=execFileSync('git',['rev-parse',commit+'^{tree}'],{encoding:'utf8'}).trim();assert.equal(subject.tree_id,tree);
if(subject.diff_digest){assert.equal(subject.diff_digest.advisory,true);assert.match(subject.diff_digest.git_version??'',/^git version \d/);}
assert.ok(record.producer);console.log('REVISION_7_EVIDENCE_VALID');
