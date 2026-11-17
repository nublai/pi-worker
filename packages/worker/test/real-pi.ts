/**
 * Real pi 1.5.2 behind the supervisor, with no credentials and no model call: HOME and PI_CODING_AGENT_DIR live in the
 * test's own temporary directory, and an extension in that agent directory registers a `piw-test` provider whose base
 * URL is a local HTTP server in this test. The server records every request body pi would send to a model (so image
 * blocks are checked at the request) and answers with a canned Anthropic Messages stream, or holds the response open
 * until the test interrupts the run.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SdkHost } from '../src/host/host.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { GrantStore } from '../src/grants/store.js';
import { privateTmp } from './helpers.js';
import { domained } from './domains.js';

export interface FakeProvider {
  readonly url: string;
  /** Every request body the SDK sent, parsed. */
  readonly requests: Record<string, unknown>[];
  /** While true, a request is held open (never answered) until the client goes away. */
  hold: boolean;
  /** Streams to answer the next requests with, in order (`sse(...)` bodies); the canned reply once they run out. */
  readonly responses: string[];
  close(): Promise<void>;
}

/** An Anthropic Messages SSE body from its events. */
export function sse(events: [string, unknown][]): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const CANNED = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'echo', stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'canned reply' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }],
]);

export async function fakeProvider(): Promise<FakeProvider> {
  const requests: Record<string, unknown>[] = [];
  const responses: string[] = [];
  const state = { hold: false };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        requests.push({ unparsed: true });
      }
      if (state.hold) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse([['message_start', { type: 'message_start', message: { id: 'msg_hold', type: 'message', role: 'assistant', content: [], model: 'echo', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }]]));
        return; // held until the run is aborted
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(responses.shift() ?? CANNED);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    responses,
    get hold() {
      return state.hold;
    },
    set hold(v: boolean) {
      state.hold = v;
    },
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The agent-directory extension that registers the local provider (and any extra source the test adds). */
export function providerExtension(url: string): string {
  return `export default pi => {
  pi.registerProvider('piw-test', {
    baseUrl: ${JSON.stringify(url)},
    apiKey: 'piw-test-no-credential',
    api: 'anthropic-messages',
    models: [{ id: 'echo', name: 'Echo', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
};
`;
}

export interface RealPi {
  readonly root: string;
  readonly cwd: string;
  readonly state: string;
  readonly agent: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly s: Supervisor;
  readonly grants: GrantStore;
  create(command?: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** A supervisor over real pi with HOME and PI_CODING_AGENT_DIR inside the test directory; `extensions` by file name. */
export function realPiSupervisor(extensions: Record<string, string>): RealPi {
  const tmp = privateTmp();
  const root = realpathSync(tmp.dir);
  const cwd = join(root, 'workspace');
  const state = join(root, 'state');
  const agent = join(root, 'agent');
  const home = join(root, 'home');
  for (const dir of [cwd, state, agent, home, join(agent, 'extensions')]) mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(extensions)) writeFileSync(join(agent, 'extensions', name), source);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent };
  const opened = openState(state);
  const grants = new GrantStore(state);
  const s = new Supervisor(domained({
    journal: opened.journal,
    receipts: new ReceiptStore(opened.journal),
    supervisorEpoch: opened.supervisorEpoch,
    stateDir: state,
    grants,
    factory: launch =>
      new SdkHost(
        { cwd: launch.cwd, sessionDir: launch.sessionDir, provider: launch.create.provider, model: launch.create.model, thinking: launch.create.thinking, projectTrusted: false },
        { env },
      ),
    inventory: launch => new SdkHost({ cwd: launch.cwd, sessionDir: '', provider: '', model: '', thinking: 'off', projectTrusted: launch.projectTrusted, inventory: true }, { env, prefix: launch.prefix }),
  }));
  return {
    root,
    cwd,
    state,
    agent,
    home,
    env,
    s,
    grants,
    async create(command = 'create') {
      const receipt = await s.create({ command_id: command, cwd, provider: 'piw-test', model: 'echo', thinking: 'off' });
      if (receipt.state !== 'delivered') throw new Error(JSON.stringify(receipt));
      return receipt.worker_id!;
    },
    async cleanup() {
      await s.shutdown();
      opened.close();
      tmp.cleanup();
    },
  };
}

/** Resolves once `check` holds, polling every 20 ms, or rejects after `ms`. */
export async function until(check: () => boolean, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}
