/**
 * The receipt crash scenario, shared by the fixture (which runs it) and the oracle (which retries its requests).
 * Native effects go to `effects.jsonl` before anything else can record them: that file is the independent oracle.
 * `PIW_CRASH_EFFECT=<n>` SIGKILLs right after the n-th native effect.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProvenNoEffect, Refusal } from '../../src/b2/errors.js';
import { openState } from '../../src/journal/state.js';
import { ReceiptStore, type Operation, type ReceiptPatch } from '../../src/receipts/receipts.js';

export type Command = { command_id: string; operation: Operation; request: Record<string, unknown> };

export const COMMANDS: Record<string, Command> = Object.fromEntries(
  (
    [
      ['refused', 'sessions.prompt'],
      ['sent', 'sessions.prompt'],
      ['lost', 'sessions.prompt'],
      ['proven', 'sessions.prompt'],
      ['cancel', 'executions.cancel'],
      ['queued', 'sessions.follow_up'],
      ['exit', 'sessions.prompt'],
      ['pending', 'sessions.prompt'],
      ['hanging', 'sessions.prompt'],
    ] as const
  ).map(([command_id, operation]) => [command_id, { command_id, operation, request: { worker_id: 'w', message: `fixture ${command_id}` } }]),
);

export const effectsFile = (root: string) => join(root, 'effects.jsonl');

export function effectsAt(root: string): string[] {
  const file = effectsFile(root);
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => (JSON.parse(line) as { command_id: string }).command_id)
    : [];
}

let effects = 0;
function nativeEffect(root: string, commandId: string): void {
  appendFileSync(effectsFile(root), `${JSON.stringify({ command_id: commandId })}\n`);
  if (process.env.PIW_CRASH_EFFECT === String(++effects)) process.kill(process.pid, 'SIGKILL');
}

const delivered: ReceiptPatch = { state: 'delivered', stage: 'forwarded', effect: 'observed' };
const never = () => new Promise<never>(() => {});

/** Runs the scenario: every receipt transition and label, a restart, owner keep and a single dispatch after it. */
export async function receiptScenario(root: string): Promise<void> {
  let state = openState(root);
  let store = new ReceiptStore(state.journal);
  const run = (id: string, effect: (s: ReceiptStore) => Promise<ReceiptPatch>) => {
    const c = COMMANDS[id]!;
    const target = store;
    return target.run(c.command_id, c.operation, c.request, () => effect(target));
  };
  const send = (s: ReceiptStore, id: string, after?: () => Promise<void>) =>
    s.dispatchThen(id, {}, async () => {
      nativeEffect(root, id);
      await after?.();
    });

  await run('refused', async () => {
    throw new Refusal('refused_before_dispatch');
  });
  await run('sent', async s => (await send(s, 'sent'), delivered));
  await run('lost', async s => {
    await send(s, 'lost', async () => {
      throw new Error('lost reply');
    });
    return delivered;
  });
  await run('proven', async s => {
    await s.dispatchThen('proven', {}, async () => {
      throw new ProvenNoEffect('host_refused', 'host_negative_ack');
    });
    return delivered;
  });
  await run('cancel', async s => (await send(s, 'cancel'), { ...delivered, stage: 'requested' }));
  // A queued follow-up flushed automatically, then dispatched once.
  await run('queued', async () => ({ state: 'queued', stage: 'reserved', effect: 'no_effect', admission: 'queued' }));
  store.readyQueued('queued');
  await run('queued', async s => (await send(s, 'queued'), delivered));
  // A host exit finalizes an accepted command while its reply is outstanding.
  let exited!: () => void;
  const exit = run('exit', async s => {
    await send(s, 'exit', () => new Promise<void>(resolve => (exited = resolve)));
    return delivered;
  });
  await new Promise(r => setImmediate(r));
  store.unknown('exit');
  exited();
  await exit;
  // Two commands left in flight at the restart: one undispatched, one dispatched.
  void run('pending', never);
  void run('hanging', async s => (await send(s, 'hanging', never), delivered));
  await new Promise(r => setImmediate(r));

  // Restart: recovery, then the owner keeps the recovered intent and its exact retry dispatches once.
  state.close();
  state = openState(root);
  store = new ReceiptStore(state.journal);
  store.recover();
  store.resolveIntent('pending', 'keep');
  await run('pending', async s => (await send(s, 'pending'), delivered));
  state.close();
}
