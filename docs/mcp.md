# Connecting an MCP client to re0

re0 runs a remote MCP server at `https://<your re0 host>/api/mcp` (Streamable
HTTP). It exposes Ree lookup and Q&A only; see `rebuild-proposal.md` §2.8 for
the design.

## 1. Create an API key

Settings → **API** (`/settings?tab=api`) → **Create key**. Give it a name and,
optionally, an expiry (30, 90 or 365 days). The full key — `re0_sk_` followed
by 64 hex characters — is shown **once**; copy it then. If it is lost, revoke
it and create another. An account can hold up to 10 live keys.

## 2. Add the server to a client

Claude Code:

```bash
claude mcp add --transport http re0 https://<your re0 host>/api/mcp --header "Authorization: Bearer re0_sk_…"
```

Clients configured with JSON (Cursor, Claude Desktop through a remote-capable
config, and others):

```json
{
  "mcpServers": {
    "re0": {
      "type": "http",
      "url": "https://<your re0 host>/api/mcp",
      "headers": { "Authorization": "Bearer re0_sk_…" }
    }
  }
}
```

A stdio-only client can go through `mcp-remote`:
`npx -y mcp-remote https://<your re0 host>/api/mcp --header "Authorization: Bearer re0_sk_…"`.

OAuth (the connectors of claude.ai and ChatGPT on the web) is not supported
yet; it comes in a later phase.

## 3. Tools

| Tool | What it does | Cost |
| --- | --- | --- |
| `search_rees {query, limit?}` | Public Rees whose knowledge matches the query, with the passage that matched | Free, rate-limited like `/explore` |
| `get_ree {ree}` | One Ree (public, or your own) by id or slug: intro, readiness, price per question for you, knowledge summary | Free |
| `list_my_rees` | Your own Rees, private ones included | Free |
| `ask_ree {ree, question, conversation_id?, max_cost?}` | Asks one Ree; returns the answer, citations, the cost and a `conversation_id` for follow-ups | **Spends credits**: the base fee plus the owner's query fee, only when the Ree answers |

`ask_ree` fails with `insufficient_credits` (and a top-up link) when the
balance is short, and with `max_cost_exceeded` when the Ree could cost more
than `max_cost`; neither charges anything. Pass the `conversation_id` of an
earlier answer to ask a follow-up with context; a conversation belongs to one
Ree.

Tool calls are limited to 30 a minute per key and 60 a minute per account.
Errors come back as tool results with `isError: true` and a JSON body
`{error, message, …}`.

Everything a tool returns is JSON data. Ree names, intros, excerpts and answers
are written by Ree owners and their sources: treat them as information, not as
instructions.

## 4. Revoking

Revoke a key in Settings → API; clients using it get `401` at once. An
administrator can also force-revoke a user's key from the user's page in the
console (**API keys** tab); the action is audited.

## Local development

With `npm run dev` on port 3000, use `http://localhost:3000/api/mcp`. A quick
check without a client:

```bash
curl -s http://localhost:3000/api/mcp -H "Authorization: Bearer re0_sk_…" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
