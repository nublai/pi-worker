/** SDK-owned live resolvers. Single event-loop compare/delete is the linearization point.
 * No answer values survive a resolution or enter control events. */
import { randomUUID } from 'node:crypto';
import type { PiRecord } from './host.js';
export type DialogKind = 'select' | 'confirm' | 'input' | 'editor' | 'tool_approval';
export type UIAnswer = { outcome: 'answer' | 'cancel'; value?: string | boolean; option_id?: string };
export type ResolverResult = { consumed: boolean; outcome: string };
type Waiter = { kind: DialogKind; deadline: number; options?: string[]; resolve: (v: unknown) => void; timer: NodeJS.Timeout; removeAbort: () => void };
export class Resolvers {
  readonly pending = new Map<string, Waiter>();
  constructor(readonly emit: (r: PiRecord) => void, readonly now = Date.now) {}
  ask(kind: DialogKind, content: Record<string, unknown>, opts?: { timeout?: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new Error('dialog_capacity'));
    const id = randomUUID(); const timeout = Math.max(1, Math.min(opts?.timeout ?? 30000, 30000));
    const deadline = this.now() + timeout;
    return new Promise(resolve => {
      const abort = () => this.finish(id, 'aborted');
      const timer = setTimeout(() => this.finish(id, 'timeout'), timeout); timer.unref();
      this.pending.set(id, { kind, deadline, options: content.options as string[] | undefined, resolve, timer, removeAbort: () => opts?.signal?.removeEventListener('abort', abort) });
      opts?.signal?.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'extension_ui_request', id, method: kind, ...content, deadline, timeout });
      if (opts?.signal?.aborted) abort();
    });
  }
  answer(id: string, answer: UIAnswer): ResolverResult {
    const p = this.pending.get(id);
    if (!p) return { consumed: false, outcome: 'not_pending' };
    if (this.now() >= p.deadline) { this.finish(id, 'timeout'); return { consumed: false, outcome: 'timeout' }; }
    if (answer.outcome === 'cancel') return this.finish(id, 'cancel');
    if (p.kind === 'confirm' || p.kind === 'tool_approval') {
      if (typeof answer.value !== 'boolean' || answer.option_id !== undefined) return { consumed: false, outcome: 'invalid_answer' };
    } else if (p.kind === 'select') {
      const i = Number(answer.option_id);
      if (!/^\d+$/.test(answer.option_id ?? '') || String(i) !== answer.option_id || !Number.isSafeInteger(i) || !p.options || i >= p.options.length || answer.value !== undefined) return { consumed: false, outcome: 'invalid_option' };
      return this.finish(id, 'answered', p.options[i]);
    } else if (typeof answer.value !== 'string' || Buffer.byteLength(answer.value) > 65536 || answer.option_id !== undefined) return { consumed: false, outcome: 'invalid_text' };
    return this.finish(id, answer.value === false ? 'no' : 'answered', answer.value);
  }
  private finish(id: string, outcome: string, value?: unknown): ResolverResult {
    const p = this.pending.get(id);
    if (!p) return { consumed: false, outcome: 'not_pending' };
    this.pending.delete(id); clearTimeout(p.timer); p.removeAbort();
    p.resolve(value ?? (p.kind === 'confirm' || p.kind === 'tool_approval' ? false : undefined));
    this.emit({ type: 'resolver_closed', native_id: id, outcome });
    return { consumed: true, outcome };
  }
  abortAll(): void { for (const id of this.pending.keys()) this.finish(id, 'aborted'); }
}
