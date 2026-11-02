# Rebuild step 2: notes for the next steps

Step 2 of `rebuild-proposal.md` §8.4, "知识全类型与知识管理". Branch `claude/rebuild-step2-knowledge-04b116`, PR into `rebuild`.

## What exists now

- **Six kinds** end to end (`lib/services/knowledge.ts`): `checkKnowledge` (network checks, outside any transaction) → `createKnowledgeInTx` (row + hold) → `processKnowledge` after the response (`extract` per kind → `assemble` → chunk → embed → store → settle, or fail and refund).
- **Connectors** in `lib/infra/connectors/`: `http.ts` (the one fetcher: http(s) only, private addresses refused on every redirect hop, size caps, credentials dropped on a cross-origin redirect), `html.ts` (main content → Markdown), `web.ts` (`fetchPage`, `crawlSite`: robots → sitemap(s) → in-site links, same host and path prefix, 500 pages, 6 at a time, 150 s budget), `github.ts` (default branch tree → raw files pinned to the commit; docs first, then source; vendored/lock/binary skipped).
- **Transcription**: `lib/infra/ai/transcription.ts`. Gateway transport uses the gateway's transcription model; an OpenAI-compatible endpoint uses a small adapter (the openai-compatible provider has none) posting `audio/transcriptions` with `verbose_json` + segment timestamps. Files over 24 MB: MP3 cut on frame boundaries, WAV on samples with a fresh header; up to 3 pieces in parallel, timestamps stitched in order. M4A is sent whole.
- **Library** (`lib/services/knowledge-library.ts`): folders (unique per Ree by `lower(name)`), `runBatch` (move / reprocess / pause / resume / trash / restore, one transaction, a stale selection refuses the whole batch), `renameKnowledge`, `purgeTrash` (30 days, bounded, idempotent).
- **Connections** (`lib/services/connections.ts`): GitHub connect (sealed handshake cookie, token sealed with `sealCredential(…, 'github')`), domain claims (`_re0.<domain>` TXT or `https://<domain>/.well-known/re0-verification.txt`, value `re0-verification=<hex>`; either check passing verifies; a verified domain covers its subdomains).
- **Pages**: `/rees/[id]/knowledge` (rewritten), `/rees/[id]/knowledge/[kid]` (new), `/settings?tab=connections` (new), wizard step 3 with all six kinds.

## Things a later step will want to know

- **Answerable knowledge** is `status = 'ready' and enabled and deleted_at is null` (`answerable()` in `lib/services/chat.ts`, `readiness()`). Step 4's multi-Ree retrieval and explore's second level must use the same predicate. Ree source counts (`lib/services/rees.ts`) exclude the trash.
- **Locators** now carry `time` (seconds, audio), `path` + `line` (GitHub), `url` (pages and sites), besides `page` / `heading`. `locatorLabel` renders `第 12:34` (zh) / `12:34` (en). A citation drawer links to `/rees/[id]/knowledge/[kid]?t=<seconds>`; the preview seeks the player there.
- **`knowledge.children`** is a list of slices of `content` (`{label, url?, path?, time?, end?, offset, length}`), JavaScript string offsets: slice in JS, not with SQL `substr` (Postgres counts characters differently once there is an emoji).
- **List query** for knowledge lives in `lib/http/knowledge.ts` (`knowledgeQuery`). `sort` is the prototype's `new|old|title`; step 1's `recent|oldest|name` are still read. `?ids=1` on the list endpoint answers every matching id (select-all, previous / next).
- **Activity codes** grew: `fetched`, `transcribed`, `paused`, `enabled`, `renamed`, `moved`, `trashed`, `restored`. The preview renders them through `activityLabel` in `components/knowledge/shared.tsx`.
- **The failure switch**: `simulatedFailureFor()` in `lib/infra/connectors/failure.ts` — a file name or title containing 「失败」 fails after the row is claimed (refunded), only when `NODE_ENV !== 'production'`.
- **Server pages must not import values from `'use client'` modules** (they arrive as client references). That is why `KIND_ICONS` lives in the plain module `components/knowledge/kind-icons.ts`.
- **Wizard source check**: `PUT /api/rees/draft` with `checkSource: true` runs the GitHub / domain checks when leaving step 3 and answers the refusal code instead of saving.

## Gotchas found

- The worktree had no usable `node_modules` (the copied one lacked `mammoth`); `npm install` in the worktree fixed it.
- In the integration fake (`tests/fixtures/fake-openai.ts`), parallel transcription made "call number" keys racy; `fakeMp3()` writes the piece index into each frame and the fake keys transcripts by it.
- `fetch` to GitHub/sites is stubbed in tests with `tests/fixtures/fake-web.ts` (`vi.stubGlobal`), which passes `127.0.0.1` through to the model fake.
- A walkthrough without real models: `npx tsx tests/fixtures/serve-fake-openai.ts 5443` and `LLM_BASE_URL=http://127.0.0.1:5443/v1`. The browser walkthrough for this step ran on a local `pgvector/pgvector:pg16` container (`re0-dev-pg`, 5441) behind `tests/fixtures/wsproxy.mjs` (5442) with `DATABASE_WS_PROXY`, real Vercel Blob, real GitHub and real websites.
- **Neon dev branch**: migration `0002_knowledge_library` has been applied to it (endpoint `ep-icy-unit`, 18 tables, two rows in `drizzle.__drizzle_migrations`). Production migrates itself in the Vercel build.
- **`CRON_SECRET`** already existed in the Vercel project for Production, Preview and Development; Vercel Cron sends it to `/api/cron/purge-trash`.

## GitHub App for "连接 GitHub"

Without `GITHUB_APP_CLIENT_ID/SECRET` the connect flow falls back to the sign-in OAuth app with the `repo` scope, which is read-write. For the read-only grant §2.2 asks for, register a GitHub App:

- **Public** (any RE0 user installs it on their own account), webhook off.
- Repository permissions: **Contents: Read-only** (Metadata: Read-only comes with it). Nothing else.
- Callback URLs: `https://re0.io/api/auth/github/callback/connect`, plus `http://localhost:3000/api/auth/github/callback/connect` for local work. A preview deployment needs its own `APP_BASE_URL` callback listed too.
- "Request user authorization (OAuth) during installation": **off** -- our callback expects the state cookie that only "连接 GitHub" sets.
- **Opt out of user-to-server token expiration** (Optional features). The stored grant has no refresh token; an expiring token would stop private repositories processing after 8 hours.
- Then generate a client secret and set `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` for Production and Preview (`vercel env add …`) and in `.env.local`.

A GitHub App's user token only reaches repositories where the App is **installed**: each user installs it (`https://github.com/apps/<slug>/installations/new`) and picks repositories, otherwise adding a private repository answers `github_repo_not_found`. The connections tab does not link to the install page yet; a `GITHUB_APP_SLUG` variable and a "选择可读取的仓库" link there would close that gap.

## Left for later steps

- Private-repository refreshes stop on disconnect but nothing schedules refreshes yet; there is no "refresh all" or periodic re-crawl.
- DNS-rebinding SSRF (a public name resolving to a private address) is not handled in-process; it relies on deployment egress rules, as the old `http.ts` did.
- A 100 MB M4A cannot be cut without a demuxer; if the transcription endpoint refuses it, the source fails and is refunded.
- Processing still runs in `after()` inside the route's 300 s; a 500-page crawl or a long audio on a slow endpoint can approach it. `recoverStale` fails and refunds runs stuck over 15 minutes. A queue (or Vercel Workflow) would be the next step if this bites.
- The knowledge profile vectors for explore (§2.4) are step 4.
