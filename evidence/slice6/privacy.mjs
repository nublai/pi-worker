/** Checks known private VM credential values in memory; never logs values or their hashes. */
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const R='/tmp/a0s6/run1',O='/tmp/a0s6/out';
const privateFiles=[...readdirSync(R+'/state/grants').map(n=>R+'/state/grants/'+n),...['auth.json','models-store.json','exe-dev-llm-integration.json'].map(n=>R+'/profile/'+n).filter(existsSync)];
const values=new Set();
function collect(x,key=''){if(typeof x==='string'){if(/key|token|secret|password|authorization/i.test(key)&&x.length>=16)values.add(x);}else if(x&&typeof x==='object')for(const [k,v]of Object.entries(x))collect(v,k);}
for(const p of privateFiles){try{collect(JSON.parse(readFileSync(p,'utf8')));}catch(cause){throw Error('invalid private scan source',{cause});}}
const checked=[];let matches=0;
function scan(label,bytes){checked.push(label);const s=bytes.toString('utf8');for(const value of values)if(s.includes(value))matches++;if(/https?:\/\/[^\s"<>]+[?&](?:token|api[_-]?key|signature|password|secret|auth)=/i.test(s))matches++;if(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(s))matches++;}
for(const n of readdirSync(O).filter(n=>/\.(json|log|diff)$/.test(n)))scan(n,readFileSync(O+'/'+n));
for(const n of readdirSync('/tmp/a0s6').filter(n=>/\.(mjs|sh|md)$/.test(n)))scan('harness/'+n,readFileSync('/tmp/a0s6/'+n));
const git=(...args)=>execFileSync('git',['-C',R+'/workspace',...args]);
for(const n of git('diff','--name-only','409bd88','HEAD').toString('utf8').trim().split('\n'))scan('commit/'+n,git('show','HEAD:'+n));
assert.equal(matches,0,'credential-pattern/value matches exist; no values are printed');
writeFileSync(O+'/privacy.json',JSON.stringify({clock:new Date().toISOString(),pass:true,checked,known_private_value_scan:true,credential_url_pattern_scan:true,github_token_pattern_scan:true,raw_private_profiles_and_sessions_exported:false,limitations:['Exact-value scan uses known run grant/provider-profile fields; not a general secret classifier.','Ancestors from the input bundle were previously reviewed; only new changed Git files are scanned here.']},null,2)+'\n');
console.log(JSON.stringify({privacy_pass:true,files:checked.length}));
