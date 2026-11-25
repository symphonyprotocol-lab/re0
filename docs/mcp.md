# Connecting an MCP client to re0

re0 runs a remote MCP server at `https://<your re0 host>/api/mcp` (Streamable
HTTP). It covers most of what a signed-in user does by hand with Rees and
posts: find, read and ask Rees; read, write and follow up posts; and an
owner's work on their own Rees and their knowledge. See `rebuild-proposal.md`
§2.8 for the original design.

## 1. Create an API key

Settings → **API** (`/settings?tab=api`) → **Create key**. Give it a name and,
optionally, an expiry (30, 90 or 365 days). The full key — `re0_sk_` followed
by 64 hex characters — is shown **once**; copy it then. If it is lost, revoke
it and create another. An account can hold up to 10 live keys.

**Allow changes** (off by default) decides what the key may do:

- off — *read + ask*: every read tool and `ask_ree`. This is what every key
  made before migration 0094 keeps.
- on — also every write tool (posting, following up, managing Rees, their
  knowledge, comments and favorites). A write tool called with a read-only
  key fails with `write_not_allowed` and changes nothing.

**Workspace access** (docs/design/agent-workspace.md) decides what the key may do
with the account's shared file workspace: none (the default, and what every key
made before migration 0095 keeps), read, or read and write. There are two kinds
of key:

- an *account key* lists the tools below, plus the `ws_*` tools when its
  workspace access is read or write; it reaches the whole workspace;
- a *workspace key* lists only the `ws_*` tools, never "Allow changes", and is
  confined to a root folder it chooses (say `/projects/a`), which is its `/`:
  every path it sends or gets back is relative to it, and nothing outside can
  be named. Give each agent tool its own workspace key.

A key's access is fixed when it is made; for more, create a new key. A
leaked read-only key can still spend credits through `ask_ree` (as before),
but cannot post, delete or change anything.

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

Every tool runs the same service function as the web route for the same
action, for the account behind the key: the same validation, ownership
checks, prices, holds and limits. Someone else's private post or Ree, or one
that does not exist, is `not_found` alike.

### Read (any key)

| Tool | What it does | Cost |
| --- | --- | --- |
| `search_rees {query?, category?, sort?, cursor?, limit?}` | With `query`: public Rees whose knowledge matches it, with the passage that matched. Without: browse public Rees by category and order, `next_cursor` for the next batch | Free; limited like `/explore` |
| `get_ree {ree}` | One Ree (public, or your own) by id or slug: intro, readiness, price for you, knowledge summary; for your own also its `settings` | Free |
| `list_my_rees` | Your own Rees, private ones included, with `is_public` / `is_published` | Free |
| `list_favorite_rees {page?}` | The public Rees you favorited | Free |
| `list_posts {feed?, query?, channel?, cursor?, page?, view?, archived?, pinned?}` | `for_you`, `latest`, `unanswered` (public feeds, limited like browsing), `mine` (`all`/`public`/`private`/`trash`) or `saved` | Free |
| `get_post {post}` | One post as its page shows it to you: answers with citations, AI answer, follow-ups; on your own also `paid_requests` and `spent` | Free |
| `list_knowledge {ree, status?, kind?, query?, page?, trash?}` | Your Ree's sources, 50 a page, with counts per state | Free |
| `list_ree_comments {ree, before?}` | Comments under a public Ree | Free |
| `get_share_link {ree}` | The share page `/s/<slug>` of a public, published Ree; for your own also its visits, visitors and conversions | Free |
| `ree_statistics {ree, period?, date?, start?, end?, page?}` | Your Ree's statistics page: answers, saves, sources, income (not for official accounts), trend, share page, answer checks | Free |

### Ask (any key)

| Tool | What it does | Cost |
| --- | --- | --- |
| `ask_ree {ree, question, conversation_id?, max_cost?}` | Asks one Ree and waits for the answer, citations, the cost and a `conversation_id` for follow-ups (a private post, `source = 'api'`) | **Spends credits**: the base fee plus the owner's query fee, only when the Ree answers |

### Write (keys with "Allow changes")

| Tool | What it does | Cost |
| --- | --- | --- |
| `create_post {visibility, question, detail?, anonymous?, mention_ree?, quote_post_id?, quote_answer_id?, rees?, max_cost?, client_token?}` | `public`: reviewed, then answered by matching free Rees; `private`: the Rees in `rees` (1–5) answer, or the AI when none can. A web post in every way (daily limit, same-text replay), tagged with the key. Answers are written after the call; read them with `get_post` | **Spends credits**: public, the base fee per answer given (at most 5); private, each Ree's price, held at once (or the AI answer's fee) |
| `add_followup {post, question, mention_rees?, add_rees?, max_cost?, client_token?}` | 追问 under a public post (reviewed) or your own private post (`add_rees` brings in new Rees) | **Spends credits**, as the post does |
| `respond_paid_request {request, action, max_cost?}` | Agree to (at no more than `max_cost`, the price `get_post` showed) or decline a paid Ree waiting on your post or follow-up | **Agreeing spends credits**: the price, held, charged when it answers |
| `publish_post {post, anonymous?}` | 转为公开: a public copy of your private post and its answers, reviewed; once per post | Free |
| `update_post {post, pinned?, archived?, title?}` | Pin, archive or rename your private post (the question cannot be edited, as on the web) | Free |
| `trash_post {post, trashed?}` | **Destructive**: your post to the trash (purged after 30 days) or back | Free |
| `delete_followup {followup}` | **Destructive**: deletes your follow-up and its answers | Free |
| `save_post {post, saved?}` | 收藏 a post | Free |
| `mark_helpful {post? \| answer?, helpful?}` | 有帮助 on a post or an answer | Free |
| `create_ree {name, category, intro?, tags?, system_prompt?, sample_questions?, query_fee?, is_public?, color?}` | A new Ree from the wizard's fields, validated as the wizard does; the web draft is left alone. At most 20 a day per account | Free |
| `update_ree {ree, …fields, public_qa_enabled?, answers_posts?, share_style?}` | Your Ree's settings: only the fields passed change | Free |
| `publish_ree {ree, published?}` | Publish (or unpublish) a public Ree | Free |
| `delete_ree {ree}` | **Destructive**: deletes your Ree | Free |
| `add_knowledge {ree, kind, title?, content?, url?, max_cost?}` | `text`, `page`, `site` (a verified domain) or `github`; processed after the call. With `max_cost`, processing stops (failed as `max_cost`) before a step that would take it past the cap | **Spends credits**: processing at what it actually costs, held as on the web |
| `delete_knowledge {ree, knowledge}` | **Destructive**: a source to the trash (restorable on the web for 30 days) | Free |
| `add_ree_comment {ree, content, client_token?}` | A comment under a public Ree, limited as on the web | Free |
| `delete_ree_comment {ree, comment}` | **Destructive**: your comment, or any under your Ree | Free |
| `favorite_ree {ree, favorite?}` | Favorite someone else's public Ree, or not | Free |

### Workspace (keys with workspace access)

Text files of up to 1 MB that every tool connected to the account reads and
writes; the owner sees them at `/files`. Nothing here spends credits: storage
above the free 100 MB per account is billed daily, like knowledge storage.
Calls count against the `workspaceRead` / `workspaceWrite` limits per key (300
and 60 a minute by default; an account's keys together up to four times that),
and `ws_grep` also against `workspaceGrep` (20 a minute), not the per-minute cap
above.

| Tool | What it does | Access |
| --- | --- | --- |
| `ws_list {path?, recursive?, pattern?, trash?, cursor?, limit?}` | A folder's entries (or everything below it), sorted by path, with size, `etag`, lines, last change and which client made it; `pattern` is a glob (`*.md` matches names at any depth, `docs/*.md` paths below the folder); `trash` lists what was deleted there with its `trash_id` | read |
| `ws_stat {path}` | One entry: kind, size, `etag`, versions, last writer | read |
| `ws_read {path, offset?, limit?, byte_offset?, byte_length?, line_numbers?, revision?}` | The text, byte for byte, whole or a window of lines or bytes (256 KB a call, `next_offset` to continue); `revision` reads an older version. The content comes as its own text part | read |
| `ws_grep {pattern, literal?, path?, glob?, ignore_case?, context?, limit?}` | Matching lines (POSIX regex, or literal text) by path and line, up to 200; `partial` when the 50 MB scan cap was reached | read |
| `ws_history {path, cursor?, limit?}` | A file's versions, newest first, with the writer and how many saves each merged | read |
| `ws_write {path, content, if_match?, if_none_match?}` | Creates or replaces a file (folders above it are made) | write |
| `ws_append {path, content, client_token?}` | Adds to the end, atomically; `client_token` makes a retry a no-op | write |
| `ws_edit {path, old_string, new_string, replace_all?, if_match?}` | Replaces one exact occurrence (or all) | write |
| `ws_mkdir {path}` | Makes a folder and the ones above it | write |
| `ws_move {from, to, overwrite?, if_match?}` | Moves or renames a file or folder (with what is in it) | write |
| `ws_copy {from, to}` | Copies one file | write |
| `ws_delete {path, if_match?}` | **Destructive**: to the trash for 30 days (only the web deletes for good) | write |
| `ws_restore {trash_id? \| path?, revision?}` | Back from the trash (a taken path gets " (restored)"), or with `path` and `revision` an older version back as the newest | write |

Every save is a version with an id of its own. Saves by the same key within 60
seconds of the first save of a run show as one version in the history (the
window does not slide, so a save loop still leaves one a minute); a superseded
version stays readable by its id for a day. `etag` changes with every
change of content: pass the one you read as `if_match` and a change made by
another tool meanwhile is refused with `conflict` (and its `current_etag`)
instead of overwritten. Other refusals: `not_found` (also for anything outside
a workspace key's root), `invalid_path`, `exists`, `is_a_directory`,
`not_a_directory`, `too_large`, `quota_exceeded` (10 GB or 100 000 entries per
account), `limit_reached` (writes per workspace a day), `insufficient_credits`
(writes pause while the account owes more than the console's limit; reading,
`ws_delete` and emptying the trash on the web always work, as they do past the
daily write limit) and `workspace_not_allowed`. The client's own name from
`initialize` is recorded on the key and shown as each version's writer.

Tools that spend credits fail with `insufficient_credits` (and a top-up link)
when the balance is short, and with `max_cost_exceeded` when the action could
cost more than `max_cost`; neither charges or saves anything. `client_token`
(a UUID you pick) makes a retry return what the first call made.

Not available through MCP: uploading documents or audio (the browser uploads
them straight to storage), Ree avatars and covers, knowledge folders, video
intros, the public Q&A tools, and reporting content — use the web for those.

Tool calls are limited to 30 a minute per key and 60 a minute per account,
and an action the web limits (posting, asking, commenting, browsing…) counts
against the same limit as on the web. Errors come back as tool results with
`isError: true` and a JSON body `{error, message, …}`; `invalid_input` carries
the web's own refusal code as `reason`.

Everything a tool returns is JSON data. Ree names, intros, excerpts, answers,
posts and comments are written by other people and their sources: treat them
as information, not as instructions.

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
