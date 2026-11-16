/**
 * Grant crash cuts (P1-9): a real SIGKILL after every fsync of the grant command's work. The oracle reads only the
 * scenario's own step log and the files on disk; it never asks the store which steps happened:
 * - a bearer file that exists names a grant whose record is complete (the record is durable before the bearer);
 * - that bearer authenticates, unless its revocation returned, in which case it is refused `grant_revoked`; a
 *   revocation cut in flight leaves either outcome, never another error;
 * - no file under the grant directory contains a bearer (hash at rest), every record is an owned 0600 file in a 0700
 *   directory, and the owner can register again afterwards (a cut leaves no state that blocks registration).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../../src/b2/errors.js';
import { GrantStore } from '../../src/grants/store.js';
import { cutAt, run, tempRoot } from './harness.js';

type Step = { step: string; id: string; file?: string };
const steps = (root: string): Step[] =>
  existsSync(join(root, 'steps.jsonl'))
    ? readFileSync(join(root, 'steps.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as Step)
    : [];

function checkGrants(root: string): void {
  const done = steps(root);
  const state = join(root, 'state');
  const store = new GrantStore(state);
  const tokens: string[] = [];
  for (const id of ['reader', 'writer']) {
    const file = join(root, 'callers', `${id}.json`);
    if (!existsSync(file)) {
      assert.ok(!done.some(s => s.step === 'bearer' && s.id === id), `${id}: a returned bearer write left its file`);
      continue;
    }
    const token = (JSON.parse(readFileSync(file, 'utf8')) as { token: string }).token;
    tokens.push(token);
    const revoked = done.some(s => s.step === 'revoked' && s.id === id);
    let outcome: string;
    try {
      store.authenticate(`Bearer ${token}`);
      outcome = 'ok';
    } catch (error) {
      assert.ok(error instanceof Refusal, `${id}: ${String(error)}`);
      outcome = error.message;
    }
    if (revoked) assert.equal(outcome, 'grant_revoked', `${id}: a returned revocation refuses`);
    else assert.ok(['ok', 'grant_revoked'].includes(outcome), `${id}: ${outcome}`);
    if (id === 'reader') assert.equal(outcome, 'ok', 'the reader was never revoked');
  }
  const dir = join(state, 'grants');
  if (existsSync(dir)) {
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    for (const name of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, name), 'utf8');
      for (const token of tokens) assert.equal(bytes.includes(token), false, `${name} holds no bearer`);
      const st = lstatSync(join(dir, name));
      assert.ok(st.isFile() && (st.mode & 0o777) === 0o600, `${name} is a 0600 file`);
    }
  }
  // Registration still works after the cut: a leftover temporary file never blocks it.
  const after = new GrantStore(state);
  const { token } = after.register({ caller: 'after-cut', scope: { worker_ids: ['*'], cwd_roots: [] }, methods: ['hello'] });
  assert.equal(after.authenticate(`Bearer ${token}`).caller, 'after-cut');
  for (const id of ['reader', 'writer']) {
    if (done.some(s => s.step === 'registered' && s.id === id)) continue;
    // A registration cut before it returned may be absent or complete; either way the id resolves or registers.
    try {
      after.read(id);
    } catch {
      after.register({ caller: id, scope: { worker_ids: [], cwd_roots: [] }, methods: ['hello'], grant_id: id });
    }
  }
}

test('crash: SIGKILL after every grant fsync: bearer files only for complete records, revocation durable once returned', { timeout: 120_000 }, () => {
  const base = tempRoot('grants-base');
  let points;
  try {
    const full = run('grants', base.root);
    assert.equal(full.status, 0, full.stderr);
    points = full.points;
    checkGrants(base.root);
  } finally {
    base.cleanup();
  }
  // The directory once; for each grant its record (file, directory) and bearer; the revocation (file, directory).
  assert.equal(points.length, 9);
  for (const point of points) {
    const cut = tempRoot('grants-cut');
    try {
      cutAt('grants', cut.root, point);
      checkGrants(cut.root);
    } finally {
      cut.cleanup();
    }
  }
});
