/**
 * Attachments and images (P1-16, Shep's S-4): `attachments.stage` (streamed binary upload into private staging,
 * SHA-256 and magic checks, idempotent by attachment id and hash), `attachments.status` (reconcile after a dropped
 * reply, never a re-upload), `attachments.release`, prompts with real image blocks (count and total limits, the exact
 * accepted image count) and `blobs.read`. The real-pi case runs pi 1.5.2 with HOME and PI_CODING_AGENT_DIR in the test
 * directory and a local provider: the image is checked at the request pi sends, in the session file and in blobs.read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { createB2Server, listenPrivate } from '../src/b2/server.js';
import { routes } from '../src/generated/routes.js';
import { error as validateError } from '../src/generated/validators.js';
import type { Worker } from '../src/supervisor/state.js';
import { bind, fixture, type Fixture } from './supervisor-fixture.js';
import { ownerGrant } from './helpers.js';
import { jpegBytes, png, sha256 } from './images.js';
import { fakeProvider, providerExtension, realPiSupervisor, until } from './real-pi.js';

const MiB = 1024 * 1024;
const LIMIT = routes['attachments.stage'].maxBodyBytes;

function world(f: Fixture) {
  const owner = ownerGrant(f.dir);
  const handle = createApp({ supervisor: f.supervisor, grants: owner.grants }).handle;
  const memory = createMemoryTransport(handle, owner.headers);
  let n = 0;
  const stage = (w: Worker, id: string, body: Buffer, extra: Record<string, string> = {}) =>
    memory.request('PUT', `/b2/attachments/${id}`, {
      raw: body,
      headers: {
        'content-type': 'image/jpeg',
        'piw-command-id': extra['piw-command-id'] ?? `stage-${id}-${++n}`,
        'piw-worker-id': w.worker_id,
        'piw-worker-epoch': w.worker_epoch,
        'piw-session-id': w.session_id!,
        'piw-binding-revision': String(w.binding_revision),
        'piw-content-sha256': sha256(body),
        ...extra,
      },
    });
  const files = () => (existsSync(join(f.dir, 'attachments')) ? readdirSync(join(f.dir, 'attachments')) : []);
  return { owner, handle, memory, stage, files };
}

test('attachments: a 1.5 MiB JPEG is staged; over the limit is 413, a hash or magic mismatch 400, all no_effect with no staged file', async () => {
  const f = fixture();
  try {
    const { memory, stage, files } = world(f);
    const w = await f.create();
    const photo = jpegBytes(1.5 * MiB);
    const ok = await stage(w, 'photo-1', photo);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((ok.body as { result: unknown }).result, { attachment_id: 'photo-1', state: 'staged', bytes: photo.length });
    assert.equal(files().length, 1);
    const status = (await memory.request('GET', '/b2/attachments/photo-1')).body as Record<string, unknown>;
    assert.deepEqual([status.state, status.bytes, status.sha256, status.content_type, status.evidence], ['staged', photo.length, sha256(photo), 'image/jpeg', 'supervisor_journal_fsynced']);
    const refusals: [string, Promise<{ status: number; body: unknown }>, number, string][] = [
      ['one byte over the limit', stage(w, 'over', jpegBytes(LIMIT + 1)), 413, 'request_too_large'],
      ['hash mismatch', stage(w, 'bad-hash', jpegBytes(1000), { 'piw-content-sha256': sha256(Buffer.from('other')) }), 400, 'attachment_sha256_mismatch'],
      ['magic mismatch', stage(w, 'bad-magic', png(4, 4)), 400, 'attachment_type_mismatch'],
      ['empty body', stage(w, 'empty', Buffer.alloc(0)), 400, 'attachment_empty'],
    ];
    for (const [label, pending, code, error] of refusals) {
      const r = await pending;
      assert.deepEqual([r.status, (r.body as { error: string }).error, (r.body as { effect: string }).effect], [code, error, 'no_effect'], label);
      assert.equal(validateError(r.body), true, label);
    }
    assert.equal(files().length, 1, 'no refused upload left a staged or partial file');
    for (const id of ['over', 'bad-hash', 'bad-magic', 'empty']) {
      assert.deepEqual((await memory.request('GET', `/b2/attachments/${id}`)).body, { error: 'unknown_attachment_is_not_proof_of_no_effect', effect: 'unknown' }, id);
    }
    // A worker generation the caller did not see, and an unknown worker, are refused before any byte is kept.
    const stale = await stage({ ...w, worker_epoch: 'other-epoch' }, 'stale', jpegBytes(100));
    assert.deepEqual([stale.status, (stale.body as { error: string }).error], [409, 'stale_binding']);
    assert.equal(files().length, 1);
  } finally {
    f.cleanup();
  }
});

test('attachments: staging is idempotent by attachment id and hash; status reconciles a dropped reply with no re-upload', { timeout: 20_000 }, async () => {
  const f = fixture();
  const { owner, handle, memory, stage, files } = world(f);
  const server = createB2Server(handle);
  const socket = join(f.dir, 'b2.sock');
  await listenPrivate(server, socket);
  try {
    const w = await f.create();
    const photo = jpegBytes(1.5 * MiB, 0x33);
    // The bridge forwards the photo and its connection drops before the reply: the upload is never re-sent.
    await new Promise<void>((resolve, reject) => {
      const req = request({
        socketPath: socket,
        method: 'PUT',
        path: '/b2/attachments/dropped',
        agent: false,
        headers: { ...owner.headers, Connection: 'close', 'content-type': 'image/jpeg', 'content-length': photo.length, 'piw-command-id': 'stage-dropped', 'piw-worker-id': w.worker_id, 'piw-worker-epoch': w.worker_epoch, 'piw-session-id': w.session_id!, 'piw-binding-revision': String(w.binding_revision), 'piw-content-sha256': sha256(photo) },
      });
      req.on('error', () => {});
      req.on('finish', () => {
        req.destroy();
        resolve();
      });
      req.on('response', () => reject(new Error('the test drops the reply before reading it')));
      req.end(photo);
    });
    let status: Record<string, unknown> = {};
    await until(() => {
      void memory.request('GET', '/b2/attachments/dropped').then(r => (status = r.body as Record<string, unknown>));
      return status.state === 'staged';
    }, 10_000, 'the dropped upload to be staged');
    assert.deepEqual([status.command_id, status.sha256, status.bytes], ['stage-dropped', sha256(photo), photo.length]);
    assert.equal((await memory.request('GET', '/b2/receipts/stage-dropped')).status, 200, 'the receipt reads too');
    // A careless re-upload of the same id and hash stores nothing twice and names the original command.
    const again = await stage(w, 'dropped', photo);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual((again.body as { result: unknown }).result, { attachment_id: 'dropped', state: 'staged', bytes: photo.length, duplicate_of: 'stage-dropped' });
    assert.equal(files().length, 1);
    // The same id with another image is a conflict, before any byte is kept.
    const other = await stage(w, 'dropped', jpegBytes(500, 0x44));
    assert.deepEqual([other.status, (other.body as { error: string }).error, (other.body as { effect: string }).effect], [409, 'attachment_id_conflict', 'no_effect']);
    // Retrying the exact command returns its stored receipt.
    const retry = await stage(w, 'dropped', photo, { 'piw-command-id': 'stage-dropped' });
    assert.equal((retry.body as { command_id: string; state: string }).state, 'delivered');
    assert.equal(files().length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    f.cleanup();
  }
});

test('attachments: a prompt sends staged images; a fifth photo, a total over the limit, another worker’s or a released one is refused no_effect', async () => {
  const f = fixture();
  try {
    const { memory, stage, files } = world(f);
    const w = await f.create();
    const other = await f.create();
    const host = f.hosts[0]!;
    for (let i = 1; i <= 5; i++) assert.equal((await stage(w, `p${i}`, jpegBytes(1000 + i))).status, 200);
    assert.equal((await stage(other, 'theirs', jpegBytes(900))).status, 200);
    const prompt = (cmd: string, ids: string[], extra: Record<string, unknown> = {}) =>
      memory.request('POST', `/b2/workers/${w.worker_id}/prompt`, { json: { ...bind(f.supervisor.get(w.worker_id), cmd), message: 'look', attachments: ids.map(attachment_id => ({ attachment_id })), ...extra } });
    const refused = async (cmd: string, ids: string[], error: string) => {
      const r = await prompt(cmd, ids);
      assert.deepEqual([r.status, (r.body as { error: string }).error, (r.body as { effect: string }).effect], [409, error, 'no_effect'], cmd);
      assert.equal(f.supervisor.receipts.all.has(cmd), false, `${cmd} left no receipt`);
    };
    await refused('five', ['p1', 'p2', 'p3', 'p4', 'p5'], 'too_many_attachments');
    await refused('twice', ['p1', 'p1'], 'duplicate_attachment');
    await refused('theirs', ['theirs'], 'unknown_attachment');
    await refused('missing', ['nope'], 'unknown_attachment');
    assert.equal(host.prompts, 0, 'no refused prompt reached pi');
    // The total bound (8 MiB per message) holds independently of the count; four 2 MiB photos are exactly at it.
    assert.throws(() => f.supervisor.attachments.forPrompt(w.worker_id, ['p1', 'p2'], { count: 4, bytes: 2000 }), /attachments_too_large/);
    // A delivered prompt carries the images by path and hash to pi, reports the count pi kept, and releases them.
    host.before = c => {
      if (c.type === 'prompt') queueMicrotask(() => void 0);
    };
    const sent = await prompt('with-images', ['p1', 'p2']);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const command = host.commands.find(c => c.type === 'prompt')!;
    assert.deepEqual(
      (command.images as { sha256: string; mime_type: string }[]).map(i => [i.sha256, i.mime_type]),
      [
        [sha256(jpegBytes(1001)), 'image/jpeg'],
        [sha256(jpegBytes(1002)), 'image/jpeg'],
      ],
    );
    for (const id of ['p1', 'p2']) {
      const s = (await memory.request('GET', `/b2/attachments/${id}`)).body as { state: string; released_by: string };
      assert.deepEqual([s.state, s.released_by], ['released', 'with-images'], id);
    }
    assert.equal(files().length, 4, 'the delivered prompt’s staged copies are removed');
    host.emit('event', { type: 'agent_settled' });
    await new Promise(r => setImmediate(r));
    await refused('released', ['p1'], 'attachment_not_staged');
    // A steer joins a running turn as text only.
    await f.supervisor.prompt(w.worker_id, { ...bind(f.supervisor.get(w.worker_id), 'running'), message: 'go' });
    const steer = await prompt('steer-images', ['p3'], { if_busy: 'steer' });
    assert.deepEqual((steer.body as { error: string }).error, 'attachments_need_idle_or_follow_up');
  } finally {
    f.cleanup();
  }
});

test('attachments: staging is allowed under a fence (the prompt is refused); release is durable before the bytes go; scope and restart', async () => {
  const f = fixture();
  try {
    const { owner, handle, memory, stage, files } = world(f);
    const w = await f.create();
    const host = f.hosts[0]!;
    host.failure = true;
    await f.supervisor.prompt(w.worker_id, { ...bind(w, 'lost'), message: 'lost' });
    host.failure = false;
    assert.ok(f.supervisor.get(w.worker_id).fence);
    const staged = await stage(w, 'fenced-photo', jpegBytes(2000));
    assert.equal(staged.status, 200, 'staging writes no session: allowed under a fence');
    const r = await memory.request('POST', `/b2/workers/${w.worker_id}/prompt`, { json: { ...bind(w, 'fenced-prompt'), message: 'x', attachments: [{ attachment_id: 'fenced-photo' }] } });
    assert.deepEqual((r.body as { error: string }).error, 'session_fenced');
    // A grant scoped elsewhere cannot read, release or tell an attachment from an unknown one.
    const scoped = owner.grants.register({ caller: 'scoped', scope: { worker_ids: [], cwd_roots: [join(f.dir, 'elsewhere')] }, methods: ['*'] });
    const outside = createMemoryTransport(handle, { authorization: `Bearer ${scoped.token}` });
    for (const [method, path, json] of [
      ['GET', '/b2/attachments/fenced-photo', undefined],
      ['GET', '/b2/attachments/never-staged', undefined],
      ['POST', '/b2/attachments/fenced-photo/release', { command_id: 'scoped-release' }],
    ] as const) {
      assert.deepEqual((await outside.request(method, path, json ? { json } : {})).body, { error: 'grant_scope_denied', effect: 'no_effect' }, path);
    }
    // Survives a restart; an unfinished upload and an unrecorded file are swept.
    writeFileSync(join(f.dir, 'attachments', `${'a'.repeat(64)}.00000000-0000-0000-0000-000000000000.part`), 'partial');
    writeFileSync(join(f.dir, 'attachments', `${'b'.repeat(64)}.img`), 'orphan');
    await f.restart();
    const after = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    assert.equal(((await after.request('GET', '/b2/attachments/fenced-photo')).body as { state: string }).state, 'staged');
    assert.equal(files().length, 1, 'only the staged attachment’s bytes remain');
    // The released record is durable before the bytes go: when it cannot be written, the bytes stay and it is staged.
    const journal = f.supervisor.attachments.journal;
    const append = journal.append.bind(journal);
    journal.append = (kind, value, label, reservation) => {
      if (label === 'attachment.release') throw new Error('injected journal failure');
      return append(kind, value, label, reservation);
    };
    assert.throws(() => f.supervisor.attachments.releaseNow(['fenced-photo'], 'injected'), /injected journal failure/);
    journal.append = append;
    assert.equal(files().length, 1, 'no record, no removal');
    assert.equal(f.supervisor.attachments.status('fenced-photo').state, 'staged');
    // Release: the released record first, then the bytes; a second release is refused.
    const released = await after.request('POST', '/b2/attachments/fenced-photo/release', { json: { command_id: 'release-1' } });
    assert.equal((released.body as { state: string }).state, 'delivered', JSON.stringify(released.body));
    assert.deepEqual(((await after.request('GET', '/b2/attachments/fenced-photo')).body as { state: string; released_by: string }).released_by, 'release-1');
    assert.equal(files().length, 0);
    assert.deepEqual((await after.request('POST', '/b2/attachments/fenced-photo/release', { json: { command_id: 'release-2' } })).body, { error: 'attachment_not_staged', effect: 'no_effect' });
  } finally {
    f.cleanup();
  }
});

test('attachments: a journal compaction keeps staged attachments; after a restart they are still staged and their bytes stay', async () => {
  const f = fixture();
  try {
    const { owner, stage, files } = world(f);
    const w = await f.create();
    const photo = jpegBytes(3000);
    assert.equal((await stage(w, 'kept-photo', photo)).status, 200);
    assert.equal((await stage(w, 'released-photo', jpegBytes(2000))).status, 200);
    f.supervisor.attachments.releaseNow(['released-photo'], 'release-before-compaction');
    // Retention (P1-12) rewrites the journal to the records it retains; an attachment record is one of them.
    f.supervisor.receipts.compact({ rewrite: true });
    await f.restart();
    const after = createMemoryTransport(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle, owner.headers);
    const status = (await after.request('GET', '/b2/attachments/kept-photo')).body as Record<string, unknown>;
    assert.deepEqual([status.state, status.bytes, status.sha256], ['staged', photo.length, sha256(photo)], JSON.stringify(status));
    assert.equal(((await after.request('GET', '/b2/attachments/released-photo')).body as { state: string }).state, 'released', 'a released record whose receipt is retained stays');
    assert.equal(files().length, 1, 'the staged bytes survive the startup sweep');
  } finally {
    f.cleanup();
  }
});

test('attachments (real pi): image blocks reach the model request and the session file; the exact accepted count; blobs.read serves the image', { timeout: 90_000 }, async () => {
  const provider = await fakeProvider();
  const f = realPiSupervisor({ 'provider.ts': providerExtension(provider.url) });
  try {
    const owner = ownerGrant(f.state);
    const handle = createApp({ supervisor: f.s, grants: owner.grants }).handle;
    const memory = createMemoryTransport(handle, owner.headers);
    const id = await f.create();
    const w = f.s.get(id);
    const image = png(24, 16);
    // Valid magic, undecodable data: pi drops it with a hint, so the accepted count is honest.
    const broken = Buffer.concat([image.subarray(0, 8), Buffer.alloc(64, 7)]);
    for (const [aid, bytes] of [
      ['real', image],
      ['broken', broken],
    ] as const) {
      const r = await memory.request('PUT', `/b2/attachments/${aid}`, {
        raw: bytes,
        headers: { 'content-type': 'image/png', 'piw-command-id': `stage-${aid}`, 'piw-worker-id': id, 'piw-worker-epoch': w.worker_epoch, 'piw-session-id': w.session_id!, 'piw-binding-revision': String(w.binding_revision), 'piw-content-sha256': sha256(bytes) },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const sent = await f.s.prompt(id, { ...bind(f.s.get(id), 'look'), message: 'what is in these photos?', attachments: [{ attachment_id: 'real' }, { attachment_id: 'broken' }] });
    assert.equal(sent.state, 'delivered', JSON.stringify(sent));
    assert.deepEqual(sent.result, { interrupt_marker: false, accepted_images: 1 }, 'the count pi put in the message');
    await until(() => f.s.get(id).foreground === 'idle' && provider.requests.length === 1, 20_000, 'the run');
    // The request pi sends: a real image block with the same bytes, not a path.
    const userMessages = (provider.requests[0]!.messages as { role: string; content: { type: string; source?: { data: string; media_type: string } }[] }[]).filter(m => m.role === 'user');
    const block = userMessages.at(-1)!.content.find(c => c.type === 'image')!;
    assert.deepEqual([block.source!.media_type, Buffer.from(block.source!.data, 'base64').equals(image)], ['image/png', true]);
    assert.ok(!JSON.stringify(provider.requests[0]).includes(f.state), 'no staging path reaches the model');
    // The same image in history.
    const lines = readFileSync(f.s.state.require(id).sessionFile!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string; type: string; message?: { role: string; content: { type: string; data?: string }[] } });
    const entry = lines.filter(e => e.type === 'message' && e.message?.role === 'user').at(-1)!;
    const images = entry.message!.content.filter(c => c.type === 'image');
    assert.equal(images.length, 1);
    assert.ok(Buffer.from(images[0]!.data!, 'base64').equals(image), 'the session file holds the image the model got');
    // blobs.read serves it, by session id, with a validated content type and within the blob cap.
    const blob = await memory.request('GET', `/b2/sessions/${w.session_id}/entries/${entry.id}/blobs/0`);
    assert.equal(blob.status, 200, JSON.stringify(blob.body));
    assert.equal(blob.contentType, 'image/png');
    assert.ok((blob.body as Buffer).equals(image));
    assert.equal(blob.headers!['piw-blob-sha256'], sha256(image));
    assert.ok((blob.body as Buffer).length <= routes['blobs.read'].responses['200'].maxBytes!);
    assert.deepEqual((await memory.request('GET', `/b2/sessions/${w.session_id}/entries/${entry.id}/blobs/1`)).body, { error: 'unknown_blob', effect: 'no_effect' });
    // Bytes changed on disk after staging never reach the model: the child refuses before any input.
    const tampered = png(8, 8);
    const staged = await memory.request('PUT', '/b2/attachments/tampered', {
      raw: tampered,
      headers: { 'content-type': 'image/png', 'piw-command-id': 'stage-tampered', 'piw-worker-id': id, 'piw-worker-epoch': w.worker_epoch, 'piw-session-id': w.session_id!, 'piw-binding-revision': String(w.binding_revision), 'piw-content-sha256': sha256(tampered) },
    });
    assert.equal(staged.status, 200);
    const stagedFile = f.s.attachments.forPrompt(id, ['tampered'], { count: 4, bytes: 1 << 30 })[0]!.path;
    writeFileSync(stagedFile, png(9, 9));
    const before = provider.requests.length;
    const refused = await f.s.prompt(id, { ...bind(f.s.get(id), 'look-tampered'), message: 'and this one?', attachments: [{ attachment_id: 'tampered' }] });
    assert.deepEqual([refused.state, refused.effect, refused.error], ['rejected', 'no_effect', 'pi_refused_prompt: attachment_bytes_changed']);
    assert.equal(provider.requests.length, before, 'nothing reached the model');
    assert.equal(f.s.get(id).fence, null);
    // Both staged copies are released once the prompt was delivered.
    for (const aid of ['real', 'broken']) assert.equal(((await memory.request('GET', `/b2/attachments/${aid}`)).body as { state: string }).state, 'released');
  } finally {
    await f.cleanup();
    await provider.close();
  }
});

test('attachments: blobs.read refuses a media type outside the allowlist or bytes that do not match it, no_effect', async () => {
  const f = fixture();
  try {
    const { memory } = world(f);
    const w = await f.create();
    const file = f.supervisor.state.require(w.worker_id).sessionFile!;
    const line = (id: string, mimeType: string, data: Buffer) => `${JSON.stringify({ type: 'message', id, parentId: null, message: { role: 'user', content: [{ type: 'image', mimeType, data: data.toString('base64') }] } })}\n`;
    writeFileSync(file, `${readFileSync(file, 'utf8')}${line('svg', 'image/svg+xml', Buffer.from('<svg/>'))}${line('liar', 'image/png', jpegBytes(64))}${line('ok', 'image/jpeg', jpegBytes(64))}`);
    const read = (entry: string) => memory.request('GET', `/b2/sessions/${w.session_id}/entries/${entry}/blobs/0`);
    assert.deepEqual((await read('svg')).body, { error: 'blob_type_not_allowed', effect: 'no_effect' });
    assert.deepEqual((await read('liar')).body, { error: 'blob_type_mismatch', effect: 'no_effect' });
    assert.deepEqual((await read('missing')).body, { error: 'unknown_entry', effect: 'no_effect' });
    const ok = await read('ok');
    assert.deepEqual([ok.status, ok.contentType], [200, 'image/jpeg']);
  } finally {
    f.cleanup();
  }
});
