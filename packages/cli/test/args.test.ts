/** Argument parsing and request building: what each command sends, and what is refused before anything is sent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes } from '@nublai/pi-worker-client';
import { parse } from '../src/args.js';
import { COMMANDS, UsageError } from '../src/commands.js';
import { buildRequest, help, imageType } from '../src/run.js';
import { uuidv7 } from '../src/uuid.js';

const usage = (argv: string[], message: RegExp) => assert.throws(() => parse(argv), (e: unknown) => e instanceof UsageError && message.test(e.message), argv.join(' '));
const build = (argv: string[]) => {
  const parsed = parse(argv);
  return buildRequest(parsed.command!, parsed, () => 'minted');
};

test('cli: one command per B2 operation, named by its operationId, plus the local grant commands', () => {
  const ops = COMMANDS.filter(c => c.op !== undefined);
  assert.deepEqual(ops.map(c => c.name).sort(), Object.keys(routes).sort());
  for (const c of ops) assert.equal(c.name, c.op);
  assert.deepEqual(COMMANDS.filter(c => c.op === undefined).map(c => c.name), ['grant register', 'grant revoke', 'grant list']);
  for (const c of ops.filter(c => c.mode !== 'stage')) {
    const params = (routes[c.op!].path.match(/\{([^}]+)\}/g) ?? []).map(p => p.slice(1, -1));
    assert.deepEqual(c.args.map(a => a.param), params, `${c.name} positional arguments are its path parameters`);
  }
  // The upload names its worker (a Piw-Worker-Id header) and its file; the attachment id is --attachment-id or minted.
  assert.deepEqual(COMMANDS.find(c => c.mode === 'stage')?.args.map(a => a.name), ['WORKER', 'FILE']);
});

test('cli: flags go anywhere, as --flag value or --flag=value; globals before the command', () => {
  const p = parse(['--socket', '/s', 'sessions.prompt', '--message=hi there', 'w1', '--attachment', 'a1', '--attachment=a2', '--binding-revision', '3']);
  assert.equal(p.command?.name, 'sessions.prompt');
  assert.deepEqual(p.args, { worker_id: 'w1' });
  assert.equal(p.flags.get('socket'), '/s');
  assert.equal(p.flags.get('message'), 'hi there');
  assert.deepEqual(p.flags.get('attachment'), ['a1', 'a2']);
  assert.equal(p.flags.get('binding-revision'), 3);
  assert.equal(parse(['workers.create', '--cwd', '/c', '--provider', 'p', '--model', 'm', '--thinking', 'off', '--project-trusted']).flags.get('project-trusted'), true);
  assert.equal(parse(['models.list', '--cwd', '/c', '--project-trusted=false']).flags.get('project-trusted'), false);
  assert.equal(parse(['grant', 'revoke', 'g1']).command?.name, 'grant revoke');
  assert.equal(parse(['--grant-file', '/g', 'grant', 'list']).command?.name, 'grant list');
  assert.equal(parse(['--help']).help, true);
  assert.equal(parse(['workers.stop', '--help']).command?.name, 'workers.stop', '--help needs no arguments');
  assert.equal(parse([]).command, undefined);
});

test('cli: usage errors are refused before anything is sent', () => {
  usage(['nope'], /unknown command nope/);
  usage(['grant'], /unknown command grant/);
  usage(['grant', 'remove', 'g'], /unknown command grant remove/);
  usage(['hello', '--message', 'x'], /unknown flag --message for hello/);
  usage(['sessions.prompt', 'w1'], /needs --message/);
  usage(['sessions.prompt', '--message', 'm'], /takes WORKER/);
  usage(['workers.get', 'w1', 'w2'], /takes WORKER/);
  usage(['hello', 'extra'], /takes no arguments/);
  usage(['sessions.prompt', 'w1', '--message'], /--message needs a value/);
  usage(['sessions.prompt', 'w1', '--message', 'a', '--message', 'b'], /given twice/);
  usage(['history.page', 'w1', '--limit', 'ten'], /--limit needs an integer/);
  usage(['hello', '--help=maybe'], /takes no value/);
  usage(['interactions.answer_if_current', 'w', '--interaction-id', 'i', '--revision', '1', '--kind', 'k', '--outcome', 'answer', '--body-file', '/no/such/file'], /--body-file: cannot read the file/);
});

test('cli: a mutation mints a UUIDv7 command id unless given; the binding fields pass through; flags win over --body-file', () => {
  assert.deepEqual(build(['sessions.prompt', 'w1', '--message', 'hi']), { path: { worker_id: 'w1' }, query: {}, body: { message: 'hi', command_id: 'minted' } });
  assert.deepEqual(build(['workers.stop', 'w1', '--command-id', 'c1', '--worker-epoch', 'e', '--session-id', 's', '--binding-revision', '2']).body, {
    command_id: 'c1',
    worker_epoch: 'e',
    session_id: 's',
    binding_revision: 2,
  });
  assert.deepEqual(build(['attachments.release', 'a1']), { path: { attachment_id: 'a1' }, query: {}, body: { command_id: 'minted' } });
  const dir = mkdtempSync(join(tmpdir(), 'piw-cli-'));
  try {
    const file = join(dir, 'body.json');
    writeFileSync(file, JSON.stringify({ message: 'from file', if_busy: 'follow_up' }));
    assert.deepEqual(build(['sessions.prompt', 'w1', '--message', 'flag', '--body-file', file]).body, { message: 'flag', if_busy: 'follow_up', command_id: 'minted' });
    writeFileSync(file, '[1]');
    assert.throws(() => build(['sessions.new', 'w1', '--body-file', file]), /--body-file must hold a JSON object/);
    writeFileSync(file, 'secret answer text');
    assert.throws(
      () => build(['sessions.new', 'w1', '--body-file', file]),
      (e: unknown) => e instanceof UsageError && !e.message.includes('secret'),
      'an unreadable body file is never echoed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const id = uuidv7(Date.UTC(2026, 10, 17));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(parseInt(id.replace(/-/g, '').slice(0, 12), 16), Date.UTC(2026, 10, 17));
});

test('cli: flags map to the wire shapes of their fields', () => {
  assert.deepEqual(build(['sessions.prompt', 'w1', '--message', 'm', '--attachment', 'a1', '--attachment', 'a2', '--if-busy', 'follow_up']).body, {
    message: 'm',
    attachments: [{ attachment_id: 'a1' }, { attachment_id: 'a2' }],
    if_busy: 'follow_up',
    command_id: 'minted',
  });
  assert.deepEqual(build(['session.configure', 'w1', '--model', 'openrouter/anthropic/claude', '--thinking', 'low']).body, {
    model: { provider: 'openrouter', id: 'anthropic/claude' },
    thinking: 'low',
    command_id: 'minted',
  });
  assert.throws(() => build(['session.configure', 'w1', '--model', 'noslash']), /PROVIDER\/MODEL_ID/);
  assert.equal(build(['sessions.rebind', 'w1', '--action', 'fork', '--source-leaf-id', 'null', '--entry-id', 'e']).body?.source_leaf_id, null);
  assert.deepEqual(build(['files.read', 'w1', '--path', '/r/f', '--root', '/r', '--root', '/q']).body, { path: '/r/f', roots: ['/r', '/q'] });
  assert.deepEqual(build(['history.page', 'w1', '--limit', '5', '--after', 'e1']), { path: { worker_id: 'w1' }, query: { limit: 5, after: 'e1' }, body: undefined });
  assert.deepEqual(build(['models.list', '--worker', 'w1']).query, { worker_id: 'w1' });
  assert.deepEqual(build(['interactions.status', 'w1', '--interaction-id', 'i1']).query, { interaction_id: 'i1' });
  assert.deepEqual(build(['blobs.read', 's1', 'e1', '0']).path, { session_id: 's1', entry_id: 'e1', index: '0' });
  const answer = ['interactions.answer_if_current', 'w1', '--interaction-id', 'i1', '--revision', '2', '--kind', 'confirm', '--outcome', 'answer'];
  assert.deepEqual(build([...answer, '--confirm', 'yes']).body, {
    interaction_id: 'i1',
    revision: 2,
    kind: 'confirm',
    outcome: 'answer',
    value: true,
    command_id: 'minted',
    answer_id: 'minted',
  });
  assert.equal(build([...answer, '--confirm', 'no', '--answer-id', 'a1']).body?.answer_id, 'a1');
  assert.throws(() => build([...answer, '--confirm', 'maybe']), /yes or no/);
  const dir = mkdtempSync(join(tmpdir(), 'piw-cli-'));
  try {
    const file = join(dir, 'answer.txt');
    writeFileSync(file, 'typed text');
    assert.equal(build([...answer, '--value-file', file]).body?.value, 'typed text');
    assert.throws(() => build([...answer, '--value-file', file, '--confirm', 'yes']), /--confirm and --value-file set the same field/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: --help lists every command, and each command its flags', () => {
  const top = help(undefined);
  for (const c of COMMANDS) assert.match(top, new RegExp(`^  ${c.name.replace('.', '\\.')} +${c.summary.replace(/[()]/g, '\\$&')}$`, 'm'));
  for (const c of COMMANDS) {
    const text = help(c);
    assert.match(text, new RegExp(`^usage: pi-worker ${c.name.replace('.', '\\.')}`));
    for (const o of c.options) assert.match(text, new RegExp(`^  --${o.flag}\\b.*${o.required ? '\\(required\\)' : ''}`, 'm'), `${c.name} --${o.flag}`);
  }
  assert.match(help(COMMANDS.find(c => c.name === 'sessions.prompt')), /^usage: pi-worker sessions\.prompt WORKER --message VALUE \[flags\]$/m);
});

test('cli: the upload type comes from the file magic', () => {
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(imageType(Buffer.from('GIF89a')), undefined);
});
