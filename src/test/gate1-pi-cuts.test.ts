/** Real Pi leader SIGKILL at each receipt phase. Supervisor stays alive. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Supervisor} from '../supervisor.js';
import {Journal} from '../journal.js';
import {bind,tick} from './helpers.js';

for(const phase of ['intent','accepted','delivered']) test(`real Pi SIGKILL after prompt ${phase} fsync: no duplicate effect or blind replay`,{timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'a0s7-pi-cut-')),cwd=join(root,'workspace'),state=join(root,'state'),agent=join(root,'agent');
  for(const path of [cwd,state,agent])mkdirSync(path,{mode:0o700});
  const extension=join(cwd,'effect.mjs'),effect=join(cwd,'effect');
  writeFileSync(extension,`import {appendFileSync} from 'node:fs';export default pi=>pi.on('input',e=>{if(e.text==='cut'){appendFileSync(${JSON.stringify(effect)},'ONCE\\n');return {action:'handled'}}});`);
  const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agent;
  let journal=new Journal(join(state,'journal')),s=new Supervisor(state,journal,'1.5.2',Supervisor.rpcFactory(resolve('node_modules/.bin/pi')));
  try{
    const created=await s.create({command_id:'create',cwd,host:'sdk',provider:'anthropic',model:'claude-sonnet-4-5',thinking:'off',launch_spec:{environment:{id:'cut',revision:1,allowed_methods:[]},role:'fixture',tools:[],denied_tools:[],resources:{extensions:[extension],skills:[]},grant_methods:[],seed_mode:'standalone'}});assert.equal(created.state,'delivered');
    const w=s.get(created.worker_id!),host=s.require(w.worker_id).host!,exited=new Promise<void>(r=>host.on('exit',r)),append=journal.append.bind(journal);
    let killed=false;
    journal.append=(kind,value)=>{
      append(kind,value);
      if(!killed&&kind==='receipt'&&value.command_id==='cut'&&value.state===phase){assert.ok(host.pid&&host.pid!==process.pid);killed=true;process.kill(host.pid,'SIGKILL');}
    };
    const request={...bind(w,'cut'),message:'cut'},receipt=await s.prompt(w.worker_id,request);
    await exited;await tick();assert.equal(killed,true);
    assert.equal(receipt.state,phase==='delivered'?'delivered':'outcome_unknown');
    assert.equal(Boolean(s.get(w.worker_id).fence),phase!=='delivered');
    const bytes=existsSync(effect)?readFileSync(effect,'utf8'):'';
    assert.equal(bytes,phase==='delivered'?'ONCE\n':'');
    assert.deepEqual(await s.prompt(w.worker_id,request),receipt);
    await s.shutdown();journal.close();let factories=0;
    journal=new Journal(join(state,'journal'));s=new Supervisor(state,journal,'1.5.2',()=>{factories++;throw new Error('must never relaunch on recovery');});await s.recover();
    assert.deepEqual(s.receipts.all.get('cut'),receipt);assert.deepEqual(await s.prompt(w.worker_id,request),receipt);assert.equal(factories,0);
    assert.equal(existsSync(effect)?readFileSync(effect,'utf8'):'',bytes);
    assert.equal(Boolean(s.get(w.worker_id).fence),phase!=='delivered');
    const latest=journal.records.filter(r=>r.kind==='receipt'&&r.value.command_id==='cut').at(-1)!;assert.equal(latest.value.state,receipt.state);
  }finally{await s.shutdown();journal.close();if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;rmSync(root,{recursive:true,force:true});}
});
