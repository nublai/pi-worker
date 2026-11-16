/**
 * Attachment crash cuts (P1-16): a real SIGKILL after every fsync of the attachments scenario (the staged bytes, the
 * directory, the staged and released records) and after every native effect. Besides the recovery oracle, an
 * independent check of the staging directory: every attachment whose last durable record is `staged` has its bytes,
 * hashed here, equal to the hash the client sent; nothing else is left (no partial upload, no unrecorded file, no
 * released bytes); and a delivered stage receipt has a durable record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal } from '../../src/journal/journal.js';
import { journalPath } from '../../src/journal/state.js';
import { checkRecovery, type Check } from './oracle.js';
import { fences } from './fence.test.js';
import { cutAt, run, tempRoot, type FsyncPoint } from './harness.js';
import { effectsAt, requestsAt } from './world.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function staging(root: string): Check {
  return (_pre, after) => {
    const records = new Map<string, { state: string; sha256: string }>();
    for (const r of parseJournal(readFileSync(journalPath(root))).records) {
      if (r.kind === 'attachment') records.set(String(r.value.attachment_id), r.value as { state: string; sha256: string });
    }
    // What the client sent, from its own request log: the hash of each attachment id's bytes.
    const sent = new Map(requestsAt(root).filter(q => q.op === 'stage').map(q => [String(q.body.attachment_id), sha(Buffer.from(String(q.body.body_base64), 'base64'))]));
    const dir = join(root, 'attachments');
    const files = new Set(existsSync(dir) ? readdirSync(dir) : []);
    const expected = new Set<string>();
    for (const [id, r] of records) {
      if (r.state !== 'staged') continue;
      const name = `${sha(id)}.img`;
      expected.add(name);
      assert.ok(files.has(name), `${id}: a staged record has its bytes`);
      assert.equal(sha(readFileSync(join(dir, name))), sent.get(id), `${id}: the staged bytes are the bytes the client sent`);
    }
    assert.deepEqual([...files].filter(f => !expected.has(f)).sort(), [], 'no partial upload, unrecorded or released bytes remain');
    for (const r of after.receipts) {
      if (r.operation === 'attachments.stage' && r.state === 'delivered') {
        const id = (r.result as { attachment_id?: string } | undefined)?.attachment_id;
        assert.ok(id && records.has(id), `${r.command_id}: a delivered stage has a durable record`);
      }
    }
  };
}

test('crash: SIGKILL after every attachments-scenario fsync: staged bytes match their record, nothing else is left', { timeout: 900_000 }, async () => {
  const base = tempRoot('attachments-base');
  let points: FsyncPoint[];
  try {
    const full = run('attachments', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
  } finally {
    base.cleanup();
  }
  for (const point of points) {
    const cut = tempRoot('attachments-cut');
    try {
      cutAt('attachments', cut.root, point);
      await checkRecovery(cut.root, [fences, staging(cut.root)]);
    } finally {
      cut.cleanup();
    }
  }
});

test('crash: SIGKILL after every attachments-scenario native effect: effect-bearing receipts, exact fences, clean staging', { timeout: 300_000 }, async () => {
  const base = tempRoot('attachments-effects');
  let count: number;
  try {
    assert.equal(run('attachments', base.root).status, 0);
    count = effectsAt(base.root).length;
  } finally {
    base.cleanup();
  }
  for (let n = 1; n <= count; n++) {
    const cut = tempRoot('attachments-effect');
    try {
      assert.equal(run('attachments', cut.root, undefined, { PIW_CRASH_EFFECT: String(n) }).signal, 'SIGKILL');
      await checkRecovery(cut.root, [fences, staging(cut.root)]);
    } finally {
      cut.cleanup();
    }
  }
});
