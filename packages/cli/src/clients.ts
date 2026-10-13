/**
 * The MCP clients `re0 setup` can configure, and the pure edits it makes to
 * their configuration files. requirement.md 9.4: every generated
 * configuration is shown before it is written, and `remove` deletes only the
 * part re0 created -- so every edit here is "the file as text in, the file
 * as text out", touching one `re0` entry and nothing else.
 *
 * No I/O in this module: `index.ts` reads and writes the files, this decides
 * what they should say, and the tests exercise it without a home directory.
 */

export const CLIENT_IDS = ['claude-code', 'claude-desktop', 'cursor', 'codex'] as const;

export type ClientId = (typeof CLIENT_IDS)[number];

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

/** The server entry's key in every client, and the only key re0 ever touches. */
export const SERVER_NAME = 're0';

/** The environment variable Codex reads the bearer token from. */
export const CODEX_TOKEN_ENV = 'RE0_API_KEY';

export interface Connection {
  /** The MCP endpoint, e.g. `https://re0.io/mcp`. */
  url: string;
  /** An API key from the dashboard; absent for anonymous, rate-limited use. */
  apiKey?: string;
}

export interface Platform {
  home: string;
  /** `process.platform`. */
  os: string;
  /** `%APPDATA%` on Windows; ignored elsewhere. */
  appData?: string;
}

export interface ClientSpec {
  id: ClientId;
  label: string;
  /** The configuration file, absolute. Null when the client has no home on this OS. */
  configPath(platform: Platform): string | null;
  /** The file with re0's entry set, from the file's current text (empty when absent). */
  setup(current: string, connection: Connection): string;
  /** The file with re0's entry removed. Returns the text unchanged when there is none. */
  remove(current: string): string;
  /** Whether the file currently carries a re0 entry. */
  hasEntry(current: string): boolean;
  /** Anything the person must do besides the file edit. */
  note?(connection: Connection): string | null;
}

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

/* ------------------------------------------------------------- JSON files */

type JsonObject = Record<string, unknown>;

/**
 * Parses a JSON configuration or fails loudly. A file that is not an object
 * is refused rather than replaced: overwriting a person's client
 * configuration because it did not parse is the one thing this tool must
 * never do.
 */
function parseJsonObject(text: string, path: string): JsonObject {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not hold a JSON object`);
  }
  return parsed as JsonObject;
}

function serversOf(config: JsonObject): JsonObject {
  const servers = config.mcpServers;
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? (servers as JsonObject)
    : {};
}

/** Two-space JSON with a trailing newline, which is what every client writes itself. */
function print(config: JsonObject): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function jsonClient(
  id: ClientId,
  label: string,
  configPath: ClientSpec['configPath'],
  entry: (connection: Connection) => JsonObject,
  note?: ClientSpec['note'],
): ClientSpec {
  return {
    id,
    label,
    configPath,
    setup(current, connection) {
      const config = parseJsonObject(current, label);
      const servers = { ...serversOf(config), [SERVER_NAME]: entry(connection) };
      return print({ ...config, mcpServers: servers });
    },
    remove(current) {
      const config = parseJsonObject(current, label);
      const servers = serversOf(config);
      if (!(SERVER_NAME in servers)) return current;
      const { [SERVER_NAME]: _removed, ...rest } = servers;
      return print({ ...config, mcpServers: rest });
    },
    hasEntry(current) {
      try {
        return SERVER_NAME in serversOf(parseJsonObject(current, label));
      } catch {
        return false;
      }
    },
    note,
  };
}

function bearer(connection: Connection): Record<string, string> | undefined {
  return connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : undefined;
}

/* ------------------------------------------------------------------ TOML */

/**
 * Codex keeps `~/.codex/config.toml`, and there is no TOML library in a
 * dependency-free CLI. The edit is kept to what can be done safely as text:
 * re0's own `[mcp_servers.re0]` table, from its header to the next header or
 * the end of the file, is replaced or removed as a block. Everything else in
 * the file is left byte for byte.
 */
const CODEX_TABLE = /^\[mcp_servers\.re0\][^\n]*\n(?:(?![[\n])[^\n]*\n)*/m;

function codexBlock(connection: Connection): string {
  const lines = [`[mcp_servers.${SERVER_NAME}]`, `url = ${JSON.stringify(connection.url)}`];
  if (connection.apiKey) lines.push(`bearer_token_env_var = ${JSON.stringify(CODEX_TOKEN_ENV)}`);
  return `${lines.join('\n')}\n`;
}

const codex: ClientSpec = {
  id: 'codex',
  label: 'Codex CLI',
  configPath: (platform) => join(platform.home, '.codex', 'config.toml'),
  setup(current, connection) {
    const block = codexBlock(connection);
    if (CODEX_TABLE.test(current)) return current.replace(CODEX_TABLE, block);
    const base = current === '' || current.endsWith('\n') ? current : `${current}\n`;
    return `${base}${base === '' ? '' : '\n'}${block}`;
  },
  remove(current) {
    if (!CODEX_TABLE.test(current)) return current;
    /* The table and the blank line that separated it, nothing more. */
    const without = current.replace(CODEX_TABLE, '').replace(/\n{3,}/g, '\n\n');
    const trimmed = without.replace(/^\n+/, '').replace(/\n+$/, '\n');
    return trimmed === '\n' ? '' : trimmed;
  },
  hasEntry: (current) => CODEX_TABLE.test(current),
  note: (connection) =>
    connection.apiKey
      ? `Codex reads the key from the ${CODEX_TOKEN_ENV} environment variable: export ${CODEX_TOKEN_ENV}=<your key> in the shell that runs Codex.`
      : null,
};

/* --------------------------------------------------------------- clients */

export const CLIENTS: readonly ClientSpec[] = [
  jsonClient(
    'claude-code',
    'Claude Code',
    (platform) => join(platform.home, '.claude.json'),
    (connection) => ({
      type: 'http',
      url: connection.url,
      ...(bearer(connection) ? { headers: bearer(connection) } : {}),
    }),
  ),
  jsonClient(
    'claude-desktop',
    'Claude Desktop',
    (platform) => {
      if (platform.os === 'darwin') {
        return join(platform.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (platform.os === 'win32') {
        return platform.appData ? join(platform.appData, 'Claude', 'claude_desktop_config.json') : null;
      }
      return join(platform.home, '.config', 'Claude', 'claude_desktop_config.json');
    },
    /* Claude Desktop speaks stdio only; mcp-remote bridges it to the endpoint. */
    (connection) => ({
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        connection.url,
        ...(connection.apiKey ? ['--header', `Authorization: Bearer ${connection.apiKey}`] : []),
      ],
    }),
    () => 'Claude Desktop reaches remote servers through the mcp-remote bridge; restart the app after this change.',
  ),
  jsonClient(
    'cursor',
    'Cursor',
    (platform) => join(platform.home, '.cursor', 'mcp.json'),
    (connection) => ({
      url: connection.url,
      ...(bearer(connection) ? { headers: bearer(connection) } : {}),
    }),
  ),
  codex,
];

export function clientById(id: ClientId): ClientSpec {
  const client = CLIENTS.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`no such client: ${id}`);
  return client;
}
