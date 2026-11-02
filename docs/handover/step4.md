# Rebuild step 4: notes for the next steps

Step 4 of `rebuild-proposal.md` §8.4, "对话、发现与公开页". Branch `claude/rebuild-step4-chat-explore-5409f7`, PR into `rebuild`.

## What exists now

- **Table changes** (`db/migrations/0005_conversations_explore.sql`): `conversation` gained `pinned`, `archived_at`, `deleted_at` and a title ≤ 120 check; `ree` gained `moderated_at` / `moderated_by` / `moderated_reason`, `rank` jsonb (hourly) and `suggested_questions` (beyond §4); `message` gained `suggested_ree_ids` (beyond §4) and an index on `(ree_id, created_at)` for Ree replies; new `ree_feedback` (one vote per asker and answer), `ree_profile_vector` (≤ 16 per public Ree, HNSW cosine) and `rate_bucket` (beyond §4: fixed-window counters for the free explore search). `CREDIT_ENTRY_REASONS` already had `query_base`, `query_fee_paid`, `query_fee_earned`.
- **Rules** without the database: `lib/domain/conversation.ts` (who a question goes to: `@name` › "只问这个 Ree" › everyone, an `@` naming nobody goes to nobody; `withoutMentions` strips `@name`s before retrieval; titles; the `/chats` query and URL; UTC+8 day groups; highlight and snippet), `lib/domain/explore.ts` (`ReeRank`, `qualityScore`, role tie-break `rankHits`, explore URL and `from` return path, related Rees from public fields only, pages of four).
- **Use cases**:
  - `lib/services/conversations.ts` — create (0–5 Rees, own or public), add / remove participants (row lock, sixth refused `too_many_rees` 409), `detachRee`, rename / pin / archive / trash / restore and their batch form, the `/chats` search (title, any message, Ree name of a participant or of a past answer; tab counts; `matched` excerpt), the sidebar history, purge after 30 days, the participant picker's candidates, "加入对话" choices, feedback.
  - `lib/services/answer.ts` — rewritten for one or more Rees per question, in parallel (below).
  - `lib/services/explore.ts` — the two-level search, browse order, cards, `suggestRees` (the in-chat fallback), `allowSearch` rate limit.
  - `lib/services/profile.ts` — `refreshProfile` (k-means in Postgres with pgvector `avg`), `suggestQuestions`, `afterKnowledgeReady` (called at the end of `processKnowledge`).
  - `lib/services/rank.ts` — `computeRanks` for `/api/cron/rank`; `lib/services/public-rees.ts` — the public page and its two lists.
- **Pages**: `/talk`, `/chats`, `/chats/[id]` (workspace); `/explore`, `/r/[slug]` (+ `opengraph-image`) in `app/(discover)`, whose layout picks the site frame for visitors and the workspace frame once signed in; `app/sitemap.ts`. The sidebar has 发现 Ree, 新建对话, 搜索对话 (⌘K / Ctrl+K anywhere in the workspace) and the history (current / pinned / recent by day). The site header and footer link 发现 Ree; the home page's example Rees are the three most active public ones (the illustrative three while there are none). Ree settings show the system's suggested questions until adopted; a public Ree's tabs link to its public page.
- **Routes**: `GET/POST /api/chats`, `PATCH/DELETE /api/chats/[id]`, `POST /api/chats/batch`, `GET /api/chats/candidates`, `POST/DELETE /api/chats/[id]/rees/[reeId]`, `POST /api/chats/[id]/messages` (both kinds), `POST /api/messages/[id]/feedback`, `GET /api/explore`, `POST /api/rees/[id]/profile-vector`, `GET /api/cron/rank` (hourly in `vercel.json`); `/api/cron/purge-trash` also purges conversations.

## How a question is answered

1. Targets come from the participants that are still usable (own, or public and not taken down, not deleted).
2. One transaction stores the question and holds, per Ree with ready knowledge, the base fee (`query_hold`) and, on someone else's Ree, its query fee apart (`query_fee_paid`, `ledger: 'chat_fee'` in `credits.ts`); short → 402 for the whole question, nothing stored. A Ree without ready knowledge is not held for (`no_sources`).
3. The stream starts with a `data-ree` part per target (id = reeId); the question is embedded once; every Ree then retrieves (same `answerable()` predicate), generates with only its own past turns, and streams into a text part with id `answer-<reeId>` and `providerMetadata.re0.reeId`. Each ends with a `data-outcome` part (id `outcome-<reeId>`, carrying `reeId`).
4. An answer settles both holds and credits the owner `addGrant({source: 'earned', reason: 'query_fee_earned', reeId})`; no evidence or the sentinel releases them (`query_refund`).
5. When nobody answered (and nothing failed) in a multi-Ree conversation, `suggestRees` runs explore's search on the same embedding, the three are stored on the question (`suggested_ree_ids`) and sent as `data-suggestions`.

The page groups every reply of one question into one assistant message (`repliesOf` in `lib/domain/chat-message.ts`); `/rees/[id]/chat` (the owner's single-Ree test) uses the same route and format.

## Explore

- Level 1: `ree_profile_vector`, HNSW with `hnsw.ef_search = 400` set locally, the nearest 20 × 16 vectors → 20 Rees. With a category or Rees to exclude, an exact scan of that slice instead (`+ 0`), because HNSW filters after it searches.
- Level 2: 50 passages from only those Rees, exact scan; per Ree the best passage (its excerpt), kept when it is evidence by the same bar as answering (`RETRIEVAL_MIN_SIMILARITY` or ≥ 75% keyword coverage); score = similarity × `rank.quality` (neutral until the first hourly run), rounded to 0.001 so that a real tie is broken by the owner's role.
- Without a question: public Rees by `rank.activity30` (other people's questions + pulls into their conversations, 30 days), role, newest. Sort "回答最多" uses all-time answers to other people; "查询费最低" the fee.
- Card and public-page figures count other people's questions and votes only, so an owner testing their own Ree moves nothing.
- Profiles: introduction (+ category, tags) → 1 vector; example questions (or, until adopted, the suggested ones) → up to 3; the rest are 12 centroids of the Ree's answerable passages (or the passages themselves under 12). Rebuilt after every knowledge run, settings save, and pause / resume / trash / restore batch; removed when the Ree is private, taken down or deleted.

## Things a later step will want to know

- **Step 5 (takedown)**: set `moderated_*` and call `detachRee(tx, reeId, { includeOwner: false })` plus remove profile vectors (or `refreshProfile`). `publicRee()` already excludes moderated Rees everywhere (explore, public page, picker, suggestions).
- **Step 5 (statistics, verification thresholds)**: "answers to others" and "votes by others" are the subqueries `answersByOthers` / votes in `lib/services/explore.ts`; `query_fee_earned` entries now carry `ree_id`.
- **Step 7 (video)**: the cover on cards and the public page is `ReeCover` in `components/discover/ree-card.tsx` (avatar + name + 暂无视频介绍); swap in the player there. The OG image is `app/(discover)/r/[slug]/opengraph-image.tsx`.
- `ShellUser.history` feeds the sidebar; `app/(workspace)/layout.tsx` and `app/(discover)/layout.tsx` both render `components/shell/workspace-frame.tsx`.
- The fake model endpoint now answers non-streaming calls too, returns three questions to the suggestion prompt, and takes a delay (`startFakeOpenAi(port, { delayMs })`, or a second CLI argument) so parallel answers visibly interleave.

## Gotchas found

- **Two dev servers on `localhost`** (any ports) share the `re0_session` cookie; one app's layout clears the other's unknown session, which looks like random sign-outs. Run one of them on `127.0.0.1:<port>`.
- The bag-of-words fake turns `word.` into a token with the period; integration fixtures put unique words mid-sentence.
- **Migration order with step 5**: drizzle skips a migration whose journal `when` is older than the newest applied row. 0005's `when` was set to 1793606000000, below step 5's 0006 (1793606068090), so production applies both in order. Whoever regenerates 0006 must keep its `when` above 0005's.
- **Neon dev branch**: 0005 was not applied there from this session (the connection was refused by the session's permission classifier). Apply it with `npm run db:migrate` from a checkout whose `.env.local` points at the Neon `dev` branch, after checking `drizzle.__drizzle_migrations`; if step 5's 0006 is already recorded there, run 0005's SQL by hand. Production and preview migrate in the Vercel build.
- The walkthrough ran on a database of its own (`re0_step4` in the `re0-dev-pg` container) behind `tests/fixtures/wsproxy.mjs` on 5446, with the fake model on 5447 (25 ms between pieces).

## Left for later

- Explore has no keyword recall at level 1 (proposal §2.4 "后面可以再加关键词倒排做混合召回"); a Ree whose profile misses a topic can be missed.
- The rate limit is a Postgres counter per minute; fine for now, a KV store if it gets hot.
- "Related Rees" scores candidates sharing the category or a tag (≤ 300); a Ree related only by name words in another category is not found.
- The sidebar shows every pinned conversation and the 200 most recent others (the prototype shows all).
- Admin takedown UI and the role writes are step 5; the video player is step 7.
