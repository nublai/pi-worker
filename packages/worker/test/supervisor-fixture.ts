/**
 * Supervisor test seam, ported from A0 `src/test/helpers.ts`: a deterministic in-process host (never pi, never a
 * model) and a supervisor over real fsynced state. The host counts native prompt submissions independently of
 * receipts.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PiRecord, PiResponse, SessionHost } from '../src/host/host.js';
import { openState, type SupervisorState as OpenState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import type { RetentionLimits } from '../src/journal/retention.js';
import type { Binding, HostFactory, HostLaunch, Worker } from '../src/supervisor/state.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { GrantStore } from '../src/grants/store.js';
import { privateTmp } from './helpers.js';
import { TestDomains } from './domains.js';

export class Host extends EventEmitter implements SessionHost {
  pid: number | undefined = undefined;
  token: string | null = null;
  prompts = 0;
  stops = 0;
  /** The next prompt starts (`agent_start`) and its reply is lost. */
  failure = false;
  serial = 0;
  commands: PiRecord[] = [];
  before = (_c: PiRecord) => {};
  stopOk = true;
  /** Native ids the supervisor cancelled at their resolver (`cancel_ui`). */
  cancelled: string[] = [];
  /** Cancellations never return while set (a resolver that hangs). */
  holdUI = false;
  /** The next `configure` changes pi, then its reply is lost. */
  configureFailure = false;
  /** The next `configure` is refused by the child before any change. */
  configureRefusal: string | null = null;
  /** The next session command (`compact`, `reload`, `invoke`) changes pi, then its reply is lost. */
  commandFailure = false;
  /** The next session command is refused by the child before any change. */
  commandRefusal: string | null = null;
  /** The next session command gets a generic negative reply (not a refusal before any change). */
  commandNegative = false;
  /** What `features` answers (pi's own commands and models). */
  features: Record<string, unknown> = {
    models: [{ provider: 'p', id: 'm', name: 'M', reasoning: false, input: ['text', 'image'], context_window: 1000, max_tokens: 100 }],
    current: { provider: 'p', id: 'm' },
    thinking: 'off',
    thinking_levels: ['off', 'low', 'high'],
    commands: [{ name: 'deploy', description: 'Deploy', source: 'extension' }],
  };
  /** The exact resolver's acknowledgement of an answer (the SDK child's `Resolvers.answer`). */
  answerUI: (nativeId: string, answer: Record<string, unknown>) => Promise<{ consumed: boolean; outcome?: string }> = async () => ({ consumed: true, outcome: 'answered' });

  constructor(
    readonly dir: string,
    public sid: string,
    public file: string,
  ) {
    super();
  }

  async request(c: PiRecord): Promise<PiResponse> {
    this.commands.push(c);
    this.before(c);
    if (c.type === 'new_session' || c.type === 'fork') {
      this.sid = `new-${this.sid}-${++this.serial}`;
      this.file = join(this.dir, `${this.sid}.jsonl`);
      writeFileSync(this.file, `${JSON.stringify({ type: 'session', id: this.sid })}\n`);
    }
    if (c.type === 'switch_session') {
      this.file = String(c.sessionPath);
      this.sid = (JSON.parse(readFileSync(this.file, 'utf8').split('\n')[0]!) as { id: string }).id;
    }
    if (c.type === 'cancel_ui') {
      this.cancelled.push(String(c.nativeId));
      if (this.holdUI) await new Promise<never>(() => {});
      return { type: 'response', id: 'x', success: true, data: { consumed: true, outcome: 'cancel' } };
    }
    if (c.type === 'answer_ui') return { type: 'response', id: 'x', success: true, data: { ...(await this.answerUI(String(c.nativeId), c.answer as Record<string, unknown>)) } };
    if (c.type === 'gate_release') return { type: 'response', id: 'x', success: true, data: { released: c.allowed === true } };
    if (c.type === 'prompt') {
      this.prompts++;
      this.emit('event', { type: 'agent_start' });
      if (this.failure) throw new Error('lost_prompt_reply');
      return { type: 'response', id: 'x', success: true, data: { disposition: 'started' } };
    }
    if (c.type === 'configure') {
      if (this.configureRefusal) return { type: 'response', id: 'x', success: false, error: this.configureRefusal, refused: 'before_input' };
      if (this.configureFailure) throw new Error('lost_configure_reply');
      return { type: 'response', id: 'x', success: true, data: { model: c.model ?? { provider: 'p', id: 'm' }, thinking: c.thinking ?? 'off', name: c.name ?? null } };
    }
    if (c.type === 'compact' || c.type === 'reload' || c.type === 'invoke') {
      if (this.commandRefusal) return { type: 'response', id: 'x', success: false, error: this.commandRefusal, refused: 'before_input' };
      if (this.commandFailure) throw new Error(`lost_${c.type}_reply`);
      if (this.commandNegative) return { type: 'response', id: 'x', success: false, error: 'sdk_command_failed' };
      if (c.type === 'compact') return { type: 'response', id: 'x', success: true, data: { tokens_before: 1234, first_kept_entry_id: null } };
      if (c.type === 'reload') return { type: 'response', id: 'x', success: true, data: { extensions: [], extension_errors: [], skills: [], tools: [], active_tools: [], commands: [{ name: 'deploy', source: 'extension' }] } };
      return { type: 'response', id: 'x', success: true, data: { disposition: 'handled' } };
    }
    if (c.type === 'features') return { type: 'response', id: 'x', success: true, data: structuredClone(this.features) };
    if (c.type === 'steer') return { type: 'response', id: 'x', success: true, data: { disposition: 'queued' } };
    if (c.type === 'inventory') return { type: 'response', id: 'x', success: true, data: { extensions: [], extension_errors: [], skills: [], tools: [], active_tools: [], commands: [{ name: 'deploy', source: 'extension' }] } };
    if (c.type === 'abort') this.emit('event', { type: 'agent_settled', aborted: true });
    return { type: 'response', id: 'x', success: true, data: { sessionId: this.sid, sessionFile: this.file, cancelled: false } };
  }

  async stop(): Promise<boolean> {
    this.stops++;
    this.emit('exit');
    return this.stopOk;
  }
}

export const bind = (w: Worker, command_id: string): Binding => ({ command_id, session_id: w.session_id!, worker_epoch: w.worker_epoch, binding_revision: w.binding_revision });
export const tick = () => new Promise<void>(r => setImmediate(r));

export interface Fixture {
  readonly dir: string;
  readonly hosts: Host[];
  supervisor: Supervisor;
  state: OpenState;
  readonly journalFile: string;
  /** The cleanup domains of the current supervisor (one per open unless the fixture shares them). */
  domains: TestDomains;
  create(): Promise<Worker>;
  /**
   * Discards the supervisor without stopping its hosts, as a killed supervisor leaves them, then recovers a new one over
   * the same state. The discarded instance is retired first (`retire`): it runs nothing more.
   */
  restart(factory?: HostFactory): Promise<Supervisor>;
  cleanup(): void;
}

/**
 * Retires a supervisor the way SIGKILL does, for an in-process restart: a killed supervisor never runs another callback.
 * Its host callbacks (exit, event, report) are detached (each checks `live.host === host`) and its move timers cleared,
 * so a host the successor's recovery kills cannot fault, clean or record through the retired instance (GPT and Grok
 * PR #21 finding 2: a late exit of the old host cleaned a shared domain a second time).
 */
export function retire(supervisor: Supervisor): void {
  for (const live of supervisor.state.workers.values()) {
    live.host = undefined;
    if (live.moveTimer) clearTimeout(live.moveTimer);
    live.moveTimer = undefined;
  }
}

export function fixture(
  config: {
    /** No domain is ever proven clean: cleanup stays pending (the conformance profile `unconfirmed_native_identity`). */
    unconfirmedIdentity?: boolean;
    /** Domains shared by every supervisor the fixture opens (a restart can clean the previous one's domains). */
    domains?: TestDomains;
    initHost?: (host: Host) => void;
    launch?: (launch: HostLaunch) => SessionHost | undefined;
    /** The receipt store's count bound (P1-12 raised the default from A0's 512). */
    receiptCap?: number;
    /** The receipt store's other retention limits (the defaults otherwise). */
    retention?: Partial<Omit<RetentionLimits, 'receipts' | 'journalBytes'>>;
    /** The journal's byte bound (the default otherwise). */
    journalBytes?: number;
  } = {},
): Fixture {
  const tmp = privateTmp();
  const dir = tmp.dir;
  const hosts: Host[] = [];
  const factory: HostFactory = launch => {
    const custom = config.launch?.(launch);
    if (custom) return custom;
    const sid = `session-${hosts.length}`;
    const file = join(dir, `${sid}.jsonl`);
    // A0's fix-round header shape (version 3): a rewritten header is shorter, so the index re-reads the file.
    writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid, version: 3 })}\n`);
    const host = new Host(dir, sid, file);
    config.initHost?.(host);
    hosts.push(host);
    return host;
  };
  const open = (f: HostFactory) => {
    const state = openState(dir, config.journalBytes === undefined ? {} : { maxBytes: config.journalBytes });
    const domains = config.domains ?? new TestDomains({ confirm: !config.unconfirmedIdentity });
    const supervisor = new Supervisor({
      journal: state.journal,
      receipts: new ReceiptStore(state.journal, config.receiptCap, undefined, config.retention),
      supervisorEpoch: state.supervisorEpoch,
      stateDir: dir,
      factory: domains.track(f),
      containment: domains,
      grants: new GrantStore(dir),
    });
    return { state, supervisor, domains };
  };
  const first = open(factory);
  const f: Fixture = {
    dir,
    hosts,
    supervisor: first.supervisor,
    state: first.state,
    domains: first.domains,
    journalFile: first.state.journal.file,
    async create() {
      const cwd = join(dir, `cwd-${hosts.length}`);
      mkdirSync(cwd);
      const r = await f.supervisor.create({ command_id: `create-${hosts.length}`, cwd, provider: 'p', model: 'm', thinking: 'off' });
      if (r.state !== 'delivered') throw new Error(JSON.stringify(r));
      return f.supervisor.get(r.worker_id!);
    },
    async restart(next = () => {
      throw new Error('restart must not adopt or relaunch a host');
    }) {
      retire(f.supervisor);
      f.state.close();
      const opened = open(next);
      f.state = opened.state;
      f.supervisor = opened.supervisor;
      f.domains = opened.domains;
      await f.supervisor.recover();
      return f.supervisor;
    },
    cleanup() {
      f.state.close();
      tmp.cleanup();
    },
  };
  return f;
}
