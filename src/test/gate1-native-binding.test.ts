import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../supervisor.js';
import { Journal } from '../journal.js';
import { bind } from './helpers.js';

for (const host of ['sdk', 'acp', 'rpc'] as const) test(`${host}: extension native tree/new/fork/resume bumps binding without B2 rebind`, { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'a0s7-native-')), cwd = join(root, 'workspace'), state = join(root, 'state'), agent = join(root, 'agent');
  for (const dir of [cwd, state, agent]) mkdirSync(dir);
  const extension = join(cwd, 'native.mjs');
  writeFileSync(extension, `import {writeFileSync,readFileSync} from 'node:fs';
export default pi => {
  pi.on('input', e => e.text === 'noop' ? {action:'handled'} : undefined);
  pi.registerCommand('native', {handler: async (args, ctx) => {
    const cwd = ctx.cwd;
    if(args === 'seed') { await ctx.newSession({setup: async sm => {
      sm.appendMessage({role:'user',content:'fixture',timestamp:Date.now()});
      sm.appendMessage({role:'assistant',content:[{type:'text',text:'fixture'}],api:'anthropic-messages',provider:'anthropic',model:'claude-sonnet-4-5',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
      sm.appendCustomEntry('after',{});
      writeFileSync(cwd+'/seed-file', sm.getSessionFile());
    }}); }
    if(args === 'tree' || args === 'fork') {
      const target=ctx.sessionManager.getEntries().find(e=>e.type==='message' && e.message.role==='assistant').id;
      if(args==='tree') await ctx.navigateTree(target,{summarize:false}); else await ctx.fork(target,{position:'at'});
    }
    if(args === 'append') pi.appendEntry('native-append', {});
    if(args === 'new') await ctx.newSession();
    if(args === 'resume') await ctx.switchSession(readFileSync(ctx.cwd+'/seed-file','utf8'));
  }});
};`);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  const journal = new Journal(join(state, 'journal'));
  const s = new Supervisor(state, journal, '1.5.2', Supervisor.rpcFactory(resolve('node_modules/.bin/pi')));
  try {
    const receipt = await s.create({ command_id: 'create', cwd, host, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', launch_spec: { environment: { id: 'native', revision: 1, allowed_methods: [] }, role: 'test', tools: [], denied_tools: [], resources: { extensions: [extension], skills: [] }, grant_methods: [], seed_mode: 'standalone' } });
    assert.equal(receipt.state, 'delivered', JSON.stringify(receipt));
    const id = receipt.worker_id!, native = s.require(id).host!, pid = native.pid;
    for (const action of ['seed', 'tree', 'append', 'fork', 'new', 'resume']) {
      const before = s.get(id);
      const reply = await native.request({ type: 'prompt', message: '/native ' + action });
      assert.equal(reply.success, true, 'native command runs without model call');
      await native.request({type:'get_state'}); // stdout barrier after the native command finishes
      const after = s.get(id);
      assert.equal(after.status, 'ready', action);
      assert.equal(after.binding_revision, before.binding_revision + (action === 'append' ? 0 : 1), action);
      assert.equal(native.pid, pid);
      if (action !== 'append') await assert.rejects(s.prompt(id, { ...bind(before, 'stale-' + action), message: 'noop' }), /stale_binding/);
      const current = await native.request({type:'get_state'});
      assert.equal(after.session_id, current.data?.sessionId);
      const tree = host === 'rpc' ? await native.request({type:'get_tree'}) : current;
      assert.equal(after.leaf_id, tree.data?.leafId);
    }
  } finally {
    await s.shutdown(); journal.close();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    rmSync(root, {recursive:true,force:true});
  }
});
