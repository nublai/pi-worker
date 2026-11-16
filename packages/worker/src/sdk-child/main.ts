/**
 * The pi process: pi's SDK (pinned in this package) in a dedicated Node process, driven by the supervisor over one
 * plain LF JSON protocol on stdin and stdout (host/host.ts). Rewritten from A0 `src/sdk-child.ts` without the ACP
 * framing or `_pi/*` extensions. Stdout is protocol only; console output and third-party logs go to stderr.
 *
 * It keeps from A0: the headless UI context whose dialogs go through exact resolvers (resolvers.ts); the native
 * binding observer (`host_identity` once, then `host_binding` for every native move, `host_binding_changing` before
 * the old session is invalidated, `host_leaf` after appends and settlement); and admission replies from pi's
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
import { randomUUID } from 'node:crypto';
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
/** `launchSpec`: a typed child gets its explicit tools, denials and resources, and nothing discovered (P1-11). */
type Launch = { sessionDir: string; provider: string; model: string; thinking: string; projectTrusted: boolean; launchSpec?: LaunchSpec | null };
let launch: Launch;
try {
  launch = JSON.parse(process.argv[2] ?? '') as Launch;
  if (typeof launch.sessionDir !== 'string' || typeof launch.provider !== 'string' || typeof launch.model !== 'string') throw new Error('launch');
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

const spec = launch.launchSpec ?? null;
const runtimePromise = createAgentSessionRuntime(
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

let current: AgentSession | undefined;
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
    emit(event as unknown as PiEvent);
    if (event.type === 'entry_appended' || event.type === 'agent_settled') emit({ type: 'host_leaf', leafId: session.sessionManager.getLeafId() });
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
      });
      break;
    }
    case 'prompt':
      // pi runs input hooks before its own busy, model and auth checks, so its later throws prove nothing. A busy or
      // compacting session is refused here instead, in the same synchronous turn as the call below (which enters the
      // input hooks before its first await): nothing has run.
      if (session.isStreaming) throw new RefusedBeforeInput('pi_busy');
      if (session.isCompacting) throw new RefusedBeforeInput('pi_compacting');
      // The reply is pi's admission (preflight), sent as soon as it is known; settlement is the agent_settled event.
      await session.prompt(String(c.message), { preflightResult: disposition => reply({ disposition }) });
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
