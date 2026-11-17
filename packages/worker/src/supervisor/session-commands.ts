/**
 * Session commands (P1-15): `sessions.compact`, `resources.reload` and `commands.invoke` (an extension command from
 * `commands.list`). Each is a session-directed mutation (contract invariant 3 lists compact, command invoke and
 * reload among the writes a fence refuses): it names the binding it saw; it is refused `no_effect` under a fence,
 * during a binding move and while an execution or another session command runs; while it runs it occupies the worker
 * (`Live.command`), so a prompt, a binding move or another session write is refused busy and the binding it named
 * holds until pi has the command; its dispatch record precedes the write to pi; after it, only pi's explicit refusal
 * before any change, with no live dialog cancelled by this command, is `no_effect`, and a lost reply is
 * `outcome_unknown` that fences the session durably before the receipt returns. Built-ins with their own method are
 * refused `use_method`, others `unsupported_command`, both before any record.
 */
import { ProvenNoEffect, Refusal } from '../b2/errors.js';
import type { components } from '../generated/api.js';
import type { PiRecord } from '../host/host.js';
import type { Receipt, ReceiptPatch } from '../receipts/receipts.js';
import { BUILTIN_COMMANDS } from './features.js';
import type { Fence } from './fence.js';
import type { Input } from './input.js';
import type { Live, SupervisorState, Binding } from './state.js';

export type Compact = components['schemas']['Compact'];
export type Invoke = components['schemas']['Invoke'];
type Operation = 'sessions.compact' | 'resources.reload' | 'commands.invoke';

/** The extension commands a worker's pi reported at ready or after its last reload. */
export function extensionCommands(live: Live): Set<string> {
  const commands = (live.worker.resources as { commands?: { name?: unknown; source?: unknown }[] } | undefined)?.commands ?? [];
  return new Set(commands.filter(c => c.source === 'extension' && typeof c.name === 'string').map(c => c.name as string));
}

export class SessionCommands {
  constructor(
    readonly s: SupervisorState,
    readonly input: Input,
    readonly fence: Fence,
  ) {}

  compact(id: string, c: Compact): Promise<Receipt> {
    return this.run(id, 'sessions.compact', c, { type: 'compact', ...(c.custom_instructions ? { customInstructions: c.custom_instructions } : {}) }, true, data => ({
      tokens_before: typeof data.tokens_before === 'number' ? data.tokens_before : null,
      first_kept_entry_id: typeof data.first_kept_entry_id === 'string' ? data.first_kept_entry_id : null,
    }));
  }

  reload(id: string, b: Binding): Promise<Receipt> {
    return this.run(id, 'resources.reload', b, { type: 'reload' }, true, (data, live) => {
      // The row's resources follow pi's loader; errors are reported, never hidden.
      const { extension_errors: errors = [], ...rest } = data as { extension_errors?: unknown[] };
      live.worker.resources = { ...rest, extension_errors: errors };
      return { extension_errors: errors };
    });
  }

  invoke(id: string, v: Invoke): Promise<Receipt> {
    return this.run(
      id,
      'commands.invoke',
      v,
      { type: 'invoke', name: v.name, ...(v.args !== undefined ? { args: v.args } : {}) },
      false,
      data => ({ disposition: typeof data.disposition === 'string' ? data.disposition : 'handled' }),
      live => {
        const builtin = BUILTIN_COMMANDS.find(b => b.name === v.name);
        if (builtin?.method) throw new Refusal('use_method', 'no_effect', undefined, { detail: builtin.method });
        if (builtin || v.name.startsWith('skill:')) throw new Refusal('unsupported_command');
        if (!extensionCommands(live).has(v.name)) throw new Refusal('unknown_command');
      },
    );
  }

  /** The shared flow of a session command. `cancelDialogs`: live dialogs are cancelled at their resolvers first. */
  private async run(
    id: string,
    operation: Operation,
    request: Binding | Compact | Invoke,
    command: PiRecord,
    cancelDialogs: boolean,
    result: (data: Record<string, unknown>, live: Live) => Record<string, unknown>,
    check: (live: Live) => void = () => {},
  ): Promise<Receipt> {
    const prior = this.s.receipts.all.get(request.command_id);
    const fresh = !prior || prior.state === 'intent_ready';
    let live!: Live;
    const receipt = await this.s.receipts.run(
      request.command_id,
      operation,
      { ...request, worker_id: id },
      async (): Promise<ReceiptPatch> => {
        // Synchronous with the checks below: from here until pi's reply the worker is occupied by this command.
        live.command = request.command_id;
        try {
          this.s.receipts.dispatch(request.command_id, { worker_id: id });
          let cancelled = 0;
          if (cancelDialogs) {
            // A compaction or a reload replaces what live dialogs belong to: they are cancelled, never answered.
            cancelled = (await this.s.interactions?.cancelAll(id, live.host!)) ?? 0;
            // pi may have moved natively while the cancellations ran (a dialog's continuation): the command never goes
            // to a session the request did not name. The cancellations already happened, so this is not no_effect.
            this.s.binding(live, request);
            if (live.rebinding || live.nativeRebinding) throw new Error('binding_change_during_session_command');
          }
          const response = await live.host!.request(command);
          if (live.faulted) throw new Error('worker fault during session command');
          if (!response.success && response.refused === 'before_input') {
            // pi's refusal proves only that its own step changed nothing; a dialog this command cancelled has already
            // run its continuation, so the request as a whole is not proven to have had no effect.
            if (cancelled > 0) throw new Error(`pi_refused_${operation}_after_dialog_cancel: ${String(response.error).slice(0, 64)}`);
            throw new ProvenNoEffect(`pi_refused_${operation}: ${String(response.error).slice(0, 64)}`, 'host_refused_before_any_change');
          }
          if (!response.success) throw new Error(`pi_${operation}_failed_after_dispatch: ${String(response.error ?? 'negative_reply').slice(0, 64)}`);
          const out = result(response.data ?? {}, live);
          this.s.refresh(live);
          this.s.persist(live, 'session.command');
          return { state: 'delivered', stage: 'forwarded', effect: 'observed', result: out };
        } finally {
          live.command = undefined;
          // Queued input held back while the command ran may dispatch now.
          setImmediate(() => void this.input.flush(live));
        }
      },
      () => {
        live = this.s.require(id);
        this.s.binding(live, request);
        this.input.writable(live);
        if (live.worker.status !== 'ready' || !live.host || live.faulted) throw new Refusal('worker_not_ready');
        check(live);
        if (live.worker.foreground !== 'idle' || live.command) throw new Refusal('worker_busy');
      },
    );
    if (fresh && receipt.state === 'outcome_unknown') {
      // The command may have changed the session: the fence is durable before the receipt is returned.
      const uncertain = this.s.require(id);
      if (this.fence.latch(uncertain, request.command_id)) this.s.persist(uncertain, 'fence.latch');
    }
    return receipt;
  }
}
