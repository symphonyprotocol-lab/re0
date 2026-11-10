/**
 * Manual PayPal payouts against the database (rebuild-proposal.md 2.3, 2.5
 * "提现审核" / "提现记录", 8.4 step 6). The user sets a PayPal address after
 * identity verification and requests earned credits, which are held at once
 * (`payout_hold`, earned grants only); an administrator approves or rejects
 * (rejection releases: `payout_release`), sends the money in PayPal outside
 * this system, then records the transfer id and the amount that arrived
 * (the hold is settled in full: `payout_paid`, the shortfall is the fee) or
 * marks it failed (released once). No PayPal API is called.
 *
 * Each step takes the payout row `FOR UPDATE` and acts only from the status
 * it expects, so two administrators pressing at once decide it once; the
 * audit row and the user's notice are written in the same transaction.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { parseAdminReason } from '@/lib/domain/adjustments';
import { CREDITS_PER_CENT, FINANCE_SERIES, financeRange, financeUnit, type FinanceSeries, type FinanceTrend } from '@/lib/domain/admin-finance';
import type { PayoutHistoryView, PayoutQueueView } from '@/lib/domain/admin-lists';
import { kycState, type KycState } from '@/lib/domain/kyc';
import { clampPage, isUuid, likePattern, type ListResult } from '@/lib/domain/list';
import {
  canMove,
  formatCentsUsd,
  formatCreditsUsd,
  normalizePaypalEmail,
  OPEN_PAYOUT_STATUSES,
  parsePaidAmount,
  parsePayoutCredits,
  parseTransferId,
  payoutStage,
  paypalHoldUntil,
  releasesHold,
  STAGE_REFUSALS,
  type PayoutStage,
  type PayoutStatus,
} from '@/lib/domain/payouts';
import type { UserRole } from '@/lib/domain/roles';
import { isWithdrawable } from '@/lib/domain/credits';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';
import { bucketStart, trendOf } from '@/lib/services/admin-finance';
import { grantsOf, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { latestKyc } from '@/lib/services/kyc';
import { notify } from '@/lib/services/notices';

export type PayoutRow = typeof schema.payout.$inferSelect;

/** A refusal on the user's side, answered as `{ error: code }`. */
export class PayoutRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PayoutRefused';
  }
}

/**
 * Earned credits not yet spent or held that a payout may draw on: paid for
 * by the askers (not from free credits) and past `EARNED_MATURITY_DAYS`
 * (review H2). The most a payout may ask for.
 */
export async function withdrawable(executor: Executor, userId: string, lock = false, now = new Date()): Promise<number> {
  const grants = await grantsOf(executor, userId, lock);
  return grants.filter((grant) => isWithdrawable(grant, now)).reduce((sum, grant) => sum + grant.remaining, 0);
}

/** What the user still owes from refunds or chargebacks that found the credits spent (2.3). */
export async function openDebt(executor: Executor, userId: string): Promise<number> {
  const [row] = await executor
    .select({ owed: sql<string>`coalesce(sum(${schema.creditDebt.remaining}), 0)` })
    .from(schema.creditDebt)
    .where(and(eq(schema.creditDebt.userId, userId), sql`${schema.creditDebt.remaining} > 0`));
  return Number(row?.owed ?? 0);
}

async function openPayout(executor: Executor, userId: string): Promise<PayoutRow | null> {
  const [row] = await executor
    .select()
    .from(schema.payout)
    .where(and(eq(schema.payout.userId, userId), inArray(schema.payout.status, [...OPEN_PAYOUT_STATUSES])))
    .limit(1);
  return row ?? null;
}

async function standing(executor: Executor, userId: string, now: Date, lock = false) {
  const query = executor.select().from(schema.user).where(eq(schema.user.id, userId));
  const [account] = lock ? await query.for('update') : await query.limit(1);
  if (!account) throw new PayoutRefused('not_found');
  const latest = await latestKyc(executor, userId);
  const open = await openPayout(executor, userId);
  const available = await withdrawable(executor, userId, lock, now);
  const kyc = kycState(latest);
  const stage = payoutStage({
    official: account.role === 'official',
    kyc,
    open: open?.status ?? null,
    paypalEmail: account.paypalEmail,
    paypalChangedAt: account.paypalEmailChangedAt,
    withdrawable: available,
    now,
  });
  return { account, latest, kyc, open, available, stage };
}

/* ------------------------------------------------------------- the user */

/** Where the user stands, without the history: the dashboard's guide. */
export async function payoutStanding(userId: string, now = new Date()): Promise<{ stage: PayoutStage; kyc: KycState; held: number }> {
  const { stage, kyc, open } = await standing(db(), userId, now);
  return { stage, kyc, held: open?.credits ?? 0 };
}

export interface PayoutOverview {
  stage: PayoutStage;
  kyc: KycState;
  official: boolean;
  paypalEmail: string | null;
  paypalHoldUntil: Date | null;
  withdrawable: number;
  open: PayoutRow | null;
  history: PayoutRow[];
}

/** The billing card, the dashboard guide and `GET /api/billing/payouts`. */
export async function payoutOverview(userId: string, now = new Date()): Promise<PayoutOverview> {
  const database = db();
  const { account, kyc, open, available, stage } = await standing(database, userId, now);
  const history = await database.select().from(schema.payout).where(eq(schema.payout.userId, userId)).orderBy(desc(schema.payout.createdAt)).limit(50);
  const holdUntil = paypalHoldUntil(account.paypalEmailChangedAt);
  return {
    stage,
    kyc,
    official: account.role === 'official',
    paypalEmail: account.paypalEmail,
    paypalHoldUntil: holdUntil && holdUntil.getTime() > now.getTime() ? holdUntil : null,
    withdrawable: available,
    open,
    history,
  };
}

/**
 * Sets the PayPal personal account's address, only once identity is
 * verified. The first address starts no wait; changing it starts the
 * seven-day hold on requests (a payout already requested keeps the address
 * it was requested to).
 */
export async function setPaypalEmail(userId: string, raw: unknown, now = new Date()): Promise<{ email: string; holdUntil: Date | null }> {
  const email = normalizePaypalEmail(raw);
  if (!email) throw new PayoutRefused('invalid_email');
  return db().transaction(async (tx) => {
    const [account] = await tx.select().from(schema.user).where(eq(schema.user.id, userId)).for('update');
    if (!account) throw new PayoutRefused('not_found');
    if (account.role === 'official') throw new PayoutRefused('official');
    const kyc = kycState(await latestKyc(tx, userId));
    if (kyc !== 'verified') throw new PayoutRefused(kyc === 'pending' ? 'kyc_pending' : 'kyc_required');
    if (account.paypalEmail === email) return { email, holdUntil: paypalHoldUntil(account.paypalEmailChangedAt) };
    const changedAt = account.paypalEmail ? now : null;
    await tx.update(schema.user).set({ paypalEmail: email, paypalEmailChangedAt: changedAt }).where(eq(schema.user.id, userId));
    return { email, holdUntil: paypalHoldUntil(changedAt) };
  });
}

/**
 * Requests a payout of `credits` (default: all withdrawable). Every gate is
 * checked again here under a per-user lock: not official, identity
 * verified, an address past its hold, no payout in progress, a whole number
 * from 500,000 up to the earned balance. The credits leave the earned grants
 * in the same transaction (`payout_hold`).
 */
export async function requestPayout(userId: string, rawCredits: unknown, now = new Date()): Promise<PayoutRow> {
  try {
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payout:${userId}`}))`);
      const { account, latest, available, stage } = await standing(tx, userId, now, true);
      if (stage !== 'eligible' && stage !== 'threshold') throw new PayoutRefused(STAGE_REFUSALS[stage]);
      if (account.disabledAt) throw new PayoutRefused('disabled');
      /* A refund that found the credits spent is owed first; it is not paid out of the platform's pocket (review M10). */
      if ((await openDebt(tx, userId)) > 0) throw new PayoutRefused('debt_open');
      const credits = parsePayoutCredits(rawCredits, available);
      if (typeof credits !== 'number') throw new PayoutRefused(credits.error);
      const id = crypto.randomUUID();
      const holdId = await placeHold(tx, { userId, kind: 'payout', amount: credits, refId: id, note: `PayPal ${account.paypalEmail}`, sources: ['earned'], withdrawableOnly: true }, now);
      const [row] = await tx
        .insert(schema.payout)
        .values({ id, userId, credits, paypalEmail: account.paypalEmail!, holdId, kycRecordId: latest!.id, createdAt: now })
        .returning();
      return row!;
    });
  } catch (error) {
    /* The one-open-payout index, should two requests race past the lock. */
    if ((error as { cause?: { code?: string } } | null)?.cause?.code === '23505') throw new PayoutRefused('payout_open');
    throw error;
  }
}

/* ---------------------------------------------------------- the console */

export interface PayoutListItem {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  credits: number;
  paypalEmail: string;
  status: PayoutStatus;
  kyc: KycState;
  taxForm: 'W-8BEN' | 'W-9' | null;
  reviewer: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  resolver: string | null;
  resolvedAt: Date | null;
  transferId: string | null;
  paidCents: number | null;
  feeCredits: number | null;
  failureReason: string | null;
  createdAt: Date;
}

const reviewer = sql<string | null>`(select a.email from ${schema.administrator} a where a.id = "payout"."reviewed_by")`;
const resolver = sql<string | null>`(select a.email from ${schema.administrator} a where a.id = "payout"."resolved_by")`;
const currentKyc = sql<KycState>`coalesce((select k.status from ${schema.kycRecord} k where k.user_id = "payout"."user_id" order by k.created_at desc, k.id desc limit 1), 'none')`;
const requestTax = sql<'W-8BEN' | 'W-9' | null>`(select k.tax_form from ${schema.kycRecord} k where k.id = "payout"."kyc_record_id")`;

type Scope = 'queue' | 'history';

/** A list's filters, shared by its CSV and its chart: scope, status, the calendar on the request time, search. */
function payoutWhere(view: PayoutQueueView | PayoutHistoryView, scope: Scope): SQL | undefined {
  const conditions: SQL[] = [];
  if (scope === 'queue') conditions.push(inArray(schema.payout.status, [...OPEN_PAYOUT_STATUSES]));
  if (view.status !== 'all') conditions.push(eq(schema.payout.status, view.status));
  const range = financeRange(view);
  if (range) conditions.push(gte(schema.payout.createdAt, new Date(range.start)), lt(schema.payout.createdAt, new Date(range.end)));
  if (view.q) {
    const pattern = likePattern(view.q);
    conditions.push(
      or(
        ilike(schema.user.name, pattern),
        ilike(schema.user.email, pattern),
        ilike(schema.payout.paypalEmail, pattern),
        ilike(schema.payout.transferId, pattern),
        sql`${schema.payout.id}::text ilike ${pattern}`,
        sql`${schema.payout.userId}::text ilike ${pattern}`,
      )!,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

function order(sort: PayoutQueueView['sort']) {
  if (sort === 'amount-high') return [desc(schema.payout.credits), asc(schema.payout.createdAt)];
  if (sort === 'amount-low') return [asc(schema.payout.credits), asc(schema.payout.createdAt)];
  return [sort === 'newest' ? desc(schema.payout.createdAt) : asc(schema.payout.createdAt), asc(schema.payout.id)];
}

const listFields = {
  payout: schema.payout,
  name: schema.user.name,
  email: schema.user.email,
  role: schema.user.role,
  kyc: currentKyc,
  taxForm: requestTax,
  reviewer,
  resolver,
};

function listItem(row: { payout: PayoutRow; name: string; email: string; role: UserRole; kyc: KycState; taxForm: 'W-8BEN' | 'W-9' | null; reviewer: string | null; resolver: string | null }): PayoutListItem {
  const { payout: p } = row;
  return {
    id: p.id,
    userId: p.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    credits: p.credits,
    paypalEmail: p.paypalEmail,
    status: p.status,
    kyc: row.kyc,
    taxForm: row.taxForm,
    reviewer: row.reviewer,
    reviewNote: p.reviewNote,
    reviewedAt: p.reviewedAt,
    resolver: row.resolver,
    resolvedAt: p.resolvedAt,
    transferId: p.transferId,
    paidCents: p.paidCents,
    feeCredits: p.feeCredits,
    failureReason: p.failureReason,
    createdAt: p.createdAt,
  };
}

/** Status tallies and the total held across requests in progress (the summary cards). */
async function payoutCounts(): Promise<{ counts: Record<string, number>; held: number }> {
  const tallies = await db()
    .select({ status: schema.payout.status, n: count(), credits: sql<number>`coalesce(sum(${schema.payout.credits}), 0)::bigint` })
    .from(schema.payout)
    .groupBy(schema.payout.status);
  const counts: Record<string, number> = { all: 0, open: 0, pending: 0, approved: 0, paid: 0, failed: 0, rejected: 0 };
  let held = 0;
  for (const tally of tallies) {
    counts[tally.status] = tally.n;
    counts.all! += tally.n;
    if (tally.status === 'pending' || tally.status === 'approved') {
      counts.open! += tally.n;
      held += Number(tally.credits);
    }
  }
  return { counts, held };
}

export async function listPayouts(
  view: PayoutQueueView | PayoutHistoryView,
  scope: Scope,
  options: { all?: boolean } = {},
): Promise<ListResult<PayoutListItem> & { counts: Record<string, number>; held: number }> {
  const database = db();
  const where = payoutWhere(view, scope);
  const [totalRow] = await database.select({ total: count() }).from(schema.payout).innerJoin(schema.user, eq(schema.user.id, schema.payout.userId)).where(where);
  const total = totalRow?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = database
    .select(listFields)
    .from(schema.payout)
    .innerJoin(schema.user, eq(schema.user.id, schema.payout.userId))
    .where(where)
    .orderBy(...order(view.sort))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  const rows = await query;
  return { items: rows.map(listItem), total, page, size: view.size, ...(await payoutCounts()) };
}

/**
 * A payout list's chart (prototype admin-finance.js): 提现审核 draws the
 * queue (pending, approved), 提现记录 the outcomes (paid, failed, rejected;
 * requests still open stay in its list but not in the chart). Every
 * matching request, not a page, by the UTC+8 hour / day / month it was
 * requested in; amounts are what was requested, in whole cents per request,
 * before PayPal's fee, never the net paid.
 */
export async function payoutTrend<S extends Scope>(
  view: PayoutQueueView | PayoutHistoryView,
  scope: S,
  now = new Date(),
): Promise<FinanceTrend<FinanceSeries<S extends 'queue' ? 'payouts' : 'payout-history'>>> {
  const kind = (scope === 'queue' ? 'payouts' : 'payout-history') as S extends 'queue' ? 'payouts' : 'payout-history';
  const at = bucketStart(schema.payout.createdAt, financeUnit(view));
  const rows = await db()
    .select({
      status: schema.payout.status,
      at,
      count: count(),
      cents: sql<string>`coalesce(sum(round(${schema.payout.credits}::numeric / ${sql.raw(String(CREDITS_PER_CENT))})), 0)::bigint`,
    })
    .from(schema.payout)
    .innerJoin(schema.user, eq(schema.user.id, schema.payout.userId))
    .where(and(inArray(schema.payout.status, [...FINANCE_SERIES[kind]]), payoutWhere(view, scope)))
    .groupBy(schema.payout.status, at);
  return trendOf(kind, view, rows, now);
}

export async function openPayoutCount(): Promise<number> {
  const [row] = await db().select({ n: count() }).from(schema.payout).where(inArray(schema.payout.status, [...OPEN_PAYOUT_STATUSES]));
  return row?.n ?? 0;
}

/** The user page's payouts tab: every request, newest first. */
export async function payoutsOf(userId: string): Promise<PayoutListItem[]> {
  const rows = await db()
    .select(listFields)
    .from(schema.payout)
    .innerJoin(schema.user, eq(schema.user.id, schema.payout.userId))
    .where(eq(schema.payout.userId, userId))
    .orderBy(desc(schema.payout.createdAt));
  return rows.map(listItem);
}

export async function payoutDetail(id: string) {
  const database = db();
  const [row] = await database
    .select({ ...listFields, account: schema.user })
    .from(schema.payout)
    .innerJoin(schema.user, eq(schema.user.id, schema.payout.userId))
    .where(eq(schema.payout.id, id))
    .limit(1);
  if (!row) return null;
  const latest = await latestKyc(database, row.payout.userId);
  const debt = await openDebt(database, row.payout.userId);
  const item = listItem(row);
  return {
    payout: item,
    user: {
      id: row.account.id,
      name: row.account.name,
      email: row.account.email,
      role: row.account.role,
      disabled: Boolean(row.account.disabledAt),
      paypalEmail: row.account.paypalEmail,
      /** Credits still owed from refunds or chargebacks; approval and payment wait until it is cleared. */
      debt,
    },
    kyc: latest ? { id: latest.id, status: latest.status, taxForm: latest.taxForm, declared: Boolean(latest.taxDeclaredAt), legalName: latest.legalName } : null,
    /** Approval and payment need verified identity, a non-official, active account and no open refund debt (8.4 step 6, review M10). */
    payable: item.kyc === 'verified' && row.account.role !== 'official' && !row.account.disabledAt && debt === 0,
  };
}

async function lockPayout(tx: Tx, id: string): Promise<PayoutRow> {
  if (!isUuid(id)) throw new AdminInputError('not_found');
  const [row] = await tx.select().from(schema.payout).where(eq(schema.payout.id, id)).for('update');
  if (!row) throw new AdminInputError('not_found');
  return row;
}

async function assertPayable(tx: Tx, userId: string): Promise<void> {
  const [account] = await tx.select({ role: schema.user.role, disabledAt: schema.user.disabledAt }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  if (account?.role === 'official') throw new AdminInputError('official');
  /* A disabled account, or one that still owes a refund, is not paid (review M10); rejecting it stays possible. */
  if (account?.disabledAt) throw new AdminInputError('disabled');
  if ((await openDebt(tx, userId)) > 0) throw new AdminInputError('debt_open');
  if (kycState(await latestKyc(tx, userId)) !== 'verified') throw new AdminInputError('kyc_required');
}

/**
 * Approve (the credits stay held, the request waits for the transfer) or
 * reject with a 3–300 character reason (the hold is released in full).
 */
export async function decidePayout(administratorId: string, id: string, decision: 'approved' | 'rejected', rawNote: unknown, now = new Date()): Promise<PayoutRow> {
  const text = typeof rawNote === 'string' ? rawNote.trim() : '';
  const note = text ? parseAdminReason(text) : '';
  if (note === null || (decision === 'rejected' && !note)) throw new AdminInputError('reason');
  return db().transaction(async (tx) => {
    const payout = await lockPayout(tx, id);
    if (!canMove(payout.status, decision)) throw new AdminInputError('stale');
    if (decision === 'approved') await assertPayable(tx, payout.userId);
    if (releasesHold(decision) && payout.holdId) await releaseHold(tx, payout.holdId, { note: `rejected · ${note}` }, now);
    const [updated] = await tx
      .update(schema.payout)
      .set({ status: decision, reviewNote: note || null, reviewedBy: administratorId, reviewedAt: now, ...(decision === 'rejected' ? { resolvedBy: administratorId, resolvedAt: now } : {}) })
      .where(eq(schema.payout.id, id))
      .returning();
    await audit(tx, {
      administratorId,
      action: decision === 'approved' ? 'payout.approved' : 'payout.rejected',
      target: id,
      before: { status: payout.status, user: payout.userId, credits: payout.credits },
      after: { status: decision, note, released: decision === 'rejected' ? payout.credits : 0 },
    });
    await notify(tx, { userId: payout.userId, kind: 'payout', text: decision === 'rejected' ? note : '', params: { status: decision, credits: payout.credits }, refId: id });
    return updated!;
  });
}

/**
 * The transfer went through: PayPal's transaction id and the dollars that
 * arrived (two decimals, more than 0, not more than requested). The hold is
 * settled in full; requested − paid is the fee, which the user bears.
 */
export async function recordPayment(administratorId: string, id: string, input: { transferId?: unknown; paid?: unknown }, now = new Date()): Promise<PayoutRow> {
  const transferId = parseTransferId(input.transferId);
  if (!transferId) throw new AdminInputError('transfer_id');
  try {
    return await recordPaymentInTx(administratorId, id, transferId, input, now);
  } catch (error) {
    /* `payout_transfer_key`: two requests recorded with one transfer at the same moment. */
    if ((error as { cause?: { code?: string } } | null)?.cause?.code === '23505') throw new AdminInputError('transfer_used');
    throw error;
  }
}

function recordPaymentInTx(administratorId: string, id: string, transferId: string, input: { paid?: unknown }, now: Date): Promise<PayoutRow> {
  return db().transaction(async (tx) => {
    const payout = await lockPayout(tx, id);
    if (!canMove(payout.status, 'paid')) throw new AdminInputError('stale');
    const amount = parsePaidAmount(input.paid, payout.credits);
    if ('error' in amount) throw new AdminInputError(amount.error);
    await assertPayable(tx, payout.userId);
    const [reused] = await tx
      .select({ id: schema.payout.id })
      .from(schema.payout)
      .where(and(eq(schema.payout.transferId, transferId), ne(schema.payout.id, id)))
      .limit(1);
    if (reused) throw new AdminInputError('transfer_used');
    if (payout.holdId) {
      await settleHold(tx, payout.holdId, payout.credits, { note: `PayPal ${transferId} · paid ${formatCentsUsd(amount.paidCents)} · fee ${formatCreditsUsd(amount.feeCredits)}` }, now);
    }
    const [updated] = await tx
      .update(schema.payout)
      .set({ status: 'paid', transferId, paidCents: amount.paidCents, feeCredits: amount.feeCredits, resolvedBy: administratorId, resolvedAt: now })
      .where(eq(schema.payout.id, id))
      .returning();
    await audit(tx, {
      administratorId,
      action: 'payout.paid',
      target: id,
      before: { status: payout.status, user: payout.userId, credits: payout.credits },
      after: { status: 'paid', transferId, paidCents: amount.paidCents, feeCredits: amount.feeCredits },
    });
    await notify(tx, { userId: payout.userId, kind: 'payout', params: { status: 'paid', credits: payout.credits, paidCents: amount.paidCents }, refId: id });
    return updated!;
  });
}

/** The transfer failed or came back: a 3–300 character reason, and the hold released, once. */
export async function failPayout(administratorId: string, id: string, rawReason: unknown, now = new Date()): Promise<PayoutRow> {
  const reason = parseAdminReason(rawReason);
  if (!reason) throw new AdminInputError('reason');
  return db().transaction(async (tx) => {
    const payout = await lockPayout(tx, id);
    if (!canMove(payout.status, 'failed')) throw new AdminInputError('stale');
    if (releasesHold('failed') && payout.holdId) await releaseHold(tx, payout.holdId, { note: `failed · ${reason}` }, now);
    const [updated] = await tx
      .update(schema.payout)
      .set({ status: 'failed', failureReason: reason, resolvedBy: administratorId, resolvedAt: now })
      .where(eq(schema.payout.id, id))
      .returning();
    await audit(tx, {
      administratorId,
      action: 'payout.failed',
      target: id,
      before: { status: payout.status, user: payout.userId, credits: payout.credits },
      after: { status: 'failed', reason, released: payout.credits },
    });
    await notify(tx, { userId: payout.userId, kind: 'payout', text: reason, params: { status: 'failed', credits: payout.credits }, refId: id });
    return updated!;
  });
}
