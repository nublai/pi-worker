/**
 * The supervisor's side of a pi process: one subprocess per worker generation speaking LF-delimited JSON on stdin
 * and stdout. Rewritten from A0 `src/host.ts` (SDK only; no RPC or ACP framing). Kept from A0 (and exmach): LF framing
 * that survives U+2028/U+2029 and UTF-8 split across chunks, request/response correlation by id, a bounded stderr
 * tail, a bounded line, and rejection of every pending request when the process exits. A request is written once;
 * a timeout is an error, never a resend.
 *
 * Protocol: the host writes `{type, id, ...}` commands; the child answers `{type: 'response', id, success, data?}`
 * and emits any other record as an event.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { killGroup, processToken } from './process.js';
import { CHANNEL_SOCKET, sandboxEnv, sandboxLaunch } from '../sandbox/sandbox.js';
import type { GitPin } from '../sandbox/git-sandbox.js';
import type { DependencyBind } from '../sandbox/staging.js';

export type PiRecord = Record<string, unknown> & { type: string };
/**
 * `refused: 'before_input'` marks an explicit refusal the child made before pi ran any input hook, staging or queue
 * action: the only negative reply that proves no effect. Any other negative reply after dispatch is unknown.
 */
export type PiResponse = { type: 'response'; id: string; success: boolean; data?: Record<string, unknown>; error?: string; refused?: 'before_input' };

/** One child report, read from the child's inherited report descriptor (FD 3). A claim, never proof. */
export type ChildReport = { report_id: string; kind: 'result' | 'help'; message: string };

/** The report channel's bounds: buffered bytes, reports per child, message bytes. */
export const REPORT_LIMITS = { bufferBytes: 16 * 1024, reports: 32, messageBytes: 8192 } as const;

/** The seam the supervisor drives; the conformance and crash tests supply a deterministic fake. */
export interface SessionHost {
  readonly pid: number | undefined;
  /** The process identity token recorded before the supervisor relies on the pid. */
  readonly token: string | null;
  request(command: PiRecord): Promise<PiResponse>;
  on(event: 'event', listener: (record: PiRecord) => void): this;
  on(event: 'exit', listener: () => void): this;
  /** A typed child's report from its inherited FD 3; never from stdout, which pi and its extensions also write. */
  on(event: 'report', listener: (report: ChildReport) => void): this;
  /** Kills the process group; true only when it was observed gone. */
  stop(): Promise<boolean>;
  /**
   * After an exit: resolves once the FD 3 report channel has closed (every report still in the pipe was emitted), or
   * after REPORT_DRAIN_MS when a descendant still holds it. A host without a report channel resolves at once.
   */
  reportsSettled?(): Promise<void>;
}

/** How long a dead typed child's report channel may stay open before the live missing-report check runs anyway. */
const REPORT_DRAIN_MS = 2000;

export const LINE_LIMIT = 4 * 1024 * 1024;
const STDERR_TAIL = 4096;

export interface LineHostOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** A typed child: a fourth pipe becomes its FD 3, the job-scoped report channel. */
  readonly report?: boolean;
  /** An argv prefix that runs the program inside the worker's cleanup domain (`Containment.enter`). */
  readonly prefix?: readonly string[];
  /**
   * Descriptors the child inherits from FD 4 on, in order (a sandbox's mount sources, sandbox.ts SANDBOX_FD_BASE).
   * The caller keeps and closes its own copies.
   */
  readonly fds?: readonly number[];
}

/** A subprocess speaking the host protocol. Its own process group, so `stop` can kill what it started. */
export class LineHost extends EventEmitter implements SessionHost {
  readonly token: string | null;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (r: PiResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly timeoutMs: number;
  private buffer = '';
  private exited = false;
  private stderrTail = '';
  /** Resolves when the report channel closes (immediately without one). */
  private reportsClosed: Promise<void> = Promise.resolve();

  constructor(executable: string, args: readonly string[], options: LineHostOptions) {
    super();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // SAFETY: stdio 0 to 2 are pipes in both forms, which is all ChildProcessWithoutNullStreams promises.
    const [command, ...argv] = [...(options.prefix ?? []), executable, ...args] as [string, ...string[]];
    const extra = options.fds?.length ? [options.report ? 'pipe' : 'ignore', ...options.fds] : options.report ? ['pipe'] : [];
    this.child = spawn(command, argv, { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', ...extra] as never }) as ChildProcessWithoutNullStreams;
    if (options.report) {
      const channel = this.child.stdio[3] as Readable;
      this.reportsClosed = new Promise(resolve => channel.once('close', () => resolve()));
      this.readReports(channel);
    }
    this.token = this.child.pid ? processToken(this.child.pid) : null;
    this.child.stderr.on('data', (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString('utf8')).slice(-STDERR_TAIL);
    });
    this.child.stdout.on('data', (b: Buffer) => this.read(b));
    this.child.stdin.on('error', e => this.fail(e));
    this.child.once('error', e => this.fail(e));
    this.child.once('exit', () => this.fail(new Error('pi exited')));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /**
   * The report channel: LF-delimited JSON `{report_id, kind, message}` and nothing else. Past its bounds or on any
   * malformed record the host fails and stops the child: a report channel that misbehaves is not trusted further.
   */
  private readReports(channel: Readable): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let count = 0;
    const reject = (reason: string) => {
      channel.destroy();
      this.fail(new Error(reason));
      void this.stop();
    };
    channel.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > REPORT_LIMITS.bufferBytes) return reject('child_report_overflow');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let r: ChildReport;
        try {
          r = JSON.parse(line) as ChildReport;
        } catch {
          return reject('invalid_child_report');
        }
        if (
          ++count > REPORT_LIMITS.reports ||
          !r ||
          typeof r !== 'object' ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(String(r.report_id)) ||
          !['result', 'help'].includes(r.kind) ||
          typeof r.message !== 'string' ||
          Buffer.byteLength(r.message) > REPORT_LIMITS.messageBytes ||
          Object.keys(r).some(k => !['report_id', 'kind', 'message'].includes(k))
        ) {
          return reject('invalid_child_report');
        }
        this.emit('report', r);
      }
    });
    channel.on('error', error => this.fail(error));
  }

  reportsSettled(): Promise<void> {
    return Promise.race([
      this.reportsClosed,
      new Promise<void>(resolve => {
        setTimeout(resolve, REPORT_DRAIN_MS).unref();
      }),
    ]);
  }

  /** The last few KiB of the child's stderr, for diagnostics only. */
  get stderr(): string {
    return this.stderrTail;
  }

  private fail(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.emit('exit');
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line) > LINE_LIMIT) {
        this.fail(new Error('pi stdout line exceeds limit'));
        void this.stop();
        return;
      }
      let record: PiRecord;
      try {
        record = JSON.parse(line) as PiRecord;
      } catch {
        continue; // Isolated non-protocol startup diagnostics.
      }
      if (!record || typeof record !== 'object' || typeof record.type !== 'string') continue;
      const waiter = record.type === 'response' && typeof record.id === 'string' ? this.pending.get(record.id) : undefined;
      if (waiter) {
        this.pending.delete(record.id as string);
        clearTimeout(waiter.timer);
        waiter.resolve(record as PiResponse);
      } else if (record.type !== 'response') this.emit('event', record);
    }
    if (Buffer.byteLength(this.buffer) > LINE_LIMIT) {
      this.fail(new Error('pi stdout line exceeds limit'));
      void this.stop();
    }
  }

  request(command: PiRecord): Promise<PiResponse> {
    if (this.exited) return Promise.reject(new Error('pi not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi ${command.type} response timeout`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // One bounded command per write; the callback fires after the chunk is flushed. No resend on any failure.
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, error => {
        if (!error) return;
        const waiter = this.pending.get(id);
        if (waiter) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async stop(): Promise<boolean> {
    return this.pid ? killGroup(this.pid, this.token) : this.exited;
  }
}

/** What the SDK child needs to open a session. Passed as one JSON argument; never prompt text. */
export interface SdkLaunch {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly projectTrusted: boolean;
  /** A typed child's launch spec: its tools, denials and explicit resources, and nothing discovered. */
  readonly launchSpec?: LaunchSpec | null;
  /** A typed child's job: it gets the FD 3 report channel scoped to this task, and nothing else. */
  readonly taskId?: string | null;
  /** Inventory only (models.list, commands.list by cwd): load the cwd's resources, open no session, answer features. */
  readonly inventory?: boolean;
}

export type LaunchSpec = import('../generated/api.js').components['schemas']['LaunchSpec'];

export const sdkChildEntry = fileURLToPath(new URL('../sdk-child/main.js', import.meta.url));

/** The version of the pi SDK this package pins (read from its package.json, without loading the SDK). */
export function pinnedPiVersion(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as { name: string; version: string };
  if (pkg.name !== '@earendil-works/pi-coding-agent') throw new Error('pi SDK package not found');
  return pkg.version;
}

/** What a typed child inherits: the session basics, locale, pi's own configuration and the model credentials pi reads. */
const TYPED_CHILD_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TERM', 'NO_COLOR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']);
const TYPED_CHILD_ENV_PATTERN = /^(LC_[A-Z]+|XDG_[A-Z_]+_(HOME|DIR|DIRS)|PI_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(API_KEY|AUTH_TOKEN|OAUTH_TOKEN))$/;

/**
 * The child's environment. A root worker gets the supervisor's, without its own PIW_* configuration or any
 * PI_WORKER_* channel a caller set (socket, grant file, report descriptor). A typed child gets only the allowlisted
 * subset of that (so never NODE_OPTIONS, NODE_PATH, LD_PRELOAD or anything else that loads code its launch spec did
 * not name), then exactly its report descriptor and task id. A sandboxed worker (`allowlist`, a sandboxed parent
 * included) gets the same allowlisted subset. A sandboxed worker's bwrap `--clearenv` sets exactly this list inside,
 * with its own HOME, TMPDIR, PATH and agent directory (sandbox.ts `sandboxEnv`).
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env, taskId?: string | null, allowlist = !!taskId): NodeJS.ProcessEnv {
  const out = Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith('PIW_') && !k.startsWith('PI_WORKER_') && (!allowlist || TYPED_CHILD_ENV.has(k) || TYPED_CHILD_ENV_PATTERN.test(k))),
  );
  if (taskId) Object.assign(out, { PI_WORKER_REPORT_FD: '3', PI_WORKER_TASK_ID: taskId, PI_SUBAGENT_ID: taskId });
  return out;
}

/**
 * A sandboxed typed child (P2-4): its root (the real path of its cwd) and the bwrap executable the daemon located.
 * `gitPin` is the root's Git metadata its validation accepted (P2-5): the launch refuses any other.
 */
export interface SdkSandbox {
  readonly root: string;
  readonly bwrap: string;
  readonly gitPin?: GitPin | null;
  /** Its staged profile's dependency trees (P2-7), bound read-only; the caller owns and closes the descriptors. */
  readonly dependencies?: readonly DependencyBind[];
  /**
   * A sandboxed parent's channel (P2-8): its directory, bound read-only at `/run/piw-parent`, and the parent's worker id.
   * Inside, `PI_WORKER_SOCKET` names the channel's socket and `PI_WORKER_ID` the parent; no bearer is given.
   */
  readonly channel?: { readonly dir: string; readonly workerId: string };
}

/** The environment inside a sandbox: `sandboxEnv`, plus a parent's channel socket and its own worker id. */
export function sandboxedEnv(env: NodeJS.ProcessEnv, sandbox: Pick<SdkSandbox, 'root' | 'channel'>): Record<string, string> {
  return { ...sandboxEnv(env, sandbox.root), ...(sandbox.channel ? { PI_WORKER_SOCKET: CHANNEL_SOCKET, PI_WORKER_ID: sandbox.channel.workerId } : {}) };
}

/**
 * The production host: pi's SDK in a dedicated Node process (`sdk-child/main.ts`), run by this Node binary. With
 * `sandbox`, pi runs in the bwrap profile of its root (sandbox.ts): the join prefix stays the outermost wrapper, so
 * bwrap and everything in it run inside the worker's cleanup domain, and the report pipe is FD 3 inside.
 */
export class SdkHost extends LineHost {
  constructor(launch: SdkLaunch, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; prefix?: readonly string[]; sandbox?: SdkSandbox } = {}) {
    const args = [sdkChildEntry, JSON.stringify(launch)];
    const env = childEnv(options.env, launch.taskId, !!launch.taskId || !!options.sandbox);
    const box = options.sandbox
      ? sandboxLaunch(options.sandbox.root, process.execPath, args, {
          env: sandboxedEnv(env, options.sandbox),
          bwrap: options.sandbox.bwrap,
          ...(options.sandbox.gitPin !== undefined ? { gitPin: options.sandbox.gitPin } : {}),
          ...(options.sandbox.dependencies ? { dependencies: options.sandbox.dependencies } : {}),
          ...(options.sandbox.channel ? { channel: options.sandbox.channel.dir } : {}),
        })
      : undefined;
    try {
      super(box ? box.command : process.execPath, box ? box.args : args, {
        cwd: launch.cwd,
        env: box ? box.env : env,
        report: !!launch.taskId,
        ...(box ? { fds: box.fds } : {}),
        ...(options.prefix ? { prefix: options.prefix } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    } finally {
      // The child has its own copies of the mount sources now (or there is no child): the supervisor keeps none open.
      box?.close();
    }
  }
}
