/** Task-owned final service/source audit; credential checks return booleans only. */
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readGitPin,safeGit,safeGitRun} from '/tmp/a0g1b/runtime/dist/git-safe.js';
const root=process.env.A0_G1_REPO??process.cwd(),dest=process.env.A0_G1_AUDIT_OUT,R=process.env.A0_G1_RUN??'/tmp/a0g1b/run';
assert.ok(dest);
const pin=readGitPin(root); // owner source checkout, never a sandbox root
const git=(...args)=>safeGit(root,pin,args);
const commit_id=git('rev-parse','HEAD'),tree_id=git('rev-parse','HEAD^{tree}');
const units=execFileSync('systemctl',['--user','list-units','a0-*','--all','--no-legend'],{encoding:'utf8'}).trim();assert.equal(units,'');
const files=[];
function walk(dir){for(const e of readdirSync(join(root,dir),{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())walk(path);else files.push({path,sha256:createHash('sha256').update(readFileSync(join(root,path))).digest('hex')});}}
walk('src');for(const path of ['package.json','package-lock.json','tsconfig.json','openapi.json'])files.push({path,sha256:createHash('sha256').update(readFileSync(join(root,path))).digest('hex')});
const record={producer:'gate1-final-service-and-source-audit',subject:{commit_id,tree_id},clock:new Date().toISOString(),node:process.version,git_version:git('--version'),loaded_a0_units:[],source_files:files};
if(root==='/tmp/a0g1b/runtime'){
  const home=process.env.HOME,paths=['.git-credentials','.config/gh/hosts.yml','.config/hub'];
  const credential_files_present=paths.filter(p=>existsSync(join(home,p)));
  const github_credential_env_names=Object.keys(process.env).filter(k=>/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/.test(k)&&process.env[k]);
  let workspacePin;try{workspacePin=JSON.parse(readFileSync(R+'/workspace-pin.json','utf8'));}catch(cause){throw new Error('Invalid workspace pin; contents withheld',{cause});}
  const helper=safeGitRun(R+'/workspace',workspacePin,['config','--get','credential.helper']);
  const store=readFileSync(R+'/workspace/.a0-agent/models-store.json','utf8');
  const github_token_pattern_present=/(?:ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]{20,}/.test(store);
  assert.deepEqual(credential_files_present,[]);assert.deepEqual(github_credential_env_names,[]);assert.equal(helper.status,1);assert.equal(github_token_pattern_present,false);
  record.credential_boundary={checked_standard_credential_file_paths:paths,credential_files_present:[],github_credential_env_names:[],git_credential_helper_configured:false,github_token_pattern_in_staged_store:false,transferred_github_credentials:false,limitations:'standard mechanisms/patterns only; not an exhaustive VM filesystem credential search'};
}
writeFileSync(dest,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({subject:record.subject,loaded_a0_units:0,source_files:files.length}));
