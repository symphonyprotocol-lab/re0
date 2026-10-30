# Review: agent-first P1–P5 on `develop`

- Range: `0b0a2df..569eb55` (P1 #52, P2 #53, P3 #54, P4 #55, P5 #56; 534 files, +35.9k / −9.9k). P0 is out of scope.
- Spec read against: `agent-first-proposal.md` v0.10, `requirement.md` (5.1, 12), `architecture.md` (8.3, 9.5, 11.2, 11.3, 11.4, 13.1).
- Date: 2026-10-30. Read-only review: no source file was changed and no migration was run against Neon. The migration checks ran on throwaway local Postgres containers. All throwaway tests were deleted.
- Method: the current files of each subsystem were read end to end and their call paths traced, including `@a2a-js/sdk` 1.3.0 internals where they matter. Every finding below was checked against the code; each one is marked **confirmed** (traced in code, or shown by a test) or **plausible** (the mechanism is confirmed, but the outcome depends on timing or on the platform).

## 1. Baseline

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **exit 0**. The first run failed (four `TS7006` in tests plus missing-module errors): the worktree's `node_modules` was stale and lacked `@a2a-js/sdk`. After `npm ci` in the worktree it is clean. `package-lock.json` is unchanged. |
| `./scripts/test-integration.sh` | **135 files passed; 1427 tests passed, 11 skipped, 0 failed** (89 s). The 11 skipped tests sit behind the retired-surface switches: `embed-widget` 9, `rest-mcp-entry` 1, `api-keys` 1 (`whileOn = surfaceEnabled(...) ? it : it.skip`). There are no `it.todo` or `.only`. |
| Database used by the suite | A disposable local Docker `pgvector/pgvector:pg16` (`re0-test-pg`, port 5439), with migrations applied file by file through psql autocommit. It does **not** touch the Neon dev branch, which the hand-over brief assumed. |
| Migrations 0062–0066 (separate throwaway PG16 and PG18) | Apply cleanly both file by file and as one transaction, which is how `drizzle-kit migrate` runs them in the Vercel build. |
| `drizzle-kit generate` | Not usable (the snapshots stop at 0001). Instead the catalog after all migrations was compared with `db/schema.ts`: tables, columns, nullability and index names/uniqueness match. Only the FK names differ (`_fkey` in the DB, `_fk` in Drizzle), which has no runtime effect. |

The first `tsc`/integration run with the stale `node_modules` reported 8 failing files. All 8 were import failures (`Cannot find package '@a2a-js/sdk'`), not code defects.

## 2. Summary

Counts: **0 blocker, 5 high, 24 medium, 43 low.**

| # | Sev | Area | Where | Claim |
| --- | --- | --- | --- | --- |
| H1 | high | Authorization / editorial | `lib/application/editorial/assets.ts:369-391` | A post the author marked `paid` can go live **free**: the body is committed and the channel move done before `setAssetAccess` fails. The scheduled path fails silently. |
| H2 | high | Evidence rules | `lib/application/retrieval/search-scope.ts:180`, `agent/ask.ts:110` | A2A `ask` and the channel twin drop the retrieval confidence gate the playground uses. Unrelated questions reach the model, bill 10 Calls (or 1), and never enter the creator's pending list. |
| H3 | high | Money | `lib/application/channels/manage.ts:169-189` | Deleting a channel cascades away its subscriptions without cancelling them at Paddle. Subscribers keep being charged and the renewals are dropped as `unresolved`. |
| H4 | high | Money | `lib/application/revenue/payout.ts:152-188`, `redeem-credit.ts:225-257` | Payout and redeem only check `balance < 0` and never cap the amount at the balance. A chargeback booked in an unclosed period does not stop the charged-back income from being paid out. |
| H5 | high (plausible) | Money / access | `lib/application/channels/subscriptions.ts:582-639` | A first collection without a Paddle subscription id creates a `txn:` row, and the later `sub_` notice creates a second row. A refund then revokes only one of them, so access survives the refund. |
| M1 | medium | Gate / A2A | `lib/application/a2a/server.ts:178-185`, `agent/actions.ts:630` | CancelTask on an `INPUT_REQUIRED` task withdraws the action but returns `TaskNotCancelableError`, and the task ends `FAILED`, not `CANCELED`. |
| M2 | medium (plausible) | Gate / A2A | `a2a/server.ts:165-185` | A confirm that races a CancelTask runs the action (publish or a billed build) while the caller sees `CANCELED`. |
| M3 | medium | Gate | `agent/actions.ts:292-321, 536` | A `move_asset` card's from/to visibility and "makes public" are frozen when it is proposed. Confirming a stale card can publish content the card says stays private. |
| M4 | medium | Gate / visibility | `agent/actions.ts:308`, `channels/manage.ts:254` | Moving a `paid` asset to another public channel resets it to `free`, but the card does not flag it. An A2A `publish` with an `assets:write` key can set this up. |
| M5 | medium (plausible) | Gate / A2A | `agent/actions.ts:431-476, 643-664`, `a2a/server.ts:241` | Nothing reconciles an A2A task whose action has left `pending`. Tasks can stay `INPUT_REQUIRED` forever, and a confirm can leave no audit row. |
| M6 | medium | A2A | `lib/http/a2a.ts:217`, `app/a2a/[[...tenant]]/route.ts:15` | A client disconnect on a streaming call, or the 60 s `maxDuration`, leaves tasks `WORKING` forever (after metering). There is no sweeper. |
| M7 | medium | A2A | `a2a/server.ts:136-140` | With `returnImmediately`, `after()` keeps only the executor alive, not the SDK's event drain, so the final artifact and `COMPLETED` can be lost on Vercel. |
| M8 | medium | Evidence / comments | `comments/index.ts:382`, `questions/index.ts:300` | A comment moved to the pending list is indexed verbatim in the Q&A asset. Its text becomes retrievable, twin evidence and anchored, and it goes public if the Q&A is free. |
| M9 | medium | Evidence rules | `app/(public)/channels/[slug]/page.tsx:294-313` | The twin answer page shows claims without per-sentence citations, and a degraded (billed) answer shows no passages. |
| M10 | medium | Authorization | `retrieval/search-scope.ts:160` | The creator's per-subscriber daily cap is enforced only on channel-scoped search. REST, the playground, the workbench and the user card bypass it. |
| M11 | medium | Rate limits | `app/media/[mediaId]/route.ts`, `app/(public)/assets/...`, `middleware.ts` | Anonymous reading and listening has no anonymous rate limit (architecture 11.2). `/media` mints a signed URL per request. |
| M12 | medium | Privacy / A2A | `a2a/tenant.ts:56-66`, `a2a/card.ts` | A user Agent Card answers 200 for every handle, enumerating accounts and showing the OAuth display name even when the user's web profile 404s. |
| M13 | medium | Untrusted input | `connectors/callback-url.ts:21`, `a2a/push.ts:47-57`, `a2a/task-events.ts:104-146` | Push delivery is awaited serially inside global loops, with no DNS timeout and an unbounded body read. One tenant's tarpit callbacks stall syncing for every tenant. |
| M14 | medium | Money | `payment/paddle.ts:668-677`, `billing/backfill.ts:114` | The console backfill files a channel transaction as the subscriber's `subscription` billing document and never books the creator's income. |
| M15 | medium (plausible) | Money | `payment/paddle.ts:405-408`, `subscriptions.ts:576-668` | The webhook trusts the `custom_data` channel tag: product, currency and amount are never checked against the plan version. |
| M16 | medium (plausible) | Money | `subscriptions.ts:697-704` | A refund revokes access but does not cancel the Paddle subscription. The next renewal charges again and restores access; a re-subscribe in between double-bills. |
| M17 | medium | Money | `subscriptions.ts:659`, `administration/settlements.ts:354+` | A late event dated into a locked period stays out of statements until someone re-runs `generateSettlements` for that period, and nothing flags it. |
| M18 | medium (plausible) | Migrations | `db/migrations/meta/_journal.json` (idx 62–66) | The journal `when` values run to 2026-11-04. A next migration stamped earlier is skipped silently by `drizzle-kit migrate` in production while CI applies it. |
| M19 | medium | Retention | `lib/application/privacy/index.ts:100-146` | Private-asset retention deletes unpublished and scheduled post/audio drafts, aged from `created_at`. |
| M20 | medium | Workbench | `lib/application/agent/conversations.ts:90-99` | Reopening a conversation of more than 40 exchanges shows its **oldest** 80 turns, not the newest. |
| M21 | medium | Tests | `lib/http/a2a.ts:95-185` | The A2A route glue (`serveA2A`: key resolution, scope refusal, tenant mismatch, anonymous limit) is never exercised. Every test builds the caller facts by hand. |
| M22 | medium | Tests | `tests/integration/agent-p4.test.ts:602,617` | The 30-day purge window is never asserted: the test writes `bodyPurgeAt` itself. |
| M23 | medium | Docs | `architecture.md:937`, `requirement.md:733`, `agent-first-proposal.md:137/140` | The docs say `/v1/revenue*` was deleted, but the code keeps it and the proposal contradicts itself. |
| M24 | medium | Docs | `requirement.md:857-868` | The error table lists codes that do not exist and gives 403 for a non-subscriber reading a paid body; the code returns 404. |
| L1–L43 | low | various | see §4 | SSRF hardening, A2A conformance details, ledger edge cases, data lifecycle, test gaps, code health, docs. |

## 3. High and medium findings

### H1. A post the author marked `paid` can go live free

- **Severity** high. **Confidence** confirmed (code trace). **Area** authorization / editorial.
- **Where**: `lib/application/editorial/assets.ts:369-391` (`publishNow`), `:400-420` (`publishDueDrafts`). `saveEditorialDraft` accepts `paid` without checking the channel; `app/dashboard/posts/[assetId]/page.tsx:129` always offers `paid`. `lib/application/channels/subscriptions.ts:355` refuses `paid` when subscriptions are off.
- **Failure scenario**:
  1. A creator writes a post for a public channel whose subscriptions are not switched on, or moves a published paid post to such a channel, and picks access = paid.
  2. On publish, one transaction writes the new body into `source.config` (which the reading page serves directly), clears `publish_at` and queues the build.
  3. Only after that commit does `moveAsset` run (which resets `access` to `free`), and then `setAssetAccess(paid)` throws `subscriptions_disabled`. Nothing is rolled back.
  4. A live post's new body is readable by everyone at once. A new post goes public free when the build runs, and becomes searchable anonymously and through `/v1/context`.
  5. On the scheduled path, `publishDueDrafts` catches the error and only logs it. `publish_at` was already cleared, so the post is never retried and the creator is not told. The function's docstring says the opposite: "the failed draft stays scheduled".
- **Evidence**:
  ```ts
  // assets.ts:369-391
  const operationId = await database.transaction(async (tx) => {
    ... .set({ config: { path, url, markdown, summary: draft.summary, body: draft.body, audioMediaId } })
    await tx.update(schema.postDraft).set({ publishAt: null })...
    return queueBuildUnlessPending(tx, asset.id);
  });
  const moved = draft.channelId !== null && draft.channelId !== asset.channelId;
  if (moved) await moveAsset({ ... });                         // access -> 'free'
  ...
  await setAssetAccess({ ..., access: draft.access });          // throws subscriptions_disabled
  // subscriptions.ts:355
  if (access === 'paid' && !row.enabledAt) throw new ChannelCommerceRefused('subscriptions_disabled', ...)
  ```
  For contrast, `answerQuestion` (`questions/index.ts`) does roll the asset back when the move or the access change fails.
- **Fix**:
  - Validate everything before writing: the target channel is owned and active, and `paid` requires `subscriptions_enabled_at`. Do the same check in `saveEditorialDraft`, and only offer `paid` in the editor when the channel sells.
  - Do the source write, the move and the access change in one transaction: pass `tx` into `moveAsset` and `setAssetAccess`. This also closes the window in which a paid post moving between channels is briefly `free`.
  - In `publishDueDrafts`, clear `publish_at` only on success, and notify the creator on failure.

### H2. A2A `ask` and the channel twin skip the retrieval confidence gate

- **Severity** high. **Confidence** confirmed. **Area** evidence rules (requirement.md 5.1 rules 1–2, proposal 7.7) and metering (8.2).
- **Where**: `lib/application/retrieval/search-scope.ts:180-203`, `lib/application/retrieval/rank.ts:182-195`, `lib/application/agent/ask.ts:110-114`, `lib/application/questions/index.ts:115`.
- **Claim**: the playground and the workbench treat only *confirmed* reads as context (`readConfirms` → `confirmsRetrieval`, `retrieval/gather.ts:225-227`). `searchScope` calls `rankAcross`, keeps only `chunks` and drops `confidence`. The vector leg returns the `recallLimit` nearest chunks with no distance cutoff. So once embeddings are configured, `ask` and the twin almost never get zero results. The four generation entries do not share one chain in the sense the spec requires.
- **Failure scenario**:
  - A channel holds a cooking site. An A2A caller sends `ask` with "how do I rotate a Kubernetes secret?". The nearest cooking chunks come back, the seat is kept and the model is called on unrelated passages.
  - If the model cites anything, the caller pays 10 Calls for an answer adapted from irrelevant text. If it declines, the result is `degraded`: the caller pays 1 Call and reads "no answer could be generated" instead of "nothing matched, nothing charged".
  - On the twin the same question is never `no_context`, so it never reaches the creator's pending list. Proposal 6.7 ("检索零结果、分身不作答的问题自动进入待答列表") is therefore dead in practice.
- **Evidence**:
  ```ts
  // search-scope.ts:180
  const { chunks } = await rankAcross(database, { members, query: input.query, maxTokens: input.maxTokens }, dependencies, settings);
  // ask.ts:110 – the only "rule 2" check
  if (found.chunks.length === 0) { await releaseCalls(seat); return { outcome: 'no_context', ... } }
  ```
  The only integration test of `ask`'s `no_context` (`tests/integration/agent-p2.test.ts:558-569`) uses an empty workspace, which is why this was missed. `askTwin` has no integration test at all. `ask` also passes `faqNearest: null` (`ask.ts:180`), so the FAQ shortcut in `answerFromContext` can never fire for `ask` or the twin: another divergence.
- **Fix**: have `searchScope` return `confidence`, or a `confirmed` flag, and apply `confirmsRetrieval` in `askScope` before generating. An unconfirmed read should release the seat, return `no_context`, skip the model and queue the twin question. The better fix routes `ask` and the twin through the same `mergeReads` / `readConfirms` step as the playground, so the gate is shared code. Add a test with an off-topic question against a non-empty, embedded corpus, and one `askTwin` test.

### H3. Deleting a channel leaves its Paddle subscriptions billing

- **Severity** high. **Confidence** confirmed. **Area** money.
- **Where**: `lib/application/channels/manage.ts:169-189`. `channel_plan_version.channel_id` and `channel_subscription.channel_id` are `ON DELETE CASCADE` (`db/schema.ts:2760`, 0064). `subscriptions.ts:585-591` handles the renewals that follow.
- **Failure scenario**:
  1. A creator with 50 paying subscribers deletes the channel (`deleteChannelAction`). The channel row is deleted; its plan versions and all 50 subscription rows cascade away.
  2. Nothing calls Paddle and nothing checks for live subscribers first.
  3. Paddle renews each subscription every period. `applyChannelTransaction` cannot find the plan version, so it logs, returns `'unresolved'`, and the webhook acknowledges with 2xx.
  4. Subscribers are charged for nothing, the creator is credited nothing, and the subscribers cannot cancel in re0 because their rows are gone. Earning events survive, because `earning_event.channel_id` has no FK.
- **Evidence**:
  ```ts
  // manage.ts:175-188 — no subscription check, no provider call
  const channel = await ownedChannel(tx, input.workspaceId, input.channelId, true);
  ... await tx.delete(schema.channel).where(eq(schema.channel.id, channel.id));
  ```
- **Fix**: refuse to delete, or soft-delete, while any subscription is `active`/`past_due`/`paused` or has `current_period_end > now()`. Otherwise cancel each provider subscription inside the flow first. Stop the cascade from `channel` to `channel_subscription` and `channel_plan_version` (soft delete or `RESTRICT`) so the ledger can still resolve late renewals, refunds and chargebacks.

### H4. Payout and redeem do not cap at the balance

- **Severity** high. **Confidence** confirmed (logic). **Area** money (proposal 6.9).
- **Where**: `lib/application/revenue/payout.ts:152-188`, `lib/application/revenue/redeem-credit.ts:225-257`, `lib/application/revenue/balance.ts:27-51`.
- **Claim**: the only balance gate is `hasNegativeBalance` (balance < 0). The amount paid is the sum of released statement rows. A refund or chargeback is booked into the period of its `updated_at` (`subscriptions.ts:682`). Until that period is closed and settled (a manual console step), it lowers the balance but is netted against no statement.
- **Failure scenario**:
  1. A January collection credits +$80. January locks on 1 February and is released around 1 June, after the 120-day hold.
  2. In June the buyer charges back the January transaction, which books −$80 into June.
  3. The balance is 80 − 80 = 0, which is not negative, so `requestPayout` passes the gate. It sweeps January's +$80 statement and pays $80.
  4. The balance is now −$80: the platform has paid out income it already knew was charged back.
  This is exactly what the proposal says the 120-day hold prevents ("没有出账过的收入遇到拒付直接冲回，不会产生负余额"). Redeem-to-Calls has the same gap.
- **Evidence**: `payout.ts:152` `if (await hasNegativeBalance(input.workspaceId, tx)) throw …`. `payout.ts:182` `const amountMinor = rows.reduce((sum, row) => sum + Number(row.amountMinor), 0);` is never compared with the balance.
- **Fix**: in both paths compute `creatorBalance(ws, tx)` and pay `min(releasable, balance)`, leaving the rest accrued, or refuse when `amountMinor > balanceMinor`. Also net not-yet-settled negative events against what is releasable (see M17).

### H5. A purchase can create two subscription rows, and a refund then leaves access open

- **Severity** high. **Confidence** plausible: it depends on Paddle's event timing, but the code already handles the case where the subscription id is not known yet. **Area** money / access.
- **Where**: `lib/application/channels/subscriptions.ts:582` (`providerKey`), `:622-639` (insert), `:697-704` (refund), `:456-463` (cancel).
- **Claim**: `providerKey = notice.subscriptionExternalId ?? 'txn:'+transactionId`. If the first collected event is processed before the transaction carries a `subscription_id`, the row is keyed `txn:…`. The next notice carries `sub_…`. `subscriptionByProvider('sub_…')` finds nothing, so a second row is inserted. The unique index is only `(provider, provider_subscription_id)`, and nothing rewrites `txn:` to `sub_`.
- **Failure scenario**: two rows grant access to the same period end. A refund resolves through `sub_…` and marks only that row `refunded`. The `txn:` row keeps granting access until the period ends, which breaks "退款立即收回访问权". `/dashboard/subscriptions` lists two subscriptions, and cancelling the `txn:` one calls Paddle with `txn%3A…`, gets a 404 and throws. The ledger is not doubled, because `earning_event` is unique on `(source, reference)`.
- **Evidence**: the insert path at `:622-639` runs whenever `!subscription`. The integration tests always pass a `subscriptionId` (`agent-p3.test.ts:198`), so this path is untested.
- **Fix**: when `subscriptionExternalId` arrives and no `sub_` row exists, look up `txn:${transactionId}` and update its key instead of inserting. Or do not grant access until the subscription id is known, and treat such a notice as "retry later", as subscription events already are.

### M1. CancelTask on a waiting task errors and ends FAILED

- **Confidence** confirmed (including SDK source). **Area** gate / A2A (proposal 7.6).
- **Where**: `lib/application/a2a/server.ts:178-185`, `lib/application/agent/actions.ts:630-632`, SDK `cancelTask` (`node_modules/@a2a-js/sdk/dist/server/index.js` ~3218).
- **Scenario**: a caller sends `publish`, gets `INPUT_REQUIRED`, then calls CancelTask. The wrapper calls `withdrawAction`, whose `closeAction` moves the task to `FAILED` ("Not done: the caller cancelled the task."). Then `this.inner.cancelTask` loads a terminal, non-CANCELED task and throws `TaskNotCancelableError` (-32002 / HTTP 409). The cancellation worked, but the caller is told it failed. The integration test (`agent-p2.test.ts:742-745`) checks only the action row and ignores the CancelTask response.
- **Fix**: give `closeAction` a task-state argument: `CANCELED` for a caller's withdrawal, `FAILED` for an owner's rejection. When a pending action was withdrawn, return the stored task without calling `inner.cancelTask`. Assert the response in the test.

### M2. A confirm racing a CancelTask

- **Confidence** plausible (a race window found by reading the code). **Area** gate / A2A.
- **Where**: `a2a/server.ts:165-185`; `agent/actions.ts:431-476, 547-576`.
- **Scenario**: the cancel wrapper only withdraws actions still `pending`, and only cancels a build already linked on the task row. Between the confirm's `pending→confirmed` update and `followConfirmation`, it finds nothing to withdraw, so the SDK marks the task `CANCELED`; `INPUT_REQUIRED` is not terminal, so the store allows it. The action then runs: the asset becomes public, or the build is queued and billed. `followConfirmation` does nothing on the terminal task, and `syncBuildTasks` reads only `WORKING` tasks. The caller believes nothing happened.
- **Fix**: if any action linked to the task is `confirmed`, refuse the cancel (`TaskNotCancelableError`). Alternatively, take `SELECT … FOR UPDATE` on the `a2a_task` row in both the confirm path and the cancel path.

### M3. A stale `move_asset` card can publish

- **Confidence** confirmed (logic); exploiting it needs the owner to act on an old card. **Area** gate (proposal 5.2, 10 "公开是一个明确动作").
- **Where**: `agent/actions.ts:292-321` (prepare), `:536` (execute), `lib/domain/agent-action.ts:102`.
- **Claim**: the digest binds only `{assetId, channelId}`. `summary.from`, `summary.to.visibility` and `makesPublic` are snapshots that execution never re-checks.
- **Scenario**: a proposal "move X into channel C (private)" shows "Nothing becomes public". Within 24 hours the owner makes C public for other reasons. Confirming the old card now publishes X. Or the card said "from public A to public B", the owner then pulled X out of A, and clicking the old card republishes X. `moveAsset` still enforces rights and the claim, so this is a consent failure, not a bypass of the gate.
- **Fix**: at confirm time, recompute `from`, `to.visibility` and `makesPublic`, and refuse as `stale` if any of them changed. Or put the expected current channel and the target visibility into the params, and have `moveAsset` check them inside its locking transaction.

### M4. Moving a `paid` asset to another public channel silently makes it free

- **Confidence** confirmed. **Area** gate / visibility.
- **Where**: `agent/actions.ts:308`, `channels/manage.ts:254`.
- **Scenario**: `makesPublic = target public && from not public`, which is false for a move from public channel A to public channel B. `moveAsset` then sets `access = 'free'` unconditionally, so the full paid body becomes readable by everyone. An external agent holding an `assets:write` key can send A2A `publish {assetId: paid-post, channel: other-public}`. The card shows a harmless move, and the owner confirms. The dashboard's `addAssetAction` resets access the same way, without a warning.
- **Fix**: select `asset.access` when preparing the action, and set a `makesFree` flag (worded on the card) when a `paid` asset is moved. Or keep `paid` across moves between two channels that both sell.

### M5. Tasks can stay `INPUT_REQUIRED` forever, and a confirm can leave no audit row

- **Confidence** plausible. **Area** gate / A2A.
- **Where**: `agent/actions.ts:431-476` (claim, execute, store result, audit, follow; separate statements), `:643-664` (`expireActions` marks every row first, then loops `changeTask`), `a2a/server.ts:236-244` (`catchUp` only looks at `pending`).
- **Scenarios**:
  - `expireActions` sets N rows to `expired`, then awaits `changeTask` for each one. Each call can wait up to 2 × 5 s on the caller's push hooks. If the drain dies part-way, the remaining tasks stay `INPUT_REQUIRED`.
  - The owner confirms, `execute` succeeds, then storing the result or writing the audit row fails. The action is `confirmed` with `result = null` and no audit row, and its A2A task is never followed.
  - The owner's click waits on the A2A caller's push endpoints (`followConfirmation` → `changeTask` → `deliverTaskPush`), so a third party controls how long the confirm takes.
- **Fix**: have `catchUp` and the drain repair `INPUT_REQUIRED` tasks whose action is `expired`, `rejected` or `failed` (move to `FAILED`) or `confirmed` (move to `WORKING` or `COMPLETED`). Write the audit row in the claiming transaction, then update it. Send pushes from `after()` or a queue, not inline. Let per-row failures in `expireActions` not stop the loop.

### M6. Orphaned `WORKING` tasks (stream disconnect, 60 s `maxDuration`) and no sweeper

- **Confidence** A1 confirmed by an SDK test; A3 plausible. **Area** A2A.
- **Where**: `lib/http/a2a.ts:217-219` (`cancel() { await events.return(undefined) }`), `app/a2a/[[...tenant]]/route.ts:15` (`maxDuration = 60`), `lib/domain/generation.ts:126` (timeout ≤ 300 s), `lib/domain/model-config.ts:56` (embedding default 60 s).
- **Scenario**:
  - The SDK writes task state from inside the stream generator. When a client disconnects from `SendStreamingMessage`, the generator returns and every later event is dropped, so the task stays `WORKING`. The caller is still metered.
  - Separately, a blocking `ask` can legitimately run past 60 s with the admin-configurable timeouts, and the function is killed mid-task.
  - Only `syncBuildTasks` (builds) and action expiry clean up. Nothing fails a non-build `WORKING` task.
  - A throwaway test (`DefaultRequestHandler` + `InMemoryTaskStore`: take the first event, then `gen.return()`) showed the store still holding `WORKING` after the executor published `COMPLETED`.
- **Fix**: drain the SDK generator independently of the HTTP stream, for example in an `after()` loop feeding a buffer. Set `maxDuration` above the longest configured chain, or cap the A2A chain below it. Add a drain step that fails tasks in `WORKING` with `workflow_run_id IS NULL` and `updated_at` older than `maxDuration` plus a margin.

### M7. `returnImmediately` can lose the final state

- **Confidence** confirmed for the ordering (SDK test); the loss depends on Vercel freezing the instance. **Area** A2A.
- **Where**: `a2a/server.ts:136-140`, `a2a/executor.ts:162-171`, `lib/http/a2a.ts:171`.
- **Scenario**: in non-blocking mode the SDK runs `_processEvents` without awaiting it. `after(() => executor.settled())` resolves as soon as `execute()` returns, while the artifact update and `COMPLETED` still need a load and a save each, plus push sends. A throwaway test with a store that takes 20 ms per load or save showed the stored task still `WORKING`, with 0 artifacts, at the moment `after` would resolve. The proposal recommends exactly this mode for long tasks (7.6).
- **Fix**: give `after()` a promise that resolves only once the terminal state is saved. For example, have the executor save the final task itself, or wrap the store to resolve a deferred on the terminal save.

### M8. Comment text enters retrieval through Q&A

- **Confidence** confirmed. **Area** evidence / comments (proposal 6.8: "不进入检索、不作为分身的证据、不上链…问答资产只引用创作者自己的回答").
- **Where**: `lib/application/comments/index.ts:377-384`, `lib/application/questions/index.ts:265-300`, `lib/domain/editorial.ts:195-197`.
- **Scenario**: a reader comments on a paid article: "My email is x@y.com — does the API support webhooks?". The creator moves the comment to the pending list and answers it as a free Q&A. The Q&A's indexed document is `# ${question}\n\n${answer}`, with the raw comment as the question and as the asset title. The comment text is now chunked, embedded, served by `search_context`, cited by the twin and `ask`, and covered by the anchored version digest. Text from a subscribers-only comment is now public and searchable without login.
- **Fix**: for questions with `source = 'comment'`, index only the creator's answer plus a title the creator types or confirms. Never index the raw comment body.

### M9. Twin answers render without citations; a degraded twin shows no passages

- **Confidence** confirmed. **Area** evidence rules 5 and 6.
- **Where**: `app/(public)/channels/[slug]/page.tsx:294-313`, `lib/application/questions/index.ts:116-125`.
- **Scenario**: `twin_answer` stores `claims` and `versions` only, with no chunk citation fields and no excerpts. The page renders each claim as a bare `<li>` plus up to three version links. A `degraded` answer is billed 1 Call and shows "These are the relevant passages." followed by no passages. A reader cannot tell which sentence came from which source, section or version.
- **Fix**: store each cited chunk's citation (source URL, document title, section, version), and the excerpts for `degraded`. Render numbered markers per claim, and the passage list for a degraded answer.

### M10. The per-subscriber daily cap only binds channel-scoped search

- **Confidence** confirmed. **Area** authorization (proposal 6.10).
- **Where**: `retrieval/search-scope.ts:160-162` is the only caller of `assertUnderSubscriberCap` (`channels/subscriptions.ts:84`). `query-docs.ts` never calls it.
- **Scenario**: a creator sets 20 reads per day. The subscriber reads paid assets without limit through `GET /api/v1/context`, the playground or workbench `query_docs`, or A2A `search_context`/`ask` on the creator's **user** tenant (`scope.kind = 'workspace'`). The cap's own docstring says it limits "every billed retrieval".
- **Fix**: enforce the cap in the shared visibility/metering step for any read of a `paid` asset by a subscriber: in `queryDocsInner`, and per channel in workspace-scoped `searchScope`.

### M11. Anonymous reading and listening has no rate limit

- **Confidence** confirmed. **Area** rate limits (architecture 11.2 lists "公开频道里免费资产的阅读与收听").
- **Where**: `app/media/[mediaId]/route.ts`, `app/(public)/assets/[...assetId]/page.tsx`, `app/(public)/channels/[slug]/page.tsx`, `app/api/page-markdown/route.ts`, `middleware.ts`.
- **Scenario**: `strictRateLimit` and `rateLimitKey` are used only by REST/MCP retrieval, A2A, anchors, admin login and the showcase. A script can scrape every free article and request `/media/<id>` in a loop; each request mints a fresh 15-minute signed URL to the private bucket, with egress billed to the platform.
- **Fix**: apply the fail-closed anonymous limiter to session-less requests on `/media/*` and the full-text reading paths, in middleware or at the top of the route or page.

### M12. A user Agent Card exists for every handle

- **Confidence** confirmed. Proposal 7.1 does ask for a skill-less public user card, so the card itself may be intended; the name leak and the enumeration are not. **Area** privacy / A2A.
- **Where**: `lib/application/a2a/tenant.ts:56-66`, `a2a/card.ts` (`name: \`${tenant.name} on re0\``), `lib/application/workspaces/handle.ts:23` (handle derived from the email's local part), `lib/domain/auth.ts:152` (workspace name = OAuth display name).
- **Scenario**: `GET /a2a/users/{guess}/agent-card.json` answers 200 for any handle that exists, and the card's name contains the user's real name, even for users with no public channel, whose `/u/{handle}` page 404s. That confirms an account exists for a guessed email local part and reveals the owner's name. It contradicts proposal 4.3 ("没有公开频道的用户没有公开主页") and the no-enumeration rule.
- **Fix**: return 404 for a user tenant with no public channel, unless the caller is that workspace. Or keep the card but name it by handle, and leave `workspace.name` out until the user publishes.

### M13. Push delivery can stall every tenant

- **Confidence** plausible: the code path is confirmed, the impact was not measured. **Area** untrusted input / availability.
- **Where**: `lib/infrastructure/connectors/callback-url.ts:21-22` (`dns.lookup`, no timeout), `lib/application/a2a/push.ts:47-57, 171-199` (`response.arrayBuffer()` with no cap; the 5 s timer starts after DNS), `lib/application/a2a/task-events.ts:104-114, 145-180` (`changeTask` awaits two sends; `syncBuildTasks()` walks all workspaces serially), `app/api/cron/drain/route.ts:52`, `app/dashboard/actions/actions.ts:69-74`.
- **Scenario**: a key holder registers five callback URLs per task, pointing at tarpits or at a domain whose name server never answers, then confirms a batch of their own ingests. Each task moved inside the global `syncBuildTasks` loop then costs about 2 × (DNS stall + 5 s). Other tenants' syncs and pushes miss the deadline, and the hung lookups also tie up the 4-thread libuv pool shared with unrelated requests.
- **Fix**: put the DNS lookup inside the per-send deadline (`dns.promises.Resolver({timeout, tries})`, or race it against a timer). Replace `arrayBuffer()` with `body?.cancel()`. Take delivery off the compare-and-set path: send with `Promise.allSettled` under one overall budget, or queue the sends. Apply the same deadline to `assertAgentAddress` in `guardedFetch`.

### M14. Console backfill misfiles channel transactions

- **Confidence** confirmed by a contract test. **Area** money (architecture 11.3).
- **Where**: `lib/infrastructure/payment/paddle.ts:668-677` (`fetchDocument`), `:335-344` (`transactionNotice`), `lib/application/billing/backfill.ts:114`.
- **Scenario**: an operator uses the "missed webhook" backfill on a channel transaction. `fetchDocument` never checks `isChannelTransaction`, so the transaction falls back to kind `subscription` and lands on `re0_workspace_id`, the subscriber's workspace. The test printed `{"kind":"subscription","ws":"<subscriber ws>","amount":600}`. The subscriber's billing page gains a document that is not theirs, and the creator's earning event, the access grant and the storage tier are never written.
- **Fix**: in `fetchDocument` and the backfill, route channel transactions to `applyChannelTransaction`, or refuse them as `not_billable`.

### M15. The webhook trusts the channel tag without checking product, currency or amount

- **Confidence** plausible. Exploiting it needs a catalogue price in the Paddle account, or Paddle.js accepting `customData` on any checkout. Checkouts here use non-catalogue prices, so this is defence in depth unless such a price exists. **Area** money.
- **Where**: `payment/paddle.ts:405-408`, `channels/subscriptions.ts:576-668`, `:621`.
- **Claim**: `isChannelTransaction` returns true for any product once `re0_kind = channel` is present. `applyChannelTransaction` then takes the plan, user and workspace from `custom_data`, and grants access whatever the amount, currency or product. A transaction with no billing period gets 31 days (`:621`). The $5 minimum is checked only when the checkout is created. A contract test treated a JPY transaction for amount 1 on another product as a channel sale.
- **Fix**: accept a channel transaction only when an item's `product_id` is `PADDLE_CHANNEL_PRODUCT_ID`, the currency matches the plan, and the ex-tax amount is at least the plan price (or there is a discount the server issued). Record anything else as `refused` for an operator.

### M16. A refund does not cancel the Paddle subscription

- **Confidence** plausible: a Paddle refund adjustment does not cancel the subscription, and this code never does. **Area** money.
- **Where**: `subscriptions.ts:697-704`, `:640-645`, `:403`.
- **Scenario**: a refund in the current period sets the row to `refunded` and its `current_period_end` to now, but the Paddle subscription stays active. Next cycle Paddle charges again, and `applyChannelTransaction` sees a later period end and sets the row back to `active`. If the buyer re-subscribed in the gap, two Paddle subscriptions renew from then on.
- **Fix**: on a refund or chargeback of the current period, cancel the Paddle subscription immediately, or queue the cancellation. At minimum, have `startChannelCheckout` refuse while the user still has a non-canceled provider subscription for that channel.

### M17. Late events in locked periods need a manual re-settle

- **Confidence** confirmed (design gap). **Area** money.
- **Where**: `subscriptions.ts:659` (`periodIdOf(collectedAt)`), `lib/application/administration/settlements.ts:354+`.
- **Scenario**: a webhook for a refund or a collection is delivered after its period has closed, because of an outage or Paddle's 3-day retry tail. The event counts in the balance but appears in no statement until an operator happens to re-run `generateSettlements` for that old period. Combined with H4, an unsettled negative lets positive statements be paid out.
- **Fix**: book late events into the current open period, or list periods whose event sum differs from their statement sum on `/admin/settlements`.

### M18. Migration journal timestamps lie in the future

- **Confidence** plausible: the mechanism is confirmed; it fires only if the next `when` is not larger. **Area** migrations.
- **Where**: `db/migrations/meta/_journal.json` idx 62–66 (`1793400000000` … `1793800000000` = 2026-10-30 22:40 … **2026-11-04 13:46 UTC**); drizzle-orm `pg-core/dialect.js:62` applies a migration only if `last.created_at < folderMillis`, a strict comparison.
- **Scenario**: the next migration is stamped with `Date.now()` before 2026-11-04 13:46 UTC, or two parallel worktrees pick the same next round number. `drizzle-kit migrate` in the Vercel build skips it silently, while `scripts/test-integration.sh` and CI (psql over every file) apply it. Tests pass, the deploy succeeds, and production fails at runtime on the missing column.
- **Fix**: add a contract test that the journal `when` values strictly increase and match the files. Document "next `when` = previous + 1e8" beside the journal. Production already stores 1793800000000, so editing the journal now does not help.

### M19. Retention deletes drafts

- **Confidence** confirmed (code path; not run end to end). **Area** retention (proposal 7.9 part 4).
- **Where**: `lib/application/privacy/index.ts:100-146` (`expirePrivateAssets`), `lib/application/editorial/assets.ts:105-125, 381-384`.
- **Scenario**: an editorial asset exists from the moment its draft is created: `lifecycle_status = 'draft'`, no successful build, and no `channel_asset` row until publish. With retention set to 30 days, a draft created 31 days ago, edited yesterday and scheduled for a public channel next week is soft-deleted on the next hourly run. That takes its media with it, and `publishDueDrafts` then skips it.
- **Fix**: exclude assets that have a `post_draft` with `publish_at` set or a public target channel, and age drafts by `greatest(created_at, post_draft.updated_at)`. If deleting old unpublished drafts is intended, say so on the privacy page.

### M20. A reopened conversation shows its oldest turns

- **Confidence** confirmed. **Area** workbench.
- **Where**: `lib/application/agent/conversations.ts:90-99` (`orderBy(asc(createdAt)).limit(TURNS_SHOWN * 2)`).
- **Scenario**: past 40 exchanges, reopening a conversation (`app/dashboard/page.tsx:57`) stops at exchange 40. The newest turns, including pending action cards, never show. The client builds the planner's `history` from what it shows, so the planner also gets the oldest turns.
- **Fix**: order by `created_at DESC LIMIT 80` and reverse in memory. The existing `(conversation_id, created_at)` index serves both directions.

### M21. The A2A route glue is untested

- **Confidence** confirmed. **Area** tests.
- **Where**: `lib/http/a2a.ts:95-185` (`serveA2A`). The test helpers `channels-a2a.test.ts:175-194`, `agent-p2.test.ts:240-273` and `agent-p3.test.ts:224-244` build `caller` facts by hand.
- **Claim**: these are never exercised: API-key-to-workspace resolution (:129-133), the "no A2A scope" refusal (:134-141), the body-tenant vs path-tenant check (:121-123), the anonymous limiter (:143-155), and anonymous callers getting `workspaceId: null` (:170-176). The P1 criterion "anonymous search writes no usage event" and the P2 criterion "an A2A caller cannot confirm" hold only if this glue is right.
- **Fix**: add one integration test that drives the route's `POST` with a `NextRequest`: anonymous search writes no usage event; a key with only `assets:write` cannot confirm; a key with no A2A scope gets `access_denied`; a body tenant different from the path tenant gets -32602.

### M22. The 30-day purge window is never asserted

- **Confidence** confirmed. **Area** tests (P4 exit criterion).
- **Where**: `tests/integration/agent-p4.test.ts:602, 617`. There are two constants, `a2a/task-store.ts:24` `TASK_BODY_RETENTION_DAYS` and `lib/domain/external-agent.ts:27` `BODY_RETENTION_DAYS`.
- **Claim**: the test writes `bodyPurgeAt` itself, so changing either constant to 300 leaves every test green.
- **Fix**: merge the two into one constant. Assert it equals 30, and check that `bodyPurgeAt` on a task the store created is `createdAt + 30 d`.

### M23. Docs disagree about `/v1/revenue*`

- **Confidence** confirmed. **Area** docs.
- **Where**: `architecture.md:937` and `requirement.md:733` say "`/v1/revenue*` 随发布者分成删除". `agent-first-proposal.md:137` says it is kept; `:140` cites it as an example of an endpoint deleted with its feature. The code keeps `app/api/v1/revenue/{route,credit/route,payout/route}.ts`, rewired to channel income.
- **Fix**: settle on "kept, now settles channel income" and correct all four lines.

### M24. The error table in requirement.md is wrong

- **Confidence** confirmed. **Area** docs.
- **Where**: `requirement.md:857-868` against `contracts/errors.ts`.
- **Claim**: `asset_processing`, `asset_redirected`, `asset_exists`, `asset_too_large` and `source_unprocessable` are not API error codes. P5 renamed `library_*` to `asset_*` mechanically in this table. The real codes are `asset_not_ready`, `asset_size_exceeded`, `parse_failed` and so on. The 403 row says a non-subscriber reading a `paid` body gets `access_denied`, but the code and the P3 test (`agent-p3.test.ts:348-349`) return 404 `asset_not_found`.
- **Fix**: regenerate the table from `contracts/errors.ts`, and move "non-subscriber, paid" into the 404 row.

## 4. Low findings

Each entry gives the place, the problem, and the fix.

**Untrusted input and SSRF.** Every outbound path is https-only and keeps certificate validation, so a request that reaches an internal IP fails the TLS handshake. That limits L1–L3 to blind probing.

- **L1. DNS rebinding.** `connectors/callback-url.ts:41-58`, `external-agents/transport.ts:55-67`, `a2a/push.ts:180`. The address that was checked is not pinned for the connection; `fetch` resolves the host again. *Fix:* use an undici `Agent({ connect: { lookup } })` that runs the private-range check on each address at connect time.
- **L2. The private-range deny-list has gaps.** `connectors/http.ts:34-35, 66-120`. It allows `fec0::/10`, NAT64 `64:ff9b::/96` (including the encoded 169.254.169.254), 6to4, `::ffff:0:0/96`, 198.18/15, 192.0.0/24, multicast and broadcast. A resolved address with a zone id (`fe80::1%eth0`) also passes. This was shown by a throwaway test. *Fix:* switch to an allow-list of global unicast, decode embedded IPv4 addresses, and strip `%zone`.
- **L3. Article import skips the DNS check.** `editorial/import.ts:26-66`, `connectors/http.ts:32, 45-47`. Import uses `fetchDocument`, which never resolves DNS, and `https://localhost./` (trailing dot) passes the blocklist. The response becomes a draft the importer can read. *Fix:* run `assertCallbackReachable` on each hop, and strip trailing dots before the blocklist lookup.
- **L4. External-agent output can reach the answering model.** `playground/agent.ts:406, 534-547`. It travels through the planner's ≤ 200-character restated question (`resolved`). The publisher-controlled agent `name` is also placed inside the `delegate_task` tool description (`:780-782`). *Fix:* set `resolved = null` when `check_delegation` ran in the exchange, and limit agent names to a safe character set or refer to agents by id.
- **L5. Push secrets share the provider key.** `a2a/push.ts:98, 203`, `crypto/credentials.ts:81-114`. Push secrets are sealed under the default `provider` purpose, which contradicts the "a row of one kind never opens as the other" comment, and no sealed value carries AAD binding it to its row or workspace. *Fix:* add a `push` purpose that falls back to `provider` for old rows, and add AAD such as `agent:<id>`, with a version prefix so old rows still open.
- **L6. Pushes go out without auth when the secret cannot be opened.** `a2a/push.ts:186-188, 201-208`. If the sealed secret fails to open (key rotated or missing), the push is still sent, with no auth header. *Fix:* drop the send and log it. Also check `isCredentialKeyConfigured()` before saving a config.
- **L7. Creator deletes keep the comment body.** `comments/index.ts:347-349`. A creator's "delete" keeps `body` and `findings` in the database, while the author's own delete and account erasure blank them. *Fix:* blank both on creator delete too.
- **L8. Inbound A2A sizes are unbounded.** `lib/http/a2a.ts:108` reads the whole request (only the platform's roughly 4.5 MB limit applies). `QUERY_MAX_CHARS` applies to read skills only. History has no cap, and each follow-up message is stored twice: the SDK appends it, then `executor.ts:187-196` appends it again. Keyed callers have no rate limit. *Fix:* cap the body (for example 256 KB), the parts and the history, de-duplicate by `messageId`, and rate-limit per key.
- **L9. A Markdown link to `/\evil.com` passes as same-site.** `components/creator/markdown.tsx:73-74`. *Fix:* reject `/\` and `\` prefixes.

**Confirmation gate and cards**

- **L10. The `create_channel` card hides the description it will publish.** `agent/actions.ts:265-277`, `components/dashboard/action-card.tsx:22-40`. The model-written description (up to 500 characters) is published on the channel page but not shown on the card; the `create_asset` card likewise omits the title and slug. *Fix:* show them on the card.
- **L11. The `refresh_asset` card always says "Nothing becomes public"**, even for an asset that sits in a public channel (`agent/actions.ts:237-263`). *Fix:* use separate wording for "updates public content".
- **L12. No cap on pending actions from A2A callers.** `a2a/executor.ts:280-334`. A looping agent can bury the owner's dashboard, which shows the newest 60 (`actions/page.tsx:22`). *Fix:* cap open actions per workspace or per key.
- **L13. A stale task snapshot can undo a state change.** `a2a/task-store.ts:59-81` blocks overwriting terminal states only, so a stale `INPUT_REQUIRED` snapshot can overwrite a `WORKING` state written out of band. A follow-up message at the moment of the confirm then strands the task. *Fix:* compare-and-set on `updated_at` or a version column, or rely on M5's reconciliation.

**A2A conformance**

- **L14. Push behaviour.** `a2a/push.ts:99-105, 171-198`:
  - Payloads ignore the stored `wireVersion`, so v0.3 clients receive v1.0 bodies (the SDK ships `V03PushNotificationSerializer`).
  - When credentials are set, the notification token is dropped.
  - There are no retries.
  - `a2a_push_config` rows, holding a URL and a sealed secret, are never purged, and orphaned or anonymous configs live forever (`privacy/index.ts:261` is the only delete).
  *Fix:* pick the serializer by version, send the token header, and purge configs together with the task bodies, plus orphans.
- **L15. SSE errors arrive inside a 200 stream.** `lib/http/a2a.ts:198-222`. SSE commits to 200 before the first event, so errors raised before streaming starts (task not found, invalid params) come back as `event: error` inside a 200 stream. *Fix:* pull the first event before choosing SSE, as the SDK's Express transport does.
- **L16. `SubscribeToTask` deviates from the spec.** `a2a/server.ts:188-228`. On a terminal task it replays the task instead of raising `UnsupportedOperationError`. It sends no heartbeat during the 50 s window. Each poll runs `catchUp`. *Fix:* follow the spec or document the deviation, and add a `: keep-alive` frame every 15 s.
- **L17. REST query parameters are parsed loosely.** `a2a/server.ts:360-377`. `includeArtifacts=false` is read as true (proto `fromJSON` uses `Boolean("false")`), and `historyLength` is not validated. `PostgresTaskStore.list` ignores `statusTimestampAfter`. *Fix:* use the SDK's REST parsers, and filter on the timestamp.
- **L18. The cards declare no `securityRequirements`.** `a2a/card.ts:272-299`. Not even `ask` or the write skills declare one. An anonymous `GetExtendedAgentCard` returns the public card instead of an auth error. *Fix:* declare Bearer on those skills, and return 401 for the extended card when no credentials are sent.
- **L19. Minor scoping.**
  - A `knowledge:search`-only key can CancelTask its workspace's write tasks (`a2a/server.ts:162-186`).
  - JSON-RPC requests rejected in the HTTP layer (401, 429) get REST-style error bodies (`lib/http/a2a.ts:133-157`).
  *Fix:* require `assets:write` to cancel write tasks, and answer JSON-RPC requests with JSON-RPC envelopes.

**Authorization and visibility**

- **L20. Media and import calls skip the role check.** `editorial/media.ts:55, 109, 172` and `importPosts`. With only single-owner workspaces today, nobody else can reach them. Once team workspaces exist, a viewer could replace a published episode's audio. *Fix:* call `assertEditor(role)` in each.
- **L21. Former subscribers keep paid passages.** Paid passages stay in stored A2A artifacts for up to 30 days after expiry (`GetTask`/`ListTasks`), and in twin answers and workbench turns with no limit. *Fix:* document this, or redact artifacts at load time for assets the caller can no longer read.
- **L22. The entitlement rule is written four times, on two clocks.**
  - `lib/domain/channel-commerce.ts:25, 38-46` (`grantsAccess`, app clock, used by `subscribesTo` for the web page, comments, the extended card and the cap).
  - `channels/visibility.ts:51-62` (SQL, DB `now()`, used by retrieval and media).
  - `channels/subscriptions.ts:168-169, 527-528`.
  The web door and the A2A/REST doors can disagree right at the period boundary, which is exactly what the P3a criterion is about. *Fix:* build the SQL from `ACCESS_STATUSES`, and use DB `now()` everywhere.
- **L23. Comment posting reveals whether an asset exists.** `comments/index.ts:200-202` answers `not_allowed` for an existing but hidden asset and `not_found` for a missing one. *Fix:* answer `not_found` whenever the caller cannot read comments.
- **L24. Draft images of a live post are readable.** `editorial/media.ts:194-215`. Anyone with the image id can fetch it before it is published. *Fix:* serve non-owners only media referenced by the current `source.config`.
- **L25. Caches outlive a channel going private.** The directory, the cards and the sitemap stay served for 2 min, 5 min and 60 min (`lib/http/channel-directory.ts:14-17`, `lib/http/a2a.ts:87`, `app/sitemap.ts`). *Fix:* call `revalidateTag` on channel edit, or document the delay.

**Evidence and metering**

- **L26. Adding audio to a Q&A bills a rebuild.** `questions/index.ts:335-357`. Attaching an audio note renames the source path, which forces a full re-embed billed as a build, skipping `assertBuildAffordable`, although the indexed text did not change. Proposal 8.2 says audio is not billed. *Fix:* treat a change to the audio hash alone as a free rebuild, or carry chunks forward by content hash.
- **L27. Retired showcase actions are not switched off.** `app/dashboard/assets/[assetId]/actions.ts:540-575, 641-660` → `showcase/draft.ts:76`. `enableShowcaseAction` and `draftShowcaseAction` do not check `surfaceEnabled('showcase')`, so a signed-in owner can still run the retired showcase generator, which has its own prompt. *Fix:* gate them.
- **L28. `reserveCalls` is not safe to replay.** `plans/weighted-call.ts:61-69` hits the unique index on a reused request id and surfaces a raw DB error. No current route reuses an id. *Fix:* look up by request id first, as `reserveCall` does.

**Money**

- **L29. The profile-email fallback never fires.** `app/api/v1/revenue/payout/route.ts:38` passes `''`, and `'' ?? account.payeeEmail` evaluates to `''`. *Fix:* pass `undefined` and use `||`.
- **L30. The payout address is not bound to the verified profile.** `revenue/payout.ts:146`. The PayPal address can be overridden on each request. Changing `payee_email` does not reset tax verification, and `verifyTaxDocument` does not require `status = 'submitted'` (`payout-profile.ts:59-79`). *Fix:* pay only `publisher_account.payee_email`, and make verification conditional on that status.
- **L31. Partial refunds can leave a cent.** `lib/domain/channel-commerce.ts:123-127`. Each partial refund is rounded on its own, so a fully refunded 999 at 80% can leave 1 cent credited. *Fix:* compute shares cumulatively.
- **L32. Chargeback reversals and partial refunds handle access wrongly.** `subscriptions.ts:600-614, 697-704`. A chargeback reversal restores the money but not access. Any partial refund, even a 10% goodwill one, revokes the whole period. *Fix:* revoke only when the net reversed amount reaches the amount collected.
- **L33. The admin settlements summary shows constants.** `administration/settlements.ts:310-311` shows the `PAYOUT_*` constants instead of the `commerce_config` values. *Fix:* read `activeCommerceSettings()`.

**Data and lifecycle**

- **L34. The account-deletion hooks have no caller.** `eraseUserComments` (`comments/index.ts:267`) and `writeOffNegativeBalance` (`revenue/balance.ts:65`) are never called; no account-deletion flow exists. Requirement 12 already says the deletion flow is not live. *Fix:* track it as an open item, or call the hooks from the admin "disable user" path.
- **L35. Retention does not re-check before deleting.** `privacy/index.ts:109-143` → `assets/delete.ts:66-160`. The "not in a public channel" and "no build" checks are not repeated inside `markAssetDeleted`. An asset moved or rebuilt during the batch is still deleted. *Fix:* re-check the conditions under the row lock.
- **L36. `syncBuildTasks` scans the whole operations table.** `a2a/task-events.ts:125-145` joins on `workflow_operation.id::text`, which defeats the primary key. EXPLAIN ANALYZE at 200k rows showed a sequential scan taking 25.8 ms, run on every GetTask poll during a build and on every drain. *Fix:* compare as uuid, or store `workflow_run_id` as uuid.
- **L37. The purge bumps `updated_at` and walks every old row.** `a2a/task-store.ts:187-199`, `external-agents/delegation.ts:523-536`. Purged 30-day-old tasks jump to the top of ListTasks and look changed to clients syncing by `updated_at`. The purge indexes are not partial, so each hourly run walks every row ever purged. *Fix:* leave `updated_at` alone, and make the indexes partial.
- **L38. "Delete all A2A tasks" is incomplete and not atomic.** `privacy/index.ts:258-272`. It leaves the `params` and `summary` of actions proposed by inbound callers, which are derived from their messages. It is not one transaction, and an in-flight `save()` upsert can re-create a task just deleted. *Fix:* run it in one transaction, clear those actions' params, and make `save` update-only after the first insert.
- **L39. Text "enums" lack CHECK constraints.** `post_draft.access`, `agent_message.role`, `agent_action.origin`, `agent_delegation.state`, `channel_subscription.provider`, `notification.kind`, `publisher_account.tax_form_kind`, `twin_answer.outcome` and `comment_report.resolution` have none. *Fix:* add them, at least for `post_draft.access` and `agent_message.role`.

**Tests**

- **L40. Thin or vacuous tests.**
  - The v0.3 JSON-RPC server path that the cards advertise (`a2a/server.ts:291-300`) is never called by a test.
  - The paid-body test skips anonymous REST and anonymous `queryDocs` (`agent-p3.test.ts:347-350`).
  - The reserved-owner test expects only a generic `invalid_request` and has no control case (`channels-a2a.test.ts:502-524`).
  - The "credential never in a log" spy watches code that never logs (`agent-p4.test.ts:68-73, 725-728`).
  - The P4 test "an instruction-like reply does not change permissions" covers one exchange only; it does not cover a later turn whose history carries the reply.
  - Test fixtures (`workspace()`, `ownedAsset()`, the claim insert) are copied across four suites although `tests/fixtures/channels.ts` exists.
  - There is no evidence that the manual P1 exit criterion, an A2A Inspector run of the three cards with `SendMessage` and `GetTask`, was ever carried out: nothing in docs, commits or scripts.

**Code health**

- **L41. Duplicated helpers across the phases.**
  - Five `assertManager` copies (`assets/manage.ts:123`, `assets/materials.ts:66`, `channels/manage.ts:34`, `external-agents/registry.ts:137`, `privacy/index.ts:64`).
  - Four `ownedAsset` copies (`agent/actions.ts:325`, `assets/manage.ts:65`, `assets/materials.ts:43`, `channels/manage.ts:369`). The `materials.ts` copy omits the archived filter the others have.
  - Two `ownedChannel` copies.
  - Three `isUniqueViolation` copies.
  - The UUID regex is defined 22 times.
  - Two constants hold the same 30-day retention.
  - `DAY_MS` is defined in 13 files.
  - There are five USD formatters, which differ on negatives (`components/creator/format.ts:13`, `lib/domain/pricing-page.ts:60`, `lib/domain/plans.ts:374`, `app/dashboard/revenue/page.tsx:44`, `app/admin/(console)/list-params.ts:81`).
  - Two `readCapped` (`external-agents/transport.ts:84`, `connectors/http.ts:314`).
  - Two A2A part-to-text extractors (`a2a/executor.ts:89-106`, `external-agents/delegation.ts:339`).
  SSRF checking itself is shared, which is good.
- **L42. Dead exports and orphaned i18n keys.**
  - Unused exports: `setImageCaption` (no UI), `countPublicAssets` (its caller was the old `/libraries` page), `PAID_RIGHTS_STATEMENT`, `CREATABLE_ASSET_KINDS`, `isAssetKind`, `HANDLE_MIN_LENGTH`.
  - Orphaned i18n keys: about 15 in both dictionaries, mostly the visibility wording left behind when P1 removed `library.visibility` (`dashboard.newAsset.wizard.visibility*`, `dashboard.assetDetail.manage.metadata.visibility*`, `privateSkips`). A few added in this range are unused too: `channels.page.openAsset`, `creator.reading.inChannel`, and `creator.comments.notOpenPaid`, which may be meant for paid comments, so check before deleting.
  - The zh and en dictionaries have no key drift: both have 4206 leaves, and the type system enforces the shape.
- **L43. Stale docs.**
  - `architecture.md:1009, 1214` cite a non-existent `contracts/a2a`.
  - Proposal 13.2 item 5 still says the SDK is not installed; it is at 1.3.0, with the v0.3 compat module in use.
  - Proposal 12 still names `library_showcase` and `library_showcase_daily`.
  - Proposal 12 lists the showcase lead table under 删除, but `showcase_lead` is kept: rows were deleted in 0061, and the table stays behind the switch.

## 5. What is solid and well covered

- **Confirmation gate core.**
  - Only an `owner` actor confirms, and it is built only in `app/dashboard/actions/actions.ts` from the session, with the role re-read from the database and the workspace matched to the action.
  - Parameters are read from the row returned by the claiming `UPDATE … WHERE state = 'pending' AND params_digest = $d AND expires_at > now() RETURNING`, never from the client. Double clicks and concurrent confirm, reject, withdraw and expire have exactly one winner.
  - The 24 h expiry is enforced at confirm time, not only by cron.
  - No tool, REST route or A2A message shape can confirm; a follow-up message carrying `{confirm, digest}` is tested.
  - `delegate_task` is workbench-only and re-checks the endpoint, the credential id and version, and the header before anything is sent.
  - The tests for this go through the real planner and tool set, and include a concurrency test and a stale-digest test.
- **Visibility.**
  - One SQL predicate (`channels/visibility.ts`) is applied before recall on every retrieval path: `queryDocs` (its `readable` column), all four `resolveAsset` recall legs, `searchScope` for every scope, `find_channels` and channel profiles (free content only), media signing, the catalogue and anchors.
  - `channel_asset.asset_id` is the primary key, so an asset belongs to at most one channel.
  - A private or suspended channel 404s with no card, even for its owner.
  - Tests carry positive controls, so a broken feature would not pass as "secure".
- **A2A tenancy.**
  - Card URLs come from `APP_BASE_URL`, not the Host header.
  - The body tenant cannot override the path tenant.
  - Tasks and push configs are scoped by tenant and workspace on load, save and list, and the SDK loads the task through the scoped store before every push-config operation, follow-up and `referenceTaskIds` entry, so there is no cross-workspace task access by id.
  - Terminal states are never overwritten.
  - CancelTask on a build cancels only a still-queued operation.
  - The card shape per layer is complete and has no internal hosts or secrets.
- **Prompt boundaries.**
  - Every system prompt is a constant.
  - The workbench tool set is fixed before any external output is read.
  - `check_delegation` output is wrapped as `untrusted: true` and never becomes evidence.
  - A2A `skill`, `maxTokens` and `limit` are validated or clamped.
- **Shared answer tail.**
  - Every generation entry ends in `answerFromContext`: zero chunks means no model call, the sentence gate with `bind()` drops sentences whose citations do not map, and model failure falls back to a chunk list.
  - Only this turn's evidence is used.
  - Operation results are templated on the server.
  - REST `/v1` has no LLM dependency.
- **Metering.**
  - Anonymous callers reserve nothing.
  - `search_context` releases its reservation on an empty result.
  - `ask` holds 10 Calls under the workspace lock, with the 500-per-day cap counted in the same transaction, so concurrent asks cannot exceed it.
  - A degraded answer commits 1 Call. The twin costs 1 Call, requires a session and is outside the cap.
  - A2A protocol operations are free.
  - Reservations are released or committed on every error and on aborted streams, and abandoned ones are swept after 15 minutes.
- **Paddle and the ledger.**
  - The signature check is HMAC-SHA256 over the raw body with all `h1` values, `timingSafeEqual` and a ±300 s window.
  - `payment_event` is unique on `(provider, event_id)` and written in the same transaction as the projection. `earning_event` is unique on `(source, reference)`.
  - Out-of-order delivery converges by re-reading the transaction from the API.
  - The 80/20 split uses total minus tax, at the fee rate frozen on the immutable plan version.
  - The $5 minimum applies at plan creation and at checkout, monthly and yearly.
  - A negative balance blocks payout, redeem and new paid plans.
  - Payout needs a verified tax document and is serialised by row locks.
  - The storage tier is raised and never lowered.
- **Credentials.**
  - AES-256-GCM with a random 96-bit IV and an auth-tag check; the HKDF salt is `re0/agent-credential/v1`.
  - The sealed column is never selected for views.
  - The last-4 rule is followed.
  - Rotation bumps the version and deleting the agent cascades to its credential.
  - Header names and values are checked.
  - No plaintext reaches logs, audit rows, exports or server-action results.
- **Comments.** Rendered as plain text with `rel="nofollow ugc noopener noreferrer"` and http/https links only; a per-user rate limit of 5 per minute and 100 per day under an advisory lock; `scanContent` hides on a hit; paid comments are visible only to subscribers and the creator; author delete and account erase leave a placeholder.
- **Migrations and rename.**
  - 0062–0066 apply on PG16 and PG18, in autocommit and in one transaction.
  - No `librar*` object is left in the catalog, including the PG18 NOT NULL constraint names.
  - The anchor-leaf hash is unchanged: the old and new code produce the same `dd200720…2709`, pinned by `anchor-leaf.test.ts`.
  - 0066's JSON key rewrite is correct and leaves the same text inside string values alone.
  - `body_purge_at` is set on every insert path. The purge leaves ids and metering, and GetTask still works afterwards.
  - Every leftover `library` token is in the 3.5 allow-list.
  - The hot-path indexes exist.
- **Retired surfaces** sit behind `lib/domain/surfaces.ts`, apart from L27.

## 6. Open business items (proposal 13.2)

All four P3a preconditions are still open. Proposal 6.9 states that channel payments are not opened in production until they are met:

1. Creator tax documentation and filing duties (W-9 / W-8BEN, 1099). The code records only "documents collected" (`tax_form_status`, `tax_form_kind`) and claims no jurisdiction is satisfied.
2. Written legal or accounting opinion on reselling as merchant of record, holding funds and paying creators out, which changes requirement 2.3.
3. Written confirmation from Paddle that re0 may sell creator content subscriptions on its own account; the evidence is still to be attached to 6.9.
4. Paddle's fee basis (tax-inclusive total or subtotal). The $5 minimum is console-configurable, so the answer can be applied without a deploy.
5. The `@a2a-js/sdk` capability check is in fact done (1.3.0 installed, compat used), but the item is still listed as open (L43). The manual A2A Inspector run has no recorded evidence (L40).

Also noted: `PAID_RIGHTS_STATEMENT` is unused, because the rights confirmation is worded from i18n. Legal should review the i18n wording, since the domain constant is not what users see.

## 7. Operational items

- **Migrations not yet applied to the Neon dev branch:** 0063, 0064, 0065 and 0066. The dev branch is at 0062 (63 journal rows). After applying them, `select count(*), max(created_at) from drizzle.__drizzle_migrations` should return 67 and 1793800000000.
- **Production applies them in one transaction during the Vercel build** (`vercel.json` runs `npm run db:migrate` before `next build`).
  - A failure in any of the files rolls back all of them and fails the build.
  - Between the 0066 commit and the new deployment going live, the old deployment and any cron that fires query the renamed `library*` tables and return 500s. 0062's `DROP COLUMN visibility` has the same window. This is acceptable before launch; later renames should go expand-then-contract.
- **Preview builds also migrate.** Confirm that the Preview environment's `DATABASE_URL` / `DATABASE_URL_UNPOOLED` point at the Neon dev branch, not production.
- **Next migration:** its journal `when` must be greater than 1793800000000 (M18).
- **Environment variables:**
  - `PADDLE_CHANNEL_PRODUCT_ID` must be set for channel checkout and webhook routing.
  - `CRON_SECRET` is required by the new `/api/cron/retention` (hourly at `:17`); without it every call returns 401 and nothing is purged.
  - `CREDENTIAL_ENCRYPTION_KEY` is reused for agent credentials and push secrets; there is no new key. Rotating it makes stored push secrets unopenable, and those pushes then go out without auth (L6).
  - No other new variables.
- **Crons in `vercel.json`:** drain `*/10`, anchor `*/15`, retention `17 * * * *`.
- **Local verification:** `scripts/test-integration.sh` uses Docker, not Neon. A worktree needs a `node_modules` that contains `@a2a-js/sdk`; the main checkout's copy is stale.
