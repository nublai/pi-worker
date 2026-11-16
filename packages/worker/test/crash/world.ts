/**
 * The supervisor crash world, ported from A0 `src/test/fixtures/crash-child.ts`: a real supervisor over real fsynced
 * state with a deterministic host whose native effects (spawn, prompt entry, control, binding move) are written to
 * `effects.jsonl` and to native artifacts before anything can record them. `PIW_CRASH_EFFECT=<n>` SIGKILLs right
 * after the n-th native effect. Every B2-level call is logged to `requests.jsonl` before it runs, so recovery can
 * retry each exactly and prove no replay.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PiRecord, PiResponse } from '../../src/host/host.js';
import { openState, type SupervisorState as OpenState } from '../../src/journal/state.js';
import { ReceiptStore, type Receipt } from '../../src/receipts/receipts.js';
import type { Worker } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { Host } from '../supervisor-fixture.js';

export type Effect = { kind: string; command_id: string; session_file?: string; session_id?: string; entry_id?: string; native_file?: string; operation?: string };
export type Logged = { op: string; id?: string; body: Record<string, unknown> };
export type Summary = { receipts: Receipt[]; workers: Worker[] };

const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as T)
    : [];
export const effectsAt = (root: string) => lines<Effect>(join(root, 'effects.jsonl'));
export const requestsAt = (root: string) => lines<Logged>(join(root, 'requests.jsonl'));

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
  const state = openState(root);
  const hosts: EffectHost[] = [];
  const supervisor = new Supervisor({
    journal: state.journal,
    receipts: new ReceiptStore(state.journal),
    supervisorEpoch: state.supervisorEpoch,
    stateDir: root,
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
    if (scenario) appendFileSync(join(root, 'requests.jsonl'), `${JSON.stringify({ op, body, id })}\n`);
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
    const prior = world.supervisor.receipts.all.get(String(request.body.command_id));
    if (!prior || prior.state === 'intent_ready') continue; // No automatic dispatch, even after owner consent.
    let retry: Receipt;
    try {
      retry = await world.call(request.op, request.body, request.id);
    } catch (error) {
      throw new Error(`retry of ${String(request.body.command_id)} refused instead of returning its receipt: ${String(error)}`);
    }
    assert.deepEqual(retry, prior, 'a duplicate lookup must not change a receipt or replay');
  }
  const summary = { receipts: [...world.supervisor.receipts.all.values()], workers: world.supervisor.list() };
  world.state.close();
  return summary;
}
