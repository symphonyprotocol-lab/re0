# Rebuild step 6: notes for the next steps

Step 6 of `rebuild-proposal.md` §8.4, "提现（人工）". Branch `claude/rebuild-step6-payout-kyc-66956d`, PR into `rebuild`.

## What exists now

- **Migration `0007_payout_kyc`** (journal idx 7, `when` 1793620000000): `kyc_record` and `payout`. `user.paypal_email` / `paypal_email_changed_at` already existed (step 1); `credit_hold.kind` already allowed `payout`; the ledger reasons `payout_hold` / `payout_release` / `payout_paid` and the notice kinds `kyc` / `payout` already existed, so nothing else changed.
- **Rules** (`lib/domain/`): `kyc.ts` (the form's limits, who may submit, `approvalBlocker`, `filesDueAt` for retention, `kycPathname`), `payouts.ts` (PayPal address normalisation ported from the old `lib/domain/payout.ts`, the seven-day hold, `payoutStage` — where a user stands, in the prototype's order —, request amount, paid amount and fee, the status machine). `admin-lists.ts` gained `kycView`, `payoutQueueView`, `payoutHistoryView`.
- **Use cases** (`lib/services/`): `kyc.ts` (overview, upload ticket, submit, console list / detail / history, signed links, approve / reject, re-verification, purge), `payouts.ts` (overview, PayPal address, request, console lists / detail, approve / reject, payment, failure). `credits.ts` gained the `payout` entry in `REASONS` and an optional `sources` filter on `placeHold` (a payout holds earned grants only).
- **Blob** (`lib/infra/blob-access.ts`): `blobInfo` (head), `signedReadUrl` (presigned GET: `issueSignedToken` + `presignUrl`, `useCache: false`), `listByPrefix`, `deleteBlobs`. Verified against the real store: a link answers 200 inside its window and 403 after; the bare URL is 403.
- **Pages**: `/settings/identity`, the 收款卡 and payout history at the bottom of `/settings?tab=billing` (`#payouts`), the dashboard's 收入与提现 guide; console `/admin/kyc` (+ `[id]`), `/admin/payouts` (+ `[id]`, `[id]/payment`), `/admin/payout-history`; the user page's KYC and payouts tabs; the users list's KYC column and filter; nav entries with badges; the overview's two to-do rows.
- **Routes**: `GET/POST /api/billing/kyc`, `POST /api/billing/kyc/upload`, `PUT /api/billing/paypal`, `GET/POST /api/billing/payouts`; `GET /api/admin/kyc` (+ `format=csv`), `GET /api/admin/kyc/[id]`, `POST …/files|approve|reject|reset`; `GET /api/admin/payouts` (queue), `GET /api/admin/payouts/history` (+ `format=csv`), `GET /api/admin/payouts/[id]`, `POST …/approve|reject|paid|failed`; `GET /api/cron/purge-kyc-files` (daily 03:45 UTC in `vercel.json`, `CRON_SECRET`).

## How it works

- **State of a user's identity** is their newest `kyc_record`: none, `pending` (read-only, no PayPal, no new upload), `verified`, `rejected` or `reset` (both may submit again, prefilled except the images). Approval needs the newest record still pending, the reviewer's 已比对 tick, an unexpired document (UTC+8 day), the declaration and both images. Rejection needs 3–300 characters.
- **Re-verification** ("要求重新验证") takes the same per-user advisory lock as submission (`kyc:<user>`), and works on the user's newest record when it is verified or rejected: it stamps `reset_at` on it and inserts a `reset` row carrying the reason (and a copy of the identity fields for the list); a pending submission is decided instead (`kyc_pending`). Payout approval and payment then refuse (`kyc_required`) until the user is verified again; rejection and failure stay possible.
- **Images**: the browser asks `/api/billing/kyc/upload` for a client token scoped to `kyc/<user>/<uuid>.<ext>`, JPG / PNG / WebP, 10 MB, then `put`s straight to private Blob (`lib/client/kyc-upload.ts`). Submission checks each pathname belongs to the user, exists, is an allowed type within 10 MB and is used by no other record.
- **Signed links**: `POST /api/admin/kyc/[id]/files` issues two 60-second presigned URLs and writes one `kyc.files.view` audit row per file (`after: { file, user, expiresAt }`). The review page fetches them on arrival (once, guarded against React's double effect), counts down, drops both images at expiry and offers 重新获取预览.
- **Purge**: due records in batches of 200 (one Blob delete and one update per batch) until done or 4 minutes pass, then one pass over uploads. Records 30 days past approval, rejection or `reset_at` lose `document_blob` / `selfie_blob` (Blob first, then the row; `files_deleted_at` set; every other field kept). Then orphans: blobs under `kyc/` older than 24 hours, named by no record, **and owned by a user of this database** — a Blob store may serve several environments, so another environment's uploads are never touched.
- **Ledger**: a request is `placeHold(kind 'payout', sources ['earned'])` → `payout_hold` (−credits). Rejection and failure `releaseHold` → `payout_release` (+credits) once; approval touches nothing; payment `settleHold` at the full amount → `payout_paid` with delta 0 and the note `PayPal <id> · paid $55.00 · fee $5.00 · charged 600000 of 600000`. `payout.paid_cents` is what arrived; `fee_credits = credits − paid_cents × 100` (exact for any request). The billing tab's 收入 filter now includes the three payout reasons.
- **One open payout per user**: a per-user advisory lock plus the partial unique index `payout_open_key` (`status in ('pending','approved')`). Step 5's `hasOpenPayout()` reads exactly that, so "no official role while a payout is open" works unchanged (tested).
- **PayPal address**: only with verified identity, ≤ 254, stored lower-case. The first address starts no wait; a change sets `paypal_email_changed_at` and payouts wait seven days. A request snapshots the address; the payout page warns when the user's current address differs.

## Things a later step will want to know

- **Shared files touched** (step 7 merges second or first, either way): `db/schema.ts` (appended), `lib/constants.ts` (appended), `i18n/index.ts` (a `step6` spread), `i18n/pages/console.ts` (three nav labels), `vercel.json` (one cron appended), `lib/services/credits.ts` (`REASONS` gained `payout`; `HoldInput.kind` gained `'payout'` and an optional `sources`) — if step 7 adds `video` to the same union and map, both lines need keeping. `scripts/test-integration.sh` reads `PG_CONTAINER`, `PG_PORT`, `WS_PORT` from the environment (defaults unchanged).
- **Not touched**: `lib/infra/blob.ts`, `lib/client/upload.ts`, `app/api/upload-token` (KYC has its own ticket route and client helper, so a video upload purpose can be added there without conflict).
- Admin user detail `backTo` now also accepts `/admin/kyc`, `/admin/payouts`, `/admin/payout-history`.
- Step 5's now-unused dashboard strings (`statistics.dashboard.income.threshold*` / `identity*`) were removed; the guide's copy lives in `i18n/pages/payouts.ts` (`guide`).

## Gotchas found

- `pkill -f wsproxy.mjs` would also stop another session's proxy; stop fixtures by the PID listening on your port (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`).
- In the browser pane, a click sent right after `navigate` can land before hydration and do nothing; wait or click through `find` refs.
- `fetch(...).text()` strips the CSV's BOM (TextDecoder does), so check the BOM with curl, not in the page.
- The walkthrough ran on `re0_step6` in `re0-dev-pg` behind `tests/fixtures/wsproxy.mjs` on 5472, fake model on 5473, `next dev -H 127.0.0.1 -p 3600`, real Vercel Blob. Earned credits were seeded with SQL (one `earned` grant plus its `query_fee_earned` entry) instead of 60 paid questions.

## Left for later

- **财务图表** (充值 / 提现 by day / week / month / custom, amount / count) is not built; §8.2 lets it slip. The prototype's `admin-finance.js` plus step 5's statistics calendar (`lib/domain/statistics.ts`) are the parts to reuse.
- No PayPal API at all (by design). When a Business account exists, "标记已打款" becomes a Payouts API call plus a webhook writing the same `payout` columns.
- The orphan purge reads at most 10,000 listed blobs per run and deletes at most 200; a store with far more `kyc/` objects would need several runs.
- Legal copy (`i18n/pages/legal.ts`) was not changed; it already promises what this step does.
