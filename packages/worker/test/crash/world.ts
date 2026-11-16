/**
 * The supervisor crash world, ported from A0 `src/test/fixtures/crash-child.ts`: a real supervisor over real fsynced
 * state with a deterministic host whose native effects (spawn, prompt entry, control, binding move) are written to
 * `effects.jsonl` and to native artifacts before anything can record them. `PIW_CRASH_EFFECT=<n>` SIGKILLs right
 * after the n-th native effect. Every B2-level call is logged to `requests.jsonl` before it runs, so recovery can
 * retry each exactly and prove no replay, and its reply (state and effect, or the refusal) to `replies.jsonl` when it
 * returns: the client's own record of what it was told, independent of the journal.
 *
 * Retention (P1-12): a scenario may write `world.json` with the journal bound and receipt retention it runs under;
 * every world opened over that root (the scenario, its restart, the oracle's recovery) uses the same limits.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PiRecord, PiResponse } from '../../src/host/host.js';
import { openState, type SupervisorState as OpenState } from '../../src/journal/state.js';
import { ReceiptStore, type Receipt } from '../../src/receipts/receipts.js';
import { Refusal } from '../../src/b2/errors.js';
import type { RetentionLimits } from '../../src/journal/retention.js';
import type { Worker } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { GrantStore } from '../../src/grants/store.js';
import { Host } from '../supervisor-fixture.js';

export type Effect = { kind: string; command_id: string; session_file?: string; session_id?: string; entry_id?: string; native_file?: string; operation?: string };
export type Logged = { op: string; id?: string; body: Record<string, unknown> };
export type Reply = { command_id: string; state?: string; effect?: string; error?: string };
export type Summary = { receipts: Receipt[]; workers: Worker[]; /** Ids retention evicted (P1-12). */ expired: string[] };
/** The limits a retention scenario runs under (`world.json`). */
export type WorldLimits = Partial<Omit<RetentionLimits, 'receipts'>> & { receipts?: number };

const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as T)
    : [];
export const effectsAt = (root: string) => lines<Effect>(join(root, 'effects.jsonl'));
export const requestsAt = (root: string) => lines<Logged>(join(root, 'requests.jsonl'));
export const repliesAt = (root: string) => lines<Reply>(join(root, 'replies.jsonl'));
export const limitsAt = (root: string): WorldLimits => (existsSync(join(root, 'world.json')) ? (JSON.parse(readFileSync(join(root, 'world.json'), 'utf8')) as WorldLimits) : {});

let effectCount = 0;
export function effect(root: string, value: Effect): void {
  appendFileSync(join(root, 'effects.jsonl'), `${JSON.stringify(value)}\n`);
  if (process.env.PIW_CRASH_EFFECT === String(++effectCount)) process.kill(process.pid, 'SIGKILL');
}

/** A host whose native effects are independent artifacts. `effectCommand` names the control command in flight. */
export class EffectHost extends Host {
  effectCommand?: string;
  /** A create-with-resume's command: its open of the resume target is a native effect too. */
  openCommand?: string;
  gate?: Promise<never>;
  release?: () => void;
  identified = false;

  constructor(
    readonly root: string,
    sid: string,
    file: string,
  ) {
    super(root, sid, file);
  }

  private control(operation: string, command = this.effectCommand): void {
    if (!command) return; // Only explicit controls, never recovery cleanup.
    const native_file = join(this.root, 'native-controls.jsonl');
    appendFileSync(native_file, `${JSON.stringify({ command_id: command, operation })}\n`);
    effect(this.root, { kind: operation, command_id: command, operation, native_file });
  }

  override async stop(): Promise<boolean> {
    const gone = await super.stop();
    this.control('stop');
    return gone;
  }

  /** The next prompt's reply waits until `release()` rejects it (a lost reply). */
  hold(): void {
    this.gate = new Promise<never>((_r, reject) => {
      this.release = () => reject(new Error('dropped_reply'));
    });
  }

  override async request(c: PiRecord): Promise<PiResponse> {
    // Interactions (P1-10): an answer the exact resolver receives, a native cancel, a tool release. Each names the
    // command it belongs to by the scenario's convention: `<native_id>-answer`, the move or control in flight (or
    // `timeout:<native_id>` for a deadline cancel, which only its write-ahead marker covers), `<gate_token>-answer:release`.
    if (c.type === 'cancel_ui') this.control('cancel_ui', this.effectCommand ?? `timeout:${String(c.nativeId)}`);
    if (c.type === 'answer_ui') this.control('answer_ui', `${String(c.nativeId)}-answer`);
    if (c.type === 'gate_release') this.control('gate_release', `${String(c.gate_token)}-answer:release`);
    if (c.type === 'get_state' && !this.identified) {
      this.identified = true;
      this.emit('event', { type: 'host_identity', sessionId: this.sid, sessionFile: this.file, leafId: null });
    }
    if (c.type === 'prompt' || c.type === 'steer') {
      const id = String(c.message);
      appendFileSync(this.file, `${JSON.stringify({ type: 'message', id, parentId: null, message: { role: 'user', content: [] } })}\n`);
      effect(this.root, { kind: c.type, command_id: id, session_file: this.file, entry_id: id });
    }
    const result = await super.request(c);
    if (c.type === 'clear_queue' || c.type === 'abort') this.control(c.type);
    // A B2 binding move: a native artifact names its command (native moves pi makes alone are not B2 effects).
    if (['new_session', 'switch_session', 'fork', 'navigate'].includes(c.type)) this.control(c.type, this.effectCommand ?? (c.type === 'switch_session' ? this.openCommand : undefined));
    if (c.type === 'prompt' && this.gate) {
      const gate = this.gate;
      this.gate = undefined;
      await gate;
    }
    return result;
  }
}

export interface World {
  readonly root: string;
  readonly hosts: EffectHost[];
  readonly supervisor: Supervisor;
  readonly state: OpenState;
  call(op: string, body: Record<string, unknown>, id?: string): Promise<Receipt>;
}

/** Opens the supervisor over `root`. In `recover` mode the factory refuses: recovery never launches or adopts. */
export function openWorld(root: string, scenario: boolean): World {
  const { journalBytes, receipts: count, ...retention } = limitsAt(root);
  const state = openState(root, { ...(journalBytes ? { maxBytes: journalBytes } : {}), retention: { ...retention, ...(count ? { receipts: count } : {}) } });
  const hosts: EffectHost[] = [];
  const supervisor = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal, count, undefined, retention),
    supervisorEpoch: state.supervisorEpoch,
    stateDir: root,
    grants: new GrantStore(root),
    factory: launch => {
      assert.ok(scenario, 'recovery must never launch or adopt a host');
      // A world reopened over a recovered root (resume.test.ts) never reuses an earlier session's id or file.
      let n = hosts.length;
      while (existsSync(join(root, `native-${n}.jsonl`))) n++;
      const id = `native-${n}`;
      const file = join(root, `${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id })}\n`);
      effect(root, { kind: 'create', command_id: launch.create.command_id, session_file: file, session_id: id });
      const host = new EffectHost(root, id, file);
      if (launch.create.resume_session_id) host.openCommand = launch.create.command_id;
      if (launch.create.provider === 'cancel-open') {
        // pi ran the switch hooks and opened the target (the native effect is recorded), then reports the switch
        // cancelled, as an extension's `session_before_switch` returning `{ cancel: true }` does.
        const native = host.request.bind(host);
        host.request = async c => {
          const reply = await native(c);
          return c.type === 'switch_session' ? { ...reply, data: { ...reply.data, cancelled: true } } : reply;
        };
      }
      if (launch.create.provider === 'fail') {
        const native = host.request.bind(host);
        host.request = async c => (c.type === 'inventory' ? { type: 'response', id: 'x', success: true, data: { extension_errors: ['/broken.ts'] } } : native(c));
      }
      hosts.push(host);
      return host;
    },
  });
  const call = async (op: string, body: Record<string, unknown>, id?: string): Promise<Receipt> => {
    if (!scenario) return dispatch(op, body, id);
    appendFileSync(join(root, 'requests.jsonl'), `${JSON.stringify({ op, body, id })}\n`);
    const reply = (r: Reply) => appendFileSync(join(root, 'replies.jsonl'), `${JSON.stringify(r)}\n`);
    try {
      const r = await dispatch(op, body, id);
      reply({ command_id: String(body.command_id), state: r.state, effect: r.effect });
      return r;
    } catch (error) {
      reply({ command_id: String(body.command_id), error: error instanceof Error ? error.message : String(error), ...(error instanceof Refusal ? { effect: error.effect } : {}) });
      throw error;
    }
  };
  const dispatch = async (op: string, body: Record<string, unknown>, id?: string): Promise<Receipt> => {
    // SAFETY: bodies are the scenario's own literal requests in the shape of each operation's schema.
    const b = body as never;
    switch (op) {
      case 'create':
        return supervisor.create(b);
      case 'prompt':
        return supervisor.prompt(id!, b);
      case 'steer':
        return supervisor.steer(id!, b);
      case 'follow_up':
        return supervisor.followUp(id!, b);
      case 'resolve':
        return supervisor.resolveUnknown(id!, b);
      case 'launch_child':
        return supervisor.launchChild(id!, b);
      case 'report':
        return supervisor.report(id!, b);
      case 'answer':
        // A retry after a restart sends a different value: the recorded outcome comes back without revalidating it.
        return supervisor.answer(id!, scenario ? b : ({ ...body, value: 'DIFFERENT_AFTER_RESTART' } as never));
      case 'stop':
      case 'cancel':
      case 'interrupt':
      case 'rebind':
      case 'new': {
        const h = hosts.find(x => x.file === supervisor.state.require(id!).sessionFile);
        if (h) h.effectCommand = String(body.command_id);
        try {
          if (op === 'rebind') return await supervisor.rebind(id!, b);
          if (op === 'new') return await supervisor.newSession(id!, b);
          return op === 'stop' ? await supervisor.stop(id!, b) : await supervisor.control(id!, b, op === 'interrupt');
        } finally {
          if (h) h.effectCommand = undefined;
        }
      }
      default:
        throw new Error(`unsupported crash world op ${op}`);
    }
  };
  return { root, hosts, supervisor, state, call };
}

/** Recovery mode: recover, retry every logged request exactly once (each must return its stored receipt), report. */
export async function recoverWorld(root: string): Promise<Summary> {
  const world = openWorld(root, false);
  await world.supervisor.recover();
  for (const request of requestsAt(root)) {
    const id = String(request.body.command_id);
    const prior = world.supervisor.receipts.all.get(id);
    if (!prior && world.supervisor.receipts.expired.has(id)) {
      // An evicted receipt's command never runs again: its retry is refused unknown, with nothing written (P1-12).
      const records = world.state.journal.records.length;
      await assert.rejects(world.call(request.op, request.body, request.id), (e: unknown) => e instanceof Refusal && e.message === 'receipt_expired' && e.effect === 'unknown', `retry of evicted ${id}`);
      assert.equal(world.state.journal.records.length, records, `the refused retry of evicted ${id} wrote nothing`);
      continue;
    }
    if (!prior || prior.state === 'intent_ready') continue; // No automatic dispatch, even after owner consent.
    let retry: Receipt;
    try {
      retry = await world.call(request.op, request.body, request.id);
    } catch (error) {
      throw new Error(`retry of ${String(request.body.command_id)} refused instead of returning its receipt: ${String(error)}`);
    }
    assert.deepEqual(retry, prior, 'a duplicate lookup must not change a receipt or replay');
  }
  const summary = { receipts: [...world.supervisor.receipts.all.values()], workers: world.supervisor.list(), expired: [...world.supervisor.receipts.expired.keys()] };
  world.state.close();
  return summary;
}
