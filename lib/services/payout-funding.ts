/**
 * Where a payout's money came from (review H2), read from the ledger for the
 * review page and the queue. Read-only; it never decides a payout.
 *
 * The path, per payout and bounded by it: the payout's hold names the earned
 * grants it draws on; each was credited by a `query_fee_earned` entry of the
 * owner written in the same instant (found through the owner's
 * `(user_id, created_at)` index), whose `ref_id` is the reply; the reply's
 * `request_id` is the question, whose conversation names the asker; the
 * asker's `query_fee_paid` entries for that question and Ree name the grants
 * the fee was paid from, and so what it was paid from. Nothing scans the
 * whole ledger.
 *
 * Earned credits with no such entry (granted in the console) and questions
 * whose conversation was since deleted (their messages go with it) cannot
 * be traced; they count in `drawn` but not in `traced`.
 */
import { sql } from 'drizzle-orm';
import { PAYOUT_MATURITY_DATES, PAYOUT_PAYERS_PAGE_SIZE, QUERY_FEE } from '@/lib/constants';
import { summarizeFunding, type FundingFlag, type FundingPayer, type FundingPayerRow, type FundingSources, type PayoutFundingSummary } from '@/lib/domain/payout-funding';
import { clampPage, isUuid } from '@/lib/domain/list';
import { db } from '@/lib/infra/db';
import { assertConsole, type Administrator } from '@/lib/services/admin';
import { grantsOf } from '@/lib/services/credits';

interface Raw {
  payout_id: string;
  drawn: string | number;
  drawn_refunded: string | number;
  sources: Record<keyof FundingSources, string | number> | null;
  payers: {
    user_id: string;
    name: string;
    email: string;
    paypal_email: string | null;
    created_at: string;
    disabled: boolean;
    credits: string | number;
    questions: string | number;
    max_fee_questions: string | number;
    first_asked_at: string;
    active_elsewhere: boolean;
  }[];
  owner_email: string;
  owner_paypal: string | null;
  payout_paypal: string;
}

const EMPTY_SOURCES: FundingSources = { paid: 0, welcome: 0, redeemed: 0, console: 0, earnedFree: 0, refunded: 0 };

async function fundingOf(ids: readonly string[]): Promise<Map<string, PayoutFundingSummary>> {
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return new Map();
  const list = sql.join(
    valid.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db().execute(sql`
    with drawn as (
      select p.id as payout_id, p.user_id as owner_id, (a->>'grantId')::uuid as grant_id, sum((a->>'amount')::bigint) as drawn
      from payout p
      join credit_hold h on h.id = p.hold_id
      cross join lateral jsonb_array_elements(h.allocations) a
      where p.id in (${list})
      group by 1, 2, 3
    ), linked as (
      select d.payout_id, d.owner_id, d.drawn,
        coalesce(pf.status <> 'paid' or pf.reversed_credits > 0, false) as refunded,
        (select e.ref_id from credit_entry e
          where e.user_id = d.owner_id and e.created_at = g.created_at and e.reason = 'query_fee_earned'
            and e.allocations @> jsonb_build_array(jsonb_build_object('grantId', d.grant_id::text))
          limit 1) as reply_id
      from drawn d
      join credit_grant g on g.id = d.grant_id
      left join purchase pf on pf.id = g.funding_purchase_id
    ), replies as (
      select l.payout_id, l.owner_id, l.reply_id, sum(l.drawn) as drawn, m.request_id, m.ree_id, c.user_id as asker_id, q.created_at as asked_at
      from linked l
      join message m on m.id = l.reply_id
      join message q on q.id = m.request_id
      join conversation c on c.id = q.conversation_id
      group by l.payout_id, l.owner_id, l.reply_id, m.request_id, m.ree_id, c.user_id, q.created_at
    ), spend as (
      select r.payout_id, r.reply_id, g.source, g.purchase_id, g.redemption_id, g.withdrawable_at, g.funding_purchase_id,
        sum(case when f.delta < 0 then (a->>'amount')::bigint else -(a->>'amount')::bigint end) as amount
      from replies r
      join credit_entry f on f.ref_id = r.request_id and f.reason = 'query_fee_paid' and f.user_id = r.asker_id and f.ree_id = r.ree_id
      cross join lateral jsonb_array_elements(f.allocations) a
      join credit_grant g on g.id = (a->>'grantId')::uuid
      group by 1, 2, 3, 4, 5, 6, 7
    ), classified as (
      select s.payout_id, s.reply_id, s.amount,
        case
          when s.source = 'welcome' then 'welcome'
          when s.source = 'earned' then case when s.withdrawable_at is null then 'earnedFree' else 'paid' end
          when s.redemption_id is not null then 'redeemed'
          when s.purchase_id is not null then 'paid'
          else 'console'
        end as kind,
        coalesce(pp.status <> 'paid' or pp.reversed_credits > 0, false) as refunded
      from spend s
      left join purchase pp on pp.id = case when s.source = 'earned' then s.funding_purchase_id else s.purchase_id end
    ), fees as (
      select payout_id, reply_id, sum(amount) as fee from classified group by 1, 2
    ), payers as (
      select r.payout_id, r.owner_id, r.asker_id, sum(r.drawn) as credits, count(*) as questions,
        count(*) filter (where f.fee >= ${QUERY_FEE.max}) as max_fee_questions, min(r.asked_at) as first_asked_at
      from replies r
      left join fees f on f.payout_id = r.payout_id and f.reply_id = r.reply_id
      group by 1, 2, 3
    )
    select d.payout_id,
      (select coalesce(sum(x.drawn), 0) from drawn x where x.payout_id = d.payout_id) as drawn,
      (select coalesce(sum(l.drawn), 0) from linked l where l.payout_id = d.payout_id and l.refunded) as drawn_refunded,
      (select json_build_object(
          'paid', coalesce(sum(c.amount) filter (where c.kind = 'paid'), 0),
          'welcome', coalesce(sum(c.amount) filter (where c.kind = 'welcome'), 0),
          'redeemed', coalesce(sum(c.amount) filter (where c.kind = 'redeemed'), 0),
          'console', coalesce(sum(c.amount) filter (where c.kind = 'console'), 0),
          'earnedFree', coalesce(sum(c.amount) filter (where c.kind = 'earnedFree'), 0),
          'refunded', coalesce(sum(c.amount) filter (where c.kind = 'paid' and c.refunded), 0))
        from classified c where c.payout_id = d.payout_id) as sources,
      coalesce((select json_agg(json_build_object(
          'user_id', u.id, 'name', u.name, 'email', u.email, 'paypal_email', u.paypal_email,
          'created_at', u.created_at, 'disabled', u.disabled_at is not null,
          'credits', py.credits, 'questions', py.questions, 'max_fee_questions', py.max_fee_questions,
          'first_asked_at', py.first_asked_at,
          'active_elsewhere',
            exists (select 1 from ree own where own.owner_id = u.id)
            or exists (select 1 from credit_entry e join ree r on r.id = e.ree_id
                       where e.user_id = u.id and e.reason = 'query_base' and r.owner_id <> py.owner_id)))
        from payers py join "user" u on u.id = py.asker_id where py.payout_id = d.payout_id), '[]') as payers,
      ou.email as owner_email, ou.paypal_email as owner_paypal, po.paypal_email as payout_paypal
    from (select distinct payout_id, owner_id from drawn) d
    join "user" ou on ou.id = d.owner_id
    join payout po on po.id = d.payout_id
  `);
  const out = new Map<string, PayoutFundingSummary>();
  for (const raw of result.rows as unknown as Raw[]) {
    const payers = raw.payers.map(
      (row): FundingPayerRow => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        paypalEmail: row.paypal_email,
        createdAt: new Date(row.created_at),
        disabled: row.disabled,
        credits: Number(row.credits),
        questions: Number(row.questions),
        maxFeeQuestions: Number(row.max_fee_questions),
        firstAskedAt: new Date(row.first_asked_at),
        activeElsewhere: row.active_elsewhere,
      }),
    );
    const sources = raw.sources
      ? (Object.fromEntries(Object.keys(EMPTY_SOURCES).map((key) => [key, Number(raw.sources![key as keyof FundingSources] ?? 0)])) as unknown as FundingSources)
      : EMPTY_SOURCES;
    out.set(
      raw.payout_id,
      summarizeFunding({
        drawn: Number(raw.drawn),
        payers,
        sources,
        drawnRefunded: Number(raw.drawn_refunded),
        ownerEmails: [raw.owner_email, raw.owner_paypal, raw.payout_paypal],
      }),
    );
  }
  return out;
}

/** The owner's earned credits by state now: what a payout may draw on, what matures when, and what never can. */
export interface EarnedMaturity {
  withdrawable: number;
  maturing: number;
  /** The next `PAYOUT_MATURITY_DATES` dates (UTC days) and what matures on each. */
  schedule: { date: Date; credits: number }[];
  /** Maturing on later dates than the schedule lists. */
  later: number;
  locked: number;
}

async function maturityOf(userId: string, now: Date): Promise<EarnedMaturity> {
  const grants = (await grantsOf(db(), userId, false)).filter((grant) => grant.source === 'earned' && grant.remaining > 0);
  const byDay = new Map<string, number>();
  let withdrawable = 0;
  let locked = 0;
  for (const grant of grants) {
    if (!grant.withdrawableAt) locked += grant.remaining;
    else if (grant.withdrawableAt.getTime() <= now.getTime()) withdrawable += grant.remaining;
    else {
      const day = grant.withdrawableAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + grant.remaining);
    }
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const schedule = days.slice(0, PAYOUT_MATURITY_DATES).map(([day, credits]) => ({ date: new Date(`${day}T00:00:00Z`), credits }));
  const maturing = days.reduce((sum, [, credits]) => sum + credits, 0);
  return { withdrawable, maturing, schedule, later: maturing - schedule.reduce((sum, entry) => sum + entry.credits, 0), locked };
}

export interface PayoutFunding {
  summary: PayoutFundingSummary;
  /** One page of `summary.ranked`. */
  payers: { items: FundingPayer[]; total: number; page: number; size: number };
  maturity: EarnedMaturity;
}

/** The review page's picture of one payout; `page` pages the askers. Null for an unknown payout. */
export async function payoutFunding(administrator: Administrator, payoutId: string, ownerId: string, page = 1, now = new Date()): Promise<PayoutFunding> {
  assertConsole(administrator);
  const summary =
    (await fundingOf([payoutId])).get(payoutId) ??
    summarizeFunding({ drawn: 0, payers: [], sources: EMPTY_SOURCES, drawnRefunded: 0, ownerEmails: [] });
  const size = PAYOUT_PAYERS_PAGE_SIZE;
  const current = clampPage(page, summary.ranked.length, size);
  return {
    summary,
    payers: { items: summary.ranked.slice((current - 1) * size, current * size), total: summary.ranked.length, page: current, size },
    maturity: await maturityOf(ownerId, now),
  };
}

/** The queue's one-line view of each payout: distinct askers, the top one's share, the flags. */
export interface FundingLine {
  payers: number;
  topShare: number;
  flags: FundingFlag[];
}

export async function payoutFundingLines(administrator: Administrator, payoutIds: readonly string[]): Promise<Map<string, FundingLine>> {
  assertConsole(administrator);
  const all = await fundingOf(payoutIds);
  return new Map([...all].map(([id, summary]) => [id, { payers: summary.payers, topShare: summary.topShare, flags: summary.flags }]));
}
