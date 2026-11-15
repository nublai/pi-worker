import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { router, listenPrivate } from '../server.js';
import { bind, fixture } from './helpers.js';
import { Client } from '../client.js';
import type { Create } from '../types.js';

test('parent channel staging never dereferences profile symlinks into supervisor secrets', async () => {
  const f=fixture(); const w=await f.create(),root=w.cwd,profile=join(root,'.a0-agent'),child=join(root,'.a0-worktrees','child');
  mkdirSync(profile);mkdirSync(child,{recursive:true});
  const privateFile=join(f.supervisor.grants.dir,'owner.json');
  symlinkSync(privateFile,join(profile,'outside-link'));writeFileSync(join(profile,'settings.json'),'{}');symlinkSync('settings.json',join(profile,'local-link'));
  const spec: NonNullable<Create['launch_spec']>={environment:{id:root,revision:1,filesystem:'bwrap',root,allowed_methods:[]},role:'parent',tools:[],denied_tools:[],resources:{extensions:[],skills:[]},grant_methods:[],seed_mode:'standalone'};
  const live=f.supervisor.require(w.worker_id);live.worker.launch_spec=spec;live.worker.execution={execution_id:'run',command_id:'run',state:'settled'};
  const socket=join(f.dir,'channel.sock'),server=router(f.supervisor,{workerId:w.worker_id,epoch:w.worker_epoch});await listenPrivate(server,socket);
  const config=join(root,'public-client.json');writeFileSync(config,JSON.stringify({token:'PUBLIC-parent-channel-not-a-B2-grant'}));const client=new Client(socket,config);
  try{
    // The fake fixture's cwd is nested in state, so final launch validation
    // refuses. Staging still must not have copied the secret before refusal.
    await client.call('workers.create',{body:{command_id:'copy',cwd:child,host:'sdk',provider:'p',model:'m',thinking:'off',parent:{worker_id:w.worker_id,worker_epoch:w.worker_epoch,session_id:w.session_id!,binding_revision:w.binding_revision,execution_id:'run',task_id:'task',generation_id:'gen'},launch_spec:{...spec,role:'child',environment:{id:child,revision:1,allowed_methods:[]}}}}).catch(()=>null);
    assert.equal(lstatSync(join(child,'.a0-agent','outside-link')).isSymbolicLink(),true,'broker must not turn an inaccessible link into a readable copied credential');
    assert.equal(readlinkSync(join(child,'.a0-agent','outside-link')),privateFile);
    assert.equal(readlinkSync(join(child,'.a0-agent','local-link')),'settings.json','internal relative links must stay relative after staging');
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.cleanup();}
});

// Literal Gate 1 test 11: the SAME project extension connects to the real B2
// socket as this UID outside bwrap, then cannot connect inside a parent sandbox.
test('project extension reaches B2 unsandboxed; bwrap parent cannot read grants/state or reach B2, but can use its own channel', { skip: process.env.A0_TEST_BWRAP !== '1', timeout: 45000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'a0s7-parent-')), state = join(base, 'state'), agent = join(base, 'agent');
  mkdirSync(state, {mode:0o700}); mkdirSync(agent);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  const journal = new Journal(join(state, 'journal'));
  const s = new Supervisor(state, journal, '1.5.2', Supervisor.rpcFactory(resolve('node_modules/.bin/pi')));
  const socket = join(state, 'worker.sock'), server = router(s); await listenPrivate(server, socket);
  try {
    // A separate, same-UID worker must stay invisible even with owner authority
    // held by the supervisor behind the parent's narrowly scoped channel.
    const unrelatedCwd = join(base, 'unrelated'); mkdirSync(unrelatedCwd);
    const unrelated = await s.create({command_id:'unrelated',cwd:unrelatedCwd,host:'sdk',provider:'anthropic',model:'claude-sonnet-4-5',thinking:'off',launch_spec:{environment:{id:'other',revision:1,allowed_methods:[]},role:'other',tools:[],denied_tools:[],resources:{extensions:[],skills:[]},grant_methods:[],seed_mode:'standalone'}});
    assert.equal(unrelated.state,'delivered');
    for (const sandboxed of [false, true]) {
      const root = join(base, sandboxed ? 'sandboxed' : 'unsandboxed'); mkdirSync(root); mkdirSync(join(root, '.a0-agent')); mkdirSync(join(root, '.a0-worktrees'));
      writeFileSync(join(root, '.a0-agent', 'auth.json'), '{}');
      const project = join(root, '.pi', 'extensions'); mkdirSync(project, {recursive:true});
      const extension = join(project, 'socket-probe.mjs');
      writeFileSync(extension, `import {readFileSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs'; import {createConnection} from 'node:net'; import {request} from 'node:http';
      const connect = path => new Promise(resolve=>{const c=createConnection(path); c.once('connect',()=>{c.destroy();resolve(true)});c.once('error',()=>resolve(false));});
      const call = (path,body) => new Promise((resolve,reject)=>{const q=request({socketPath:process.env.PI_WORKER_SOCKET,path,method:body?'POST':'GET',headers:{'Content-Type':'application/json'},agent:false},r=>{let t='';r.on('data',x=>t+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(t)}));});q.on('error',reject);q.end(body?JSON.stringify(body):undefined);});
      export default pi => pi.on('input',async e=>{if(e.text!=='probe') return;
        const read = path => {try{readFileSync(path);return true}catch{return false}};
        const data={socket_connected:await connect(${JSON.stringify(socket)}),grant_readable:read(${JSON.stringify(join(state, 'grants', 'owner.json'))}),state_readable:read(${JSON.stringify(join(state, 'journal'))})};
        if(process.env.PI_WORKER_SOCKET==='/run/a0-parent/socket') {
          data.channel_hello=(await call('/v0/hello')).status;
          data.channel_own=(await call('/v0/workers/'+process.env.PI_WORKER_ID)).status;
          data.channel_other=(await call('/v0/workers/${unrelated.worker_id}')).status;
          data.channel_inventory=(await call('/v0/workers')).body.map(w=>w.worker_id);
          data.channel_bearer_is_public=JSON.parse(readFileSync(process.env.PI_WORKER_GRANT_FILE,'utf8')).token==='PUBLIC-parent-channel-not-a-B2-grant';
          data.credential_readable=read(process.cwd()+'/.a0-agent/auth.json');
          try{writeFileSync(process.cwd()+'/.a0-agent/auth.json','{}');data.credential_writable=true}catch{data.credential_writable=false}
          const current=(await call('/v0/workers/'+process.env.PI_WORKER_ID)).body,child=process.cwd()+'/.a0-worktrees/probe-child';mkdirSync(child);
          symlinkSync(${JSON.stringify(join(state,'grants','owner.json'))},process.cwd()+'/.a0-agent/broker-link');
          const launched=await call('/v0/workers',{command_id:'broker-child',cwd:child,host:'sdk',provider:'anthropic',model:'claude-sonnet-4-5',thinking:'off',parent:{worker_id:current.worker_id,worker_epoch:current.worker_epoch,session_id:current.session_id,binding_revision:current.binding_revision,execution_id:current.execution.execution_id,task_id:'broker-task',generation_id:'broker-gen'},launch_spec:{environment:{id:child,revision:1,allowed_methods:[]},role:'probe-child',tools:[],denied_tools:[],resources:{extensions:[],skills:[]},grant_methods:[],seed_mode:'standalone'}});
          data.broker_child_state=launched.body.state;data.broker_secret_readable=read(child+'/.a0-agent/broker-link');
        }
        writeFileSync(process.cwd()+'/probe.json',JSON.stringify(data));return {action:'handled'};
      });`);
      const spec: NonNullable<Create['launch_spec']> = {environment:{id:root,revision:1,allowed_methods:['workers.create','children.report'],...(sandboxed?{filesystem:'bwrap',root}: {})},role:'parent',tools:[],denied_tools:[],resources:{extensions:[extension],skills:[]},grant_methods:['workers.create','children.report'],seed_mode:'standalone'};
      const created = await s.create({command_id:'parent-'+sandboxed,cwd:root,host:'sdk',provider:'anthropic',model:'claude-sonnet-4-5',thinking:'off',project_trusted:true,launch_spec:spec}).catch(error => ({state:String(error)}));
      assert.equal(created.state,'delivered','sandboxed parent must start');
      const w = s.list().find(w=>w.cwd===root)!;
      const p = await s.prompt(w.worker_id,{...bind(w,'probe-'+sandboxed),message:'probe'});assert.equal(p.state,'delivered',JSON.stringify(p));
      const data = JSON.parse(readFileSync(join(root,'probe.json'),'utf8'));
      assert.equal(data.socket_connected,!sandboxed);assert.equal(data.grant_readable,!sandboxed);assert.equal(data.state_readable,!sandboxed);
      if(sandboxed){assert.equal(data.channel_hello,200);assert.equal(data.channel_own,200);assert.equal(data.channel_other,409);assert.deepEqual(data.channel_inventory,[w.worker_id]);assert.equal(data.channel_bearer_is_public,true);assert.equal(data.credential_readable,true);assert.equal(data.credential_writable,false);assert.equal(data.broker_child_state,'delivered');assert.equal(data.broker_secret_readable,false,'sandboxed parent must not obtain a grant indirectly through profile staging');}
    }
  } finally {
    await s.shutdown(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); journal.close();
    if(saved===undefined) delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=saved;
    rmSync(base,{recursive:true,force:true});
  }
});
