/**
 * Phone inventory and features (P1-14, contract 8.1): session rows from the resume catalog, a session's raw lines by
 * byte range (Shep's S-1), the model and command catalogs pi reports (from the worker's pi, or a short-lived
 * inventory process for a cwd before any worker exists), and `session.configure` (model, thinking level, name).
 *
 * `session.configure` is a session write: it names the binding it saw, is refused under a fence, during a binding
 * move and while an execution runs, records its dispatch before the write to pi, and after that only pi's explicit
 * refusal before any change is `no_effect`; anything else is `outcome_unknown` and fences the session.
 */
import { realpathSync, statSync } from 'node:fs';
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import type { RawReply } from '../b2/router.js';
import type { components } from '../generated/api.js';
import { HISTORY_LINE_MAX_BYTES, readHistory } from '../history/session-file.js';
import type { PiRecord, SessionHost } from '../host/host.js';
import type { Receipt } from '../receipts/receipts.js';
import type { Fence } from './fence.js';
import type { Input } from './input.js';
import type { Lifecycle } from './lifecycle.js';
import { HOLDING, type Live, type SupervisorState } from './state.js';

export type Configure = components['schemas']['Configure'];
export type SessionRow = components['schemas']['SessionRow'];
export type ModelList = components['schemas']['ModelList'];
export type CommandList = components['schemas']['CommandList'];
export type Command = components['schemas']['Command'];
type Thinking = components['schemas']['Thinking'];

/** A short-lived pi process for a cwd that answers `features` and opens no session (sdk-child inventory mode). */
export type InventoryFactory = (cwd: string, projectTrusted: boolean) => SessionHost;

/**
 * pi 1.5.2's built-in slash commands (its `BUILTIN_SLASH_COMMANDS`, not exported) and how B2 serves each: a typed
 * method, or nothing (refused explicitly). The pinned SDK is the source; a pi upgrade revisits this table.
 */
export const BUILTIN_COMMANDS: readonly { name: string; description: string; argument_hint?: string; method: string | null }[] = [
  { name: 'settings', description: 'Open settings menu', method: null },
  { name: 'model', description: 'Select model', argument_hint: '<provider/model>', method: 'session.configure' },
  { name: 'tree', description: 'Navigate session tree (switch branches)', method: 'sessions.rebind' },
  { name: 'thinking', description: 'Set thinking level', argument_hint: '<level>', method: 'session.configure' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling', method: null },
  { name: 'export', description: 'Export session', method: null },
  { name: 'import', description: 'Import a JSONL session', method: null },
  { name: 'share', description: 'Share session', method: null },
  { name: 'bug', description: 'Report a bug to the Pi developers', argument_hint: '<description>', method: null },
  { name: 'copy', description: 'Copy last agent message to clipboard', method: null },
  { name: 'name', description: 'Set session display name', method: 'session.configure' },
  { name: 'session', description: 'Show session info and stats', method: 'sessions.get' },
  { name: 'changelog', description: 'Show changelog entries', method: null },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts', method: null },
  { name: 'fork', description: 'Create a new fork from a previous user message', method: 'sessions.rebind' },
  { name: 'clone', description: 'Duplicate the current session at the current position', method: 'sessions.rebind' },
  { name: 'trust', description: 'Save project trust decision for future sessions', method: null },
  { name: 'login', description: 'Configure provider authentication', argument_hint: '<provider>', method: null },
  { name: 'logout', description: 'Remove provider authentication', method: null },
  { name: 'new', description: 'Start a new session', method: 'sessions.new' },
  { name: 'compact', description: 'Manually compact the session context', method: 'sessions.compact' },
  { name: 'resume', description: 'Resume another session', method: 'sessions.rebind' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes, and context files', method: 'resources.reload' },
  { name: 'quit', description: 'Quit pi', method: null },
];

/** The command rows: built-ins with their method, then pi's own commands (extension, prompt template, skill). */
export function commandRows(own: readonly { name: string; description: string | null; source: 'extension' | 'prompt' | 'skill' }[]): Command[] {
  const builtins: Command[] = BUILTIN_COMMANDS.map(b => ({
    name: b.name,
    description: b.description,
    source: 'builtin',
    argument_hint: b.argument_hint ?? null,
    invocation: b.method ? 'method' : 'unsupported',
    method: b.method,
  }));
  // Extension commands run through commands.invoke; prompt templates and skills are not served through B2 yet.
  const rest: Command[] = own.map(c => ({
    name: c.name.slice(0, 256),
    description: c.description,
    source: c.source,
    argument_hint: null,
    invocation: c.source === 'extension' ? 'commands.invoke' : 'unsupported',
    method: null,
  }));
  return [...builtins, ...rest];
}

const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export class Features {
  /** The inventory process for `cwd` queries; without it they refuse `inventory_unavailable`. */
  inventory?: InventoryFactory;
  /** Builds the command rows from pi's own commands. */
  rows = commandRows;

  constructor(
    readonly s: SupervisorState,
    readonly lifecycle: Lifecycle,
    readonly input: Input,
    readonly fence: Fence,
  ) {
    lifecycle.observers.push((live, event) => this.observe(live, event));
  }

  /** pi reports its model, thinking level and session name: the row follows (memory; journaled with the next record). */
  private observe(live: Live, event: PiRecord): void {
    if (event.type !== 'host_config') return;
    const w = live.worker;
    const model = event.model as { provider?: unknown; id?: unknown } | null;
    if (model && typeof model.provider === 'string' && typeof model.id === 'string') w.model = { provider: model.provider.slice(0, 128), id: model.id.slice(0, 256) };
    if (typeof event.thinking === 'string' && THINKING.has(event.thinking)) w.thinking = event.thinking as Thinking;
    if (typeof event.name === 'string' || event.name === null) w.title = typeof event.name === 'string' ? event.name.slice(0, 512) : null;
    this.s.publishChanged(live);
  }

  /** One session row from the catalog, or null when the catalog does not know the session. */
  row(sessionId: string): (SessionRow & { cwd: string }) | null {
    const known = this.s.sessionFiles.get(sessionId);
    const owner = known ? this.s.workers.get(known.worker_id) : undefined;
    if (!known || !owner) return null;
    const summary = this.s.summaries.get(known.file);
    const holder = [...this.s.workers.values()].find(l => l.worker.session_id === sessionId && HOLDING.has(l.worker.status));
    return {
      session_id: sessionId,
      chat_id: sessionId,
      runtime: 'worker',
      cwd: owner.worker.cwd,
      title: summary.title,
      preview: summary.preview,
      created_at: summary.created_at,
      last_activity_at: summary.last_activity_at,
      message_count: summary.message_count,
      holder_worker_id: holder?.worker.worker_id ?? this.s.sessionReservations.get(sessionId) ?? null,
      last_worker_id: owner.worker.worker_id,
      fenced: !!owner.worker.fence,
      lineage: owner.worker.parent_worker_id ? 'child' : 'root',
      stats: summary.stats,
      evidence: 'pi_session_file',
    };
  }

  /** Every catalog row the caller may see, under `cwd` when given, newest activity first. */
  list(visible: (row: SessionRow) => boolean, q: { cwd?: string; limit?: number }): { sessions: SessionRow[]; truncated: boolean } {
    let cwd: string | undefined;
    if (q.cwd !== undefined) {
      try {
        cwd = realpathSync(q.cwd);
      } catch {
        cwd = q.cwd;
      }
    }
    const rows = [...this.s.sessionFiles.keys()]
      .map(id => this.row(id))
      .filter((r): r is SessionRow => r !== null && (cwd === undefined || r.cwd === cwd) && visible(r))
      .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '') || a.session_id.localeCompare(b.session_id));
    const limit = q.limit ?? 100;
    return { sessions: rows.slice(0, limit), truncated: rows.length > limit };
  }

  /** A session file's complete lines by byte range (sessions.history); a bad offset is a typed 400, never empty. */
  history(sessionId: string, q: { offset?: number; max_bytes?: number; identity?: string; tail?: string }): RawReply {
    const known = this.s.sessionFiles.get(sessionId);
    if (!known) throw new Refusal('unknown_session');
    const read = readHistory(known.file, {
      offset: q.offset ?? 0,
      maxBytes: q.max_bytes ?? 1024 * 1024,
      ...(q.identity !== undefined ? { identity: q.identity } : {}),
      ...(q.tail !== undefined ? { tail: q.tail } : {}),
    });
    if ('error' in read) throw new Refusal(read.error, 'no_effect', undefined, {}, read.error === 'history_line_too_large' ? 409 : 400);
    return {
      contentType: 'application/x-ndjson',
      body: read.body,
      headers: {
        'piw-session-id': sessionId,
        'piw-file-identity': read.identity,
        'piw-offset': read.offset,
        'piw-next-offset': read.nextOffset,
        'piw-watermark': read.watermark,
        'piw-reset': read.reset,
        ...(read.tail ? { 'piw-tail-sha256': read.tail } : {}),
        'piw-history-line-max': HISTORY_LINE_MAX_BYTES,
      },
    };
  }

  /** pi's `features` answer: from the worker's own pi, or from an inventory process for a cwd. */
  private async features(target: { worker_id?: string; cwd?: string; project_trusted?: boolean }): Promise<{ data: Record<string, unknown>; evidence: 'pi_worker_process' | 'pi_inventory_process' }> {
    if ((target.worker_id === undefined) === (target.cwd === undefined)) throw new Refusal('name_exactly_one_of_worker_id_or_cwd', 'no_effect', undefined, {}, 400);
    if (target.worker_id !== undefined) {
      const live = this.s.require(target.worker_id);
      if (live.worker.status !== 'ready' || !live.host || live.faulted) throw new Refusal('worker_not_ready');
      const reply = await live.host.request({ type: 'features' });
      if (!reply.success || !reply.data) throw new Refusal('pi_features_unavailable');
      return { data: reply.data, evidence: 'pi_worker_process' };
    }
    let cwd: string;
    try {
      if (!statSync(target.cwd!).isDirectory()) throw new Error('not a directory');
      cwd = realpathSync(target.cwd!);
    } catch {
      throw new Refusal('cwd_not_directory');
    }
    if (!this.inventory) throw new Refusal('inventory_unavailable');
    const host = this.inventory(cwd, target.project_trusted === true);
    try {
      const reply = await host.request({ type: 'features' });
      if (!reply.success || !reply.data) throw new Refusal('pi_features_unavailable');
      return { data: reply.data, evidence: 'pi_inventory_process' };
    } finally {
      await host.stop();
    }
  }

  async models(target: { worker_id?: string; cwd?: string; project_trusted?: boolean }): Promise<ModelList> {
    const { data, evidence } = await this.features(target);
    const levels = Array.isArray(data.thinking_levels) ? data.thinking_levels.filter(l => typeof l === 'string' && THINKING.has(l)) : [];
    return {
      models: (Array.isArray(data.models) ? data.models : []) as ModelList['models'],
      current: (data.current ?? null) as ModelList['current'],
      thinking: typeof data.thinking === 'string' && THINKING.has(data.thinking) ? (data.thinking as Thinking) : null,
      thinking_levels: levels as Thinking[],
      evidence,
    };
  }

  async commands(target: { worker_id?: string; cwd?: string; project_trusted?: boolean }): Promise<CommandList> {
    const { data, evidence } = await this.features(target);
    const own = (Array.isArray(data.commands) ? data.commands : []) as { name: string; description: string | null; source: 'extension' | 'prompt' | 'skill' }[];
    return { commands: this.rows(own), evidence };
  }

  /** `session.configure`: model, thinking level and name through pi, as one session write. */
  async configure(id: string, c: Configure): Promise<Receipt> {
    const prior = this.s.receipts.all.get(c.command_id);
    const fresh = !prior || prior.state === 'intent_ready';
    let live!: Live;
    const receipt = await this.s.receipts.run(
      c.command_id,
      'session.configure',
      { ...c, worker_id: id },
      async () => {
        const w = live.worker;
        const response = await this.s.receipts.dispatchThen(c.command_id, { worker_id: id }, () =>
          live.host!.request({ type: 'configure', ...(c.model ? { model: c.model } : {}), ...(c.thinking ? { thinking: c.thinking } : {}), ...(c.name !== undefined ? { name: c.name } : {}) }),
        );
        // Only the child's explicit refusal before its first change proves nothing happened.
        if (!response.success && response.refused === 'before_input') throw new ProvenNoEffect(`pi_refused_configure: ${String(response.error).slice(0, 64)}`, 'host_refused_before_any_change');
        if (!response.success) throw new Error(`pi_configure_failed_after_dispatch: ${String(response.error ?? 'negative_reply').slice(0, 64)}`);
        const d = response.data ?? {};
        const model = d.model as { provider?: unknown; id?: unknown } | null;
        if (model && typeof model.provider === 'string' && typeof model.id === 'string') w.model = { provider: model.provider, id: model.id };
        if (typeof d.thinking === 'string' && THINKING.has(d.thinking)) w.thinking = d.thinking as Thinking;
        if (typeof d.name === 'string') w.title = d.name.slice(0, 512);
        this.s.refresh(live);
        this.s.persist(live, 'session.configure');
        return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: { model: w.model ?? null, thinking: w.thinking ?? null, name: w.title ?? null } };
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, c);
        this.input.writable(live);
        if (live.worker.status !== 'ready' || !live.host || live.faulted) throw new Refusal('worker_not_ready');
        if (c.model === undefined && c.thinking === undefined && c.name === undefined) throw new Refusal('nothing_to_configure', 'no_effect', undefined, {}, 400);
        if (live.worker.foreground !== 'idle') throw new Refusal('worker_busy');
      },
    );
    if (fresh && receipt.state === 'outcome_unknown') {
      // The change may have happened: the fence is durable before the receipt is returned (invariant 3).
      const uncertain = this.s.require(id);
      if (this.fence.latch(uncertain, c.command_id)) this.s.persist(uncertain, 'fence.latch');
    }
    return receipt;
  }
}
