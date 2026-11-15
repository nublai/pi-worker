import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const R='/tmp/a0s6/run1',P=R+'/profile/npm/node_modules';
function json(p){try{return JSON.parse(readFileSync(p,'utf8'));}catch(cause){throw Error('invalid platform metadata',{cause});}}
const host=P+'/pi-herdr-agents',files=['maestro/core/worker-execution.ts','maestro/adapters/pi/worker-client.ts','maestro/runtime/pi-worker-session.ts','pi-extension/subagents/worker-backend.ts'];
const result={node:process.version,pi:execFileSync('/home/exedev/.local/bin/pi',['--version'],{encoding:'utf8'}).trim(),herdr_version:json(host+'/package.json').version,pstack_version:json(P+'/pi-herdr-pstack/package.json').version,host_experimental_source:'f9e6cc5367dd203e7d32e6b4059aa389f3003a8d',host_source_sha256:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(host+'/'+f)).digest('hex')])),input_bundle_sha256:createHash('sha256').update(readFileSync('/tmp/a0s6/base.bundle')).digest('hex'),output_bundle_sha256:createHash('sha256').update(readFileSync('/tmp/a0s6/out/issue-1.bundle')).digest('hex'),remote_git_transport:'local Git bundle only; no GitHub credential transfer'};
writeFileSync('/tmp/a0s6/out/platform.json',JSON.stringify(result,null,2)+'\n');
