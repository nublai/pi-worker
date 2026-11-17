/**
 * The CLI end to end against a fake worker on a Unix socket: one request per command (plus the binding read when the
 * binding is left out), one JSON object out, typed errors and exit codes; and `grant` through the daemon package's
 * real command on a private state directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}
type Handler = (req: Seen, res: ServerResponse) => void;

const worker = { worker_id: 'w1', worker_epoch: 'epoch-1', session_id: 'session-1', binding_revision: 4 };

async function fake(handler: Handler) {
  const dir = mkdtempSync(join(tmpdir(), 'piw-cli-'));
  chmodSync(dir, 0o700);
  const socket = join(dir, 'b2.sock');
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>(r => server.listen(socket, () => r()));
  const grant = join(dir, 'grant.json');
  writeFileSync(grant, JSON.stringify({ token: 'piw1.test' }), { mode: 0o600 });
  return {
    dir,
    seen,
    async cli(...argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, { out: l => out.push(l), err: l => err.push(l), env: { PIW_SOCKET: socket, PIW_GRANT_FILE: grant } }, () => 'minted');
      return { code, out, err, json: out.length === 1 ? (JSON.parse(out[0]!) as Record<string, unknown>) : undefined, error: err.length ? (JSON.parse(err[0]!) as Record<string, unknown>) : undefined };
    },
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          r();
        });
      }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const receipt = (state = 'delivered', extra: Record<string, unknown> = {}) => ({ command_id: 'minted', operation: 'sessions.prompt', state, effect: 'observed', ...extra });

test('cli run: a left-out binding is read from workers.get once; a given one is sent as is; the receipt is the output', async () => {
  const f = await fake((req, res) => (req.method === 'GET' ? json(res, 200, worker) : json(res, 200, receipt())));
  try {
    const sent = await f.cli('sessions.prompt', 'w1', '--message', 'hi');
    assert.equal(sent.code, 0);
    assert.deepEqual(sent.err, []);
    assert.deepEqual(sent.json, receipt());
    assert.deepEqual(
      f.seen.map(s => `${s.method} ${s.url}`),
      ['GET /b2/workers/w1', 'POST /b2/workers/w1/prompt'],
    );
    assert.deepEqual(JSON.parse(f.seen[1]!.body.toString()), { message: 'hi', command_id: 'minted', worker_epoch: 'epoch-1', session_id: 'session-1', binding_revision: 4 });
    assert.equal(f.seen[1]!.headers.authorization, 'Bearer piw1.test');
    f.seen.length = 0;
    await f.cli('workers.stop', 'w1', '--command-id', 'c', '--worker-epoch', 'old', '--session-id', 's0', '--binding-revision', '1');
    assert.deepEqual(f.seen.map(s => `${s.method} ${s.url}`), ['POST /b2/workers/w1/stop'], 'a full binding is never replaced by the current one');
    assert.deepEqual(JSON.parse(f.seen[0]!.body.toString()), { command_id: 'c', worker_epoch: 'old', session_id: 's0', binding_revision: 1 });
    f.seen.length = 0;
    const read = await f.cli('history.page', 'w1', '--limit', '2');
    assert.deepEqual(f.seen.map(s => `${s.method} ${s.url}`), ['GET /b2/workers/w1/history?limit=2']);
    assert.deepEqual(read.json, worker);
  } finally {
    await f.close();
  }
});

test('cli run: a refusal prints its typed name and exits 1; a lost reply after the write exits 3 with the command id; a usage error sends nothing', async () => {
  let mode = 'refuse';
  const f = await fake((req, res) => {
    if (req.method === 'GET') return json(res, 200, worker);
    if (mode === 'refuse') return json(res, 409, { error: 'worker_busy', effect: 'no_effect' });
    if (mode === 'unknown') return json(res, 500, { error: 'dispatch_lost', effect: 'unknown' });
    res.destroy();
  });
  try {
    const refused = await f.cli('sessions.prompt', 'w1', '--message', 'hi');
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.out, []);
    assert.deepEqual(refused.error, { error: 'worker_busy', status: 409, effect: 'no_effect', command_id: 'minted' });
    mode = 'unknown';
    const unknown = await f.cli('sessions.prompt', 'w1', '--message', 'hi');
    assert.equal(unknown.code, 3);
    assert.deepEqual(unknown.error, { error: 'dispatch_lost', status: 500, effect: 'unknown', command_id: 'minted' });
    mode = 'drop';
    const dropped = await f.cli('sessions.prompt', 'w1', '--message', 'hi', '--worker-epoch', 'e', '--session-id', 's', '--binding-revision', '1');
    assert.equal(dropped.code, 3);
    assert.equal(dropped.error?.error, 'transport_after_write');
    assert.equal(dropped.error?.command_id, 'minted');
    const before = f.seen.length;
    const usage = await f.cli('sessions.prompt', 'w1');
    assert.equal(usage.code, 2);
    assert.equal(usage.error?.error, 'usage');
    assert.equal(f.seen.length, before, 'nothing sent');
    const noSocket = await run(['hello'], { out: () => {}, err: () => {}, env: {} });
    assert.equal(noSocket, 2);
  } finally {
    await f.close();
  }
});

test('cli run: a mutation receipt that records a refusal or an unknown outcome is printed and fails the exit code', async () => {
  let state = 'rejected';
  const f = await fake((_req, res) => json(res, 200, receipt(state, state === 'rejected' ? { effect: 'no_effect', error: 'nothing_to_compact' } : { effect: 'unknown' })));
  try {
    const args = ['sessions.compact', 'w1', '--worker-epoch', 'e', '--session-id', 's', '--binding-revision', '1'];
    const rejected = await f.cli(...args);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.json?.state, 'rejected');
    assert.deepEqual(rejected.error, { error: 'nothing_to_compact', receipt_state: 'rejected', effect: 'no_effect', command_id: 'minted' });
    state = 'outcome_unknown';
    const unknown = await f.cli(...args);
    assert.equal(unknown.code, 3);
    assert.equal(unknown.error?.error, 'outcome_unknown');
    const read = await f.cli('receipts.get', 'minted');
    assert.equal(read.code, 0, 'reading a receipt is not a failure, whatever it records');
  } finally {
    await f.close();
  }
});

test('cli run: attachments.stage uploads the file once with its type, hash and binding; a failure names the attachment id', async () => {
  let fail = false;
  const f = await fake((req, res) => {
    if (req.method === 'GET') return json(res, 200, worker);
    if (fail) return json(res, 500, { error: 'stage_unknown', effect: 'unknown' });
    json(res, 200, { command_id: 'minted', operation: 'attachments.stage', state: 'delivered', result: { attachment_id: 'minted' } });
  });
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
    const file = join(f.dir, 'photo.png');
    writeFileSync(file, png);
    const staged = await f.cli('attachments.stage', 'w1', file);
    assert.equal(staged.code, 0, JSON.stringify(staged.err));
    const put = f.seen.at(-1)!;
    assert.equal(`${put.method} ${put.url}`, 'PUT /b2/attachments/minted');
    assert.equal(put.headers['content-type'], 'image/png');
    assert.equal(put.headers['piw-worker-id'], 'w1');
    assert.equal(put.headers['piw-binding-revision'], '4');
    assert.equal(put.headers['piw-content-sha256'], createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(put.body, png);
    fail = true;
    const lost = await f.cli('attachments.stage', 'w1', file, '--attachment-id', 'a9', '--command-id', 'c9');
    assert.equal(lost.code, 3);
    assert.deepEqual(lost.error, { error: 'stage_unknown', status: 500, effect: 'unknown', command_id: 'c9', attachment_id: 'a9' });
    writeFileSync(file, 'GIF89a');
    const gif = await f.cli('attachments.stage', 'w1', file);
    assert.equal(gif.code, 2);
    assert.match(String(gif.error?.detail), /not a JPEG, PNG or WebP/);
  } finally {
    await f.close();
  }
});

test('cli run: byte reads print headers, size and hash, and write --out as a new 0600 file', async () => {
  const blob = Buffer.from([0xff, 0xd8, 0xff, 1, 2]);
  const lines = '{"type":"session","id":"s"}\n{"type":"message","id":"m"}\n';
  const f = await fake((req, res) => {
    if (req.url.includes('/blobs/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Piw-Blob-Index': '0' });
      return res.end(blob);
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Piw-Next-Offset': String(Buffer.byteLength(lines)) });
    res.end(lines);
  });
  try {
    const history = await f.cli('sessions.history', 's1', '--offset', '0');
    assert.deepEqual(history.json, {
      content_type: 'application/x-ndjson',
      headers: { 'piw-next-offset': String(Buffer.byteLength(lines)) },
      bytes: Buffer.byteLength(lines),
      sha256: createHash('sha256').update(lines).digest('hex'),
      lines: [
        { type: 'session', id: 's' },
        { type: 'message', id: 'm' },
      ],
    });
    const out = join(f.dir, 'blob.jpg');
    const read = await f.cli('blobs.read', 's1', 'e1', '0', '--out', out);
    assert.equal(read.code, 0);
    assert.deepEqual(readFileSync(out), blob);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(read.json?.sha256, createHash('sha256').update(blob).digest('hex'));
    const again = await f.cli('blobs.read', 's1', 'e1', '0', '--out', out);
    assert.equal(again.code, 3, 'an existing --out file is never overwritten');
    assert.equal((await f.cli('blobs.read', 's1', 'e1', '0')).json?.body_base64, blob.toString('base64'));
  } finally {
    await f.close();
  }
});

test('cli run: events.subscribe prints one frame per line and stops when the named execution settles', async () => {
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const f = await fake((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame({ type: 'snapshot', workers: [{ worker_id: 'w1', execution: { execution_id: 'x0', state: 'settled' } }], cursor: { seq: 1 }, resync_reason: 'fresh' }));
    res.write(frame({ type: 'execution.settled', worker_id: 'w1', execution_id: 'x0' }));
    res.write(frame({ type: 'execution.settled', worker_id: 'w1', execution_id: 'x1' }));
    res.write(frame({ type: 'worker.updated', worker_id: 'w1' })); // never printed: the watch ended
  });
  try {
    const watched = await f.cli('events.subscribe', '--worker', 'w1', '--type', 'execution.settled', '--until-settled', '--execution-id', 'x1');
    assert.equal(watched.code, 0);
    assert.deepEqual(
      watched.out.map(l => (JSON.parse(l) as { type: string; execution_id?: string }).execution_id ?? 'snapshot'),
      ['snapshot', 'x0', 'x1'],
    );
    assert.equal(f.seen[0]!.url, '/b2/events?worker_id=w1&types=execution.settled');
    const two = await f.cli('events.subscribe', '--max-events', '2');
    assert.equal(two.out.length, 2);
    const snapshotSettled = await f.cli('events.subscribe', '--until-settled', '--execution-id', 'x0');
    assert.equal(snapshotSettled.out.length, 1, 'a snapshot that already shows the execution settled ends the watch');
  } finally {
    await f.close();
  }
});

test("cli run: grant register, list and revoke run the daemon package's local command; never HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piw-cli-grant-'));
  const env = { PIW_STATE_DIR: join(dir, 'state'), PIW_SOCKET: join(dir, 'no-daemon.sock') };
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { out: l => out.push(l), err: l => err.push(l), env });
    return { code, out: out.map(l => JSON.parse(l) as unknown), err: err.map(l => JSON.parse(l) as Record<string, unknown>) };
  };
  try {
    const bearer = join(dir, 'bearer.json');
    const registered = await cli('grant', 'register', '--caller', 'ops', '--out', bearer, '--id', 'g1', '--method', 'hello', '--method', 'workers.list', '--worker', '*', '--answers-for-person');
    assert.equal(registered.code, 0, JSON.stringify(registered.err));
    assert.deepEqual(registered.out, [{ grant_id: 'g1', caller: 'ops', bearer_file: bearer }]);
    assert.equal(statSync(bearer).mode & 0o777, 0o600);
    const token = (JSON.parse(readFileSync(bearer, 'utf8')) as { token: string }).token;
    assert.match(token, /^piw1\.g1\./);
    const listed = await cli('grant', 'list');
    assert.equal(listed.code, 0);
    const [g] = listed.out[0] as Record<string, unknown>[];
    assert.deepEqual([g!.grant_id, g!.methods, g!.scope, g!.answers_for_person, g!.revoked], ['g1', ['hello', 'workers.list'], { worker_ids: ['*'], cwd_roots: [] }, true, false]);
    assert.ok(!JSON.stringify(listed.out).includes(token), 'the list never shows the bearer');
    assert.deepEqual((await cli('grant', 'revoke', 'g1')).out, [{ grant_id: 'g1', revoked: true }]);
    assert.deepEqual(((await cli('grant', 'list')).out[0] as { revoked: boolean }[]).map(x => x.revoked), [true]);
    const missing = await cli('grant', 'revoke', 'nope');
    assert.deepEqual([missing.code, missing.err], [1, [{ error: 'invalid_grant', effect: 'no_effect' }]]);
    const duplicate = await cli('grant', 'register', '--caller', 'ops', '--out', join(dir, 'other.json'), '--id', 'g1');
    assert.deepEqual([duplicate.code, duplicate.err], [1, [{ error: 'grant_id_exists', effect: 'no_effect' }]]);
    assert.equal(existsSync(join(dir, 'other.json')), false);
    assert.equal(existsSync(env.PIW_SOCKET), false, 'no socket was involved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
