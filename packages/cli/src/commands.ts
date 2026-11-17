/**
 * The command table: one command per B2 operation, named by its operationId, plus the local `grant` commands. Each
 * entry says how arguments become the operation's path, query and body; nothing here decides what the worker owns.
 */
import type { OperationId } from '@nublai/pi-worker-client';

/**
 * How a flag's value is read. `bool` takes no value (`--flag`, or `--flag=false`); `list` repeats; `json-file` and
 * `text-file` name a file whose contents are the value (so private text never sits in argv).
 */
export type Kind = 'string' | 'int' | 'bool' | 'list' | 'json-file' | 'text-file';

export interface Option {
  /** The flag without its leading `--`. */
  readonly flag: string;
  readonly kind: Kind;
  readonly help: string;
  readonly required?: boolean;
  /** Where the value goes: a body or query field (default: the flag with `-` as `_`), or the CLI itself. */
  readonly in: 'body' | 'query' | 'cli';
  readonly field?: string;
  /** Turns the parsed value into the field's wire value. */
  readonly wire?: (value: never) => unknown;
}

/**
 * How a command runs:
 * - `call`: one JSON request; `binding`: a session-directed mutation whose body carries `command_id` and the binding
 *   (filled from `workers.get` unless given); `command`: a mutation whose body carries only `command_id`;
 * - `stage`: the image upload; `read`: an ndjson or binary read; `watch`: the SSE stream;
 * - `grant`: the daemon package's local `grant` command (never HTTP).
 */
export type Mode = 'call' | 'binding' | 'command' | 'stage' | 'read' | 'watch' | 'grant';

export interface Command {
  readonly name: string;
  readonly op?: OperationId;
  readonly mode: Mode;
  readonly summary: string;
  /** Positional arguments in order; each fills the path parameter it names. */
  readonly args: readonly { readonly name: string; readonly param: string }[];
  readonly options: readonly Option[];
}

const flagField = (o: Option): string => o.field ?? o.flag.replaceAll('-', '_');
export const fieldOf = flagField;

const body = (flag: string, kind: Kind, help: string, extra: Partial<Option> = {}): Option => ({ flag, kind, help, in: 'body', ...extra });
const query = (flag: string, kind: Kind, help: string, extra: Partial<Option> = {}): Option => ({ flag, kind, help, in: 'query', ...extra });
const cli = (flag: string, kind: Kind, help: string, extra: Partial<Option> = {}): Option => ({ flag, kind, help, in: 'cli', ...extra });

const WORKER = { name: 'WORKER', param: 'worker_id' } as const;
const SESSION = { name: 'SESSION', param: 'session_id' } as const;
const ATTACHMENT = { name: 'ATTACHMENT', param: 'attachment_id' } as const;

export const COMMAND_ID = body('command-id', 'string', 'command id (default: a new UUIDv7, printed in the receipt)');
/** The binding a session-directed mutation names; any one left out is read from `workers.get`. */
export const BINDING: readonly Option[] = [
  COMMAND_ID,
  body('worker-epoch', 'string', 'expected worker epoch (default: current)'),
  body('session-id', 'string', 'expected session id (default: current)'),
  body('binding-revision', 'int', 'expected binding revision (default: current)'),
];
export const BODY_FILE = cli('body-file', 'json-file', 'JSON object file with more body fields; flags win');
export const GLOBAL: readonly Option[] = [
  cli('socket', 'string', 'B2 socket (default: PIW_SOCKET, else $XDG_RUNTIME_DIR/pi-worker/b2.sock)'),
  cli('grant-file', 'string', 'bearer file from `grant register` (default: PIW_GRANT_FILE)'),
  cli('timeout-ms', 'int', 'per-request timeout in ms (default 60000); never retried'),
  cli('help', 'bool', 'show help'),
];

const executionId = (required = false) => body('execution-id', 'string', 'execution id', { required });
const message = body('message', 'string', 'message text', { required: true });
const thinking = (required: boolean) => body('thinking', 'string', 'off|minimal|low|medium|high|xhigh|max', { required });
const feature = [
  query('worker', 'string', 'ask this worker', { field: 'worker_id' }),
  query('cwd', 'string', 'ask a short-lived pi for this absolute cwd'),
  query('project-trusted', 'bool', 'trust the cwd project resources'),
];

export const COMMANDS: readonly Command[] = [
  { name: 'hello', op: 'hello', mode: 'call', summary: 'Negotiate the protocol and read the named limits', args: [], options: [] },
  { name: 'workers.list', op: 'workers.list', mode: 'call', summary: 'List the workers this grant may see', args: [], options: [] },
  {
    name: 'workers.create',
    op: 'workers.create',
    mode: 'command',
    summary: 'Create a worker and launch pi',
    args: [],
    options: [
      COMMAND_ID,
      body('cwd', 'string', 'absolute working directory', { required: true }),
      body('provider', 'string', 'model provider', { required: true }),
      body('model', 'string', 'model id', { required: true }),
      thinking(true),
      body('project-trusted', 'bool', 'load the project resources'),
      body('resume-session-id', 'string', 'reattach a session the catalog knows'),
      BODY_FILE,
    ],
  },
  { name: 'workers.get', op: 'workers.get', mode: 'call', summary: 'Read one worker row', args: [WORKER], options: [] },
  {
    name: 'session.configure',
    op: 'session.configure',
    mode: 'binding',
    summary: "Change the bound session's model, thinking level or name",
    args: [WORKER],
    options: [
      ...BINDING,
      body('model', 'string', 'PROVIDER/MODEL_ID', {
        wire: (v: string) => {
          const at = v.indexOf('/');
          if (at < 1 || at === v.length - 1) throw new UsageError('--model takes PROVIDER/MODEL_ID');
          return { provider: v.slice(0, at), id: v.slice(at + 1) };
        },
      }),
      thinking(false),
      body('name', 'string', 'session name'),
      BODY_FILE,
    ],
  },
  { name: 'sessions.compact', op: 'sessions.compact', mode: 'binding', summary: 'Compact the bound session (/compact)', args: [WORKER], options: [...BINDING, body('custom-instructions', 'string', 'summary instructions'), BODY_FILE] },
  { name: 'resources.reload', op: 'resources.reload', mode: 'binding', summary: 'Reload extensions, skills, prompts and context files (/reload)', args: [WORKER], options: [...BINDING, BODY_FILE] },
  {
    name: 'commands.invoke',
    op: 'commands.invoke',
    mode: 'binding',
    summary: 'Run an extension command',
    args: [WORKER],
    options: [...BINDING, body('name', 'string', 'command name without the slash', { required: true }), body('args', 'string', 'argument text'), BODY_FILE],
  },
  {
    name: 'sessions.prompt',
    op: 'sessions.prompt',
    mode: 'binding',
    summary: 'Send a prompt to the bound session',
    args: [WORKER],
    options: [
      ...BINDING,
      message,
      body('if-busy', 'string', 'steer|follow_up|reject (default reject)'),
      body('attachment', 'list', 'staged attachment id (repeatable)', { field: 'attachments', wire: (ids: string[]) => ids.map(attachment_id => ({ attachment_id })) }),
      BODY_FILE,
    ],
  },
  { name: 'sessions.follow_up', op: 'sessions.follow_up', mode: 'binding', summary: 'Queue a follow-up against a named execution', args: [WORKER], options: [...BINDING, executionId(true), message, BODY_FILE] },
  { name: 'sessions.steer', op: 'sessions.steer', mode: 'binding', summary: 'Steer the named running execution', args: [WORKER], options: [...BINDING, executionId(true), message, BODY_FILE] },
  {
    name: 'sessions.rebind',
    op: 'sessions.rebind',
    mode: 'binding',
    summary: 'Move the binding (new, fork, resume, navigate)',
    args: [WORKER],
    options: [
      ...BINDING,
      body('action', 'string', 'new|fork|resume|navigate', { required: true }),
      body('target-session-id', 'string', 'session to resume'),
      body('entry-id', 'string', 'entry to fork from or navigate to'),
      body('source-leaf-id', 'string', "the leaf you saw ('null' for none)", { wire: (v: string) => (v === 'null' ? null : v) }),
      BODY_FILE,
    ],
  },
  { name: 'sessions.new', op: 'sessions.new', mode: 'binding', summary: 'Bind a new session (/new)', args: [WORKER], options: [...BINDING, BODY_FILE] },
  {
    name: 'sessions.resolve_unknown',
    op: 'sessions.resolve_unknown',
    mode: 'binding',
    summary: 'Lift a fence with one disposition',
    args: [WORKER],
    options: [
      ...BINDING,
      body('disposition', 'string', 'keep|abandon|observed', { required: true }),
      body('fence-generation', 'int', 'the fence generation you saw', { required: true }),
      body('uncertain-command-id', 'string', 'the uncertain command (or --execution-id)'),
      executionId(),
      BODY_FILE,
    ],
  },
  { name: 'workers.stop', op: 'workers.stop', mode: 'binding', summary: "Stop the worker's pi; keeps the session", args: [WORKER], options: [...BINDING, BODY_FILE] },
  { name: 'workers.relaunch', op: 'workers.relaunch', mode: 'binding', summary: 'Relaunch pi on the same session after confirmed cleanup', args: [WORKER], options: [...BINDING, BODY_FILE] },
  { name: 'executions.cancel', op: 'executions.cancel', mode: 'binding', summary: 'Cancel the current execution; allowed while fenced', args: [WORKER], options: [...BINDING, executionId(), BODY_FILE] },
  { name: 'executions.interrupt', op: 'executions.interrupt', mode: 'binding', summary: 'Interrupt (Escape); allowed while fenced', args: [WORKER], options: [...BINDING, executionId(), BODY_FILE] },
  {
    name: 'children.launch',
    op: 'children.launch',
    mode: 'binding',
    summary: 'Launch a child worker under the current execution',
    args: [WORKER],
    options: [...BINDING, executionId(true), body('launch', 'json-file', 'the child Create body, as a JSON file', { required: true }), BODY_FILE],
  },
  {
    name: 'children.report',
    op: 'children.report',
    mode: 'binding',
    summary: "A child's claim to its parent",
    args: [WORKER],
    options: [
      ...BINDING,
      body('task-id', 'string', 'task id', { required: true }),
      body('result-digest', 'string', 'result digest', { required: true }),
      body('kind', 'string', 'result|help'),
      body('message', 'string', 'message text'),
      BODY_FILE,
    ],
  },
  { name: 'interactions.list', op: 'interactions.list', mode: 'call', summary: 'Live interactions of a worker', args: [WORKER], options: [] },
  {
    name: 'interactions.status',
    op: 'interactions.status',
    mode: 'call',
    summary: "One interaction's state and answer stage",
    args: [WORKER],
    options: [query('interaction-id', 'string', 'interaction id', { required: true })],
  },
  {
    name: 'interactions.answer_if_current',
    op: 'interactions.answer_if_current',
    mode: 'binding',
    summary: 'Answer an interaction if its binding and revision are current',
    args: [WORKER],
    options: [
      ...BINDING,
      body('interaction-id', 'string', 'interaction id', { required: true }),
      body('revision', 'int', 'interaction revision', { required: true }),
      body('kind', 'string', 'select|confirm|input|editor|tool_approval', { required: true }),
      body('outcome', 'string', 'answer|cancel', { required: true }),
      body('option-id', 'string', 'chosen option (select)'),
      body('confirm', 'string', 'yes|no (confirm, tool_approval)', {
        field: 'value',
        wire: (v: string) => {
          if (v !== 'yes' && v !== 'no') throw new UsageError('--confirm takes yes or no');
          return v === 'yes';
        },
      }),
      body('value-file', 'text-file', 'file holding the answer text (input, editor)', { field: 'value' }),
      body('answer-id', 'string', 'answer id (default: the command id)'),
      body('actor', 'string', 'device or person reference'),
      BODY_FILE,
    ],
  },
  {
    name: 'history.page',
    op: 'history.page',
    mode: 'call',
    summary: "Page the bound session's pi entries",
    args: [WORKER],
    options: [query('watermark', 'string', 'watermark entry id'), query('after', 'string', 'page after this entry id'), query('limit', 'int', 'entries per page')],
  },
  { name: 'items.read', op: 'items.read', mode: 'call', summary: 'Read one whole pi entry of the bound session', args: [WORKER, { name: 'ENTRY', param: 'entry_id' }], options: [] },
  {
    name: 'files.read',
    op: 'files.read',
    mode: 'call',
    summary: 'Read a file inside explicit confinement roots',
    args: [WORKER],
    options: [body('path', 'string', 'absolute file path', { required: true }), body('root', 'list', 'confinement root (repeatable)', { field: 'roots', required: true })],
  },
  {
    name: 'attachments.stage',
    op: 'attachments.stage',
    mode: 'stage',
    summary: 'Stage one image file (JPEG, PNG or WebP) for a later prompt',
    args: [WORKER, { name: 'FILE', param: 'file' }],
    options: [
      cli('attachment-id', 'string', 'attachment id (default: a new UUIDv7)'),
      cli('content-type', 'string', 'image/jpeg|image/png|image/webp (default: from the file magic)'),
      ...BINDING,
    ],
  },
  { name: 'attachments.status', op: 'attachments.status', mode: 'call', summary: "Read a staged attachment's state", args: [ATTACHMENT], options: [] },
  { name: 'attachments.release', op: 'attachments.release', mode: 'command', summary: 'Release a staged attachment and remove its bytes', args: [ATTACHMENT], options: [COMMAND_ID] },
  {
    name: 'sessions.list',
    op: 'sessions.list',
    mode: 'call',
    summary: 'List the sessions the catalog knows, newest first',
    args: [],
    options: [query('cwd', 'string', 'only this absolute cwd'), query('limit', 'int', 'rows')],
  },
  { name: 'sessions.get', op: 'sessions.get', mode: 'call', summary: 'Read one session row', args: [SESSION], options: [] },
  {
    name: 'sessions.history',
    op: 'sessions.history',
    mode: 'read',
    summary: "Read a session file's complete lines by byte range",
    args: [SESSION],
    options: [
      query('offset', 'int', 'start byte (default 0)'),
      query('max-bytes', 'int', 'most bytes'),
      query('identity', 'string', 'Piw-File-Identity of the previous read'),
      query('tail', 'string', 'Piw-Tail-Sha256 of the previous read'),
      query('prefix', 'string', 'Piw-Prefix-Sha256 of the previous read'),
      cli('out', 'string', 'write the raw lines to this new file instead of printing them'),
    ],
  },
  { name: 'models.list', op: 'models.list', mode: 'call', summary: 'The model catalog pi reports (one of --worker, --cwd)', args: [], options: feature },
  { name: 'commands.list', op: 'commands.list', mode: 'call', summary: 'The slash commands pi offers (one of --worker, --cwd)', args: [], options: feature },
  {
    name: 'blobs.read',
    op: 'blobs.read',
    mode: 'read',
    summary: 'Read one image of a session entry',
    args: [SESSION, { name: 'ENTRY', param: 'entry_id' }, { name: 'INDEX', param: 'index' }],
    options: [cli('out', 'string', 'write the image to this new file (default: base64 in the output)')],
  },
  { name: 'receipts.get', op: 'receipts.get', mode: 'call', summary: "Read a command's receipt", args: [{ name: 'COMMAND_ID', param: 'command_id' }], options: [] },
  {
    name: 'events.subscribe',
    op: 'events.subscribe',
    mode: 'watch',
    summary: 'Print the event stream, one frame per line (a snapshot first)',
    args: [],
    options: [
      cli('worker', 'list', 'only this worker (repeatable)'),
      cli('type', 'list', 'only this event type (repeatable)'),
      cli('since', 'string', 'Last-Event-ID cursor JSON'),
      cli('resync-overflow', 'bool', 'ask for a snapshot instead of closing on overflow'),
      cli('max-events', 'int', 'stop after N frames'),
      cli('until-settled', 'bool', 'stop once the execution (--execution-id, else any) is settled'),
      cli('execution-id', 'string', 'the execution --until-settled waits for'),
    ],
  },
  {
    name: 'grant register',
    mode: 'grant',
    summary: 'Register a bearer grant (local file access to the state directory)',
    args: [],
    options: [
      cli('caller', 'string', 'caller name', { required: true }),
      cli('out', 'string', 'new 0600 file that receives the bearer', { required: true }),
      cli('method', 'list', 'allowed operationId, or * (repeatable; default *)'),
      cli('worker', 'list', 'worker id in scope, or * (repeatable; default none)'),
      cli('cwd-root', 'list', 'absolute cwd root in scope, or * (repeatable; default none)'),
      cli('answers-for-person', 'bool', 'may answer interactions for the person'),
      cli('id', 'string', 'grant id (default: random)'),
    ],
  },
  { name: 'grant revoke', mode: 'grant', summary: 'Revoke a grant; its next request is refused', args: [{ name: 'GRANT_ID', param: 'grant_id' }], options: [] },
  { name: 'grant list', mode: 'grant', summary: 'List grants (hashes only, never bearers)', args: [], options: [] },
];

export class UsageError extends Error {}

export const commandByName = new Map(COMMANDS.map(c => [c.name, c]));
