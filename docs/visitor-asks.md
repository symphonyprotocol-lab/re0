# Visitor asks on the share page

Decided 2026-11-24. A Ree's owner can let signed-out visitors ask the Ree on its share page `/s/[slug]`. The owner pays for the answers.

## Shape

- **Off by default.** It is switched on per Ree under 设置 → 分享页免登录提问. It works only while the Ree is public.
- **A visitor's question is a public post** with `source = 'visitor'` and no author. It shows as "一位访客 / A visitor". It names the Ree and goes through the normal content review. Once published it appears in the feed, on the Ree page and at `/p/[id]`.
- **Only that Ree answers.** It is never matched to other Rees and gets no AI general answer, because the owner would be paying for those.
- **The browser that asked follows its questions** under the box: in review, answering, answered (with the answer), no answer, or refused. The post stores an HMAC of the `re0_visitor` cookie, never the raw id.
- **Signed-in users** see the normal composer and pay for themselves. The visitor endpoint refuses them (`409 signed_in`).

## Who pays

- Each answer costs the owner the base fee (`QUERY_BASE_FEE`, 20). The query fee of one's own Ree is waived, the same as when the owner asks it.
- The fee is **held from the owner when the visitor asks**. If the balance cannot cover it, the question is refused with `owner_credits` and nothing is counted. The balance is never overdrawn.
- When processing starts, the hold moves onto the answer. It is settled when the Ree answers. It is given back when:
  - review refuses the question;
  - the Ree has no answer;
  - the Ree went private first;
  - the run died;
  - the post was taken down (by an administrator or by reports) after review but before the Ree took it up. The posts sweep releases it (`releaseHiddenVisitorHolds`). If the post is restored later, it settles with no answer and nobody pays.
- The owner's ledger shows the Ree's name and "分享页访客提问 / Share-page visitor question" (note `visitor answer`), as `query_hold` → `query_base` / `query_refund`.

## Limits (UTC day, `anonymousDay`)

Each question is counted in `anonymous_chat_quota`, the table reused from the old anonymous chat. It is counted under every key below, and the strictest key decides:

| Key | Limit |
| --- | --- |
| `va:<ree>:fp:<hmac>` (browser fingerprint) | the owner's per-visitor number, 1–50 (default 3) |
| `va:<ree>:id:<hmac>` (`re0_visitor` cookie) | same |
| `va:<ree>:ip:<hmac>` (client address, IPv6 by /64) | 3 × per-visitor; a request without an address is refused |
| `va:<ree>:all` | the owner's optional daily total, 1–1000 |
| `va:all` | platform ceiling `visitorAsksPerDay`, default 2000, editable in the console's limits page |

How counting works:
- Keys are taken in one transaction, together with the hold and the post. A conditional upsert takes them in sorted order, so concurrent requests can neither pass a limit nor deadlock.
- Every accepted question counts, answered or not. Nothing is given back, so refusals and refunds cannot be farmed. A question refused for the owner's balance is rolled back and not counted.
- An address may also send at most 5 questions a minute over all Rees (`rate_bucket`). This is taken after the Ree is checked, so asking a closed Ree costs nothing. The status GET the box polls is held to the signed-out browsing limit (`browse`).
- Raw fingerprint, cookie and address values are never stored. The keys are HMACs under a key derived from `AUTH_SECRET`, the same scheme the old anonymous chat used (8568b7ea / 87643c3b).

**Why the optional daily total:** the per-visitor limit does not bound spending. Many addresses × 3 visitors each is unbounded, so the total is the owner's own spending cap: total × 20 credits a day. The platform ceiling bounds the review and model load across all Rees.

## Code

- `lib/domain/visitor-ask.ts`: limits, settings parsing, view types.
- `lib/services/visitor-asks.ts`: asking, quota, status.
- `lib/services/posts.ts`: the payer for visitor posts, matching to the one Ree, moving the hold, releasing it in `rejectPost` / `finishPost`, the ledger note.
- `app/api/share/[slug]/ask/route.ts`: GET status (fingerprint in the `x-re0-fp` header) and POST ask.
- `components/posts/visitor-ask.tsx`, `lib/client/fingerprint.ts` (restored from e8c895c8^).
- `components/rees/visitor-ask-fields.tsx`, inside the Ree settings form (`visitorAskSettings` on `PATCH /api/rees/[id]`).
- Migration `0086_visitor_asks.sql`.
