/**
 * Argument parsing against the command table: `pi-worker [global flags] <command> [ARGS] [flags]`, flags anywhere,
 * `--flag value` or `--flag=value`. Unknown flags, missing values, a non-list flag given twice, missing or extra
 * positional arguments and missing required flags are usage errors; nothing is sent.
 */
import { readFileSync } from 'node:fs';
import { commandByName, GLOBAL, UsageError, type Command, type Option } from './commands.js';

export type Value = string | number | boolean | string[] | unknown;

export interface Parsed {
  /** Undefined for bare `pi-worker` or `pi-worker --help`. */
  readonly command: Command | undefined;
  /** Positional values by the path parameter they fill. */
  readonly args: Readonly<Record<string, string>>;
  /** Flag values by flag name (globals included), already typed by kind. */
  readonly flags: ReadonlyMap<string, Value>;
  readonly help: boolean;
}

const GLOBAL_BY_FLAG = new Map(GLOBAL.map(o => [o.flag, o]));

function splitFlag(token: string): { name: string; inline: string | undefined } {
  const eq = token.indexOf('=');
  return eq < 0 ? { name: token.slice(2), inline: undefined } : { name: token.slice(2, eq), inline: token.slice(eq + 1) };
}

/** The command name: the first word that is not a global flag or its value; `grant` takes its subcommand. */
function findCommand(argv: readonly string[]): { name: string | undefined; words: number[] } {
  const words: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const { name, inline } = splitFlag(token);
      const option = GLOBAL_BY_FLAG.get(name);
      if (option && option.kind !== 'bool' && inline === undefined) i++;
      if (!option) break; // a command flag: the command came before it, or there is none
      continue;
    }
    words.push(i);
    if (token !== 'grant' || words.length > 1) break;
  }
  if (words.length === 0) return { name: undefined, words };
  const first = argv[words[0]!]!;
  if (first === 'grant') {
    const sub = words[1] === undefined ? undefined : argv[words[1]];
    return { name: sub === undefined ? 'grant' : `grant ${sub}`, words: words.slice(0, 2) };
  }
  return { name: first, words: words.slice(0, 1) };
}

function typed(option: Option, raw: string | undefined): Value {
  switch (option.kind) {
    case 'bool':
      if (raw === undefined || raw === 'true') return true;
      if (raw === 'false') return false;
      throw new UsageError(`--${option.flag} takes no value (or =true, =false)`);
    case 'int':
      if (raw === undefined || !/^-?\d+$/.test(raw)) throw new UsageError(`--${option.flag} needs an integer`);
      return Number(raw);
    case 'json-file': {
      let text: string;
      try {
        text = readFileSync(raw!, 'utf8');
      } catch {
        throw new UsageError(`--${option.flag}: cannot read the file`);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Never echo the contents: a body file may hold an answer.
        throw new UsageError(`--${option.flag}: the file is not JSON`);
      }
    }
    case 'text-file':
      try {
        return readFileSync(raw!, 'utf8');
      } catch {
        throw new UsageError(`--${option.flag}: cannot read the file`);
      }
    default:
      return raw!;
  }
}

export function parse(argv: readonly string[]): Parsed {
  const { name, words } = findCommand(argv);
  const command = name === undefined ? undefined : commandByName.get(name);
  if (name !== undefined && !command) throw new UsageError(`unknown command ${name}; see pi-worker --help`);
  const options = new Map<string, Option>([...GLOBAL_BY_FLAG, ...(command?.options ?? []).map(o => [o.flag, o] as const)]);
  const flags = new Map<string, Value>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (words.includes(i)) continue;
    const token = argv[i]!;
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const { name: flag, inline } = splitFlag(token);
    const option = options.get(flag);
    if (!option) throw new UsageError(`unknown flag --${flag}${command ? ` for ${command.name}` : ''}`);
    let raw = inline;
    if (option.kind !== 'bool' && raw === undefined) {
      raw = argv[i + 1];
      if (raw === undefined) throw new UsageError(`--${flag} needs a value`);
      i++;
    }
    const value = typed(option, raw);
    if (option.kind === 'list') flags.set(flag, [...((flags.get(flag) as string[] | undefined) ?? []), value as string]);
    else if (flags.has(flag)) throw new UsageError(`--${flag} given twice`);
    else flags.set(flag, value);
  }
  const help = flags.get('help') === true;
  const args: Record<string, string> = {};
  if (command && !help) {
    if (positional.length !== command.args.length) {
      throw new UsageError(`${command.name} takes ${command.args.length ? command.args.map(a => a.name).join(' ') : 'no arguments'}`);
    }
    command.args.forEach((a, i) => (args[a.param] = positional[i]!));
    for (const o of command.options) if (o.required && !flags.has(o.flag)) throw new UsageError(`${command.name} needs --${o.flag}`);
  } else if (!command && positional.length && !help) {
    throw new UsageError('no command; see pi-worker --help');
  }
  return { command, args, flags, help };
}
