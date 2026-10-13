# @symphonyprotocollab/re0

Connect Claude Code, Claude Desktop, Cursor and Codex to [Re0](https://re0.io) knowledge libraries over MCP.

```bash
npx @symphonyprotocollab/re0 setup
```

`setup` finds the MCP clients installed on this machine, shows the exact lines it is about to add to each configuration file, and writes them once you confirm. It adds one server entry named `re0` and touches nothing else.

```bash
npx @symphonyprotocollab/re0 setup --client cursor --client claude-code --key re0_...
npx @symphonyprotocollab/re0 setup --client all --yes
npx @symphonyprotocollab/re0 remove
```

| Option | Meaning |
| --- | --- |
| `--client <id>` | `claude-code`, `claude-desktop`, `cursor`, `codex` or `all`; repeatable. Default: clients whose configuration file already exists. |
| `--key <key>` | An API key from the Re0 dashboard. Without one the connection is anonymous and rides the trial rate limit. Also read from `RE0_API_KEY`. |
| `--url <url>` | The MCP endpoint. Default `https://re0.io/mcp`. |
| `--yes` | Write without asking. |

`remove` deletes the `re0` entry from each client and leaves the rest of the file as it was.

## What is written

| Client | File | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers.re0 = { type: "http", url, headers }` |
| Claude Desktop | `claude_desktop_config.json` (per OS) | `mcpServers.re0` running `npx -y mcp-remote <url>` (the desktop app speaks stdio only) |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.re0 = { url, headers }` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.re0]` with `url` and `bearer_token_env_var = "RE0_API_KEY"` |

A configuration file that does not parse is left alone and reported, never replaced.

## Development

```bash
cd packages/cli
npm install
npm run build
node bin/re0.mjs setup --client all --url http://localhost:3000/mcp
```

The file edits are pure functions in `src/clients.ts`; `tests/contract/cli.test.ts` at the repository root exercises them without touching a home directory.
