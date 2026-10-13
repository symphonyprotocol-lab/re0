/**
 * `re0` -- connect an MCP client to Re0. requirement.md 9.4.
 *
 *   re0 setup  [--client <id>...] [--key <api key>] [--url <endpoint>] [--yes]
 *   re0 remove [--client <id>...] [--yes]
 *
 * `setup` writes re0's server entry into each chosen client's configuration
 * and `remove` takes it out again; neither touches any other entry. Every
 * write is shown first and confirmed, unless `--yes`. Without `--client`,
 * the clients whose configuration file already exists are chosen.
 *
 * Dependency-free on purpose: the whole program is what `npx @symphonyprotocollab/re0` downloads.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import {
  CLIENTS,
  CLIENT_IDS,
  CODEX_TOKEN_ENV,
  clientById,
  isClientId,
  type ClientId,
  type ClientSpec,
  type Connection,
  type Platform,
} from './clients.js';

const DEFAULT_URL = 'https://re0.io/mcp';
const VERSION = '0.1.0';

const USAGE = `re0 ${VERSION} -- connect Claude, Codex and Cursor to Re0 over MCP

Usage:
  re0 setup  [--client <id>]... [--key <api key>] [--url <endpoint>] [--yes]
  re0 remove [--client <id>]... [--yes]

Clients: ${CLIENT_IDS.join(', ')}, all (default: those already installed)

Options:
  --client <id>   Which client to configure; repeatable
  --key <key>     An API key from the dashboard (or set ${CODEX_TOKEN_ENV}); anonymous otherwise
  --url <url>     The MCP endpoint (default ${DEFAULT_URL})
  --yes, -y       Write without asking
  --help, -h      This text
  --version, -v   Print the version
`;

interface Args {
  command: 'setup' | 'remove' | 'help' | 'version';
  clients: ClientId[] | 'all' | 'installed';
  key?: string;
  url: string;
  yes: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: 'help', clients: 'installed', url: DEFAULT_URL, yes: false };
  const clients: ClientId[] = [];
  let all = false;
  const rest = [...argv];
  const first = rest[0];
  if (first === 'setup' || first === 'remove') {
    args.command = first;
    rest.shift();
  } else if (first === 'help' || first === '--help' || first === '-h' || first === undefined) {
    args.command = 'help';
    return args;
  } else if (first === 'version' || first === '--version' || first === '-v') {
    args.command = 'version';
    return args;
  } else {
    throw new Error(`unknown command: ${first}`);
  }

  while (rest.length > 0) {
    const flag = rest.shift()!;
    const value = () => {
      const next = rest.shift();
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--client': {
        const id = value();
        if (id === 'all') all = true;
        else if (isClientId(id)) clients.push(id);
        else throw new Error(`unknown client: ${id} (one of ${CLIENT_IDS.join(', ')}, all)`);
        break;
      }
      case '--key':
        args.key = value();
        break;
      case '--url':
        args.url = value().replace(/\/$/, '');
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--help':
      case '-h':
        args.command = 'help';
        return args;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  args.clients = all ? 'all' : clients.length > 0 ? clients : 'installed';
  return args;
}

/* ------------------------------------------------------------------ I/O */

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function platform(): Platform {
  return { home: homedir(), os: process.platform, appData: process.env.APPDATA };
}

interface Target {
  client: ClientSpec;
  path: string;
  current: string | null;
}

async function targets(selection: Args['clients'], here: Platform): Promise<Target[]> {
  const chosen =
    selection === 'all' || selection === 'installed'
      ? CLIENTS
      : selection.map((id) => clientById(id));
  const found: Target[] = [];
  for (const client of chosen) {
    const path = client.configPath(here);
    if (!path) continue;
    const current = await readText(path);
    if (selection === 'installed' && current === null) continue;
    found.push({ client, path, current });
  }
  return found;
}

/* -------------------------------------------------------------- commands */

async function setup(args: Args): Promise<number> {
  const connection: Connection = {
    url: args.url,
    apiKey: args.key ?? process.env[CODEX_TOKEN_ENV] ?? undefined,
  };
  const found = await targets(args.clients, platform());
  if (found.length === 0) {
    stderr.write('No MCP client configuration found. Name one with --client (or --client all).\n');
    return 1;
  }

  const plans = found.map((target) => ({
    ...target,
    next: target.client.setup(target.current ?? '', connection),
  }));

  stdout.write(`Connecting to ${connection.url}${connection.apiKey ? ' with your API key' : ' anonymously (trial limits apply)'}.\n\n`);
  for (const plan of plans) {
    const verb = plan.current === null ? 'create' : plan.client.hasEntry(plan.current) ? 'update' : 'edit';
    stdout.write(`${plan.client.label}: ${verb} ${plan.path}\n`);
    stdout.write(indent(diffHint(plan.current, plan.next)));
  }

  if (!args.yes && !(await confirm('\nWrite these files?'))) {
    stdout.write('Nothing written.\n');
    return 1;
  }

  for (const plan of plans) {
    await mkdir(dirname(plan.path), { recursive: true });
    await writeFile(plan.path, plan.next, 'utf8');
    stdout.write(`Wrote ${plan.path}\n`);
    const note = plan.client.note?.(connection);
    if (note) stdout.write(`  ${note}\n`);
  }
  stdout.write('\nDone. Restart the client to pick up the change.\n');
  return 0;
}

async function remove(args: Args): Promise<number> {
  const found = await targets(args.clients === 'installed' ? 'all' : args.clients, platform());
  const plans = found
    .filter((target) => target.current !== null && target.client.hasEntry(target.current))
    .map((target) => ({ ...target, next: target.client.remove(target.current!) }));

  if (plans.length === 0) {
    stdout.write('No re0 entry found in any client configuration.\n');
    return 0;
  }
  for (const plan of plans) stdout.write(`${plan.client.label}: remove re0 from ${plan.path}\n`);

  if (!args.yes && !(await confirm('\nRemove these entries?'))) {
    stdout.write('Nothing written.\n');
    return 1;
  }
  for (const plan of plans) {
    await writeFile(plan.path, plan.next, 'utf8');
    stdout.write(`Wrote ${plan.path}\n`);
  }
  return 0;
}

/** The lines that change, enough to see what is about to be written. */
function diffHint(current: string | null, next: string): string {
  const before = new Set((current ?? '').split('\n'));
  const added = next.split('\n').filter((line) => line.trim() !== '' && !before.has(line));
  return added.map((line) => `+ ${line}`).join('\n') + (added.length > 0 ? '\n' : '');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : 'bad arguments'}\n\n${USAGE}`);
    return 2;
  }
  switch (args.command) {
    case 'help':
      stdout.write(USAGE);
      return 0;
    case 'version':
      stdout.write(`${VERSION}\n`);
      return 0;
    case 'setup':
      return setup(args);
    case 'remove':
      return remove(args);
  }
}
