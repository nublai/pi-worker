/**
 * The pi process: pi's SDK (pinned in this package) in a dedicated Node process, driven by the supervisor over one
 * plain LF JSON protocol on stdin and stdout (host/host.ts). Rewritten from A0 `src/sdk-child.ts` without the ACP
 * framing or `_pi/*` extensions. Stdout is protocol only; console output and third-party logs go to stderr.
 *
 * It keeps from A0: the headless UI context whose dialogs go through exact resolvers (resolvers.ts); the native
 * binding observer (`host_identity` once, then `host_binding` for every native move, `host_binding_changing` before
 * the old session is invalidated, `host_leaf` after appends and before settlement); and admission replies from pi's
 * prompt preflight (`started`, `handled`, `queued`), which are not settlement (`agent_settled` is an event).
 *
 * The tool gate (stage 4), opt-in per extension: an extension that wants a tool call approved holds it in its own
 * `tool_call` handler and emits TOOL_GATE_CHANNEL on pi's event bus with the approval it binds (artifact digest,
 * policy revision, expiry, operation, resource, environment, offered scope) and a `respond` callback. This child then
 * opens a typed `tool_approval` through an exact resolver (stages 1 to 3 at the supervisor), asks the supervisor for
 * the release with `gate_check`, and on `gate_release` revalidates (the supervisor allowed it, no binding move since,
 * not expired, the extension's own `recheck` of its artifact and policy) before it acknowledges `released` and calls
 * `respond`, with no await in between. Anything else (no answer, a No, a timeout, a move, a denial) responds false.
 * Every gate ends with exactly one terminal notification to the supervisor: `gate_released` after a release, and
 * `gate_closed` (with its reason) before any `respond(false)`, so the supervisor settles the approval even when no
 * release was ever asked for (a No, a cancel, an expiry after consumption, a move, a release that never came).
 * Without an extension that uses the seam, no tool is gated: the specimen policy of A0 is not ported.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { Resolvers, type PiEvent, type UIAnswer } from './resolvers.js';

type LaunchSpec = { tools: string[]; denied_tools: string[]; resources: { extensions: string[]; skills: string[] } };
/**
 * `launchSpec`: a typed child gets its explicit tools, denials and resources, and nothing discovered (P1-11).
 * `inventory`: no session at all; load the cwd's settings and resources, answer `features`, and exit (P1-14).
 */
type Launch = { sessionDir: string; provider: string; model: string; thinking: string; projectTrusted: boolean; launchSpec?: LaunchSpec | null; inventory?: boolean };
let launch: Launch;
try {
  launch = JSON.parse(process.argv[2] ?? '') as Launch;
  if (launch.inventory !== true && (typeof launch.sessionDir !== 'string' || typeof launch.provider !== 'string' || typeof launch.model !== 'string')) throw new Error('launch');
} catch {
  console.error('invalid_launch');
  process.exit(1);
}

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
console.log = (...args: unknown[]) => console.error(...args);
const emit = (event: PiEvent): void => output(event);

const resolvers = new Resolvers(emit);
const noOp = () => {};
type DialogOptions = { timeout?: number; signal?: AbortSignal };
const uiMethods = {
  select: (title: string, options: string[], opts?: DialogOptions) => resolvers.ask('select', { title, options }, opts),
  confirm: (title: string, message: string, opts?: DialogOptions) => resolvers.ask('confirm', { title, message }, opts),
  input: (title: string, placeholder?: string, opts?: DialogOptions) => resolvers.ask('input', { title, placeholder }, opts),
  editor: (title: string, prefill?: string) => resolvers.ask('editor', { title, prefill }),
  notify: (message: string, notifyType = 'info') => emit({ type: 'extension_ui_request', method: 'notify', message, notifyType }),
  custom: async () => {
    emit({ type: 'unsupported_ui', kind: 'custom', reason: 'headless_form_required' });
    throw new Error('unsupported_custom_ui');
  },
  onTerminalInput: () => noOp,
  getEditorText: () => '',
  getAllThemes: () => [],
  getToolsExpanded: () => false,
  getTheme: () => undefined,
  getEditorComponent: () => undefined,
  setTheme: () => ({ success: false, error: 'headless_theme_unsupported' }),
};
// SAFETY: every dialog method above obeys ExtensionUIContext's result contract; the remaining members are
// presentation-only no-ops in this headless profile, supplied by the Proxy (custom() fails explicitly above).
const ui = new Proxy(uiMethods, {
  get: (target, key) =>
    key in target ? target[key as keyof typeof target] : key === 'theme' ? new Proxy({}, { get: () => (...args: unknown[]) => args.at(-1) }) : noOp,
}) as unknown as ExtensionUIContext;

/** The event-bus channel of the tool gate seam (see the module comment). */
const TOOL_GATE_CHANNEL = 'pi-worker:tool-gate';
/** How long a consumed approval waits for the supervisor's `gate_release` before the gate denies. */
const GATE_RELEASE_TIMEOUT_MS = 10_000;
const APPROVAL_FIELDS = ['digest', 'policy_revision', 'operation', 'resource', 'environment', 'offered_scope'] as const;
type Approval = { digest: string; policy_revision: string; expiry: number; operation: string; resource: string; environment: string; offered_scope: string };
type GateRequest = { approval: Approval; title?: string; recheck?: () => boolean; respond: (released: boolean) => void };
type Acknowledge = (data: Record<string, unknown>) => void;
type Decision = { allowed: boolean; acknowledge?: Acknowledge; reason: string };
const gates = new Map<string, { binding: Approval & { gate_token: string }; settle: (allowed: boolean, acknowledge?: Acknowledge) => void }>();
/** Bumped by every binding move: a gate opened before it never releases after it. */
let bindingGeneration = 0;

/** A binding move invalidates every live dialog and gate: no old answer or release may land in the new session. */
function cancelAll(): void {
  bindingGeneration++;
  resolvers.abortAll();
  for (const gate of [...gates.values()]) gate.settle(false);
  gates.clear();
}

function isApproval(value: unknown): value is Approval {
  const a = value as Approval;
  return !!a && typeof a === 'object' && APPROVAL_FIELDS.every(k => typeof a[k] === 'string' && a[k].length > 0 && a[k].length <= 4096) && Number.isSafeInteger(a.expiry);
}

/** One gated tool call: approval (stages 1 to 3), then the supervisor's release, then the final revalidation. */
async function gateRelease(request: GateRequest): Promise<void> {
  const binding = { ...request.approval, gate_token: randomUUID() };
  const generation = bindingGeneration;
  const allowed = await resolvers.ask('tool_approval', { title: request.title ?? `${binding.operation} approval`, approval: binding }, { timeout: Math.min(30_000, binding.expiry - Date.now()) });
  // The terminal notification of a gate that does not release; sent before the extension hears the denial.
  const closed = (reason: string) => emit({ type: 'gate_closed', gate_token: binding.gate_token, reason });
  if (allowed !== true || generation !== bindingGeneration || Date.now() >= binding.expiry) {
    closed(allowed !== true ? 'not_approved' : generation !== bindingGeneration ? 'binding_moved' : 'expired');
    request.respond(false);
    return;
  }
  const decision = await new Promise<Decision>(resolve => {
    const timer = setTimeout(() => {
      gates.delete(binding.gate_token);
      resolve({ allowed: false, reason: 'release_timeout' });
    }, GATE_RELEASE_TIMEOUT_MS);
    timer.unref();
    gates.set(binding.gate_token, {
      binding,
      settle: (supervisorAllowed, acknowledge) => {
        clearTimeout(timer);
        gates.delete(binding.gate_token);
        // Without an acknowledgement the settle came from a binding move (cancelAll), not from a release command.
        resolve({ allowed: supervisorAllowed, reason: acknowledge ? 'release_denied' : 'binding_moved', ...(acknowledge ? { acknowledge } : {}) });
      },
    });
    emit({ type: 'gate_check', ...binding });
  });
  // The gate owns the final validation. No await between it, the acknowledgement and the extension's permission.
  let valid = decision.allowed && generation === bindingGeneration && Date.now() < binding.expiry;
  if (valid && request.recheck) {
    try {
      valid = request.recheck() === true;
    } catch {
      valid = false;
    }
  }
  decision.acknowledge?.({ released: valid });
  if (!valid) closed(decision.reason);
  request.respond(valid);
  if (valid) emit({ type: 'gate_released', gate_token: binding.gate_token });
}

/** The opt-in tool gate seam on pi's event bus; a malformed request is denied. */
const toolGate: ExtensionFactory = pi => {
  pi.events.on(TOOL_GATE_CHANNEL, data => {
    const request = data as GateRequest;
    if (!request || typeof request.respond !== 'function') return;
    if (!isApproval(request.approval) || (request.recheck !== undefined && typeof request.recheck !== 'function')) {
      request.respond(false);
      return;
    }
    void gateRelease(request).catch(() => request.respond(false));
  });
};

// session_tree is an extension lifecycle event, not an AgentSession.subscribe event: appends and settlement alone
// miss a native move that adds no entry.
const bindingObserver: ExtensionFactory = pi => {
  // The worker row's model, thinking level and title follow pi, whoever changed them (session.configure or natively).
  pi.on('model_select', () => emitConfig());
  pi.on('thinking_level_select', () => emitConfig());
  pi.on('session_info_changed', () => emitConfig());
  pi.on('session_tree', (_event, ctx) => {
    cancelAll();
    emit({
      type: 'host_binding',
      action: 'tree',
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      leafId: ctx.sessionManager.getLeafId(),
    });
  });
};

/** The worker's interrupt marker (S-5): the same line and rule as Shep's bridge (ADR-0006, R9). */
const INTERRUPT_MARKER = '[The previous request was interrupted by the user before it finished.]';
/** The custom entry that stamps a supervisor command into pi's session before its input (contract 8.1). */
const INPUT_STAMP = 'pi-worker.input';

/** A model as B2 lists it. */
function modelRow(m: { provider: string; id: string; name?: string; reasoning?: boolean; input?: string[]; contextWindow?: number; maxTokens?: number }) {
  return {
    provider: m.provider,
    id: m.id,
    name: String(m.name ?? m.id).slice(0, 256),
    reasoning: m.reasoning === true,
    input: (m.input ?? ['text']).filter(i => i === 'text' || i === 'image'),
    context_window: Number.isSafeInteger(m.contextWindow) ? m.contextWindow! : 0,
    max_tokens: Number.isSafeInteger(m.maxTokens) ? m.maxTokens! : 0,
  };
}

type CommandRow = { name: string; description: string | null; source: 'extension' | 'prompt' | 'skill' };
const describe = (d: unknown) => (typeof d === 'string' && d ? d.slice(0, 4096) : null);

/**
 * Inventory mode (`commands.list` and `models.list` for a cwd before any worker exists): services only, no session
 * runtime, so no session file. Extensions load as they would for a worker of that cwd; nothing is prompted.
 */
async function inventory(): Promise<void> {
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: launch.projectTrusted }),
    resourceLoaderOptions: {
      extensionFactories: [
        { name: 'codemode', builtin: true, factory: createCodemodeExtension() },
        { name: 'tool_search', builtin: true, factory: createToolSearchExtension() },
        { name: 'mcp', builtin: true, factory: createMcpExtension() },
      ],
    },
  });
  const loader = services.resourceLoader;
  const commands: CommandRow[] = [];
  for (const extension of loader.getExtensions().extensions) for (const c of extension.commands.values()) commands.push({ name: c.name, description: describe(c.description), source: 'extension' });
  for (const t of loader.getPrompts().prompts) commands.push({ name: t.name, description: describe(t.description), source: 'prompt' });
  for (const skill of loader.getSkills().skills) commands.push({ name: `skill:${skill.name}`, description: describe(skill.description), source: 'skill' });
  const features = {
    models: services.modelRuntime.getAvailableSnapshot().map(modelRow),
    current: null,
    thinking: null,
    thinking_levels: [],
    commands,
    extension_errors: loader.getExtensions().errors.map(e => e.path),
  };
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const n = buffer.indexOf('\n');
      if (n < 0) break;
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      let c: { type?: unknown; id?: unknown };
      try {
        c = JSON.parse(line) as typeof c;
      } catch {
        continue;
      }
      if (c.type === 'features') output({ type: 'response', id: c.id, success: true, data: features });
      else output({ type: 'response', id: c.id, success: false, error: 'inventory_only' });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (launch.inventory === true) {
  await inventory().catch(error => {
    console.error('inventory_failed', error instanceof Error ? error.message : '');
    process.exit(1);
  });
}

const spec = launch.launchSpec ?? null;
const runtimePromise = launch.inventory === true ? new Promise<never>(() => {}) : createAgentSessionRuntime(
  async options => {
    const services = await createAgentSessionServices({
      ...options,
      settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: launch.projectTrusted }),
      resourceLoaderOptions: {
        // A typed child loads only the resources its spec names: no discovered extensions, skills, prompt templates,
        // context files or MCP servers.
        ...(spec
          ? {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noContextFiles: true,
              disabledBuiltinExtensions: ['mcp'],
              additionalExtensionPaths: spec.resources.extensions,
              additionalSkillPaths: spec.resources.skills,
            }
          : {}),
        extensionFactories: [
          { name: 'codemode', builtin: true, factory: createCodemodeExtension() },
          { name: 'tool_search', builtin: true, factory: createToolSearchExtension() },
          { name: 'mcp', builtin: true, factory: createMcpExtension() },
          bindingObserver,
          toolGate,
        ],
      },
    });
    const model = services.modelRuntime.getModel(launch.provider, launch.model);
    if (!model) throw new Error('configured_model_not_found');
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      model,
      // SAFETY: the supervisor passes a value of the spec's Thinking enum, which is pi's ThinkingLevel.
      thinkingLevel: launch.thinking as 'off',
      ...(spec ? { tools: spec.tools, ...(spec.tools.length === 0 ? { noTools: 'all' as const } : {}), excludeTools: spec.denied_tools } : {}),
    });
    return { ...created, services, diagnostics: services.diagnostics };
  },
  { cwd: process.cwd(), agentDir: getAgentDir(), sessionManager: SessionManager.create(process.cwd(), launch.sessionDir) },
);

/** pi's own commands for a session: extension commands, prompt templates, skills. */
function ownCommands(session: AgentSession): CommandRow[] {
  const commands: CommandRow[] = [];
  for (const command of session.extensionRunner.getRegisteredCommands()) commands.push({ name: command.invocationName, description: describe(command.description), source: 'extension' });
  for (const template of session.promptTemplates) commands.push({ name: template.name, description: describe(template.description), source: 'prompt' });
  for (const skill of session.resourceLoader.getSkills().skills) commands.push({ name: `skill:${skill.name}`, description: describe(skill.description), source: 'skill' });
  return commands;
}

let current: AgentSession | undefined;
/** The supervisor execution the current run belongs to: its settlement is stamped into the session file. */
let running: { execution_id: string; command_id: string } | null = null;
/** A prompt with images waits for pi's user message to report how many images pi kept (it may drop one). */
let awaitingUser: ((images: number) => void) | null = null;

function emitConfig(): void {
  const session = current;
  if (!session) return;
  const model = session.model;
  emit({ type: 'host_config', model: model ? { provider: model.provider, id: model.id } : null, thinking: session.thinkingLevel ?? null, name: session.sessionName ?? null });
}

/**
 * The interrupt rule (Shep's ADR-0006, R9), derived from the log: the newest turn on the active path ended `aborted`
 * and no user message came after it, and the new text starts a turn (not `/…` or `!…`).
 */
function afterAbortedTurn(session: AgentSession, text: string): boolean {
  const t = text.replace(/^[ \t\r\n]+/, '');
  if (t === '' || t.startsWith('/') || t.startsWith('!')) return false;
  const branch = session.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== 'message') continue;
    const message = entry.message as { role?: string; stopReason?: string };
    if (message.role === 'user') return false;
    if (message.role === 'assistant') return message.stopReason === 'aborted';
  }
  return false;
}

async function bind(session: AgentSession): Promise<void> {
  const replaced = current !== undefined && current !== session;
  current = session;
  emit({
    type: replaced ? 'host_binding' : 'host_identity',
    action: 'replace',
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    leafId: session.sessionManager.getLeafId(),
  });
  // SAFETY: SDK events are plain records with a string type, the host seam's only requirement.
  session.subscribe(event => {
    if (current !== session) return;
    if (event.type === 'message_end' && awaitingUser) {
      const message = (event as { message?: { role?: string; content?: unknown } }).message;
      if (message?.role === 'user') {
        const kept = Array.isArray(message.content) ? message.content.filter(c => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'image').length : 0;
        const done = awaitingUser;
        awaitingUser = null;
        done(kept);
      }
    }
    if (event.type === 'agent_settled' && running) {
      // Settlement evidence in pi's own file, attributed to the exact execution and command (fence `observed`).
      session.sessionManager.appendCustomEntry('agent_settled', { execution_id: running.execution_id, command_id: running.command_id });
      running = null;
    }
    // pi's leaf after the turn goes BEFORE its settlement: the supervisor settles the execution on `agent_settled`,
    // and a caller that reads history then must get the turn, not the leaf pi had selected before it (pi emits no
    // `entry_appended` for its message entries, so this is the first leaf report of the turn).
    if (event.type === 'agent_settled') emit({ type: 'host_leaf', leafId: session.sessionManager.getLeafId() });
    // SAFETY: sanitize keeps an event's own fields, so the result is still a record with its string `type`.
    emit(sanitize(event) as unknown as PiEvent);
    // pi appends a rename, a thinking change and a compaction without `entry_appended`; these events follow each one.
    if (event.type === 'entry_appended' || event.type === 'session_info_changed' || event.type === 'thinking_level_changed' || event.type === 'compaction_end') {
      emit({ type: 'host_leaf', leafId: session.sessionManager.getLeafId() });
    }
  });
  await session.bindExtensions({
    uiContext: ui,
    mode: 'rpc',
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async options => (await runtimePromise).newSession(options),
      fork: async (entry, options) => (await runtimePromise).fork(entry, options),
      switchSession: async (path, options) => (await runtimePromise).switchSession(path, options),
      navigateTree: async (entry, options) => {
        cancelAll();
        return session.navigateTree(entry, options);
      },
      reload: () => session.reload(),
    },
    abortHandler: () => {
      cancelAll();
      void session.abort();
    },
    onError: error => emit({ type: 'extension_error', path: error.extensionPath, event: error.event, error: error.error }),
    shutdownHandler: () => {
      void shutdown();
    },
  });
  emitConfig();
}

const ready = runtimePromise.then(async runtime => {
  runtime.setBeforeSessionInvalidate(() => {
    cancelAll();
    emit({ type: 'host_binding_changing' });
  });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  return runtime;
});

/**
 * An SDK event as the supervisor receives it: image bytes are replaced by their size and media type (the session file
 * keeps them; `blobs.read` serves them), so no stdout line carries megabytes of base64.
 */
/** What an SDK event becomes on the wire: JSON data (anything else is dropped by JSON.stringify anyway). */
type WireValue = string | number | boolean | null | undefined | WireValue[] | { [key: string]: WireValue };

function sanitize(value: unknown, depth = 0): WireValue {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth > 64) return undefined;
  if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.type === 'image' && typeof record.data === 'string') {
    return { type: 'image', mimeType: typeof record.mimeType === 'string' ? record.mimeType : null, data_omitted: true, base64_chars: record.data.length };
  }
  const out: { [key: string]: WireValue } = {};
  for (const [k, v] of Object.entries(record)) out[k] = sanitize(v, depth + 1);
  return out;
}

type Command = PiEvent & { id?: unknown };

/** An explicit refusal before pi ran anything for this command: the one negative reply that proves no effect. */
class RefusedBeforeInput extends Error {}

/** Commands drain concurrently: the startup bind and a prompt may both be waiting on a dialog. */
async function command(c: Command, reply: (data: Record<string, unknown>) => void): Promise<void> {
  if (c.type === 'answer_ui') {
    // SAFETY: the supervisor validated the answer shape against the interaction's kind before sending it.
    reply({ ...resolvers.answer(String(c.nativeId), c.answer as UIAnswer) });
    return;
  }
  if (c.type === 'cancel_ui') {
    // The supervisor's own cancel (deadline, binding move, interrupt) through the same exact resolver.
    reply({ ...resolvers.answer(String(c.nativeId), { outcome: 'cancel' }) });
    return;
  }
  if (c.type === 'gate_release') {
    // The supervisor's release decision for one gate; the gate acknowledges after its own final validation.
    const gate = gates.get(String(c.gate_token));
    if (!gate || c.digest !== gate.binding.digest) {
      reply({ released: false });
      return;
    }
    await new Promise<void>(done =>
      gate.settle(c.allowed === true, data => {
        reply(data);
        done();
      }),
    );
    return;
  }
  if (c.type === 'abort') cancelAll();
  const runtime = await ready;
  const session = runtime.session;
  switch (c.type) {
    case 'get_state':
      reply({ sessionId: session.sessionId, sessionFile: session.sessionFile, leafId: session.sessionManager.getLeafId() });
      break;
    case 'inventory': {
      const loader = runtime.services.resourceLoader;
      reply({
        extensions: loader.getExtensions().extensions.map(e => e.path),
        extension_errors: loader.getExtensions().errors.map(e => e.path),
        skills: loader.getSkills().skills.map(s => ({ name: s.name, path: s.filePath })),
        tools: session.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })),
        active_tools: session.getActiveToolNames(),
        commands: ownCommands(session).map(c => ({ name: c.name, source: c.source })),
      });
      break;
    }
    case 'compact': {
      // pi's own preconditions, checked before anything runs; anything after them that fails is unknown.
      if (session.isStreaming) throw new RefusedBeforeInput('pi_busy');
      if (session.isCompacting) throw new RefusedBeforeInput('pi_compacting');
      if (!session.model) throw new RefusedBeforeInput('no_model_selected');
      const before = session.sessionManager.getEntries().length;
      const leaf = session.sessionManager.getLeafId();
      try {
        const result = await session.compact(typeof c.customInstructions === 'string' ? c.customInstructions : undefined);
        reply({ tokens_before: result.tokensBefore, first_kept_entry_id: result.firstKeptEntryId ?? null });
      } catch (error) {
        // pi throws these two from its preparation, before any hook or summary: proven only if nothing was appended.
        const message = error instanceof Error ? error.message : '';
        const unchanged = session.sessionManager.getEntries().length === before && session.sessionManager.getLeafId() === leaf;
        if (unchanged && message === 'Nothing to compact (session too small)') throw new RefusedBeforeInput('nothing_to_compact');
        if (unchanged && message === 'Already compacted') throw new RefusedBeforeInput('already_compacted');
        throw error;
      }
      break;
    }
    case 'reload': {
      if (session.isStreaming) throw new RefusedBeforeInput('pi_busy');
      if (session.isCompacting) throw new RefusedBeforeInput('pi_compacting');
      cancelAll();
      await session.reload();
      const loader = runtime.services.resourceLoader;
      reply({
        extensions: loader.getExtensions().extensions.map(e => e.path),
        extension_errors: loader.getExtensions().errors.map(e => e.path),
        skills: loader.getSkills().skills.map(sk => ({ name: sk.name, path: sk.filePath })),
        tools: session.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })),
        active_tools: session.getActiveToolNames(),
        commands: ownCommands(session).map(cm => ({ name: cm.name, source: cm.source })),
      });
      emitConfig();
      break;
    }
    case 'invoke': {
      // Only an extension command pi has registered now; anything else would become a prompt to the model.
      const name = String(c.name);
      if (!session.extensionRunner.getRegisteredCommands().some(cm => cm.invocationName === name)) throw new RefusedBeforeInput('unknown_command');
      if (session.isStreaming) throw new RefusedBeforeInput('pi_busy');
      if (session.isCompacting) throw new RefusedBeforeInput('pi_compacting');
      const text = `/${name}${typeof c.args === 'string' && c.args !== '' ? ` ${c.args}` : ''}`;
      await session.prompt(text, { preflightResult: disposition => reply({ disposition }) });
      break;
    }
    case 'prompt':
      // pi runs input hooks before its own busy, model and auth checks, so its later throws prove nothing. A busy or
      // compacting session is refused here instead, in the same synchronous turn as the call below (which enters the
      // input hooks before its first await): nothing has run.
      if (session.isStreaming) throw new RefusedBeforeInput('pi_busy');
      if (session.isCompacting) throw new RefusedBeforeInput('pi_compacting');
      {
        const text = String(c.message);
        // Staged images: read, checked against the hash the supervisor recorded, and sent as real image blocks.
        const staged = Array.isArray(c.images) ? (c.images as { path: string; sha256: string; mime_type: string }[]) : [];
        const blocks = staged.map(image => {
          let bytes: Buffer;
          try {
            bytes = readFileSync(image.path);
          } catch {
            throw new RefusedBeforeInput('attachment_unreadable');
          }
          if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new RefusedBeforeInput('attachment_bytes_changed');
          return { type: 'image' as const, data: bytes.toString('base64'), mimeType: image.mime_type };
        });
        if (blocks.length && !session.model?.input.includes('image')) throw new RefusedBeforeInput('model_without_image_input');
        // The worker owns the interrupt marker (S-5): the model gets it, the stamp keeps the text the user typed.
        const marked = afterAbortedTurn(session, text);
        const delivered = marked ? `${INTERRUPT_MARKER}\n${text}` : text;
        if (typeof c.command_id === 'string' && typeof c.execution_id === 'string') {
          // The command id in pi's own file, right before its input (contract 8.1), so `observed` can match it.
          session.sessionManager.appendCustomEntry(INPUT_STAMP, {
            command_id: c.command_id,
            execution_id: c.execution_id,
            interrupt_marker: marked,
            ...(marked ? { display_text: text } : {}),
          });
          running = { execution_id: c.execution_id, command_id: c.command_id };
        }
        // The reply is pi's admission (preflight), sent as soon as it is known; settlement is the agent_settled event.
        await session.prompt(delivered, {
          ...(blocks.length ? { images: blocks } : {}),
          preflightResult: disposition => {
            if (disposition !== 'started') running = null;
            const base = { disposition, ...(marked ? { interrupt_marker: true } : {}) };
            if (!blocks.length) return reply(base);
            if (disposition !== 'started') return reply({ ...base, accepted_images: 0 });
            // The run's user message follows at once; its image blocks are what pi accepted.
            const timer = setTimeout(() => {
              awaitingUser = null;
              reply(base);
            }, 10_000);
            awaitingUser = kept => {
              clearTimeout(timer);
              reply({ ...base, accepted_images: kept });
            };
          },
        });
      }
      break;
    case 'steer':
      reply({ disposition: await session.steer(String(c.message)) });
      break;
    case 'abort':
      await session.abort();
      reply({});
      break;
    case 'clear_queue':
      session.clearQueue();
      reply({});
      break;
    case 'navigate':
      cancelAll();
      reply({ ...(await session.navigateTree(String(c.entryId), { summarize: false })) });
      break;
    case 'new_session':
      reply({ ...(await runtime.newSession()) });
      break;
    case 'switch_session':
      reply({ ...(await runtime.switchSession(String(c.sessionPath))) });
      break;
    case 'fork':
      // B2 forks AT the named entry: the new session continues from it (pi's default `before` re-edits a user turn).
      reply({ ...(await runtime.fork(String(c.entryId), { position: 'at' })) });
      break;
    case 'get_tree':
      reply({ tree: session.sessionManager.getTree() });
      break;
    case 'features': {
      const commands = ownCommands(session);
      const model = session.model;
      reply({
        models: session.modelRuntime.getAvailableSnapshot().map(modelRow),
        current: model ? { provider: model.provider, id: model.id } : null,
        thinking: session.thinkingLevel ?? null,
        thinking_levels: session.getAvailableThinkingLevels(),
        commands,
      });
      break;
    }
    case 'configure': {
      // Every check that can refuse runs before the first change: nothing has happened when one fails.
      if (session.isStreaming) throw new RefusedBeforeInput('pi_busy');
      if (session.isCompacting) throw new RefusedBeforeInput('pi_compacting');
      const want = c.model as { provider?: unknown; id?: unknown } | undefined;
      const model = want ? session.modelRuntime.getAvailableSnapshot().find(m => m.provider === want.provider && m.id === want.id) : undefined;
      if (want && !model) throw new RefusedBeforeInput('model_not_available');
      const name = typeof c.name === 'string' ? c.name.trim() : undefined;
      if (c.name !== undefined && !name) throw new RefusedBeforeInput('session_name_empty');
      if (model) await session.setModel(model);
      // SAFETY: the supervisor passes a value of the spec's Thinking enum, which is pi's ThinkingLevel.
      if (typeof c.thinking === 'string') session.setThinkingLevel(c.thinking as 'off');
      if (name) session.setSessionName(name);
      // pi's model selection appends with no session event: its leaf goes before the reply.
      emit({ type: 'host_leaf', leafId: session.sessionManager.getLeafId() });
      const now = session.model;
      reply({ model: now ? { provider: now.provider, id: now.id } : null, thinking: session.thinkingLevel ?? null, name: session.sessionName ?? null });
      break;
    }
    default:
      throw new Error('unsupported_sdk_command');
  }
}

async function handle(c: Command): Promise<void> {
  let replied = false;
  try {
    await command(c, data => {
      if (replied) return;
      replied = true;
      output({ type: 'response', id: c.id, success: true, data });
    });
    // A command that returned without a reply (for example a prompt pi deferred) is not proof that nothing ran.
    if (!replied) output({ type: 'response', id: c.id, success: false, error: 'sdk_command_not_admitted' });
  } catch (error) {
    if (replied) return;
    // Only an explicit refusal before pi ran anything is marked; any other failure may follow input hooks.
    if (error instanceof RefusedBeforeInput) output({ type: 'response', id: c.id, success: false, error: error.message, refused: 'before_input' });
    else output({ type: 'response', id: c.id, success: false, error: 'sdk_command_failed' });
  }
}

const decoder = new StringDecoder('utf8');
let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += decoder.write(chunk);
  if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
    void shutdown();
    return;
  }
  for (;;) {
    const n = buffer.indexOf('\n');
    if (n < 0) break;
    const line = buffer.slice(0, n);
    buffer = buffer.slice(n + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // A malformed record is refused without echoing its data.
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as Command).type === 'string') void handle(parsed as Command);
  }
});

async function shutdown(): Promise<void> {
  cancelAll();
  try {
    await (await runtimePromise).dispose();
  } finally {
    process.exit(0);
  }
}
process.stdin.on('end', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
ready.catch(error => {
  console.error('sdk_initialization_failed', error instanceof Error ? error.message : '');
  process.exit(1);
});
