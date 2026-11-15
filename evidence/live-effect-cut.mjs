#!/usr/bin/env node
/** THROWAWAY: one real-Pi prompt effect cut on the authorized a0-worker VM.
 * A child process runs the actual supervisor/router/RpcHost; SIGKILL only after
 * Pi's own user entry is visible, before the prompt receipt can finish. No grants
 * or model/API bodies are logged. Uses only fresh /tmp/a0s2fix state (Pi ordinary
 * discovery is not isolation). Run from this repository after npm run build.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, watch, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal, parseJournal } from '../dist/journal.js';
import { Supervisor } from '../dist/supervisor.js';
import { RpcHost } from '../dist/host.js';
import { Client, ClientFailure } from '../dist/client.js';
import { router, listenPrivate } from '../dist/server.js';
import { killGroup, procInfo } from '../dist/process.js';
process.umask(0o077);
const marker = 'A0S2FIX_EFFECT_POINT_INPUT';
const bind = (w, command_id) => ({ command_id, session_id: w.session_id, worker_epoch: w.worker_epoch, binding_revision: w.binding_revision });
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
function deadline(promise, label, ms = 120000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}
if (process.argv[2] === 'child') {
  const root = process.argv[3], state = join(root, 'state');
  let nativeFile, nativePid;
  const journal = new Journal(join(state, 'journal'));
  const s = new Supervisor(state, journal, '1.5.2', (c, dir) => {
    const h = new RpcHost('pi', c.cwd, dir, c.provider, c.model, c.thinking);
    nativePid = h.pid;
    const request = h.request.bind(h);
    h.request = async c => {
      if (c.type !== 'prompt') {
        const response = await request(c);
        if (c.type === 'get_state') nativeFile = response.data?.sessionFile;
        return response;
      }
      assert.ok(nativeFile);
      let watcher, timer;
      const evidence = new Promise((resolve, reject) => {
        const check = () => {
          const entries = lines(nativeFile);
          const user = entries.find(e => e.type === 'message' && e.message?.role === 'user' && JSON.stringify(e.message.content).includes(marker));
          if (user) resolve({ session_file: nativeFile, session_id: entries.find(e => e.type === 'session')?.id, user_entry_id: user.id, native_pid: nativePid });
        };
        watcher = watch(dirname(nativeFile), check);
        timer = setTimeout(() => reject(new Error('Pi input evidence timeout')), 90000);
        check();
      });
      const pending = request(c); pending.catch(() => {});
      let observed;
      try { observed = await evidence; } finally { watcher.close(); clearTimeout(timer); }
      const file = join(root, 'native-effect.json'); writeFileSync(file, JSON.stringify(observed) + '\n');
      const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      process.kill(process.pid, 'SIGKILL'); // Actual process death, before return to supervisor.
      return pending;
    };
    return h;
  });
  const server = router(s); await listenPrivate(server, join(state, 'worker.sock'));
  const receipt = await s.create({ command_id: 'live-create', cwd: join(root, 'cwd'), provider: 'exe-dev-anthropic', model: 'claude-sonnet-4-6@llm', thinking: 'off' });
  assert.equal(receipt.state, 'delivered');
  process.send({ worker: s.get(receipt.worker_id) });
} else {
  const version = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(); assert.equal(version, '1.5.2');
  mkdirSync('/tmp/a0s2fix', { recursive: true, mode: 0o700 });
  const root = mkdtempSync('/tmp/a0s2fix/live-effect-');
  mkdirSync(join(root, 'state'), { mode: 0o700 }); mkdirSync(join(root, 'cwd'), { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  let journal, s, server;
  try {
    const [ready] = await deadline(Promise.race([once(child, 'message'), exited.then(() => { throw new Error('supervisor child exited before ready'); })]), 'supervisor readiness timeout');
    const w = ready.worker, client = new Client(join(root, 'state', 'worker.sock'));
    const request = { ...bind(w, 'live-prompt'), message: marker + '. Do not use tools or delegate. Reply exactly CUT_READY.' };
    await assert.rejects(client.call('sessions.prompt', { id: w.worker_id, body: request }), e => e instanceof ClientFailure && e.effect === 'unknown');
    const [, signal] = await deadline(exited, 'effect cut timeout'); assert.equal(signal, 'SIGKILL');
    const native = JSON.parse(readFileSync(join(root, 'native-effect.json'), 'utf8'));
    const before = parseJournal(readFileSync(join(root, 'state', 'journal'))).records;
    const prompt = before.filter(r => r.kind === 'receipt' && r.value.command_id === 'live-prompt').at(-1).value;
    assert.equal(prompt.state, 'accepted');
    assert.ok(lines(native.session_file).some(e => e.id === native.user_entry_id && e.message?.role === 'user'));
    journal = new Journal(join(root, 'state', 'journal'));
    s = new Supervisor(join(root, 'state'), journal, version, () => assert.fail('recovery must not spawn/adopt'));
    await s.recover();
    server = router(s); await listenPrivate(server, join(root, 'state', 'worker.sock'));
    const recovered = await client.call('receipts.get', { id: 'live-prompt' });
    assert.equal(recovered.state, 'outcome_unknown'); assert.equal(recovered.effect, 'unknown');
    assert.ok(s.get(w.worker_id).fence.uncertain_command_ids.includes('live-prompt'));
    const count = () => lines(native.session_file).filter(e => e.type === 'message' && e.message?.role === 'user' && JSON.stringify(e.message.content).includes(marker)).length;
    assert.equal(count(), 1);
    assert.deepEqual(await client.call('sessions.prompt', { id: w.worker_id, body: request }), recovered);
    assert.equal(count(), 1, 'duplicate did not resend');
    assert.ok(!procInfo(native.native_pid) || procInfo(native.native_pid).state === 'Z', 'native leader observed gone');
    const output = { prototype: true, result: 'pass', root, pi_version: version, node: process.version, effect_point: 'Pi session user entry visible; prompt RPC result withheld', supervisor_death: signal, pre_cut: prompt.state, recovered: recovered.state + '/' + recovered.effect, fence: s.get(w.worker_id).fence.command_id, native_user_entries: count(), duplicate_native_user_entries: count(), recovery_spawns: 0, native_pid: native.native_pid, native_leader_gone: true, limit: 'process-group cleanup, not escaped-descendant containment; no power-loss proof' };
    writeFileSync(join(root, 'summary.json'), JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (s) await s.shutdown();
    journal?.close();
    // Also clean up a failed run using only identities recorded by this run.
    const file = join(root, 'state', 'journal');
    if (existsSync(file)) for (const record of parseJournal(readFileSync(file)).records) if (record.kind === 'worker' && record.value.pid) await killGroup(record.value.pid, record.value.token);
  }
}
