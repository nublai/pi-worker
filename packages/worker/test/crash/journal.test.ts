/**
 * Journal tests: append, parse, torn tail, corruption, capacity, closed-journal writes, the state lock, and a real
 * SIGKILL after every fsync of two supervisor starts. Journal cases ported from A0 `src/test/receipts.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, parseJournal } from '../../src/journal/journal.js';
import { journalPath, openState } from '../../src/journal/state.js';
import { LockHeld } from '../../src/lock.js';
import { cutAt, lastJson, run, tempRoot } from './harness.js';

function journalIn(name: string, maxBytes?: number) {
  const { root, cleanup } = tempRoot(name);
  const journal = new Journal(join(root, 'journal'), maxBytes);
  return {
    root,
    journal,
    cleanup: () => {
      journal.close();
      cleanup();
    },
  };
}

test('journal: records round-trip through a reopen with sequence and checksum', () => {
  const f = journalIn('roundtrip');
  try {
    f.journal.append('supervisor', { supervisor_id: 'a' }, 'supervisor.start');
    f.journal.append('supervisor', { supervisor_id: 'a', n: 2 }, 'supervisor.start');
    const reopened = new Journal(f.journal.file);
    try {
      assert.deepEqual(reopened.records, f.journal.records);
      assert.deepEqual(
        reopened.records.map(r => r.seq),
        [1, 2],
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});

test('a late callback on a CLOSED journal cannot corrupt a newly opened journal via recycled fd', () => {
  const { root, cleanup } = tempRoot('closed-journal');
  const file = join(root, 'journal');
  const old = new Journal(file);
  old.append('supervisor', { supervisor_id: 'first' }, 'supervisor.start');
  old.close();
  const next = new Journal(file);
  try {
    next.append('supervisor', { supervisor_id: 'second' }, 'supervisor.start');
    const before = readFileSync(file);
    assert.throws(() => old.append('supervisor', { worker: { status: 'late-exit' } }, 'supervisor.start'), /closed/);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(parseJournal(readFileSync(file)).records.length, 2);
  } finally {
    next.close();
    cleanup();
  }
});

test('journal truncates a torn final record, rejects complete corruption or sequence gaps', () => {
  const f = journalIn('torn');
  try {
    f.journal.append('supervisor', { supervisor_id: 'id' }, 'supervisor.start');
    const valid = readFileSync(f.journal.file);
    appendFileSync(f.journal.file, '{"partial":');
    const recovered = new Journal(f.journal.file);
    assert.equal(recovered.records.length, 1);
    assert.deepEqual(readFileSync(f.journal.file), valid);
    recovered.close();
    assert.throws(() => parseJournal(Buffer.concat([valid, Buffer.from('{"bad":true}\n')])), /journal corruption/);
    assert.throws(() => parseJournal(Buffer.concat([valid, valid])), /journal corruption/);
    const altered = Buffer.from(valid.toString().replace('supervisor_id', 'supervisor_ix'));
    assert.throws(() => parseJournal(altered), /journal corruption/);
  } finally {
    f.cleanup();
  }
});

test('journal: an append past capacity fails, marks the journal failed and writes nothing; reservations hold room', () => {
  const f = journalIn('capacity', 600);
  try {
    f.journal.append('supervisor', { supervisor_id: 'x' }, 'supervisor.start');
    const before = readFileSync(f.journal.file);
    assert.equal(f.journal.reserve('command', 400), true);
    assert.equal(f.journal.reserve('other', 400), false, 'a reservation never overcommits');
    assert.throws(() => f.journal.append('supervisor', { pad: 'x'.repeat(200) }, 'supervisor.start'), /journal capacity/);
    assert.equal(f.journal.failed, true);
    assert.deepEqual(readFileSync(f.journal.file), before);
    assert.throws(() => f.journal.append('supervisor', {}, 'supervisor.start'), /journal failed/);
  } finally {
    f.cleanup();
  }
});

test('journal: a command may consume its own reservation for its final record', () => {
  const f = journalIn('reservation', 700);
  try {
    assert.equal(f.journal.reserve('command', 400), true);
    assert.throws(() => f.journal.append('supervisor', { pad: 'y'.repeat(260) }, 'supervisor.start'), /journal capacity/);
    const g = journalIn('reservation-own', 700);
    try {
      assert.equal(g.journal.reserve('command', 400), true);
      g.journal.append('supervisor', { pad: 'y'.repeat(260) }, 'supervisor.start', 'command');
      g.journal.release('command');
      assert.equal(g.journal.records.length, 1);
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('state: the supervisor id persists across starts, the epoch is new, and a second supervisor is refused', () => {
  const { root, cleanup } = tempRoot('state');
  try {
    const first = openState(root);
    assert.throws(() => openState(root), LockHeld);
    first.close();
    const second = openState(root);
    try {
      assert.equal(second.supervisorId, first.supervisorId);
      assert.notEqual(second.supervisorEpoch, first.supervisorEpoch);
      const starts = parseJournal(readFileSync(journalPath(root))).records.filter(r => r.kind === 'supervisor');
      assert.deepEqual(
        starts.map(r => r.value.supervisor_epoch),
        [first.supervisorEpoch, second.supervisorEpoch],
      );
    } finally {
      second.close();
    }
  } finally {
    cleanup();
  }
});

test('crash: SIGKILL after every fsync of two supervisor starts recovers a parseable journal with every fsynced record', { timeout: 120_000 }, () => {
  const base = tempRoot('journal-base');
  try {
    const full = run('journal', base.root);
    assert.equal(full.status, 0, full.stderr);
    const ids = lastJson<{ supervisor_ids: string[] }>(full.stdout).supervisor_ids;
    assert.equal(ids[0], ids[1], 'the second start keeps the first id');
    assert.deepEqual(
      full.points.map(p => `${p.label}@${p.occurrence}`),
      ['journal.open_file@1', 'journal.open_directory@1', 'supervisor.start@1', 'journal.open_file@2', 'journal.open_directory@2', 'supervisor.start@2'],
    );
    const matrix: string[] = [];
    for (const point of full.points) {
      const cut = tempRoot('journal-cut');
      try {
        cutAt('journal', cut.root, point);
        // Oracle: the journal parses, every start whose record was fsynced is present, and none other.
        const records = parseJournal(readFileSync(journalPath(cut.root))).records;
        const starts = records.filter(r => r.kind === 'supervisor');
        const fsynced = full.points.filter(p => p.label === 'supervisor.start' && p.index <= point.index).length;
        assert.equal(starts.length, fsynced, `${point.label}@${point.occurrence}`);
        assert.ok(new Set(starts.map(r => r.value.supervisor_id)).size <= 1, 'one supervisor id across starts');
        // Recovery: the next start opens, keeps the id and appends a fresh epoch.
        const recovered = openState(cut.root);
        try {
          if (starts[0]) assert.equal(recovered.supervisorId, starts[0].value.supervisor_id);
          assert.equal(recovered.journal.records.filter(r => r.kind === 'supervisor').length, fsynced + 1);
        } finally {
          recovered.close();
        }
        matrix.push(`${point.label}@${point.occurrence}`);
      } finally {
        cut.cleanup();
      }
    }
    assert.equal(matrix.length, 6);
  } finally {
    base.cleanup();
  }
});
