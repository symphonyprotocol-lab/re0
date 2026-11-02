# Rebuild step 3: notes for the next steps

Step 3 of `rebuild-proposal.md` §8.4, "充值与计费闭环". Branch `claude/rebuild-step3-billing-23425e`, PR into `rebuild`.

## What exists now

- **Tables** (`db/migrations/0003_billing.sql`, `0004_checkout_reuse.sql`): `purchase` (one paid Paddle transaction; unique `paddle_transaction_id`; `quantity` 1–10; `reversed_credits` and `adjustment_ids` for refunds), `subscription` (mirrored from Paddle; `cancel_at_period_end`, current period, `paddle_updated_at` so an older event never overwrites a newer one), and two of my own: `billing_event` (every accepted notification by Paddle `event_id`, written in the same transaction as its effects) `credit_debt` (what a refund could not take back), and `paddle_checkout` (0004: every checkout transaction, so a Plan checkout opened in the last hour is reopened rather than created again). 0004 also relaxes `purchase.quantity` to `>= 1`: 1–10 is the checkout's rule, a payment is recorded as Paddle took it. `credit_grant` gained `period_start` and `purchase_id` (unique: one grant per purchase), a check that only Plan grants expire, and the ledger reasons `chargeback` and `debt_offset`.
- **Rules** in `lib/domain/billing.ts`: `parseOrder` (Pack 1–10), `planIsActive` (status `active` and inside the period, cancelled renewal included), `planUsage` (the sidebar meter; red at ≥ 90% on the exact ratio), `reversalCredits` (refunded share of the purchase's credits), `takeBack` (own grant first, then spending order; the rest is the shortfall), `offsetDebts`, and the ledger's activity filter (`ACTIVITY_REASONS`).
- **Use cases** in `lib/services/billing.ts`: `startCheckout`, `checkoutState`, `receivePaddleWebhook` / `applyPaddleEvent`, `setRenewal`, `expireDuePlans`, `billingSummary`, `shellBilling`, `listEntries`. Ledger additions in `lib/services/credits.ts`: `addGrant` (every new grant pays open debts first; **use it for step 4's earned credits and step 5's admin adjustments**), `expirePlanGrants`.
- **Paddle** in `lib/infra/paddle.ts`: config (all-or-nothing), signature check (`ts=…;h1=…`, every `h1`, 5 minutes), `checkoutTransactionBody` (catalogue price + `custom_data.re0_user_id`), cancel at period end, resume. Webhooks are applied from the event payload itself; Paddle's API is not re-read.
- **Pages**: `/`, `/pricing`, `/checkout`, `/legal/terms`, `/legal/privacy` in `app/(site)/` with `components/site/*`; `/settings?tab=billing` in `components/billing/*`; the sidebar meter `PlanMeter` in `components/shell/app-shell.tsx`; `/billing` is a route handler answering 302.

## How the money moves

- Checkout creates a Paddle transaction server side (`POST /api/billing/checkout`) and the page opens Paddle.js's overlay on it. Credits are written only when Paddle says the money arrived. A per-user advisory lock serialises checkout; a Plan is refused while any subscription is `active` or `expired` (Paddle `past_due`/`paused`, which Paddle may still collect), and an open Plan checkout from the last hour is reused.
- Settlement entries' notes end in `charged X of Y` (`settlementNote` / `chargedFromNote` in `lib/domain/credits.ts`); the ledger's 「实收 N」 reads it back.
- A paid transaction whose total is missing records the list price (never 0, which would make every refund full); a Pack quantity above 10 is credited as paid with a warning.
- `transaction.paid` or `transaction.completed` (whichever comes first) creates the purchase and the grant. A Plan payment's grant expires at the transaction's `billing_period.ends_at`; before granting it, Plan grants whose period ended are written off (`expire` entries) -- this is "以 Paddle 续费 webhook 为准". If the payment beats the subscription event, a provisional `subscription` row is written so Packs unlock at once.
- `subscription.*` mirrors status (`active`/`trialing` → active, `canceled` → cancelled, `past_due`/`paused` → expired) and `scheduled_change.action = cancel` → `cancel_at_period_end`.
- `adjustment.created/updated` with `status = approved` and action `refund` or `chargeback` takes credits back; `pending_approval`, `credit`, `chargeback_warning` and `chargeback_reverse` are ignored.
- `/api/cron/expire-plan` (daily, `vercel.json`) only writes the `expire` entries for periods that ended without a renewal; an ended period is already unspendable and outside the balance because `usable()` checks `expires_at`.
- Credits released from a hold after its Plan grant expired go back into the expired grant and are written off on the next expiry run. That is intended: they were that period's credits.

## Things a later step will want to know

- **Step 4 (query fees)**: credit the owner with `addGrant(tx, { source: 'earned', reason: 'query_fee_earned', … })` so debts are honoured; the "收入" tab already filters `query_fee_earned`.
- **Step 5 (admin)**: `/admin/purchases` reads `purchase` and `subscription`; `billing_event.payload` holds every raw notification for the "webhook 冲回结果" view. Manual credit adjustments should also go through `addGrant` (positive) or a hold-free deduction that never goes below zero.
- **Step 6 (KYC)**: the privacy policy now promises: images in private Blob, 60-second signed links, every view audited, originals deleted 30 days after approval, **and within 30 days of a rejection or reset** (my addition, for data minimisation; `purge-kyc-files` must cover those too), metadata kept for the account's life plus the legal retention period. Tax: W-9 / W-8BEN type plus declaration time.
- Pages under `app/(site)` use `SiteShell`; the header's nav has only 首页 and 价格与购买. Step 4 should add 发现 Ree (`/explore`) to `links` in `components/site/site-shell.tsx` and point the home page's example Rees at real public ones.
- Paddle's overlay lets the buyer change the Pack quantity within the price's 1–10 limits; the webhook credits whatever quantity was paid.

## Local walkthrough

- Paddle cannot reach `localhost`, and in this session a cloudflared tunnel was refused by the auto-mode classifier ("External Ingress Tunnel"). What worked instead: Paddle.js's sandbox overlay **does** open on `http://localhost:3300` (only a report-only CSP warning), so a real sandbox payment with Paddle's test card completes locally; then `npm run paddle:replay -- --since=<ISO> --target=http://localhost:3300` fetches the real events from the sandbox API and posts them signed with `PADDLE_WEBHOOK_SECRET`.
- The walkthrough ran on the local Docker Postgres `re0-dev-pg` (5441, left running) behind `tests/fixtures/wsproxy.mjs` (5442), with the fake model endpoint on 5443, signed in through `POST /api/auth/e2e`.
- Sandbox state left behind: subscription `sub_01m6desm2bw7yek0a00mdswxzs` (renewal on, period ends 2026-12-02; it will "renew" in the sandbox), Pack transaction `txn_01m6dewhcdjmrskh3xw9kf06mf` fully refunded (`adj_01m6df395t7kj6wdsc81yjk71q`).
- **Neon dev branch**: `0003_billing` and `0004_checkout_reuse` applied (four rows in `drizzle.__drizzle_migrations`).
- `npm run paddle:replay` follows Paddle's pagination back to `--since` (or until every `--ids` is found).

## Paddle and Vercel configuration

- Sandbox catalogue created for the rebuild: Plan product `pro_01m6dd90d8d4vxss3t6cmq5v0m` / price `pri_01m6dd91ke3f0e9erqcg51axqy` (USD 10 monthly, quantity 1–1); Pack product `pro_01m6dd90yt2p69zh7vcs50ff22` / price `pri_01m6dd9257tyggjwkyt322dan2` (USD 10, quantity 1–10). Both ids are in `.env.local` (worktree and main checkout) as `PADDLE_PLAN_PRICE_ID` / `PADDLE_PACK_PRICE_ID`.
- The old products ("Pro", "Additional Calls") are untouched and unused; events for them are answered `ignored`.
- For a deployed environment: set `PADDLE_PLAN_PRICE_ID` and `PADDLE_PACK_PRICE_ID` in Vercel (Preview with the sandbox ids above; Production with ids from a live catalogue created the same way), and point a Paddle notification destination at `https://<host>/api/billing/paddle` subscribed to `transaction.paid`, `transaction.completed`, `subscription.*`, `adjustment.created`, `adjustment.updated`; its secret is `PADDLE_WEBHOOK_SECRET` for that environment. Approve the host as a checkout domain and set the default payment link to `https://<host>/checkout`.
- The existing sandbox notification destination `ntfset_01m4qktpb481n42809k0yy4xk4` still points at an expired quick tunnel; I did not change it.

## Left for later

- Chargeback reversals (`chargeback_reverse`) are ignored: the credits stay taken back. Restoring them needs a decision on whether to re-grant or to reduce the debt first.
- A refund of an old Plan period takes back the refunded share even if part of that period's credits had already expired unused.
- No customer portal link (payment method update, invoices); Paddle emails the buyer. `paddle_customer_id` is stored for when it is added.
- Real tunnel-delivered webhooks were not exercised; the delivery path is covered by signed replays of genuine sandbox events and by tests.
