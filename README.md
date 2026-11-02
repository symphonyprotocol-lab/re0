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
npm run dev
```

Environment (`.env.local`, or `vercel env pull`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Neon (`dev` branch locally); migrations use the unpooled one |
| `APP_BASE_URL` | the origin OAuth callbacks and same-origin checks use |
| `AUTH_SECRET` (or the older `SESSION_SIGNING_SECRET`) | session digests and sealed cookies, ≥ 32 chars |
| `ADMIN_SECRET_KEY` (or the older `CREDENTIAL_ENCRYPTION_KEY`) | encrypts model API keys and TOTP secrets, ≥ 32 chars |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `GITHUB_OAUTH_CLIENT_ID/SECRET` | sign-in |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (private store) |
| `AI_GATEWAY_API_KEY` | AI Gateway (on Vercel the OIDC token works without it) |
| `GENERATION_MODEL`, `EMBEDDING_MODEL`, `TRANSCRIPTION_MODEL` | fallback models when the console has none (`provider/model` for the gateway) |
| `GENERATION_BASE_URL` / `_API_KEY` (and `EMBEDDING_*`, `TRANSCRIPTION_*`), or `LLM_BASE_URL` / `LLM_API_KEY` for all kinds | point a kind at an OpenAI-compatible endpoint instead of the gateway |
| `OCR_PROVIDER`, `OCR_PROVIDER_API_KEY` | optional OCR for scanned PDFs (ocr.space) |
| `GITHUB_APP_CLIENT_ID/SECRET` | optional: a GitHub App (Contents: read-only) for "连接 GitHub"; without it the sign-in OAuth app is used with the `repo` scope. Either way the callback is `/api/auth/github/callback/connect` |
| `GITHUB_INGESTION_TOKEN` | optional: raises the anonymous GitHub rate limit for public repositories (never used for private ones) |
| `CLAIM_DNS_RESOLVERS` | optional: comma-separated resolvers for the domain check's TXT lookup |
| `CRON_SECRET` | protects `/api/cron/purge-trash`, `/api/cron/expire-plan`, `/api/cron/rank` and `/api/cron/reembed` (Vercel Cron sends it); unset, the routes stay shut |
| `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENVIRONMENT` (`sandbox` or `production`) | Paddle Billing: server API key, the public token Paddle.js uses, the notification destination's secret. All of these plus the two price ids, or checkout stays off |
| `PADDLE_PLAN_PRICE_ID`, `PADDLE_PACK_PRICE_ID` | the catalogue prices: Plan USD 10 monthly (quantity 1), Pack USD 10 (quantity 1–10) |
| `PADDLE_CHECKOUT_BASE_URL` | optional: the origin a transaction's checkout link points at, when it is not `APP_BASE_URL` (Paddle will not take `localhost`) |
| `E2E_LOGIN_SECRET` | `next dev` only: enables `POST /api/auth/e2e` for test sign-in; ignored in builds |
| `DATABASE_WS_PROXY` | `next dev` only: run against a local Postgres behind `tests/fixtures/wsproxy.mjs` |

The first visitor of `/admin/login` on an empty database registers the owner (password + TOTP); after that the page only signs in.

## Database

```bash
npm run db:generate   # after editing db/schema.ts
npm run db:migrate    # apply to DATABASE_URL_UNPOOLED
npm run db:reset-dev -- --confirm=<endpoint id>   # drop and rebuild the Neon dev branch (guarded, see the script)
```

Preview builds clear a preview branch that still carries the pre-rebuild schema once (`db:prepare-preview`, `vercel.json`), then migrate.

## Checks

```bash
npm run typecheck
./scripts/test-integration.sh
```

The second runs the whole suite (unit and integration) against a disposable pgvector container; model calls go to a local fake endpoint, Blob is mocked, and GitHub, websites and DNS are stubbed.

To walk the app through by hand without real models, run the same fake endpoint on a fixed port and point `LLM_BASE_URL` at it:

```bash
npx tsx tests/fixtures/serve-fake-openai.ts 5443 [delay ms]   # then LLM_BASE_URL=http://127.0.0.1:5443/v1; a delay shows parallel answers interleaving
```

Paddle cannot reach `localhost`. After paying in the sandbox overlay locally, replay what Paddle recorded into the local webhook, signed with `PADDLE_WEBHOOK_SECRET` (sandbox and loopback targets only; idempotent):

```bash
npm run paddle:replay -- --since=2026-11-02T06:00:00Z --target=http://localhost:3300
```

A file name or title containing 「失败」 takes the processing failure path (refunded) under `next dev` and in tests; a production build has no such switch.
