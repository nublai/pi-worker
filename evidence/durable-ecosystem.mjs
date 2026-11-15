/** Authored isolated compatibility probe. Never imports host configuration or credentials. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
const exec = promisify(execFile), dir = mkdtempSync('/tmp/a0d/ecosystem-');
const agentDir = join(dir, '.pi/agent'); mkdirSync(join(agentDir, 'skills/pstack'), { recursive: true }); mkdirSync(join(agentDir, 'extensions'));
writeFileSync(join(dir, 'AGENTS.md'), 'A0D_AGENTS_SENTINEL: fixture context only.');
const pstackPath = join(homedir(), '.pi/agent/npm/node_modules/pi-herdr-pstack/skills/pstack/setup-pstack/SKILL.md');
const pstackText = readFileSync(pstackPath, 'utf8'); writeFileSync(join(agentDir, 'skills/pstack/SKILL.md'), pstackText);
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'config-only': { baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'fixture-not-a-secret', models: [{ id: 'config-only' }] } } }));
const mcpPath = join(dir, 'mcp-server.mjs');
writeFileSync(mcpPath, `import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline'; appendFileSync(${JSON.stringify(dir + '/mcp-start')},'started\\n'); const lines=createInterface({input:process.stdin}); lines.on('line',l=>{const r=JSON.parse(l); const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:r.method==='tools/list'?{tools:[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:{content:[{type:'text',text:r.params.arguments.text}]};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`);
writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpPath] } } }));
let invoked = false;
function codingAgentExtension(pi) { invoked = true; pi.registerTool({ name: 'native_fixture' }); }
const registry = createRegistry(); registry.install(CodingTools);
registry.install(codingAgentExtension); // JavaScript accepts it as a named object; it never executes the factory.
const models = createModels(), faux = fauxProvider({ provider: 'fixture', models: [{ id: 'm' }] }); models.setProvider(faux.provider);
const h = await Harness.open(new MemoryStorage(), { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd }), settings: { compaction: { enabled: false } } }, ctx);
try {
  const root = await h.root(ctx, { agent: { cwd: dir, model: { provider: 'fixture', modelId: 'm' } } });
  faux.setResponses([fauxAssistantMessage('FIXTURE_OK')]); await (await root.submit({ type: 'input', content: 'Fixture only' }, ctx)).wait(ctx);
  const initial = await root.entries({}, 100, undefined, ctx), agent = await root.agent(ctx);
  const auto = { nativeExtensionInvoked: invoked, tools: agent.tools.map(t => t.name), agentsDiscovered: JSON.stringify(initial).includes('A0D_AGENTS_SENTINEL'), pstackDiscovered: JSON.stringify(initial).includes('setup-pstack'), modelsJsonDiscovered: !!models.getModel('config-only', 'config-only'), mcpStarted: existsSync(dir + '/mcp-start') };
  assert.deepEqual(auto, { nativeExtensionInvoked: false, tools: ['read','write','edit','bash'], agentsDiscovered: false, pstackDiscovered: false, modelsJsonDiscovered: false, mcpStarted: false });
  // Actual installed package module import, not package activation; no factory invocation or configuration mutation.
  const packageAttempts = [];
  for (const [pkg, relative] of [['pi-herdr-agents', 'pi-extension/subagents/index.ts'], ['pi-herdr-pstack','pi-extension/pstack/index.ts']]) {
    const base = join(homedir(), '.pi/agent/npm/node_modules', pkg), metadata = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    const path = join(base, relative);
    const program = `try { const m=await import(${JSON.stringify(path)}); const {createRegistry}=await import('@earendil-works/pi-durable');const r=createRegistry();r.install(m.default);console.log(JSON.stringify({imported:true,registered:r.snapshot().installed().map(e=>({name:e.name,tools:e.tools?.length??0,hooks:e.hooks?.length??0}))})); } catch(e) {console.log(JSON.stringify({imported:false,code:e.code??null,message:e.message.split('\\n')[0]}));}`;
    const output = await exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], { timeout: 10000, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agentDir } });
    packageAttempts.push({ pkg, version: metadata.version, result: JSON.parse(output.stdout) });
  }
  // Explicit minimal ports: prompt sections + a manually connected MCP tool. No discovery implied.
  const { spawn } = await import('node:child_process'); const { createInterface } = await import('node:readline');
  const child = spawn(process.execPath, [mcpPath], { stdio: ['pipe','pipe','inherit'] });
  const lines = createInterface({ input: child.stdout }), waiting = new Map(); let id = 0;
  lines.on('line', text => { const r = JSON.parse(text); waiting.get(r.id)?.(r.result); waiting.delete(r.id); });
  const request = (method, params = {}) => new Promise(resolve => { const rid = ++id; waiting.set(rid, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n'); });
  let manual;
  try {
    await request('initialize'); const listed = await request('tools/list');
    registry.install(defineExtension({ name: 'manual-port', sections: [section('agents', () => readFileSync(join(dir, 'AGENTS.md'), 'utf8')), section('pstack', () => pstackText)],
      tools: [defineTool({ name: 'mcp_echo', description: listed.tools[0].description, parameters: listed.tools[0].inputSchema,
        execute: async args => ({ output: (await request('tools/call', { name: 'echo', arguments: args })).content }) })] }));
    faux.setResponses([fauxAssistantMessage(fauxToolCall('mcp_echo', { text: 'MCP_PORT_OK' }), { stopReason: 'toolUse' }), fauxAssistantMessage('MANUAL_PORT_OK')]);
    await (await root.submit({ type: 'input', content: 'Run fixture tool' }, ctx)).wait(ctx); await root.waitForIdle(ctx);
    const history = await root.entries({}, 100, undefined, ctx);
    manual = { agentsSection: JSON.stringify(history).includes('A0D_AGENTS_SENTINEL'), pstackSection: JSON.stringify(history).includes('setup-pstack'), mcpToolResult: history.items.some(e => e.kind === 'pi.tool-result' && JSON.stringify(e).includes('MCP_PORT_OK')), modelsAdapter: 'src/durable-models.ts; real gateway verified separately' };
    assert(manual.agentsSection && manual.pstackSection && manual.mcpToolResult);
  } finally { const done = new Promise(resolve => child.once('exit', resolve)); child.stdin.end(); await done; lines.close(); }
  console.log(JSON.stringify({ dir, auto, packageAttempts, manual, limitations: 'Synthetic MCP stdio server, not production server/auth; raw package import is not a Pi loader; no package workflow invoked.' }, null, 2));
} finally { await h.close(ctx); }
