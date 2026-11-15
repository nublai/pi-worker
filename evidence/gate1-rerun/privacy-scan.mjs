/** Task-owned final export scan on VM; never logs/hashes credential values. */
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.A0_G1_EXPORT_REVIEW,dest=process.env.A0_G1_PRIVACY_OUT;assert.ok(root&&dest);
function parse(s){try{return JSON.parse(s);}catch(cause){throw new Error('Invalid private scan input; contents withheld',{cause});}}
const secrets=[];
function collect(v,path=''){if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))collect(x,path+'/'+k);else if(typeof v==='string'&&v.length>=12&&/api.?key|token|password|secret/i.test(path)&&!(/^[A-Z][A-Z0-9_]+$/.test(v)))secrets.push(v);}
collect(parse(readFileSync('/tmp/a0g1/run/workspace/.a0-agent/models-store.json','utf8')));
collect(parse(readFileSync('/tmp/a0g1/run/state/grants/orchestrator.json','utf8')));
collect(parse(readFileSync('/tmp/a0g1/run/state/grants/owner.json','utf8')));
for(const n of readdirSync('/tmp/a0g1/run/state/grants'))if(n.startsWith('channel-'))collect(parse(readFileSync('/tmp/a0g1/run/state/grants/'+n,'utf8')));
let files=0,bytes=0;
function scan(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())scan(path);else {const b=readFileSync(path);files++;bytes+=b.length;for(const secret of secrets)assert.equal(b.includes(Buffer.from(secret)),false,'private credential value in export; file withheld');const text=b.toString('utf8');assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|[?&](?:access_token|api_key|signature|token)=[^\s"&]+/i.test(text),false,'credential-like export pattern; file withheld');}}}
scan(root);
// Gate1 rerun: no verification record exists (job failed before verification); bind to the runtime subject.
const verification={subject:{commit_id:'4474a9a8eecda33ba5d0af2c0259554dd56fb431',tree_id:'cabd514c0962de15324a4e2b1f15767a44ee3666'}};
writeFileSync(dest,JSON.stringify({producer:'gate1-final-in-memory-private-value-and-pattern-scanner',subject:{commit_id:verification.subject.commit_id,tree_id:verification.subject.tree_id},clock:new Date().toISOString(),scope:'gate1 rerun whitelisted VM evidence export',files,bytes,known_private_values_compared_in_memory:true,no_credential_value_or_hash_logged:true,credential_patterns_checked:true,pass:true,limitations:['exact-value and pattern scans do not detect every possible transformed/unknown secret','private raw profiles/grants/transcripts not exported']},null,2)+'\n');
console.log(JSON.stringify({files,bytes,pass:true}));
