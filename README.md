# RE0

Create a Ree, give it some knowledge, and it answers only from that knowledge.

This is the rebuild (`rebuild` branch). The plan is [`rebuild-proposal.md`](rebuild-proposal.md); the interaction spec is the browser prototype in [`rebuild-prototype/`](rebuild-prototype/README.md) (`node rebuild-prototype/serve.mjs`). Delivery is in seven steps (proposal 8.4). Step 1 built the skeleton and the core loop: sign in → create a Ree in the four-step wizard → add knowledge → ask it in the Chat tab and get a streamed answer with numbered citations; administrators sign in to `/admin` and configure the three kinds of model. Step 2 opened all six kinds of knowledge -- documents, pasted text, audio (transcribed with timestamps), GitHub repositories (public by URL, private through the owner's GitHub connection), single pages and whole websites (after a DNS TXT or well-known domain check) -- and the full library: folders, the "use in answers" switch, batch actions, a trash purged after 30 days, and a standalone preview page. Step 3 brought money in: the public site (`/`, `/pricing`, `/checkout`, `/legal/*`), the Plan (USD 10 a month, 100,000 credits per billing period that expire with it) and Packs (USD 10 each, 1–10 per checkout, never expire, only while a Plan is active) through Paddle, the billing tab with the ledger and renewal on / off, refunds that take credits back without a negative balance, and the sidebar's Plan meter. Step 4 opened conversations and discovery: conversations with up to five Rees (`/talk`, `/chats`, `/chats/[id]`) where each asked Ree answers in its own bubble at the same time, `@name` or "only this Ree" narrowing who answers, unanswered questions free and followed by public Rees that might know; `/explore`, which finds Rees by matching a question against their knowledge (a profile per public Ree, then their passages); the public page `/r/[slug]` with "add to a chat"; and query fees, which go to the Ree's owner as earned credits. Step 5 added roles and the console: users apply for the verified role from `/settings?tab=role` once they meet the threshold, administrators review it, make accounts official or revoke them; in-app notices with a sidebar dot; per-Ree usage statistics (`/rees/[id]/statistics`, UTC+8, day / week / month / custom), the dashboard's panels and `/workspace/sources|answers`; and the console's overview, users, verification requests, purchases, Rees (takedown / restore), audit log with CSV exports, administrators by invitation link, and the full re-embed job that switches the embedding model. Hand-over notes per step are in [`docs/handover/`](docs/handover/).

## Layout (proposal 8.3)

| Path | What |
| --- | --- |
| `app/` | App Router pages and API routes; `app/admin` is the console |
| `lib/constants.ts` | every price, fee, limit and threshold |
| `lib/domain/` | pure rules: ledger arithmetic, Ree fields, chunking, retrieval ranking, answers, audit codes |
| `lib/infra/` | Neon (drizzle), Vercel Blob, AI SDK (`modelFor`), document connectors, crypto, OAuth |
| `lib/services/` | use cases that touch the database (auth, credits, Rees, knowledge, chat, answer, console) |
| `db/` | drizzle schema and migrations (from `0001`) |
| `i18n/` | zh / en dictionaries, one file per page |
| `components/` | UI |
| `tests/` | unit tests and database integration tests |

## Running it

```bash
npm install
npm run db:up     # local Postgres 18 + pgvector in Docker, and its WebSocket proxy
npm run db:migrate
npm run dev
```

Local development runs against a Postgres container (`docker-compose.yml`: `re0-dev-pg` on `127.0.0.1:5432`, data in the `re0-dev-pg` volume) behind `tests/fixtures/wsproxy.mjs` (`re0-dev-wsproxy` on `127.0.0.1:5433`), because the app's driver speaks Postgres over a WebSocket. Point `.env.local` at it:

```bash
DATABASE_URL="postgres://postgres:pw@127.0.0.1:5432/re0"
DATABASE_URL_UNPOOLED="postgres://postgres:pw@127.0.0.1:5432/re0"
DATABASE_WS_PROXY="127.0.0.1:5433/v2"
```

`vercel env pull` writes Vercel's Development values instead; put these three lines back afterwards. There is no Neon branch for local development any more; Neon serves production (and preview builds) only.

Environment (`.env.local`, or `vercel env pull`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Neon in production; locally the Docker Postgres above. Migrations use the unpooled one |
| `APP_BASE_URL` | the origin OAuth callbacks and same-origin checks use |
| `AUTH_SECRET` (or the older `SESSION_SIGNING_SECRET`) | session digests and sealed cookies, ≥ 32 chars |
| `ADMIN_SECRET_KEY` (or the older `CREDENTIAL_ENCRYPTION_KEY`) | encrypts model API keys and TOTP secrets, ≥ 32 chars |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `GITHUB_OAUTH_CLIENT_ID/SECRET` | sign-in |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (private store) |
| `AI_GATEWAY_API_KEY` | AI Gateway (on Vercel the OIDC token works without it) |
| `GENERATION_MODEL`, `EMBEDDING_MODEL`, `TRANSCRIPTION_MODEL` | fallback models when the console has none (`provider/model` for the gateway) |
| `GENERATION_BASE_URL` / `_API_KEY` (and `EMBEDDING_*`, `TRANSCRIPTION_*`), or `LLM_BASE_URL` / `LLM_API_KEY` for all kinds | point a kind at an OpenAI-compatible endpoint instead of the gateway |
| `FIRECRAWL_API_KEY` | optional single-key fallback when `/admin/firecrawl` has no saved keys; PDFs that need Firecrawl normally use the console's encrypted key pool |
| `FIRECRAWL_BASE_URL` | optional Firecrawl server origin (no `/v2/parse` suffix); self-hosted servers must support Parse and per-page PDF output, and may omit the key if authentication is disabled |
| `GITHUB_APP_CLIENT_ID/SECRET` | optional: a GitHub App (Contents: read-only) for "连接 GitHub"; without it the sign-in OAuth app is used with the `repo` scope. Either way the callback is `/api/auth/github/callback/connect` |
| `GITHUB_APP_SLUG` | the name in the GitHub App's public URL, used to open its installation page for personal accounts and organizations |
| `GITHUB_READ_TOKEN` | optional: a GitHub token (a fine-grained token with public-repository read-only access is enough) for importing public repositories when the owner has no GitHub connection, or their connection cannot see the repository. Unset, those reads go to GitHub unauthenticated: four API calls per import or refresh (one when it is added, three when it is processed) against 60 an hour per server IP, shared with every other tenant on that IP, and file bodies from raw.githubusercontent.com, which throttles anonymous clients too (a throttled import fails as `rate_limited` and can be reprocessed). Set it before bulk-importing public repositories. It is only ever used for repositories GitHub reports as public |
| `CLAIM_DNS_RESOLVERS` | optional: comma-separated resolvers for the domain check's TXT lookup |
| `CRON_SECRET` | protects `/api/cron/purge-trash`, `/api/cron/expire-plan`, `/api/cron/rank`, `/api/cron/reembed` and `/api/cron/knowledge` (Vercel Cron sends it); unset, the routes stay shut |
| `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENVIRONMENT` (`sandbox` or `production`) | Paddle Billing: server API key, the public token Paddle.js uses, the notification destination's secret. All of these plus the two price ids, or checkout stays off |
| `PADDLE_PLAN_PRICE_ID`, `PADDLE_PACK_PRICE_ID` | the catalogue prices: Plan USD 10 monthly (quantity 1), Pack USD 10 (quantity 1–10) |
| `PADDLE_CHECKOUT_BASE_URL` | optional: the origin a transaction's checkout link points at, when it is not `APP_BASE_URL` (Paddle will not take `localhost`) |
| `E2E_LOGIN_SECRET` | `next dev` only: enables `POST /api/auth/e2e` for test sign-in; ignored in builds |
| `DATABASE_WS_PROXY` | not in production builds: the WebSocket proxy in front of a local Postgres (`127.0.0.1:5433/v2` with `npm run db:up`); `next dev` and `drizzle-kit` both honour it |

The first visitor of `/admin/login` on an empty database registers the owner (password + TOTP); after that the page only signs in.

The **Product demo · Voiceover** video template uses OpenAI TTS-1 through Vercel AI Gateway. Under **Console → Models → Voiceover**, test and activate the prefilled model. The model can reuse a saved Gateway credential or accept a dedicated Gateway API key, which is encrypted. Without a saved voiceover configuration, the app can use the deployment's Gateway key or Vercel OIDC.

Documents are parsed locally where possible (`lib/infra/connectors`). Word (DOCX) always is: `mammoth` turns it into HTML and `turndown` (with the GFM plugin) into Markdown; a file that inflates past 200 MB is refused as too large. A PDF's text layer is read with `unpdf` (pdf.js) and rebuilt into per-page Markdown, keeping physical page numbers for citations; pdf.js's CMaps and standard fonts come from the `pdfjs-dist` package (pinned to the version unpdf bundles) and are traced into the document routes by `next.config.mjs`. When any page of a PDF is a scan (images cover most of it and almost no text sits between its header and footer), uses a font pdf.js cannot load, or the text is garbled, when pdf.js cannot open the file, or when local reading passes its 60 s or 1,000-page budget, the whole file goes to [Firecrawl Parse](https://docs.firecrawl.dev/features/parse) instead: its bytes are sent directly from the server to `/v2/parse`, with `pages: true` preserving page numbers, and gets whatever is left of the document's 120 s. The thresholds are named constants in `lib/infra/connectors/pdf.ts`. Markdown and TXT are read as they are. Local parsing costs no Firecrawl credits; a source then pays only for embedding. For Firecrawl, missing configuration, invalid responses, missing PDF page data, or explicitly truncated output fail processing and release the reserved credits. The upload limit remains 20 MB. The former `OCR_PROVIDER*` settings are no longer used.

Manage document-parsing credentials in **Console → Firecrawl** (`/admin/firecrawl`), after applying migrations `0011_firecrawl_keys` and `0014_firecrawl_fallback`. Add, rename, replace, enable, disable or delete keys without redeploying. Keys use the same `ADMIN_SECRET_KEY` encryption as model credentials; only names and final four characters are returned to the browser or audit log. Duplicate keys are refused. Enabled ordinary keys rotate by least recent allocation in a short database transaction, shared across server instances, with no lock held during the provider request. Set one key as **Main account (fallback only)**: it receives traffic only when all ordinary keys are disabled, cooling down, unreadable, or already failed in the current parse. Once an ordinary key recovers, it takes priority again. The main key still respects its own enabled state and cooldown. Migration `0014_firecrawl_fallback` marks the existing key named `主账号` as the main account; later renaming does not change its role. Selecting a new main account moves the previous one back into ordinary rotation, and both changes are audited. The console shows allocation counts, last HTTP results and cooldowns. Set the default parsing cost on the same Firecrawl page, and optional account-specific costs in each key editor. Embedding and transcription costs are edited with the corresponding model in **Console → Models**. Saving a service configuration and its cost is atomic; existing rates and historical receipt snapshots are preserved. **Pricing & promotions** is reserved for customer-facing Plan / Pack pricing and welcome credits.

HTTP 401/402/403 cools a key for five minutes; HTTP 429 honors `Retry-After` (one second to 24 hours, default one minute). Parsing immediately tries the next available console key, attempting each at most once within a shared 120-second deadline. Network failures are not retried because the original request may already have been billed; they cool the key for five minutes. Other errors, including document validation failures and HTTP 5xx, fail normally. Replacing a key or re-enabling it clears its cooldown. If any console records exist, disabled/cooling keys never fall back to the environment. Only an empty key list uses `FIRECRAWL_API_KEY` (or an unauthenticated self-hosted `FIRECRAWL_BASE_URL`).

## Database

```bash
npm run db:generate   # after editing db/schema.ts
npm run db:migrate    # apply to DATABASE_URL_UNPOOLED (through DATABASE_WS_PROXY locally)
npm run db:psql       # psql into the local database
npm run db:down       # stop the containers; the volume keeps the data
```

To start the local database over: `docker compose down -v`, then `npm run db:up` and `npm run db:migrate`. `npm run db:reset-dev -- --confirm=<endpoint id>` does the same for a non-production Neon branch, should one be used again (guarded, see the script).

Preview deployments are retired: `vercel.json` builds without touching a database except in production (`db:deploy`). `db:prepare-preview` still exists for a Preview build that sets `ALLOW_PREVIEW_DATABASE_RESET=1` on purpose, and refuses otherwise.

## Security headers

`next.config.mjs` sends HSTS, `nosniff`, a same-origin referrer, `X-Frame-Options: DENY` and a Permissions-Policy on every route. The Content-Security-Policy is enforced:

- Pages get theirs from `middleware.ts`, built per request by `lib/http/csp.ts` around a fresh nonce. Next reads the nonce from the request's policy header and stamps it on its own script tags; `'strict-dynamic'` then trusts what those scripts load (Paddle.js through `next/script`, Paddle's loader, the lazy video-export chunks). Scripts never run inline. The policy allows exactly: Paddle (`cdn.paddle.com` for the script, its environment's CDN for the stylesheet, `*.paddle.com` for the checkout frame and its calls), WebAssembly and `blob:` workers for the in-browser MP4 export, `blob:`/`data:` media and previews, the GitHub / Google avatar hosts and Vercel Blob for images, Vercel Blob's client upload and Remotion's license usage report (`www.remotion.pro`, sent after every export) under `connect-src`, and GitHub / Google as sign-in form targets. Fonts come from this origin (`next/font` self-hosts them).
- API routes, `/media`, Next's static files and `public/` are never documents and get `default-src 'none'`.
- Every page was already rendered per request (the root layout reads the session and language cookies), so the nonce costs no static rendering or CDN caching.

Kill switch: set `CSP_REPORT_ONLY=1` in the project's environment and redeploy. The same policy is then sent as `Content-Security-Policy-Report-Only`: nothing is blocked, and violations show up in the browser console as `[Report Only] Refused to ...`. Remove the variable (and redeploy) to enforce again. Middleware reads the variable per request; the non-document policy comes from `next.config.mjs` and so follows it at build time, which a redeploy is. There is no report endpoint, so the policy has no `report-uri` / `report-to`.

A new external origin (a script, an iframe, an analytics tag) has to be added to `lib/http/csp.ts` and `tests/unit/security-headers.test.ts`, or the browser refuses it.

## Checks

```bash
npm run typecheck
./scripts/test-integration.sh
```

The second runs the whole suite (unit and integration) against a disposable pgvector container; model calls go to a local fake endpoint, Blob is mocked, and Firecrawl, GitHub, websites and DNS are stubbed.

To walk the app through by hand without real models, run the same fake endpoint on a fixed port and point `LLM_BASE_URL` at it:

```bash
npx tsx tests/fixtures/serve-fake-openai.ts 5443 [delay ms]   # then LLM_BASE_URL=http://127.0.0.1:5443/v1; a delay shows parallel answers interleaving
```

Paddle cannot reach `localhost`. After paying in the sandbox overlay locally, replay what Paddle recorded into the local webhook, signed with `PADDLE_WEBHOOK_SECRET` (sandbox and loopback targets only; idempotent):

```bash
npm run paddle:replay -- --since=2026-11-02T06:00:00Z --target=http://localhost:3300
```

A file name or title containing 「失败」 takes the processing failure path (refunded) under `next dev` and in tests; a production build has no such switch.
