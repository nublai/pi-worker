/**
 * The pi process: pi's SDK (pinned in this package) in a dedicated Node process, driven by the supervisor over one
 * plain LF JSON protocol on stdin and stdout (host/host.ts). Rewritten from A0 `src/sdk-child.ts` without the ACP
 * framing or `_pi/*` extensions. Stdout is protocol only; console output and third-party logs go to stderr.
 *
 * It keeps from A0: the headless UI context whose dialogs go through exact resolvers (resolvers.ts); the native
 * binding observer (`host_identity` once, then `host_binding` for every native move, `host_binding_changing` before
 * the old session is invalidated, `host_leaf` after appends and settlement); and admission replies from pi's
 * prompt preflight (`started`, `handled`, `queued`), which are not settlement (`agent_settled` is an event).
 */
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

/** A binding move invalidates every live dialog: no old answer may land in the new session. */
function cancelAll(): void {
  resolvers.abortAll();
}

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
