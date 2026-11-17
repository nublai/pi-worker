/**
 * Worker rows carry `first_user_line` (Shep P5-2 title fallback): the first line of the session's first user text,
 * the worker's interrupt marker stripped, trimmed, at most 280 characters, read from the session file as `preview` is;
 * null before a user message with text. In every row: workers.get, the snapshot and worker.updated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { INTERRUPT_MARKER } from '../src/history/session-file.js';
import { validateEventFrame, type EventFrame } from '../src/generated/events.js';
import type { Worker as Row } from '../src/supervisor/state.js';

/** The row with the field this test is about (declared here so that this file also builds on the revision before it). */
type Worker = Row & { first_user_line?: string | null };
import { fixture } from './supervisor-fixture.js';

const user = (id: string, content: unknown) => `${JSON.stringify({ type: 'message', id, parentId: null, timestamp: '2026-11-17T08:00:00.000Z', message: { role: 'user', content } })}\n`;

test('first_user_line: the first line of the first user text, marker stripped, trimmed, at most 280 characters, in every worker row', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    const id = w.worker_id;
    const file = f.supervisor.state.require(id).sessionFile!;
    // Rows read with the line (snapshot and worker.updated validated against their schemas).
    const frames: EventFrame[] = [];
    const sub = f.supervisor.subscribe(
      frame => {
        assert.equal(validateEventFrame(frame), true, `${frame.type}: ${JSON.stringify(validateEventFrame.errors)}`);
        frames.push(frame);
      },
      { workerIds: [id] },
    );
    const line = () => (f.supervisor.get(id) as Worker).first_user_line;
    assert.equal(line(), null, 'a new session has none');
    // pi wrote an image-only user message: no text line yet.
    appendFileSync(file, user('u0', [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]));
    assert.equal(line(), null, 'an image has no text line');
    const long = 'y'.repeat(300);
    appendFileSync(file, user('u1', [{ type: 'text', text: `${INTERRUPT_MARKER}\n  \n  ${long}  \nsecond line` }]));
    assert.equal(line(), long.slice(0, 280));
    // A later user message does not change it.
    appendFileSync(file, user('u2', 'a later message'));
    assert.equal(line(), long.slice(0, 280));
    assert.equal(f.supervisor.get(id).preview, 'a later message');
    sub.close();
    const rows = frames.flatMap(x => (x.type === 'snapshot' ? x.workers : x.type === 'worker.updated' ? [x.data.worker] : [])) as Worker[];
    assert.equal(rows[0]!.first_user_line, null, 'the snapshot');
    assert.ok(
      rows.some(r => r.first_user_line === long.slice(0, 280)),
      'a worker.updated carries it',
    );
    // A fresh snapshot carries it too.
    let snapshot: Worker[] = [];
    f.supervisor.subscribe(frame => {
      if (frame.type === 'snapshot') snapshot = frame.workers as Worker[];
    }).close();
    assert.equal(snapshot.find(r => r.worker_id === id)?.first_user_line, long.slice(0, 280));
  } finally {
    f.cleanup();
  }
});
