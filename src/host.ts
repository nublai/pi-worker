/** Small subprocess host seam: selectable RPC, SDK and ACP children.
 * LF framing, correlation, bounded stderr and rejection on exit adapted from exmach pi.ts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { UIAnswer } from './resolvers.js';
import { killGroup, processToken } from './process.js';
export type PiRecord = Record<string, unknown> & { type: string };
export type PiResponse = { type: 'response'; id: string; success: boolean; data?: Record<string, unknown>; error?: string };
export interface SessionHost {
  readonly pid: number | undefined;
  readonly token: string | null;
  request(command: PiRecord): Promise<PiResponse>;
  readonly kind?: 'rpc' | 'sdk' | 'acp';
  answerUI?(nativeId: string, answer: UIAnswer, options?: string[]): Promise<{ stage: 2 | 3; consumed?: boolean; outcome?: string }>;
  cancelUI(nativeId: string): Promise<void>;
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
  readonly kind: 'rpc' | 'sdk' | 'acp';
  constructor(executable: string, cwd: string, sessionDir: string, provider: string, model: string, thinking: string, readonly timeoutMs = 30_000, launch?: { kind: 'sdk' | 'acp'; args: string[] }) {
    super(); this.kind = launch?.kind ?? 'rpc';
    this.child = spawn(executable, launch?.args ?? ['--mode', 'rpc', '--session-dir', sessionDir, '--provider', provider, '--model', model, '--thinking', thinking, '-e', fileURLToPath(new URL('./rpc-audit.js', import.meta.url))], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  protected decode(record: Record<string, unknown>): PiRecord | null { return record as PiRecord; }
  protected encode(command: PiRecord): Record<string, unknown> { return command; }
  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, ''); this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) { this.fail(new Error('pi stdout line exceeds limit')); void this.stop(); return; }
      let record: PiRecord;
      try { const parsed = this.decode(JSON.parse(line)); if (!parsed) continue; record = parsed; } catch { continue; } // Isolated non-protocol startup diagnostics.
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
      this.child.stdin.write(JSON.stringify(this.encode({ ...command, id })) + '\n', error => {
        if (!error) return;
        const waiter = this.pending.get(id);
        if (waiter) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  async answerUI(nativeId: string, answer: UIAnswer, options?: string[]): Promise<{ stage: 2 | 3; consumed?: boolean; outcome?: string }> {
    if (this.kind !== 'rpc') {
      const r = await this.request({ type: 'answer_ui', nativeId, answer });
      if (!r.success) throw new Error(r.error ?? 'answer_failed');
      return { stage: 3, consumed: r.data?.consumed === true, outcome: String(r.data?.outcome) };
    }
    await this.writeUI({ type: 'extension_ui_response', id: nativeId, ...(answer.outcome === 'cancel' ? { cancelled: true } : typeof answer.value === 'boolean' ? { confirmed: answer.value } : { value: answer.option_id !== undefined ? options?.[Number(answer.option_id)] : answer.value }) });
    return { stage: 2 };
  }
  private writeUI(record: PiRecord): Promise<void> {
    if (this.exited) return Promise.reject(new Error('pi not running'));
    return new Promise((resolve, reject) => this.child.stdin.write(JSON.stringify(record) + '\n', error => error ? reject(error) : resolve()));
  }
  cancelUI(nativeId: string): Promise<void> {
    if (this.kind !== 'rpc') return this.answerUI(nativeId, { outcome: 'cancel' }).then(() => {});
    if (this.exited) return Promise.reject(new Error('pi not running'));
    // UI responses are one-way protocol messages, NOT correlated RPC requests.
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: nativeId, cancelled: true }) + '\n', error => error ? reject(error) : resolve());
    });
  }
  async stop(): Promise<boolean> { return this.pid ? killGroup(this.pid, this.token) : this.exited; }
}
