/** Fresh merged-build reproduction of two-client and answer/navigation races. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, binding, entries, deadline } from './common.mjs';
const h = await harness('races'), { root, client, s, journal, until } = h;
const summary = { outcome: 'running', root, node: process.version, model: 'exe-dev-anthropic/claude-sonnet-4-6@llm', rows: [] };
const specimen = `import { appendFileSync } from 'node:fs';
export default function(pi) {
  pi.on('input', (event, ctx) => {
    if (event.text !== 'merge-dialog') return;
    void ctx.ui.input('Merge race input', 'synthetic', { timeout: 45000 }).then(value => {
      appendFileSync(ctx.cwd + '/native.jsonl', JSON.stringify({ value }) + '\\n');
      ctx.ui.notify('MERGE_NATIVE_RESULT');
    });
    return { action: 'handled' };
  });
}`;
let seq = 0;
const id = prefix => prefix + '-' + ++seq;
const answer = (w, q) => client.call('interactions.answer_if_current', { id: w.worker_id, body: { ...binding(w, id('answer')), answer_id: id('answer-id'), interaction_id: q.interaction_id, revision: q.revision, kind: q.kind, outcome: 'answer', value: 'merge synthetic answer' } });
try {
  for (const host of ['rpc', 'sdk', 'acp']) {
    const cwd = join(root, host); mkdirSync(join(cwd, '.pi/extensions'), { recursive: true }); writeFileSync(join(cwd, '.pi/extensions/race.ts'), specimen);
    const r = await client.call('workers.create', { body: { command_id: id('create'), cwd, host, project_trusted: true, provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off' } });
    assert.equal(r.state, 'delivered'); let w = s.get(r.worker_id);
    const row = { host, navigation: [] }; summary.rows.push(row);
    const open = async () => {
      const p = await client.call('sessions.prompt', { id: w.worker_id, body: { ...binding(s.get(w.worker_id), id('dialog')), message: 'merge-dialog' } });
      assert.equal(p.state, 'delivered');
      return until(() => s.interactions.list(w.worker_id)[0], 'native dialog');
    };
    let q = await open();
    const attempts = await Promise.allSettled([answer(w, q), answer(w, q)]);
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(a => a.status === 'rejected').length, 1);
    const won = attempts.find(a => a.status === 'fulfilled').value;
    assert.equal(won.answer_stage, host === 'rpc' ? 2 : 3);
    row.two_client = { winners: 1, refusals: 1, stage: won.answer_stage };
    const native = () => entries(join(cwd, 'native.jsonl'));
    await until(() => { try { return native().length === 1; } catch { return false; } }, 'first native result');
    if (host !== 'rpc') {
      const started = await client.call('sessions.prompt', { id: w.worker_id, body: { ...binding(s.get(w.worker_id), id('history')), message: 'Reply with READY only. Do not use tools or delegate.' } });
      assert.equal(started.state, 'delivered'); await until(() => s.get(w.worker_id).execution?.state === 'settled', 'real provider settlement');
      const target = s.require(w.worker_id).index.page(null, 100).entries.find(e => e.type === 'message'); assert.ok(target);
      for (const consumed of [false, true]) {
        w = s.get(w.worker_id); const before = native().length; q = await open();
        const hostObject = s.require(w.worker_id).host, original = hostObject.answerUI.bind(hostObject);
        let release, entered;
        const hold = new Promise(resolve => { release = resolve; }), atCut = new Promise(resolve => { entered = resolve; });
        hostObject.answerUI = async (...args) => {
          if (args[1].outcome === 'cancel') return original(...args);
          const result = consumed ? await original(...args) : undefined;
          entered(); await hold; return result ?? original(...args);
        };
        const pending = answer(w, q);
        try {
          await deadline(atCut, 'held native answer');
          const moved = await client.call('sessions.rebind', { id: w.worker_id, body: { ...binding(s.get(w.worker_id), id('navigate')), action: 'navigate', entry_id: target.id, source_leaf_id: s.get(w.worker_id).leaf_id } });
          assert.equal(moved.state, 'delivered'); release(); const result = await pending;
          assert.equal(result.state, consumed ? 'outcome_unknown' : 'rejected'); assert.equal(result.effect, consumed ? 'unknown' : 'no_effect'); assert.ok(result.answer_stage < 3);
          const current = s.get(w.worker_id); assert.equal(current.binding_revision, w.binding_revision + 1); assert.equal(Boolean(current.fence), consumed);
          await until(() => native().length === before + 1, 'independent native effect');
          assert.equal(Object.hasOwn(native()[before], 'value'), consumed);
          assert.equal(journal.records.some(r => r.kind === 'interaction' && r.value.interaction_id === q.interaction_id && Number(r.value.answer_stage) >= 3), false);
          row.navigation.push({ consumed, state: result.state, effect: result.effect, stage: result.answer_stage, old_revision: w.binding_revision, new_revision: current.binding_revision, native_has_value: consumed, fenced: Boolean(current.fence) });
          if (consumed) await client.call('sessions.resolve_unknown', { id: w.worker_id, body: { ...binding(current, id('resolve')), uncertain_command_id: result.command_id, fence_generation: current.fence.fence_generation, disposition: 'keep' } });
        } finally { release(); hostObject.answerUI = original; }
      }
    }
    await client.call('workers.stop', { id: w.worker_id, body: binding(s.get(w.worker_id), id('stop')) });
  }
  summary.outcome = 'pass';
} catch (error) { summary.outcome = 'failed'; summary.error = error.message; process.exitCode = 1; console.error(error); }
finally { await h.close(summary); console.log(JSON.stringify({ root, outcome: summary.outcome })); }
