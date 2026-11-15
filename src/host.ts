/** Small subprocess host seam: RPC now; SDK/ACP subprocesses can implement it later.
 * LF framing, correlation, bounded stderr and rejection on exit adapted from exmach pi.ts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { killGroup, processToken } from './process.js';
export type PiRecord = Record<string, unknown> & { type: string };
export type PiResponse = { type: 'response'; id: string; success: boolean; data?: Record<string, unknown>; error?: string };
export interface SessionHost {
  readonly pid: number | undefined;
  readonly token: string | null;
  request(command: PiRecord): Promise<PiResponse>;
  on(event: 'event', listener: (record: PiRecord) => void): this;
  on(event: 'exit', listener: () => void): this;
  stop(): Promise<boolean>;
}
export class RpcHost extends EventEmitter implements SessionHost {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (r: PiResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private exited = false;
  private stderr = '';
  readonly token: string | null;
  constructor(executable: string, cwd: string, sessionDir: string, provider: string, model: string, thinking: string, readonly timeoutMs = 30_000) {
    super();
    this.child = spawn(executable, ['--mode', 'rpc', '--session-dir', sessionDir, '--provider', provider, '--model', model, '--thinking', thinking], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.token = this.child.pid ? processToken(this.child.pid) : null;
    this.child.stderr.on('data', (b: Buffer) => { this.stderr = (this.stderr + b.toString('utf8')).slice(-4096); });
    this.child.stdout.on('data', (b: Buffer) => this.read(b));
    this.child.stdin.on('error', (e) => this.fail(e));
    this.child.once('error', e => this.fail(e));
    this.child.once('exit', () => this.fail(new Error('pi exited')));
  }
  get pid(): number | undefined { return this.child.pid; }
  private fail(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.emit('exit');
  }
  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, ''); this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) { this.fail(new Error('pi stdout line exceeds limit')); void this.stop(); return; }
      let record: PiRecord;
      try { record = JSON.parse(line) as PiRecord; } catch { continue; } // Isolated non-protocol startup diagnostics.
      if (!record || typeof record.type !== 'string') continue;
      const waiter = record.type === 'response' && typeof record.id === 'string' ? this.pending.get(record.id) : undefined;
      if (waiter) { this.pending.delete(record.id as string); clearTimeout(waiter.timer); waiter.resolve(record as PiResponse); }
      else if (record.type !== 'response') this.emit('event', record);
    }
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.fail(new Error('pi stdout line exceeds limit')); void this.stop(); }
  }
  request(command: PiRecord): Promise<PiResponse> {
    if (this.exited) return Promise.reject(new Error('pi not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`pi ${command.type} response timeout`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // Node's write callback fires after the chunk is flushed; one bounded command is in
      // flight per session. No write loop ignores backpressure or builds an unbounded queue.
      this.child.stdin.write(JSON.stringify({ ...command, id }) + '\n', error => {
        if (!error) return;
        const waiter = this.pending.get(id);
        if (waiter) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  async stop(): Promise<boolean> { return this.pid ? killGroup(this.pid, this.token) : this.exited; }
}
