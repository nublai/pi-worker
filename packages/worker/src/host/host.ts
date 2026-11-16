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
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { killGroup, processToken } from './process.js';

export type PiRecord = Record<string, unknown> & { type: string };
/**
 * `refused: 'before_input'` marks an explicit refusal the child made before pi ran any input hook, staging or queue
 * action: the only negative reply that proves no effect. Any other negative reply after dispatch is unknown.
 */
export type PiResponse = { type: 'response'; id: string; success: boolean; data?: Record<string, unknown>; error?: string; refused?: 'before_input' };

/** The seam the supervisor drives; the conformance and crash tests supply a deterministic fake. */
export interface SessionHost {
  readonly pid: number | undefined;
  /** The process identity token recorded before the supervisor relies on the pid. */
  readonly token: string | null;
  request(command: PiRecord): Promise<PiResponse>;
  on(event: 'event', listener: (record: PiRecord) => void): this;
  on(event: 'exit', listener: () => void): this;
  /** Kills the process group; true only when it was observed gone. */
  stop(): Promise<boolean>;
}

export const LINE_LIMIT = 4 * 1024 * 1024;
const STDERR_TAIL = 4096;

export interface LineHostOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
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

  constructor(executable: string, args: readonly string[], options: LineHostOptions) {
    super();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.child = spawn(executable, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
}

export const sdkChildEntry = fileURLToPath(new URL('../sdk-child/main.js', import.meta.url));

/** The version of the pi SDK this package pins (read from its package.json, without loading the SDK). */
export function pinnedPiVersion(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as { name: string; version: string };
  if (pkg.name !== '@earendil-works/pi-coding-agent') throw new Error('pi SDK package not found');
  return pkg.version;
}

/** The child's environment: the supervisor's, without its own PIW_* configuration. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('PIW_')));
}

/** The production host: pi's SDK in a dedicated Node process (`sdk-child/main.ts`), run by this Node binary. */
export class SdkHost extends LineHost {
  constructor(launch: SdkLaunch, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
    super(process.execPath, [sdkChildEntry, JSON.stringify(launch)], { cwd: launch.cwd, env: childEnv(options.env), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  }
}
