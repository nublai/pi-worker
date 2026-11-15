/** Authored THROWAWAY CLI driver; run only from isolated /tmp/a0d/repo. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
const exec = promisify(execFile);
const root = mkdtempSync('/tmp/a0d/live-');
const dir = join(root, 'state'); mkdirSync(dir, { mode: 0o700 });
const env = { ...process.env, A0D_STATE_DIR: dir, A0_SOCKET: join(dir, 'worker.sock'), A0D_GATEWAY: '1' };
const cli = async (...args) => JSON.parse((await exec(process.execPath, ['dist/cli.js', ...args], { env, timeout: 90000 })).stdout);
const emit = (name, value) => { writeFileSync(join(root, name + '.json'), JSON.stringify(value, null, 2)); console.log(JSON.stringify({ name, value })); };
let host;
async function start() {
  host = spawn(process.execPath, ['dist/durable-main.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('host ready timeout: ' + log)), 20000);
    host.stderr.on('data', b => { log += b; if (log.includes('"socket"')) { clearTimeout(timer); resolve(); } });
    host.once('exit', code => { clearTimeout(timer); reject(new Error('host exit ' + code + ': ' + log)); });
  });
}
async function stopHost(signal = 'SIGTERM') { if (!host || host.exitCode !== null || host.signalCode) return; const exited = once(host, 'exit'); host.kill(signal); await exited; }
function waitFile(file, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const ready = () => existsSync(file) && readFileSync(file).length > 0;
    const watcher = watch(dir, () => { if (ready()) done(); });
    const timer = setTimeout(() => { watcher.close(); reject(new Error('missing ' + file)); }, timeout);
    function done() { clearTimeout(timer); watcher.close(); resolve(); }
    if (ready()) done();
  });
}
async function settled(id) {
  const { stdout } = await exec(process.execPath, ['dist/cli.js', 'watch', id, '--until-settled'], { env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  const frames = stdout.trim().split('\n').map(JSON.parse);
  writeFileSync(join(root, id + '-events.jsonl'), stdout);
  assert.equal(frames[0].type, 'snapshot');
  assert(frames.some(f => f.type === 'agent_settled' || f.worker?.execution?.state === 'settled'));
  return frames.map(f => f.type);
}
async function create(name, provider = 'a0-faux', model = 'deterministic') {
  const cwd = join(root, name); mkdirSync(cwd);
  return (await cli('create', '--command-id', 'create-' + name, '--cwd', cwd, '--provider', provider, '--model', model, '--thinking', 'off')).worker_id;
}
try {
  await start(); emit('hello', await cli('hello'));
  // Actual gateway, no host credential. Kept independent from deterministic cut fixtures.
  const real = await create('gateway', 'exe-dev-anthropic', 'claude-sonnet-4-6@llm');
  const prompt = ['prompt', real, '--command-id', 'gateway-prompt', '--message', 'Reply exactly A0D_GATEWAY_OK. Do not call tools.'];
  const first = await cli(...prompt), duplicate = await cli(...prompt); assert.deepEqual(first, duplicate);
  const events = await settled(real), history = await cli('history', real);
  assert(JSON.stringify(history).includes('A0D_GATEWAY_OK')); // user repeats it: additionally require assistant below
  assert(history.entries.some(e => e.kind === 'pi.assistant' && JSON.stringify(e.model).includes('A0D_GATEWAY_OK')));
  assert.equal(history.entries.filter(e => e.kind === 'pi.user').length, 1);
  emit('gateway', { first, duplicateIdentical: true, events, history, stop: await cli('stop', real, '--command-id', 'stop-gateway') });
  // Adapter lock versus library lock are separate tests.
  const second = await exec(process.execPath, ['dist/durable-main.js'], { env, timeout: 10000 }).then(() => ({ refused: false }), e => ({ refused: true, message: e.stderr.includes('another durable host owns this storage') }));
  assert.deepEqual(second, { refused: true, message: true }); emit('host-second-writer', second);
  const model = await create('model-cut');
  const m = await cli('prompt', model, '--command-id', 'model-cut', '--message', 'MODEL_CUT');
  await waitFile(join(dir, 'model-cut-once'));
  const q = await cli('prompt', model, '--command-id', 'queued', '--message', 'QUEUED_INPUT');
  await stopHost('SIGKILL'); await start();
  const afterEvents = await settled(model), after = await cli('history', model);
  const attempts = readFileSync(join(dir, 'model-attempts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(attempts.filter(x => x.scenario === 'MODEL_CUT').length, 2);
  assert.equal(attempts.filter(x => x.scenario === 'QUEUED_INPUT').length, 1);
  assert.deepEqual(await cli('receipt', 'model-cut'), m);
  assert.deepEqual(await cli('prompt', model, '--command-id', 'model-cut', '--message', 'MODEL_CUT'), m);
  assert.equal(after.entries.filter(e => e.kind === 'pi.user').length, 2);
  emit('model-cut', { receipt: m, queued: q, afterEvents, attempts, history: after, worker: await cli('get', model) });
  await cli('stop', model, '--command-id', 'stop-model');
  const bash = await create('bash-cut');
  const b = await cli('prompt', bash, '--command-id', 'bash-cut', '--message', 'BASH_CUT');
  await waitFile(join(dir, 'bash-start')); assert.equal(readFileSync(join(dir, 'bash-start'), 'utf8'), 'ONCE\n');
  const bq = await cli('prompt', bash, '--command-id', 'bash-queued', '--message', 'AFTER_BASH_QUEUE');
  const oldPid = host.pid; await stopHost('SIGKILL'); await start();
  await settled(bash); const bh = await cli('history', bash);
  const tool = bh.entries.find(e => e.kind === 'pi.tool-result');
  assert(tool); assert(JSON.stringify(tool).includes('interrupted'));
  assert.equal(readFileSync(join(dir, 'bash-start'), 'utf8'), 'ONCE\n');
  // Observe the old detached shell finishing, not a replay. Finite 6s tool, no cleanup race.
  await waitFile(join(dir, 'bash-finish')); assert.equal(readFileSync(join(dir, 'bash-finish'), 'utf8'), 'FINISHED\n');
  const stop = await cli('stop', bash, '--command-id', 'stop-bash');
  emit('bash-cut', { oldPid, shellPid: Number(readFileSync(join(dir, 'bash-pid'), 'utf8')), receipt: b, queued: bq, history: bh, startEffects: 1, oldShellFinished: true, stop, worker: await cli('get', bash) });
  emit('inventory', await cli('list'));
} finally { await stopHost(); emit('cleanup', { root, hostStopped: !host || host.exitCode !== null || !!host.signalCode, lockAbsent: !existsSync(join(dir, 'host.lock')) }); }
