/**
 * Runs one parsed command: one B2 operation through `@nublai/pi-worker-client`, or the daemon package's local
 * `grant` command, or a host command (src/host.ts). The only extra request is the `workers.get` read that fills a
 * binding the caller left out.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, ClientFailure, routes, type Cursor, type EventFrame, type OperationId } from '@nublai/pi-worker-client';
import { parse, type Parsed, type Value } from './args.js';
import { BINDING, COMMANDS, fieldOf, GLOBAL, UsageError, type Command, type Option } from './commands.js';
import { EXIT, grantFailure, mapError, ReceiptRefusal } from './errors.js';
import { daemon, doctor, install, logs, realSystem, uninstall, userEnv, type System } from './host.js';
import { uuidv7 } from './uuid.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  readonly env: NodeJS.ProcessEnv;
  /** The host the host commands act on (default: this one); tests pass a fake systemd. */
  readonly system?: System;
}

export interface Request {
  readonly path: Record<string, string>;
  readonly query: Record<string, unknown>;
  readonly body: Record<string, unknown> | undefined;
}

const BINDING_FIELDS = ['worker_epoch', 'session_id', 'binding_revision'] as const;

/** The operation's path, query and body from the parsed arguments. Mints `command_id` for a mutation without one. */
export function buildRequest(command: Command, parsed: Parsed, mint: () => string = uuidv7): Request {
  const path = Object.fromEntries(Object.entries(parsed.args).filter(([param]) => param !== 'file'));
  const query: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  const setBy = new Map<string, string>();
  for (const option of command.options) {
    if (option.in === 'cli' || !parsed.flags.has(option.flag)) continue;
    const field = fieldOf(option);
    const target = option.in === 'body' ? fields : query;
    const key = `${option.in}.${field}`;
    if (setBy.has(key)) throw new UsageError(`--${setBy.get(key)} and --${option.flag} set the same field`);
    setBy.set(key, option.flag);
    const value = parsed.flags.get(option.flag);
    target[field] = option.wire ? option.wire(value as never) : value;
  }
  const json = command.op !== undefined && routes[command.op].body === 'json';
  let body: Record<string, unknown> | undefined;
  if (json) {
    const file = parsed.flags.get('body-file');
    if (file !== undefined && (file === null || typeof file !== 'object' || Array.isArray(file))) throw new UsageError('--body-file must hold a JSON object');
    body = { ...(file as Record<string, unknown> | undefined), ...fields };
    if (command.mode === 'binding' || command.mode === 'command') body.command_id ??= mint();
    if (command.op === 'interactions.answer_if_current') body.answer_id ??= body.command_id;
  } else if (command.mode === 'stage') {
    body = { ...fields, command_id: fields.command_id ?? mint() };
  }
  return { path, query, body };
}

/** The default socket, as the daemon resolves it. */
export function socketPath(flags: ReadonlyMap<string, Value>, env: NodeJS.ProcessEnv): string {
  const given = (flags.get('socket') as string | undefined) ?? env.PIW_SOCKET;
  if (given) return given;
  if (env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)) return join(env.XDG_RUNTIME_DIR, 'pi-worker', 'b2.sock');
  throw new UsageError('no socket: pass --socket, or set PIW_SOCKET or XDG_RUNTIME_DIR');
}

/** Fills the binding fields the caller left out from the worker's current row (one `workers.get`). */
async function fillBinding(client: Client, workerId: string, body: Record<string, unknown>): Promise<void> {
  if (BINDING_FIELDS.every(f => body[f] !== undefined)) return;
  const worker = await client.call('workers.get', { path: { worker_id: workerId } });
  if (worker.session_id === null) throw new ClientFailure('worker_has_no_session', 'no_effect', 'before_write');
  body.worker_epoch ??= worker.worker_epoch;
  body.session_id ??= worker.session_id;
  body.binding_revision ??= worker.binding_revision;
}

const IMAGE_MAGIC: [string, (b: Buffer) => boolean][] = [
  ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

/** The image media type the file's magic bytes name, for the upload's Content-Type. */
export function imageType(bytes: Buffer): string | undefined {
  return IMAGE_MAGIC.find(([, match]) => match(bytes))?.[0];
}

function writeNew(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}

async function readBytes(client: Client, command: Command, request: Request, out: string | undefined): Promise<Record<string, unknown>> {
  const reply = await client.read(command.op!, { path: request.path as never, query: request.query as never });
  const headers = Object.fromEntries(Object.entries(reply.headers).filter(([k]) => k.startsWith('piw-')));
  const summary = { content_type: reply.contentType, headers, bytes: reply.body.length, sha256: createHash('sha256').update(reply.body).digest('hex') };
  if (out !== undefined) {
    writeNew(out, reply.body);
    return { ...summary, out };
  }
  if (command.op === 'blobs.read') return { ...summary, body_base64: reply.body.toString('base64') };
  const lines = reply.body
    .toString('utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
  return { ...summary, lines };
}

async function watch(client: Client, flags: ReadonlyMap<string, Value>, io: Io): Promise<void> {
  let since: Cursor | undefined;
  if (flags.has('since')) {
    try {
      since = JSON.parse(flags.get('since') as string) as Cursor;
    } catch {
      throw new UsageError('--since takes a cursor as JSON');
    }
  }
  const max = flags.get('max-events') as number | undefined;
  const untilSettled = flags.get('until-settled') === true;
  const execution = flags.get('execution-id') as string | undefined;
  const workers = flags.get('worker') as string[] | undefined;
  const matches = (id: string | undefined) => execution === undefined || id === execution;
  let count = 0;
  await client.watch(
    (frame: EventFrame) => {
      io.out(JSON.stringify(frame));
      count++;
      if (max !== undefined && count >= max) return false;
      if (!untilSettled) return true;
      if (frame.type === 'execution.settled') return !matches(frame.execution_id);
      if (frame.type === 'snapshot') {
        const settled = frame.workers.some(w => (!workers || workers.includes(w.worker_id)) && w.execution?.state === 'settled' && matches(w.execution.execution_id));
        return !settled;
      }
      return true;
    },
    {
      ...(workers ? { workerIds: workers } : {}),
      ...(flags.has('type') ? { types: flags.get('type') as string[] } : {}),
      ...(since ? { since } : {}),
      ...(flags.get('resync-overflow') === true ? { overflowResync: true } : {}),
    },
  );
}

/** The daemon package's `grant` command (dist/src/grant.js next to its main). */
export function grantCommandPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve('@nublai/pi-worker'))), 'grant.js');
}

function grant(command: Command, parsed: Parsed, io: Io): void {
  const flags = parsed.flags;
  const argv: string[] = [command.name.slice('grant '.length)];
  if (command.name === 'grant revoke') argv.push(parsed.args.grant_id!);
  if (command.name === 'grant register') {
    argv.push('--caller', flags.get('caller') as string, '--out', flags.get('out') as string);
    for (const [flag, list] of [['method', '--method'], ['worker', '--worker'], ['cwd-root', '--cwd-root']] as const) {
      for (const value of (flags.get(flag) as string[] | undefined) ?? []) argv.push(list, value);
    }
    if (flags.get('answers-for-person') === true) argv.push('--answers-for-person');
    if (flags.has('id')) argv.push('--id', flags.get('id') as string);
  }
  // The same runtime fallback as install (`XDG_RUNTIME_DIR` defaults to `/run/user/<uid>`), so a shell without one
  // registers in the state directory install pinned.
  const env = userEnv(io.env, io.system?.uid ?? process.getuid!());
  const result = spawnSync(process.execPath, [grantCommandPath(), ...argv], { encoding: 'utf8', env });
  if (result.status !== 0) throw grantFailure(result.stderr ?? '', result.status);
  io.out(JSON.stringify(JSON.parse(result.stdout) as unknown));
}

/** A host command; resolves with its exit code (`doctor` exits 1 when a check fails, `logs` with journalctl's). */
async function host(command: Command, parsed: Parsed, io: Io): Promise<number> {
  const system = io.system ?? realSystem();
  const print = (value: unknown) => io.out(JSON.stringify(value));
  switch (command.name) {
    case 'install':
      print(await install({ from: parsed.flags.get('from') as string, ...(parsed.flags.has('wait-ms') ? { waitMs: parsed.flags.get('wait-ms') as number } : {}) }, io.env, system));
      return EXIT.ok;
    case 'doctor': {
      const checks = await doctor(io.env, system);
      const ok = checks.every(c => c.ok);
      if (parsed.flags.get('json') === true) print({ ok, checks });
      else for (const c of checks) io.out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(18)} ${c.detail}`);
      return ok ? EXIT.ok : EXIT.noEffect;
    }
    case 'logs':
      return logs(parsed.flags.get('follow') === true, io.env, system);
    case 'uninstall':
      print(uninstall(parsed.flags.get('purge') === true, io.env, system));
      return EXIT.ok;
    default:
      await daemon();
      return EXIT.ok;
  }
}

async function execute(command: Command, parsed: Parsed, io: Io, context: Record<string, string | undefined>, mint: () => string): Promise<void> {
  if (command.mode === 'grant') return grant(command, parsed, io);
  const request = buildRequest(command, parsed, mint);
  context.command_id = request.body?.command_id as string | undefined;
  const client = new Client({
    socketPath: socketPath(parsed.flags, io.env),
    grantFile: (parsed.flags.get('grant-file') as string | undefined) ?? io.env.PIW_GRANT_FILE,
    ...(parsed.flags.has('timeout-ms') ? { timeoutMs: parsed.flags.get('timeout-ms') as number } : {}),
  });
  const print = (value: unknown) => io.out(JSON.stringify(value));
  switch (command.mode) {
    case 'watch':
      return watch(client, parsed.flags, io);
    case 'read':
      return print(await readBytes(client, command, request, parsed.flags.get('out') as string | undefined));
    case 'stage': {
      let bytes: Buffer;
      try {
        bytes = readFileSync(parsed.args.file!);
      } catch {
        throw new UsageError('cannot read FILE');
      }
      const contentType = (parsed.flags.get('content-type') as string | undefined) ?? imageType(bytes);
      if (!contentType) throw new UsageError('FILE is not a JPEG, PNG or WebP image; pass --content-type');
      const attachmentId = (parsed.flags.get('attachment-id') as string | undefined) ?? mint();
      context.attachment_id = attachmentId;
      const body = request.body!;
      await fillBinding(client, parsed.args.worker_id!, body);
      const params = { command_id: body.command_id, worker_id: parsed.args.worker_id, worker_epoch: body.worker_epoch, session_id: body.session_id, binding_revision: body.binding_revision };
      const receipt = await client.stage(attachmentId, params as never, contentType, bytes);
      print(receipt);
      return refusedReceipt(receipt);
    }
    case 'binding':
      await fillBinding(client, parsed.args.worker_id!, request.body!);
      break;
    default:
      if (command.op === 'hello') return print(await client.hello());
  }
  const options = {
    ...(Object.keys(request.path).length ? { path: request.path } : {}),
    ...(Object.keys(request.query).length ? { query: request.query } : {}),
    ...(request.body ? { body: request.body } : {}),
  };
  const reply = await client.call(command.op as OperationId, options as never);
  print(reply);
  if (command.mode === 'binding' || command.mode === 'command') refusedReceipt(reply);
}

/**
 * A mutation's 200 is its receipt, printed whole. A receipt that records a refusal (`rejected`) or an unknown outcome
 * (`outcome_unknown`) is still a failure for the exit code and the stderr object.
 */
function refusedReceipt(reply: unknown): void {
  const receipt = reply as { state?: string; effect?: string; error?: string };
  if (receipt.state !== 'rejected' && receipt.state !== 'outcome_unknown') return;
  const effect = receipt.state === 'rejected' && receipt.effect === 'no_effect' ? 'no_effect' : 'unknown';
  throw new ReceiptRefusal(receipt.error ?? receipt.state, effect, receipt.state);
}

const VALUE: Record<Option['kind'], string> = { string: ' VALUE', int: ' N', bool: '', list: ' VALUE', 'json-file': ' FILE', 'text-file': ' FILE' };

function optionLines(options: readonly Option[]): string[] {
  const left = options.map(o => `  --${o.flag}${VALUE[o.kind]}`);
  const width = Math.max(...left.map(l => l.length)) + 2;
  return options.map((o, i) => `${left[i]!.padEnd(width)}${o.help}${o.required ? ' (required)' : ''}`);
}

export function help(command: Command | undefined): string {
  if (!command) {
    const width = Math.max(...COMMANDS.map(c => c.name.length)) + 2;
    return [
      'usage: pi-worker [--socket PATH] [--grant-file FILE] <command> [ARGS] [flags]',
      '',
      'Each command is one B2 operation, named by its operationId, or a local grant command. Output is one JSON',
      'object on stdout (events.subscribe: one per frame). A failure prints {"error": <typed name>, "effect", ...} on',
      'stderr and exits 1 (refused, no effect), 2 (usage, nothing sent) or 3 (effect unknown: read',
      'receipts.get COMMAND_ID, never retry blindly).',
      '',
      'commands:',
      ...COMMANDS.map(c => `  ${c.name.padEnd(width)}${c.summary}`),
      '',
      'global flags:',
      ...optionLines(GLOBAL),
      '',
      'pi-worker <command> --help shows its flags.',
    ].join('\n');
  }
  const required = command.options.filter(o => o.required).map(o => `--${o.flag}${VALUE[o.kind]}`);
  const lines = [`usage: pi-worker ${[command.name, ...command.args.map(a => a.name), ...required].join(' ')}${command.options.length > required.length ? ' [flags]' : ''}`, command.summary];
  if (command.mode === 'binding' || (command.mode === 'stage' && command.options.includes(BINDING[0]!))) {
    lines.push('Binding flags left out are read from workers.get (the current binding).');
  }
  if (command.options.length) lines.push('', ...optionLines(command.options));
  return lines.join('\n');
}

/** Runs the CLI; resolves with the exit code. */
export async function run(argv: readonly string[], io: Io, mint: () => string = uuidv7): Promise<number> {
  const context: Record<string, string | undefined> = {};
  try {
    const parsed = parse(argv);
    if (parsed.help || !parsed.command) {
      if (!parsed.help) throw new UsageError('no command; see pi-worker --help');
      io.out(help(parsed.command));
      return EXIT.ok;
    }
    if (parsed.command.mode === 'host') return await host(parsed.command, parsed, io);
    await execute(parsed.command, parsed, io, context, mint);
    return EXIT.ok;
  } catch (error) {
    const { body, exitCode } = mapError(error, context);
    io.err(JSON.stringify(body));
    return exitCode;
  }
}
