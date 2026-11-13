# Invitations and starter tasks

Signup invitations with a site-wide quota of withdrawable rewards, one-time rewards for a new account's first steps, and daily check-ins. Every number is set on the console's 邀请与任务 page (`/admin/invites`).

## Rewards

| What | Default | Bucket | Withdrawable | Ledger reason |
| --- | --- | --- | --- | --- |
| Registering | `signup_reward` (unchanged, `/admin/pricing`) | welcome | no | `welcome` |
| First Ree published | 2,500 | welcome | no | `task_first_ree` |
| First question to a Ree (signed in) | 1,000 | welcome | no | `task_first_question` |
| First comment on a Ree | 1,000 | welcome | no | `task_first_comment` |
| Inviting someone who registers, within the site quota and the inviter's cap (20) | 5,000, to the inviter | earned, `withdrawable_at` = now, no `funding_purchase_id`, no `ree_id` | yes, through every payout gate | `invite_reward` |
| The same, past either limit | the same amount | welcome | no | `invite_reward_gift` |
| Daily check-in (first 3 months, up to 30 days) | 1,500 per day | welcome | no | `check_in` |

An amount of 0 turns that reward off. Amounts are read inside the transaction that pays them.

## Invite codes and attribution

- `invite_code`: one code per account (8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`). Created in the registration transaction; accounts older than invitations get theirs on first read (`ensureInviteCode`, race-safe through `ON CONFLICT DO NOTHING` and a re-read).
- The link is `/login?invite=CODE`. The login form posts the code to `/api/auth/[provider]/start`; it travels in the sealed OAuth handshake and reaches `createSession`, which applies it only when it creates a new user row, in the same transaction as `grantWelcome`.
- `invitation` (primary key `invitee_id`): inviter, code, the credits paid and whether they were withdrawable. Written by `attributeInvitation` under `pg_advisory_xact_lock(hashtext('invitations:quota'))`, after counting the withdrawable rows.
- The quota (`withdrawable_invites`, default 1,000) is the site-wide number of invited registrations whose reward is withdrawable. It never closes invitations: every invited registration is attributed and paid; the first N pay withdrawable earned credits, later ones the same amount as gift credits. Lowering N below the count only makes later rewards gift credits; raising it converts nothing already paid. An invite reward of 0 attributes, pays nothing and uses no place.
- Per-inviter cap (`withdrawable_invites_per_inviter`, default 20): an invitation pays withdrawable credits only while the site quota has a place **and** the inviter has had fewer withdrawable rewards than the cap. Otherwise it pays the same amount as gift credits (`invite_reward_gift`), and `invitation.gift_reason` records `site_quota` or `inviter_cap`; the site quota is named when both are reached. An inviter-capped invitation uses no site-wide place. Both counts are taken under the same `invitations:quota` lock. Lowering the cap affects later invitations only; raising it converts nothing; 0 makes every invitation reward gift credits.
- Not attributed (registration still succeeds): unknown or malformed code, a disabled inviter, invitations switched off. The login page names the inviter; the invite tab says when invitations are off or the withdrawable places are used up.

## Public copy

The terms (§7) and the pricing FAQ state the invitation rule with the console's current numbers (`lib/services/public-copy.ts`): the withdrawable quota and the per-inviter limit, or, when either is 0 (or the reward is 0), that invitation rewards are gift credits only. The invite tab's notes come from one function (`invitePanelCopy`), so a limit of 0 never reads as "first 0 are withdrawable" or "your limit of 0 is reached".

## Payouts

A withdrawable invite reward has no maturity wait, and no other exemption: `requestPayout` sees it through `withdrawable()` like any matured earned grant, so the minimum (`PAYOUT_MIN_CREDITS`, 500,000), KYC, a PayPal address and its change hold, one open payout, no open debt and an active account all apply. There is no separate payout path.

## Payout minimum

- Site-wide: `payout_settings` (singleton, revision check, `settings:payout_minimum` lock, audit `payout.minimum.update`), default `PAYOUT_MIN_CREDITS` (500,000). Set on the console's payout review page (`/admin/payouts`, "提现规则").
- Per account: `user.payout_min_credits`, null for the site-wide value; set or cleared on the console's user page (summary tab), audited as `user.payout_min_credits` before/after (`user.payout_minimum`). It may be lower or higher than the site-wide value.
- Both bounded 1 to 100,000,000 credits. The effective minimum (own, else site-wide) is read inside `requestPayout`'s transaction and drives `payoutStage`, `parsePayoutCredits` and every user-facing figure. Approval does not re-check it, so a request already made is never judged again after a change. Every other gate is unchanged, and an own minimum exempts from none of them.
- The terms (§7) and the pricing FAQ render the current site-wide value and say an account may have its own.

## Daily check-ins

- `check_in` (unique `user_id, day`): one row per account and calendar day, the day computed on the server in `CHECK_IN_TIME_ZONE` (Asia/Singapore, UTC+8). `checkIn` takes `pg_advisory_xact_lock(hashtext('check-in:<user>'))`, counts, inserts and grants in one transaction, so a double click or a race pays once and the maximum holds.
- Open for `check_in_window_months` (default 3) calendar months from the account's creation, up to `check_in_max_days` (default 30) check-ins, days need not be consecutive. Accounts older than the window cannot check in; younger ones use what is left. Changing the settings leaves paid check-ins alone.
- The task guide shows today's state, progress, the reward and the window's end; it stays while check-ins are left. After dismissal, the check-in line alone stays on the Rees page while one is available today.

## Tasks

- `task_reward` (primary key `user_id, task`): one row per paid task. `grantTaskReward` inserts with `ON CONFLICT DO NOTHING` and adds the grant only when the row was inserted, inside the action's transaction: `setReePublished` (the transition to published), `holdQuestion` (after the holds; anonymous chat does not use it), `addReeComment` (only when the comment row is new, so a retried request pays nothing).
- Tasks count from release, for every account: earlier actions are not paid, the next qualifying one is. Deleting what earned a reward keeps the reward and does not pay again. With an amount of 0 no row is written, so the task stays open for when it is switched back on.
- The guide on `/rees` lists registering plus each task that is on or already paid, and the invite line while invitations are open. It hides once dismissed (`user.task_guide_dismissed_at`) or once everything shown is done.

## Where earned invite credits are read

- Payouts (`withdrawable`, payout hold `sources: ['earned'], withdrawableOnly: true`): drawn like any matured earned grant.
- Refund and chargeback voids and restores key on `funding_purchase_id`; invite grants have none, so they are never voided.
- Per-Ree statistics key on `credit_entry.ree_id`; invite entries have none, so they are not Ree income.
- `credit_grant.invite_funded` marks a withdrawable invitation reward, and `paidShare`/`creditQueryFee` carry the mark to the owner's earned grant whenever a query fee is paid with such credits, over any number of hops. Withdrawability is unchanged: those earnings mature like any paid-for earnings.
- Payout funding review: `sources.invite` counts query fees paid with invite-funded credits (no longer under `paid`), `drawnInvite` is what a payout draws on invite-funded grants (rewards themselves and earnings from them), and the `invite_funded` flag is raised at `PAYOUT_REVIEW_SIGNALS.inviteFundedShare` (30%). The review also shows the applicant's number of invited registrations.
- `invitation` foreign keys do not cascade, as with the ledger: an invited account cannot be deleted from under a paid reward and its quota place.
