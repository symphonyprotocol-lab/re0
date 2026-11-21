# Earned credits: never spent, converted, or paying for a purchase

Earned credits (`credit_grant.source = 'earned'`) are query-fee income and invitation rewards within the withdrawable quota. Until 2026-11 they were the last bucket of the spend order, so using the product quietly spent them (an inviter's 5,000 withdrawable reward could be gone before they ever saw it). Now they are never spent by using the product. They leave only three ways:

| Way | What it takes | What it gives | Ledger |
| --- | --- | --- | --- |
| Payout (unchanged) | matured, paid-for earned credits | PayPal transfer | `payout_hold` / `payout_paid` / `payout_release` |
| Conversion | any earned credits not held | Pack credits at `convert_rate_bp` / 10,000, rounded down | `earned_convert` (out), `earned_converted` (in) |
| Deduction | what a payout could draw on: paid for and matured | up to all of a Plan or Pack's price, `deduct_credits_per_cent` per US cent | `deduction_hold` / `deduction_paid` / `deduction_release`, `deduction_return` |

## Spending

`SPENDABLE_SOURCES = ['plan', 'welcome', 'pack']` is the default of `spendOrder`, `availableOf` and `allocate`, so every hold, settlement top-up, `takeOrOwe`, balance check and the sidebar balance leave earned credits out. Callers that mean earned credits name them: a payout (`sources: ['earned'], withdrawableOnly`), a conversion, a deduction (`deductibleOnly`, which is the same test as `withdrawableOnly`).

Debts (review S3; shown apart on the balance page and the console's user detail, `debtsOf`): a usage debt -- storage, a knowledge run's overrun, a late supplier bill, all written by `takeOrOwe` without a purchase -- is paid only by spendable grants as they arrive; earned credits pay only refund and chargeback debts (`credit_debt.purchase_id` set). Only those hold back a payout (`payouts.openDebt`). A refund's take-back (`takeBack`) still walks every source, earned last: it recovers money, it does not use the product. Holds placed before this change keep their allocations and are released or settled as before.

Within earned credits the order is: never withdrawable (paid with free credits) first, then the latest to mature, so what is withdrawable now stays longest.

## Settings

`earned_settings` (one row; none means `EARNED_DEFAULTS`), edited on the console's pricing page and audited (`earned.settings.update`), saved against a revision like the payout minimum:

- `convert_enabled`, `convert_rate_bp` (10,000 = 1:1), `convert_min_credits` (100)
- `deduct_enabled`, `deduct_credits_per_cent` (100, so 1 credit = USD 0.0001, the terms' face value), `deduct_max_percent` (100), `deduct_min_charge_minor` (100: what is left for Paddle is 0 or at least USD 1.00)

## Conversion

`POST /api/billing/earned/convert {credits, rateBp}`. Under `pg_advisory_xact_lock('earned:<user>')` (shared with checkout), with the grants locked: refuse if disabled, below the minimum, the rate is not the one the dialog showed (`rate_changed`) or the unheld earned credits do not cover it. One `earned_convert` entry takes the credits; Pack grants (`earned_converted`) arrive, one per origin: what was converted from paid-for earnings carries `converted_paid = true` and keeps their `funding_purchase_id` and `invite_funded`, so `paidShare` and the payout funding review treat it like the earnings it came from (the query fees it pays reach owners as withdrawable earnings, traced to the same purchase or invitation); what came from earnings paid with free credits is free. Each paid part is rounded down on its own, the free part takes the rest of the rounded total. Pack credits converted from earnings still maturing carry `void_until` (the earnings' payout date): until then a refund of their funding purchase may void them like the earnings themselves (`voidFundedEarned`, review S2). Free conversions are marked `converted`, so the payout funding review files what they pay as free earnings. Not undoable. A new grant pays any open debt first, as every grant does; the result's `offset` says how much, and the success message names it.

## Deduction

Only matured, paid-for earnings (exactly what a payout could draw on) may pay. Earnings still maturing could yet be voided by a refund of the purchase that paid them; letting them buy a Plan or Pack would turn them into fresh paid credits no refund could reach (review B1). They can still be converted (below).

`POST /api/billing/checkout` takes `earnedMinor` (US cents off the order, after any promotion, before tax), `deductCreditsPerCent` (the rate the page showed: a different current rate is refused, `rate_changed`) and `requestId` (a UUID per order as shown). `planDeduction` checks the switch, the cap, the minimum left to pay and the deductible balance.

- **Part of the price**: a `deduction` hold is placed under a fresh purchase id; the Paddle transaction gets one non-recurring `flat` discount (promotion + earned) and `custom_data.re0_earned_minor`; the `paddle_checkout` row records the hold and the amounts. The webhook (`creditTransaction`) accepts the payment less `earned_minor`, writes the purchase under the hold's id and pays the hold. If the hold was released meanwhile it is placed and paid again, or what is gone becomes a debt.
- **All of it**: no Paddle. The hold is placed and paid at once, the purchase is written with no transaction id (`amount_minor = 0`) and the request's `request_id` (unique per user: the same request again returns this purchase, review S4; the same id with a different order is refused, `request_mismatch`), the grant follows. A Plan paid this way is one month from now that does not renew; `redeemedPlansOf` reads it like a redeemed Plan, so it unlocks Packs and holds off a subscription until it ends.
- **One at a time**: opening a checkout with earned credits cancels (in Paddle, first) and supersedes the user's other open checkouts that hold some, releasing their holds. The rate the page showed is checked before anything else, so a reused checkout cannot keep an old rate either: a Plan checkout is reused only when its price, its cents off and the credits held for them at today's rate are all the same (review round 2). The every-minute `plan-redemptions` cron (and the daily `expire-plan` one) cancels checkouts still unpaid after an hour (`EARNED_CHECKOUT_HOLD_MS`, the same hour a Plan checkout is reused for) and releases their holds; the checkout page counts what the user's own unpaid checkouts hold as available (a new checkout frees it first) and the balance page shows it as 付款占用中; the sweep goes oldest first. A cancellation Paddle refuses leaves the checkout and its hold as they are (it may still be paid): the failure is counted on the row (`release_attempts`, `release_tried_at`, `release_error`, migration 0077), the sweep tries it again after 2, 4, 8 ... minutes up to an hour, so stuck ones never starve the rest, and Paddle's status is read -- `paid` or `completed` means its webhook was lost and logs an `ALERT` for someone to replay or credit it. A new checkout never waits on a stuck one: it leaves that hold alone and holds other credits, so no credit is held twice. Each cron job runs on its own, so one failing never stops the other. The balance page says such holds are *usually* released within an hour. A superseded checkout that is paid anyway is refused as before.
- **Renewals** are charged in full (the discount does not recur).

## Refunds and chargebacks

The refunded share is `adjustment / amount_minor` (cash paid). The credits come back as before; `returnedEarned` gives back the same share of `earned_credits` (`deduction_return`) to the grants the hold took them from, last first, keeping their payout dates; what those grants cannot take comes back as a new earned grant maturing in 30 days. If the refund left a debt, the returned earned credits pay it first (`debt_offset`, then `restoreVoidedEarned`). `purchase.earned_returned` keeps the running total. A won chargeback (`chargeback_reverse`) takes the same share back again (`deduction_paid`): from the grants the deduction took, then from withdrawable earned credits, owing (a refund-type debt) what is no longer there; never from earnings that cannot be withdrawn (review S1). What the original grants can no longer take back on a refund comes back as a new grant with the first one's payout date and origin. A purchase paid entirely with earned credits has no Paddle transaction and no self-service refund.

## History

Nothing is rewritten. Earned credits already spent under the old order stay spent; what is left stops being spent from this release on.
