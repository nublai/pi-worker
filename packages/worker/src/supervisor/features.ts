/**
 * Phone inventory and features (P1-14, contract 8.1): session rows from the resume catalog, a session's raw lines by
 * byte range (Shep's S-1), the model and command catalogs pi reports (from the worker's pi, or a short-lived
 * inventory process for a cwd before any worker exists), and `session.configure` (model, thinking level, name).
 *
 * `session.configure` is a session write: it names the binding it saw, is refused under a fence, during a binding
 * move and while an execution runs, records its dispatch before the write to pi, and after that only pi's explicit
 * refusal before any change is `no_effect`; anything else is `outcome_unknown` and fences the session.
 *
 * An inventory probe is a pi process like a worker's (it loads extensions and MCP servers), so it runs in its own
 * cleanup domain (P2-1): the domain is journaled (`inventory.start`) before the probe is spawned, the probe ends only
 * when the domain is killed, observed empty and removed, and that is journaled (`inventory.cleaned`). A probe whose
 * cleanup is not confirmed (unproven, or a supervisor crash) stays recorded and recovery cleans it before listening.
 */
import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Domain } from '../containment/containment.js';
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import type { RawReply } from '../b2/router.js';
import type { components } from '../generated/api.js';
import { createHash } from 'node:crypto';
import { HISTORY_LINE_MAX_BYTES, readHistory } from '../history/session-file.js';
import { SessionIndex } from '../history/session-index.js';
import { sniff } from '../attachments/attachments.js';
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

/** What an inventory probe is launched with: its cwd, its trust, and the cleanup domain it runs in. */
export interface InventoryLaunch {
  /** The real path of the cwd. */
  readonly cwd: string;
  readonly projectTrusted: boolean;
  /** The probe's cleanup domain, recorded and created before the factory runs. */
  readonly domain: Domain;
  /** The argv prefix that runs the probe's program inside the domain (`Containment.enter`). */
  readonly prefix: readonly string[];
}

/** A short-lived pi process for a cwd that answers `features` and opens no session (sdk-child inventory mode). */
export type InventoryFactory = (launch: InventoryLaunch) => SessionHost;

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

/** The largest image blobs.read returns, and the longest entry line it parses to find one. */
export const BLOB_MAX_BYTES = 16 * 1024 * 1024;
const BLOB_LINE_MAX_BYTES = 64 * 1024 * 1024;
const BLOB_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** The image blocks of an entry, in document order. */
function images(value: unknown, out: { data: string; mimeType: unknown }[] = [], depth = 0): { data: string; mimeType: unknown }[] {
  if (depth > 64 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) images(v, out, depth + 1);
    return out;
  }
  const r = value as Record<string, unknown>;
  if (r.type === 'image' && typeof r.data === 'string') {
    out.push({ data: r.data, mimeType: r.mimeType });
    return out;
  }
  for (const v of Object.values(r)) images(v, out, depth + 1);
  return out;
}

const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export class Features {
  /** The inventory process for `cwd` queries; without it they refuse `inventory_unavailable`. */
  inventory?: InventoryFactory;
  /** Builds the command rows from pi's own commands. */
  rows = commandRows;
  /** Inventory probes whose domain is recorded and not yet confirmed removed, by probe id (from the journal). */
  private readonly probes = new Map<string, Domain>();

  constructor(
    readonly s: SupervisorState,
    readonly lifecycle: Lifecycle,
    readonly input: Input,
    readonly fence: Fence,
  ) {
    lifecycle.observers.push((live, event) => this.observe(live, event));
    for (const record of s.journal.records) {
      if (record.kind !== 'inventory') continue;
      const id = String(record.value.inventory_id);
      // SAFETY: every `inventory` record is written by features() or retire() below with the probe's Domain.
      if (record.value.state === 'cleaned') this.probes.delete(id);
      else this.probes.set(id, structuredClone(record.value.domain) as Domain);
    }
  }

  /** Probe ids whose cleanup is not confirmed yet. */
  pendingProbes(): string[] {
    return [...this.probes.keys()];
  }

  /**
   * Kills the probe's domain, waits for `populated 0` and removal, then records the confirmation. False (and the probe
   * stays recorded) when the removal was not observed or its record could not be made durable. Never throws.
   */
  private async retire(id: string, domain: Domain): Promise<boolean> {
    const gone = await this.lifecycle.containment.clean(domain).catch(() => false);
    if (!gone) return false;
    try {
      this.s.journal.append('inventory', { inventory_id: id, state: 'cleaned', domain }, 'inventory.cleaned');
    } catch {
      return false;
    }
    this.probes.delete(id);
    return true;
  }

  /** After a restart, before the socket listens: every recorded probe's domain is cleaned; unproven ones stay recorded. */
  async recover(): Promise<void> {
    for (const [id, domain] of [...this.probes]) await this.retire(id, domain);
  }

  /** Kills every recorded probe's domain; used on SIGTERM. Records nothing: the next start cleans and confirms. */
  async shutdown(): Promise<void> {
    for (const domain of this.probes.values()) await this.lifecycle.containment.clean(domain).catch(() => false);
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
  history(sessionId: string, q: { offset?: number; max_bytes?: number; identity?: string; tail?: string; prefix?: string }): RawReply {
    const known = this.s.sessionFiles.get(sessionId);
    if (!known) throw new Refusal('unknown_session');
    const read = readHistory(known.file, {
      offset: q.offset ?? 0,
      maxBytes: q.max_bytes ?? 1024 * 1024,
      ...(q.identity !== undefined ? { identity: q.identity } : {}),
      ...(q.tail !== undefined ? { tail: q.tail } : {}),
      ...(q.prefix !== undefined ? { prefix: q.prefix } : {}),
    }, this.s.summaries.generations);
    if ('error' in read) throw new Refusal(read.error, 'no_effect', undefined, {}, read.error === 'history_line_too_large' || read.error === 'session_file_not_regular' ? 409 : 400);
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
        'piw-prefix-sha256': read.prefix,
        'piw-history-line-max': HISTORY_LINE_MAX_BYTES,
      },
    };
  }

  /** One image of a session entry as bytes (blobs.read): an allowed media type that matches its magic, within the cap. */
  blob(sessionId: string, entryId: string, index: number): RawReply {
    const known = this.s.sessionFiles.get(sessionId);
    if (!known) throw new Refusal('unknown_session');
    const line = new SessionIndex(known.file).raw(entryId, BLOB_LINE_MAX_BYTES);
    if (line === null) throw new Refusal('unknown_entry');
    if ('error' in line) throw new Refusal('entry_too_large');
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString('utf8'));
    } catch {
      throw new Refusal('entry_unreadable');
    }
    const found = images(entry)[index];
    if (!found) throw new Refusal('unknown_blob');
    const mime = typeof found.mimeType === 'string' ? found.mimeType.toLowerCase() : '';
    if (!BLOB_TYPES.has(mime)) throw new Refusal('blob_type_not_allowed');
    if (found.data.length > Math.ceil(BLOB_MAX_BYTES / 3) * 4 + 4) throw new Refusal('blob_too_large');
    const bytes = Buffer.from(found.data, 'base64');
    if (bytes.length > BLOB_MAX_BYTES) throw new Refusal('blob_too_large');
    const gif = bytes.subarray(0, 6).toString('latin1');
    const magic = mime === 'image/gif' ? gif === 'GIF87a' || gif === 'GIF89a' : sniff(bytes.subarray(0, 16)) === mime;
    if (!magic) throw new Refusal('blob_type_mismatch');
    return {
      contentType: mime,
      body: bytes,
      headers: {
        'piw-session-id': sessionId,
        'piw-entry-id': entryId,
        'piw-blob-index': index,
        'piw-blob-sha256': createHash('sha256').update(bytes).digest('hex'),
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
    const containment = this.lifecycle.containment;
    const id = randomUUID();
    const domain = containment.reserve(`inventory-${id}`);
    // The probe's domain is durable before anything is spawned: from here on a crash leaves a record recovery cleans.
    try {
      this.s.journal.append('inventory', { inventory_id: id, state: 'started', domain }, 'inventory.start');
    } catch {
      throw new Refusal('inventory_unavailable');
    }
    this.probes.set(id, domain);
    let answer: { data: Record<string, unknown>; evidence: 'pi_inventory_process' } | undefined;
    let failure: unknown;
    try {
      const host = this.inventory({ cwd, projectTrusted: target.project_trusted === true, domain, prefix: containment.enter(domain) });
      const reply = await host.request({ type: 'features' });
      if (!reply.success || !reply.data) throw new Refusal('pi_features_unavailable');
      answer = { data: reply.data, evidence: 'pi_inventory_process' };
    } catch (error) {
      failure = error;
    }
    // The probe ends only when its domain is removed and recorded: the host's own stop (a process-group kill) is no
    // proof that a detached descendant is gone.
    if (!(await this.retire(id, domain))) throw new Refusal('inventory_cleanup_unproven');
    if (!answer) throw failure;
    return answer;
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
        // Synchronous with the checks below: the worker is occupied by this write until pi's reply.
        live.command = c.command_id;
        let response;
        try {
          response = await this.s.receipts.dispatchThen(c.command_id, { worker_id: id }, () =>
            live.host!.request({ type: 'configure', ...(c.model ? { model: c.model } : {}), ...(c.thinking ? { thinking: c.thinking } : {}), ...(c.name !== undefined ? { name: c.name } : {}) }),
          );
        } finally {
          live.command = undefined;
          setImmediate(() => void this.input.flush(live));
        }
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
        if (live.worker.foreground !== 'idle' || live.command) throw new Refusal('worker_busy');
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
