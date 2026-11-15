/** Dedicated library subprocess. Stdout is protocol only; third-party logs go to stderr.
 * A0 ACP profile: ACP v1 initialize/new/prompt/cancel/update/permission, negotiated
 * _pi extensions for lossless dialogs, early admission, exact resolver acks and tree. */
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager, getAgentDir, createCodemodeExtension, createToolSearchExtension, createMcpExtension,
  type ExtensionUIContext, type AgentSession, type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { Resolvers, type UIAnswer } from './resolvers.js';
import { requestHash } from './receipts.js';
import type { PiRecord } from './host.js';
import { GrantStore } from './grants.js';
const [protocol, sessionDir, provider, modelId, thinking, projectTrusted] = process.argv.slice(2);
const acp = protocol === 'acp';
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
console.log = (...args) => console.error(...args);
let current: AgentSession | undefined;
const nativeKinds = new Map<string, string>();
function emit(event: PiRecord): void {
  if (!acp) { output(event); return; }
  const sessionId = current?.sessionId ?? '';
  if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'tool_approval'].includes(String(event.method))) {
    nativeKinds.set(String(event.id), String(event.method));
    output({ jsonrpc: '2.0', id: event.id, method: event.method === 'tool_approval' ? 'session/request_permission' : '_pi/dialog', params: { sessionId, ...(event.method === 'tool_approval' ? { toolCall: { toolCallId: event.id, title: 'bash approval', kind: 'execute', status: 'pending' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }] } : {}), _meta: { piEvent: event } } });
  } else if (event.type === 'message_update' && (event.assistantMessageEvent as { type?: string })?.type === 'text_delta') {
    output({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (event.assistantMessageEvent as { delta: string }).delta } }, _meta: { piEvent: event } } });
  } else {
    output({ jsonrpc: '2.0', method: '_pi/event', params: { sessionId, event } });
  }
}
const resolvers = new Resolvers(emit);
const noOp = () => {};
const uiMethods = {
  select: (title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }) => resolvers.ask('select', { title, options }, opts),
  confirm: (title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }) => resolvers.ask('confirm', { title, message }, opts),
  input: (title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal }) => resolvers.ask('input', { title, placeholder }, opts),
  editor: (title: string, prefill?: string) => resolvers.ask('editor', { title, prefill }),
  notify: (message: string, notifyType = 'info') => emit({ type: 'extension_ui_request', method: 'notify', message, notifyType }),
  custom: async () => { emit({ type: 'unsupported_ui', kind: 'custom', reason: 'headless_form_required' }); throw new Error('unsupported_custom_ui'); },
  onTerminalInput: () => noOp, getEditorText: () => '', getAllThemes: () => [], getToolsExpanded: () => false,
  getTheme: () => undefined, getEditorComponent: () => undefined,
  setTheme: () => ({ success: false, error: 'headless_theme_unsupported' }),
};
// Non-dialog presentation is intentionally inert; custom() above fails explicitly.
// SAFETY: All dialog methods above obey ExtensionUIContext results; remaining members
// are presentation-only no-ops in this headless profile, supplied by the Proxy.
const ui = new Proxy(uiMethods, { get: (target, key) => key in target ? target[key as keyof typeof target] : key === 'theme' ? new Proxy({}, { get: () => (...args: unknown[]) => args.at(-1) }) : noOp }) as unknown as ExtensionUIContext;
type Gate = { digest: string; policy_revision: string; expiry: number; gate_token: string; operation: string; resource: string; environment: string; offered_scope: string };
type ReleaseGrant = { state_dir: string; grant_id: string; actor: string; worker_id: string; cwd: string };
const gates = new Map<string, { binding: Gate; proof?: ReleaseGrant; resolve: (allowed: boolean) => void; acknowledge?: (data: Record<string, unknown>) => void }>();
function policy(): { revision: string; expiry: number; releaseDelayMs?: number } {
  try { const p = JSON.parse(readFileSync(join(process.cwd(), '.a0-gate-policy'), 'utf8')); if (typeof p.revision !== 'string' || !Number.isSafeInteger(p.expiry)) throw new Error('invalid_policy'); return p; }
  catch { throw new Error('gate_policy_unavailable'); }
}
const gateExtension: ExtensionFactory = pi => {
  pi.on('tool_call', async (event) => {
    if (event.toolName !== 'bash') return;
    if (!existsSync(join(process.cwd(), '.a0-gate-policy'))) return; // Opt-in specimen, not a sandbox.
    let p; try { p = policy(); } catch { return { block: true, reason: 'invalid_gate_policy' }; }
    const binding: Gate = { digest: requestHash(event.input), policy_revision: p.revision, expiry: p.expiry, gate_token: randomUUID(), operation: 'bash', resource: process.cwd(), environment: process.cwd(), offered_scope: 'once' };
    const allowed = await resolvers.ask('tool_approval', { title: 'A0 typed bash approval', approval: binding }, { timeout: Math.min(30000, p.expiry - Date.now()) });
    if (!allowed) return { block: true, reason: 'approval_not_allowed' };
    const released = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { gates.delete(binding.gate_token); resolve(false); }, 10000); timer.unref();
      gates.set(binding.gate_token, { binding, resolve: value => { clearTimeout(timer); resolve(value); } });
      const request = () => emit({ type: 'gate_check', ...binding });
      if (p.releaseDelayMs) setTimeout(request, Math.min(5000, p.releaseDelayMs)).unref(); else request();
    });
    // Gate owns final artifact/policy/expiry validation, not the dialog title.
    let currentPolicy; try { currentPolicy = policy(); } catch { currentPolicy = undefined; }
    let grantValid = false;
    const proof = gates.get(binding.gate_token)?.proof;
    try { if (proof) { new GrantStore(proof.state_dir).checkIdentity(proof.grant_id, proof.actor, proof); grantValid = true; } } catch { /* Revocation/expiry at the exact release point denies. */ }
    const valid = Boolean(released && grantValid && currentPolicy && binding.digest === requestHash(event.input) && binding.policy_revision === currentPolicy.revision && binding.expiry === currentPolicy.expiry && Date.now() < binding.expiry);
    const gate = gates.get(binding.gate_token); gates.delete(binding.gate_token);
    // No await between final validation, acknowledgement and returning permission.
    // Stage 4 is this gate's release, never the bash process or effect completion.
    gate?.acknowledge?.({ released: valid });
    if (!valid) return { block: true, reason: 'approval_binding_invalid_at_release' };
    emit({ type: 'gate_released', gate_token: binding.gate_token });
    return undefined;
  });
};
const runtimePromise = createAgentSessionRuntime(async options => {
  const services = await createAgentSessionServices({ ...options, settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: projectTrusted === 'true' }), resourceLoaderOptions: { extensionFactories: [
    { name: 'codemode', builtin: true, factory: createCodemodeExtension() },
    { name: 'tool_search', builtin: true, factory: createToolSearchExtension() },
    { name: 'mcp', builtin: true, factory: createMcpExtension() }, gateExtension,
  ] } });
  const model = services.modelRuntime.getModel(provider!, modelId!);
  if (!model) throw new Error('configured_model_not_found');
  const created = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model, thinkingLevel: thinking as 'off' });
  return { ...created, services, diagnostics: services.diagnostics };
}, { cwd: process.cwd(), agentDir: getAgentDir(), sessionManager: SessionManager.create(process.cwd(), sessionDir) });
async function bind(session: AgentSession): Promise<void> {
  current = session;
  emit({ type: 'host_identity', sessionId: session.sessionId, sessionFile: session.sessionFile });
  // SAFETY: SDK events are plain records with a string type, the host seam's only requirement.
  session.subscribe(event => {
    emit(event as unknown as PiRecord);
    if (event.type === 'entry_appended' || event.type === 'agent_settled') emit({ type: 'host_leaf', leafId: session.sessionManager.getLeafId() });
  });
  await session.bindExtensions({ uiContext: ui, mode: 'rpc', abortHandler: () => { resolvers.abortAll(); void session.abort(); }, onError: error => emit({ type: 'extension_error', path: error.extensionPath, event: error.event, error: error.error }), shutdownHandler: () => { void shutdown(); } });
}
const ready = runtimePromise.then(async runtime => { runtime.setBeforeSessionInvalidate(() => resolvers.abortAll()); runtime.setRebindSession(bind); await bind(runtime.session); return runtime; });
// Drain commands concurrently: startup bind and prompt may be waiting on a dialog.
async function command(c: PiRecord, reply: (data: Record<string, unknown>) => void): Promise<void> {
  if (c.type === 'answer_ui') { reply(resolvers.answer(String(c.nativeId), c.answer as UIAnswer)); return; }
  if (c.type === 'gate_release') {
    const gate = gates.get(String(c.gate_token));
    if (!gate) { reply({ released: false }); return; }
    let p; try { p = policy(); } catch { p = undefined; }
    const valid = c.allowed === true && p && gate.binding.policy_revision === p.revision && gate.binding.expiry === p.expiry && Date.now() < p.expiry && c.digest === gate.binding.digest;
    gate.proof = c.release_grant as ReleaseGrant | undefined; gate.acknowledge = reply; gate.resolve(Boolean(valid)); return;
  }
  if (c.type === 'abort') { resolvers.abortAll(); for (const gate of gates.values()) gate.resolve(false); gates.clear(); }
  const runtime = await ready, session = runtime.session;
  switch (c.type) {
    case 'get_state': reply({ sessionId: session.sessionId, sessionFile: session.sessionFile, leafId: session.sessionManager.getLeafId() }); break;
    case 'inventory': {
      const loader = runtime.services.resourceLoader;
      reply({ extensions: loader.getExtensions().extensions.map(e => e.path), extension_errors: loader.getExtensions().errors.map(e => e.path), skills: loader.getSkills().skills.map(s => ({ name: s.name, path: s.filePath })), tools: session.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })), active_tools: session.getActiveToolNames() }); break;
    }
    case 'prompt': await session.prompt(String(c.message), { preflightResult: disposition => reply({ disposition }) }); break;
    case 'abort': await session.abort(); reply({}); break;
    case 'clear_queue': session.clearQueue(); reply({}); break;
    case 'navigate': reply(await session.navigateTree(String(c.entryId), { summarize: false })); break;
    case 'new_session': reply(await runtime.newSession()); break;
    case 'switch_session': reply(await runtime.switchSession(String(c.sessionPath))); break;
    case 'fork': reply(await runtime.fork(String(c.entryId))); break;
    case 'get_tree': reply({ tree: session.sessionManager.getTree() }); break;
    default: throw new Error('unsupported_sdk_command');
  }
}
let initialized = false;
async function handle(r: Record<string, unknown>): Promise<void> {
  if (!acp) {
    try { await command(r as PiRecord, data => output({ type: 'response', id: r.id, success: true, data })); }
    catch { output({ type: 'response', id: r.id, success: false, error: 'sdk_command_failed' }); }
    return;
  }
  const result = (data: unknown) => output({ jsonrpc: '2.0', id: r.id, result: data });
  try {
    if (r.jsonrpc !== '2.0') throw new Error('invalid_jsonrpc');
    if ('result' in r) {
      const data = r.result as { _meta?: { piAnswer?: UIAnswer; ackId?: string } };
      if (!nativeKinds.has(String(r.id)) || !data._meta?.piAnswer || !data._meta.ackId) throw new Error('profile_response_required');
      nativeKinds.delete(String(r.id));
      const consumed = resolvers.answer(String(r.id), data._meta.piAnswer);
      output({ jsonrpc: '2.0', method: '_pi/consumed', params: { id: data._meta.ackId, data: consumed } }); return;
    }
    const p = r.params as Record<string, unknown>;
    if (r.method === 'initialize') {
      if (p.protocolVersion !== 1 || (p._meta as Record<string, unknown>)?.piWorkerProfile !== 1) throw new Error('pi_profile_required');
      initialized = true; result({ protocolVersion: 1, agentInfo: { name: 'a0-pi-sdk-adapter', version: '0.3.0' }, agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: {} }, _meta: { piWorkerProfile: 1, resolverAck: true } }); return;
    }
    if (!initialized) throw new Error('initialize_required');
    if (r.method === 'session/new') {
      if (p.cwd !== process.cwd() || !Array.isArray(p.mcpServers) || p.mcpServers.length) throw new Error('fixed_cwd_no_client_mcp');
      const rt = await ready; result({ sessionId: rt.session.sessionId }); return;
    }
    if (r.method === 'session/prompt') {
      const rt = await ready;
      if (p.sessionId !== rt.session.sessionId || !Array.isArray(p.prompt) || p.prompt.some(x => x.type !== 'text')) throw new Error('invalid_prompt');
      await command({ type: 'prompt', message: p.prompt.map(x => x.text).join('\n') }, data => output({ jsonrpc: '2.0', method: '_pi/admitted', params: { id: r.id, data } }));
      result({ stopReason: 'end_turn' }); return;
    }
    if (r.method === 'session/cancel') { if (p.sessionId !== current?.sessionId) throw new Error('wrong_session'); await command({ type: 'abort' }, noOp); return; }
    if (r.method === '_pi/command') { await command(p.command as PiRecord, result); return; }
    throw new Error('method_not_found');
  } catch { if ('id' in r) output({ jsonrpc: '2.0', id: r.id, error: { code: -32602, message: 'unsupported_or_invalid_a0_profile_request' } }); }
}
const decoder = new StringDecoder('utf8'); let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += decoder.write(chunk);
  if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { void shutdown(); return; }
  for (;;) { const n = buffer.indexOf('\n'); if (n < 0) break; const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); try { void handle(JSON.parse(line)); } catch { /* malformed record refused without data echo */ } }
});
async function shutdown(): Promise<void> { resolvers.abortAll(); for (const gate of gates.values()) gate.resolve(false); gates.clear(); try { await (await runtimePromise).dispose(); } finally { process.exit(0); } }
process.stdin.on('end', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
ready.catch(() => { console.error('sdk_initialization_failed'); process.exit(1); });
