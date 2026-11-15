/** Merge verification helpers authored for this merge; private VM-only state. */
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, existsSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { Journal } from '../../dist/journal.js';
import { Supervisor } from '../../dist/supervisor.js';
import { router, listenPrivate } from '../../dist/server.js';
import { Client } from '../../dist/client.js';

export const binding = (w, command_id) => ({ command_id, worker_epoch: w.worker_epoch, session_id: w.session_id, binding_revision: w.binding_revision });
export const entries = file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
export function deadline(promise, label, ms = 60000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout: ' + label)), ms); })]).finally(() => clearTimeout(timer));
}
export async function harness(name, experimental = false) {
  if (hostname() !== 'a0-worker') throw new Error('only authorized on a0-worker');
  const root = mkdtempSync('/tmp/a0merge/' + name + '-'), profile = join(root, 'agent'), state = join(root, 'state');
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  for (const name of ['auth.json', 'models-store.json', 'exe-dev-llm-integration.json']) {
    const input = join('/home/exedev/.pi/agent', name);
    if (existsSync(input)) { copyFileSync(input, join(profile, name)); chmodSync(join(profile, name), 0o600); }
  }
  mkdirSync(join(profile, 'extensions'));
  cpSync('/home/exedev/.pi/agent/extensions/exe-dev', join(profile, 'extensions/exe-dev'), { recursive: true });
  if (experimental) {
    mkdirSync(join(profile, 'npm'));
    cpSync('/tmp/a0s4fix/installed/node_modules', join(profile, 'npm/node_modules'), { recursive: true });
    cpSync('/home/exedev/.pi/agent/npm/node_modules/pi-herdr-pstack', join(profile, 'npm/node_modules/pi-herdr-pstack'), { recursive: true });
  }
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ packages: [], enableSkillCommands: true }));
  const socket = join(state, 'worker.sock');
  for (const key of Object.keys(process.env)) if (/^(HERDR_|HC_|PI_SUBAGENT_|PI_WORKER_)/.test(key)) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = profile;
  const journal = new Journal(join(state, 'journal')), exits = [], leaders = [], nativeCounts = {};
  const factory = Supervisor.rpcFactory('/home/exedev/.local/bin/pi');
  const s = new Supervisor(state, journal, '1.5.2', (c, dir, context) => {
    const host = factory(c, dir, context), request = host.request.bind(host);
    leaders.push({ pid: host.pid, host: c.host ?? 'rpc', worker_id: context.worker_id });
    exits.push(new Promise(resolve => host.child.once('exit', resolve)));
    host.request = command => { const key = (c.host ?? 'rpc') + ':' + command.type; nativeCounts[key] = (nativeCounts[key] ?? 0) + 1; return request(command); };
    return host;
  });
  const server = router(s); await listenPrivate(server, socket);
  const client = new Client(socket);
  function until(predicate, label, ms = 60000) {
    let subscription;
    const p = new Promise((resolve, reject) => {
      const check = () => { try { const value = predicate(); if (value) resolve(value); } catch (error) { reject(error); } };
      subscription = s.events.subscribe(() => s.list(), null, () => { setImmediate(check); });
      check();
    });
    return deadline(p, label, ms).finally(() => subscription.close());
  }
  async function close(summary) {
    await s.shutdown(); await deadline(Promise.all(exits), 'own native exits', 10000);
    summary.process_check = leaders.map(p => ({ ...p, absent: !existsSync('/proc/' + p.pid) }));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); journal.close();
    summary.native_counts = nativeCounts;
    writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    if (!summary.process_check.every(p => p.absent)) throw new Error('owned leader remains');
  }
  console.log(JSON.stringify({ root, phase: 'start' }));
  return { root, profile, state, socket, s, journal, client, until, close, nativeCounts };
}
