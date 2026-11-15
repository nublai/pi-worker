/** Real SIGKILL/fsync cuts; host seam has independent native effect artifacts. Not live pi. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Journal } from '../../journal.js';
import { Supervisor } from '../../supervisor.js';
import { Host, bind } from '../helpers.js';
import type { UIAnswer } from '../../resolvers.js';
import type { Answer } from '../../interactions.js';
import type { PiRecord } from '../../host.js';
const [mode, root] = process.argv.slice(2) as [string, string];
mkdirSync(root, { recursive: true, mode: 0o700 });
const effectsFile = join(root, 'effects.jsonl'), requestsFile = join(root, 'requests.jsonl'); let effects = 0;
function effect(value: Record<string, unknown>): void {
  appendFileSync(effectsFile, JSON.stringify(value) + '\n');
  if (process.env.A0_CRASH_EFFECT === String(++effects)) process.kill(process.pid, 'SIGKILL');
}
class NativeHost extends Host {
  readonly kind = 'sdk' as const;
  async answerUI(native_id: string, _answer: UIAnswer) {
    const nativeResult = join(root, native_id + '.consumed'); writeFileSync(nativeResult, 'resolver consumed once\n');
    effect({ kind: 'answer', native_id, native_result: nativeResult });
    return { stage: 3 as const, consumed: true, outcome: 'answered' };
  }
  override async cancelUI(native_id: string) {
    effect({ kind: 'cancel', native_id });
  }
  override async request(c: PiRecord) {
    if (c.type === 'gate_release') {
      const nativeResult = join(root, String(c.gate_token) + '.released');
      if (c.allowed) writeFileSync(nativeResult, 'gate released once\n');
      effect({ kind: 'gate', gate_token: c.gate_token, released: c.allowed, native_result: nativeResult });
      return { type: 'response' as const, id: 'gate', success: true, data: { released: c.allowed === true } };
    }
    if (c.type === 'navigate') {
      const nativeResult = join(root, 'navigation'); writeFileSync(nativeResult, String(c.entryId));
      effect({ kind: 'navigate', native_result: nativeResult });
      return { type: 'response' as const, id: 'navigate', success: true, data: { cancelled: false } };
    }
    return super.request(c);
  }
}
const journal = new Journal(join(root, 'journal')); let host: NativeHost;
const supervisor = new Supervisor(root, journal, '1.5.2', () => {
  assert.equal(mode, 'scenario', 'restart must never launch or adopt a host');
  const file = join(root, 'native.jsonl'); writeFileSync(file, JSON.stringify({ type: 'session', id: 'native' }) + '\n' + JSON.stringify({ type: 'message', id: 'entry', parentId: null, message: { role: 'user', content: [] } }) + '\n');
  host = new NativeHost(root, 'native', file); return host;
});
if (mode === 'scenario') {
  const cwd = join(root, 'cwd'); mkdirSync(cwd); const created = await supervisor.create({ command_id: 'create', cwd, provider: 'test', model: 'test', thinking: 'off', host: 'sdk' }); const w = supervisor.get(created.worker_id!);
  function open(native_id: string, method = 'input', extra = {}) { host.emit('event', { type: 'extension_ui_request', id: native_id, method, ...extra }); return supervisor.interactions.list(w.worker_id).find(i => i.native_id === native_id)!; }
  async function answer(native_id: string, kind: Answer['kind'] = 'input', extra = {}) {
    const i = supervisor.interactions.list(w.worker_id).find(i => i.native_id === native_id)!;
    const a = { ...bind(w, native_id + '-answer'), answer_id: native_id + '-answer', interaction_id: String(i.interaction_id), revision: 1, kind, outcome: 'answer' as const, value: kind === 'tool_approval' ? true : 'PRIVATE_NO_HASH', ...extra };
    const { value: _v, ...metadata } = a; appendFileSync(requestsFile, JSON.stringify({ worker_id: w.worker_id, ...metadata }) + '\n');
    return supervisor.answer(w.worker_id, a);
  }
  open('question'); await answer('question');
  open('cancelled'); await answer('cancelled', 'input', { outcome: 'cancel', value: undefined });
  for (const mode of ['allow', 'revoked']) {
    const approval = { gate_token: mode, digest: 'artifact', policy_revision: 'p1', expiry: Date.now() + 60000, operation: 'bash', resource: cwd, environment: cwd, offered_scope: 'once' };
    const i = open(mode, 'tool_approval', { approval });
    let authorized = true;
    await supervisor.authority.run(() => { if (!authorized) throw new Error('grant_revoked'); }, () => answer(mode, 'tool_approval'));
    if (mode === 'revoked') authorized = false;
    await supervisor.interactions.gate(supervisor.require(w.worker_id).worker, { type: 'gate_check', ...approval }, () => {});
    assert.equal(supervisor.interactions.status(w.worker_id, String(i.interaction_id)).status, mode === 'allow' ? 'tool_released' : 'release_denied');
  }
  open('timeout', 'confirm', { timeout: 1 }); await delay(10);
  assert.equal(supervisor.interactions.list(w.worker_id).length, 0);
  open('navigate-dialog');
  const navigation = await supervisor.rebind(w.worker_id, { ...bind(w, 'navigate'), action: 'navigate', entry_id: 'entry', source_leaf_id: w.leaf_id }); assert.equal(navigation.state, 'delivered');
  // Leave a live question to prove recovery interruption and stale rejection.
  open('restart-pending'); journal.close(); console.log(JSON.stringify({ done: true }));
} else {
  await supervisor.recover();
  if (existsSync(requestsFile)) for (const line of readFileSync(requestsFile, 'utf8').trim().split('\n').filter(Boolean)) {
    const a = JSON.parse(line) as Answer & { worker_id: string };
    const prior = supervisor.receipts.all.get(a.command_id); if (!prior) continue;
    const duplicate = await supervisor.answer(a.worker_id, { ...a, value: 'DIFFERENT_AFTER_RESTART' });
    assert.deepEqual(duplicate, prior); // Invalid changed value is NOT revalidated after restart.
  }
  assert.equal(supervisor.interactions.list(supervisor.list()[0]?.worker_id ?? '').length, 0);
  console.log(JSON.stringify({ receipts: [...supervisor.receipts.all.values()], workers: supervisor.list(), interactions: [...supervisor.interactions.records.values()] })); journal.close();
}
