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
    if (c.type === 'features') return { type: 'response', id: 'x', success: true, data: structuredClone(this.features) };
    if (c.type === 'steer') return { type: 'response', id: 'x', success: true, data: { disposition: 'queued' } };
    if (c.type === 'inventory') return { type: 'response', id: 'x', success: true, data: { extensions: [], extension_errors: [], skills: [], tools: [], active_tools: [] } };
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
  create(): Promise<Worker>;
  /** Discards the supervisor without stopping its hosts, then recovers a new one over the same state. */
  restart(factory?: HostFactory): Promise<Supervisor>;
  cleanup(): void;
}

export function fixture(
  config: {
    unconfirmedIdentity?: boolean;
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
    // A process identity that cannot be confirmed: cleanup must stay pending without signalling anything.
    if (config.unconfirmedIdentity) host.pid = 2147483647;
    config.initHost?.(host);
    hosts.push(host);
    return host;
  };
  const open = (f: HostFactory) => {
    const state = openState(dir, config.journalBytes === undefined ? {} : { maxBytes: config.journalBytes });
    return { state, supervisor: new Supervisor({ journal: state.journal, receipts: new ReceiptStore(state.journal, config.receiptCap, undefined, config.retention), supervisorEpoch: state.supervisorEpoch, stateDir: dir, factory: f, grants: new GrantStore(dir) }) };
  };
  const first = open(factory);
  const f: Fixture = {
    dir,
    hosts,
    supervisor: first.supervisor,
    state: first.state,
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
      f.state.close();
      const opened = open(next);
      f.state = opened.state;
      f.supervisor = opened.supervisor;
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
