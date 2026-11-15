#!/usr/bin/env node
/** THROWAWAY second entrypoint. Scratch only; never opens RPC state. */
import { mkdirSync, lstatSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { DurableHost } from './durable-host.js';
import { spikeModels } from './durable-models.js';
import { processToken } from './process.js';
import { router, listenPrivate } from './server.js';
const dir = resolve(process.env.A0D_STATE_DIR ?? '/tmp/a0d/state');
if (!dir.startsWith('/tmp/a0d/')) throw new Error('throwaway state must be below /tmp/a0d/');
process.umask(0o077); mkdirSync(dir, { recursive: true, mode: 0o700 });
const st = lstatSync(dir);
if (st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('private owned state required');
// Host-owned single-writer lock, not supplied by Durable. Same limitations as RPC mkdir lock.
const lock = join(dir, 'host.lock');
try { mkdirSync(lock, { mode: 0o700 }); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid: number; token: string };
  if (processToken(owner.pid) === owner.token) throw new Error('another durable host owns this storage');
  rmSync(lock, { recursive: true }); mkdirSync(lock, { mode: 0o700 });
}
writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: processToken(process.pid) }));
const registry = createRegistry(); registry.install(CodingTools);
const models = spikeModels(dir, process.env.A0D_GATEWAY === '1');
const harness = await Harness.open(await openNodeJsonlStorage(join(dir, 'storage'), ctx, { fsync: true }), {
  models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir }),
  settings: { retry: { maxRetries: 2, baseDelayMs: 100 }, compaction: { enabled: false } },
  onReport: report => console.error(JSON.stringify({ report: report.kind })),
}, ctx);
const host = new DurableHost(harness, models); await host.recover();
const server = router(host); await listenPrivate(server, join(dir, 'worker.sock'));
console.error(JSON.stringify({ prototype: true, runtime: 'pi-durable@1.5.2', pid: process.pid, socket: join(dir, 'worker.sock') }));
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true;
  await host.shutdown(); server.closeAllConnections(); server.close(); rmSync(lock, { recursive: true }); process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
