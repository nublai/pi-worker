/**
 * What pi is doing right now, for the working bubble and the Chats row (b2-for-shep.md section 3, P1-19):
 * `assistant.delta` from pi's `message_update` text deltas and `tool.started` / `tool.finished` from its
 * `tool_execution_start` / `tool_execution_end`. All three are memory only and never replayed; a reconnect or an
 * overflow loses them by design, and the snapshot never carries them.
 *
 * Bounded at every step: a delta carries the message's text tail (at most TAIL_CHARS), never the message, and the
 * hub keeps at most one undelivered delta per worker for a backpressured subscriber (events/hub.ts), so a delta
 * storm cannot overflow a subscriber queue. Tool ids, names and summaries are cut to the schema's bounds.
 */
import { headOf } from '../history/session-file.js';
import type { PiRecord } from '../host/host.js';
import type { Lifecycle } from './lifecycle.js';
import type { Live, SupervisorState } from './state.js';

/** The most characters of assistant text one `assistant.delta` carries (the schema's `tail` maxLength). */
export const TAIL_CHARS = 2048;
const TOOL_ID_CHARS = 512;
const TOOL_NAME_CHARS = 128;
const SUMMARY_CHARS = 200;
/** In-flight tool calls remembered per worker, for the summary `tool.finished` repeats. */
const TOOLS_PER_WORKER = 64;
const SUMMARY_ARGS = ['command', 'path', 'file_path', 'pattern', 'url', 'query', 'description'];

/** The last `n` UTF-16 code units of `text`, never starting inside a surrogate pair. */
export function tailOf(text: string, n = TAIL_CHARS): string {
  if (text.length <= n) return text;
  let start = text.length - n;
  const c = text.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) start++;
  return text.slice(start);
}

/** The text parts of pi's partial assistant message, joined as the session file's preview joins them. */
function assistantText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== 'assistant') return null;
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return null;
  return m.content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map(c => c.text)
    .join('\n');
}

/** One line about a tool call: the first string argument of SUMMARY_ARGS, cut to SUMMARY_CHARS. */
function summaryOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  for (const key of SUMMARY_ARGS) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return headOf(v.trim().replace(/\s+/g, ' '), SUMMARY_CHARS);
  }
  return null;
}

/** pi's text delta as `assistant.delta`: the message's text tail and length. */
function delta(s: SupervisorState, live: Live, event: PiRecord): void {
  const update = event.assistantMessageEvent as { type?: unknown } | undefined;
  if (update?.type !== 'text_delta') return;
  const text = assistantText(event.message);
  if (text === null) return;
  const w = live.worker;
  s.events.publish('assistant.delta', { worker_id: w.worker_id, execution_id: w.execution?.execution_id ?? null, data: { tail: tailOf(text), length: text.length } });
}

/** Wires the activity observer: pi's own SDK events become the three transient events. */
export function activity(s: SupervisorState, lifecycle: Lifecycle): void {
  const tools = new WeakMap<Live, Map<string, string | null>>();
  lifecycle.observers.push((live, event: PiRecord) => {
    if (event.type === 'message_update') return delta(s, live, event);
    if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
    if (typeof event.toolCallId !== 'string' || !event.toolCallId || typeof event.toolName !== 'string' || !event.toolName) return;
    const w = live.worker;
    const execution_id = w.execution?.execution_id ?? null;
    const tool_call_id = headOf(event.toolCallId, TOOL_ID_CHARS);
    const name = headOf(event.toolName, TOOL_NAME_CHARS);
    const pending = tools.get(live) ?? new Map<string, string | null>();
    tools.set(live, pending);
    if (event.type === 'tool_execution_start') {
      const summary = summaryOf(event.args);
      pending.set(tool_call_id, summary);
      // A tool that never reported its end is forgotten first: the map stays bounded.
      if (pending.size > TOOLS_PER_WORKER) pending.delete(pending.keys().next().value!);
      s.events.publish('tool.started', { worker_id: w.worker_id, execution_id, data: { tool_call_id, name, summary } });
      return;
    }
    const summary = pending.get(tool_call_id) ?? null;
    pending.delete(tool_call_id);
    s.events.publish('tool.finished', { worker_id: w.worker_id, execution_id, data: { tool_call_id, name, summary, is_error: event.isError === true } });
  });
}
