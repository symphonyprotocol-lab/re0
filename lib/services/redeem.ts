/**
 * Redeeming a code (docs/design/redeem-codes.md 4, 5) and the hourly cron
 * that issues a redeemed Plan's later months.
 *
 * One redemption is one transaction: the user's checkout lock (so two
 * redemptions, or a redemption and a Plan checkout, never interleave), then
 * the code's row lock (so a code's uses never exceed its limit), then every
 * check, and only then the writes. A refused redemption has written
 * nothing. Every attempt takes a slot in its user's and IP's `rate_bucket`
 * windows before the database is asked about the code; an attempt that was
 * not a wrong guess gives its slots back, so only guesses use up the limit.
 */
import { and, asc, count, eq, gt, isNull, lte, max, sql } from 'drizzle-orm';
import { CHECKOUT_REUSE_MS, REDEEM_PLAN_BATCH, REDEEM_RATE_LIMIT } from '@/lib/constants';
import { redeemedPeriod, redeemedPeriodIndexAt } from '@/lib/domain/billing';
import { isUuid } from '@/lib/domain/list';
import { batchPhase, maskedCode, normalizeCode, redeemedPlanEnd, redeemedPlanStart, type RedeemKind } from '@/lib/domain/redeem';
import { encryptionSecret } from '@/lib/infra/crypto/secrets';
import { hmacSha256, sha256 } from '@/lib/infra/crypto/tokens';
import { db, schema, type Tx } from '@/lib/infra/db';
import { cancelCheckoutTransaction, paddleConfig } from '@/lib/infra/paddle';
import { addGrant, balanceOf, expirePlanGrants } from '@/lib/services/credits';
import { redeemedPlansOf } from '@/lib/services/billing';
import { takeRateSlots, type RateRule } from '@/lib/services/rate-limit';

export type RedeemRefusal =
  | 'code_not_found'
  | 'code_not_started'
  | 'code_expired'
  | 'code_disabled'
  | 'code_exhausted'
  | 'already_redeemed'
  | 'plan_subscription_renewing'
  | 'plan_renewal_pending'
  | 'too_many_attempts';

export interface RedeemOutcome {
  redemptionId: string;
  kind: RedeemKind;
  /** A Pack's credits, or a Plan's credits per month. */
  credits: number;
  plan: { startsAt: string; endsAt: string; months: number; queued: boolean } | null;
  balance: number;
}

export type RedeemResult =
  | ({ ok: true } & RedeemOutcome)
  | { ok: false; error: RedeemRefusal; retryAfter?: number; startsAt?: string };

export interface RedeemContext {
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
  /** Paddle's cancellation of a superseded Plan checkout; tests replace it. */
  cancelCheckout?: (id: string) => Promise<void>;
}

/** The digest a code is stored and looked up under. */
export function codeDigest(normalized: string): Promise<string> {
  return sha256(`redeem:${normalized}`);
}

function rateRules(userId: string, ip: string | null | undefined): RateRule[] {
  return REDEEM_RATE_LIMIT.flatMap((rule) => {
    const subject = rule.scope === 'user' ? userId : ip;
    return subject ? [{ key: `redeem:${rule.scope}:${subject}:${rule.windowSeconds}`, limit: rule.limit, windowSeconds: rule.windowSeconds }] : [];
  });
}

/**
 * A day-salted HMAC of the IP under a key derived from ADMIN_SECRET_KEY:
 * enough to see one source behind many accounts that day, and, unlike a
 * plain digest, not reversible by hashing every IPv4 address.
 */
async function ipHash(ip: string | null | undefined, now: Date): Promise<string | null> {
  return ip ? hmacSha256(encryptionSecret(), `redeem-ip:${now.toISOString().slice(0, 10)}:${ip}`) : null;
}

type RedemptionRow = typeof schema.redeemRedemption.$inferSelect;

function ledgerNote(last4: string, redemption: Pick<RedemptionRow, 'kind' | 'planMonths'>, period: number, quantity: number | null): string {
  const what = redemption.kind === 'plan' ? `plan ${period + 1}/${redemption.planMonths}` : `pack x${quantity ?? 1}`;
  return `redeem ${maskedCode(last4)} · ${what}`;
}

/**
 * Month `index` of a redeemed Plan, as a Plan grant to that month's end.
 * Plan grants whose period is over are written off first, as a renewal
 * does. Idempotent: a month already issued is left alone.
 */
async function issuePlanMonth(tx: Tx, redemption: RedemptionRow, last4: string, index: number, now: Date): Promise<boolean> {
  const [issued] = await tx
    .select({ id: schema.creditGrant.id })
    .from(schema.creditGrant)
    .where(and(eq(schema.creditGrant.redemptionId, redemption.id), eq(schema.creditGrant.redemptionPeriod, index)))
    .limit(1);
  if (issued) return false;
  const period = redeemedPeriod(redemption.planStartsAt!, index);
  await expirePlanGrants(tx, { userId: redemption.userId, cutoff: period.start.getTime() > now.getTime() ? period.start : now }, now);
  await addGrant(
    tx,
    {
      userId: redemption.userId,
      source: 'plan',
      amount: redemption.credits,
      reason: 'redeem',
      refId: redemption.id,
      redemptionId: redemption.id,
      redemptionPeriod: index,
      expiresAt: period.end,
      periodStart: period.start,
      note: ledgerNote(last4, redemption, index, null),
    },
    now,
  );
  return true;
}

function outcomeOf(redemption: RedemptionRow, balance: number, now: Date): RedeemOutcome {
  return {
    redemptionId: redemption.id,
    kind: redemption.kind,
    credits: redemption.credits,
    plan:
      redemption.kind === 'plan'
        ? {
            startsAt: redemption.planStartsAt!.toISOString(),
            endsAt: redemption.planEndsAt!.toISOString(),
            months: redemption.planMonths!,
            queued: redemption.planStartsAt!.getTime() > now.getTime(),
          }
        : null,
    balance,
  };
}

/** `POST /api/billing/redeem`. */
export async function redeemCode(userId: string, input: { code?: unknown; requestId?: unknown }, context: RedeemContext = {}): Promise<RedeemResult> {
  const now = context.now ?? new Date();
  const slots = await takeRateSlots(rateRules(userId, context.ip), now);
  if (!slots.ok) return { ok: false, error: 'too_many_attempts', retryAfter: slots.retryAfter };
  let result: RedeemResult | null = null;
  try {
    result = await attempt(userId, input, context, now);
    return result;
  } finally {
    /* A wrong guess keeps its slots; anything else, a throw included, gives them back. */
    if (!(result && !result.ok && result.error === 'code_not_found')) await slots.release();
  }
}

async function attempt(userId: string, input: { code?: unknown; requestId?: unknown }, context: RedeemContext, now: Date): Promise<RedeemResult> {
  const normalized = normalizeCode(input.code);
  if (!normalized) return { ok: false, error: 'code_not_found' };
  const requestId = isUuid(input.requestId) ? input.requestId : null;
  const digest = await codeDigest(normalized);
  const hashedIp = await ipHash(context.ip, now);
  const superseded: string[] = [];

  const result = await db().transaction(async (tx): Promise<RedeemResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checkout:${userId}`}))`);
    let storedRequestId = requestId;
    if (requestId) {
      const [replay] = await tx
        .select({ redemption: schema.redeemRedemption, digest: schema.redeemCode.codeDigest })
        .from(schema.redeemRedemption)
        .innerJoin(schema.redeemCode, eq(schema.redeemCode.id, schema.redeemRedemption.codeId))
        .where(and(eq(schema.redeemRedemption.userId, userId), eq(schema.redeemRedemption.requestId, requestId)))
        .limit(1);
      /* The same request again gets its first answer. The id reused for another code is a new request, stored without the id it cannot share. */
      if (replay && replay.digest === digest) return { ok: true, ...outcomeOf(replay.redemption, await balanceOf(tx, userId, now), now) };
      if (replay) storedRequestId = null;
    }
    const [found] = await tx
      .select({ code: schema.redeemCode, batch: schema.redeemBatch })
      .from(schema.redeemCode)
      .innerJoin(schema.redeemBatch, eq(schema.redeemBatch.id, schema.redeemCode.batchId))
      .where(eq(schema.redeemCode.codeDigest, digest))
      .for('update', { of: schema.redeemCode });
    if (!found) return { ok: false, error: 'code_not_found' };
    const { code, batch } = found;
    if (code.status === 'disabled') return { ok: false, error: 'code_disabled' };
    const phase = batchPhase(batch, now);
    if (phase === 'disabled') return { ok: false, error: 'code_disabled' };
    if (phase === 'scheduled') return { ok: false, error: 'code_not_started', startsAt: batch.startsAt.toISOString() };
    if (phase === 'expired') return { ok: false, error: 'code_expired' };
    /* The user's own limit first: someone re-entering the single-use code they used is told they already have. */
    const [mine] = await tx
      .select({ n: count() })
      .from(schema.redeemRedemption)
      .where(and(eq(schema.redeemRedemption.batchId, batch.id), eq(schema.redeemRedemption.userId, userId), isNull(schema.redeemRedemption.revokedAt)));
    if ((mine?.n ?? 0) >= batch.perUserLimit) return { ok: false, error: 'already_redeemed' };
    if (code.maxRedemptions !== null && code.redemptionCount >= code.maxRedemptions) return { ok: false, error: 'code_exhausted' };

    let planStartsAt: Date | null = null;
    let planEndsAt: Date | null = null;
    if (batch.kind === 'plan') {
      const subscriptions = await tx
        .select({ status: schema.subscription.status, cancelAtPeriodEnd: schema.subscription.cancelAtPeriodEnd, currentPeriodEnd: schema.subscription.currentPeriodEnd })
        .from(schema.subscription)
        .where(eq(schema.subscription.userId, userId));
      const redeemed = await redeemedPlansOf(tx, userId, now);
      const start = redeemedPlanStart(subscriptions, redeemed.map((plan) => plan.endsAt), now);
      if ('error' in start) return { ok: false, error: start.error };
      planStartsAt = start.startsAt;
      planEndsAt = redeemedPlanEnd(planStartsAt, batch.planMonths!);
    }

    /* The row lock already serialises this code; the condition and the check constraint are the backstop. */
    const [counted] = await tx
      .update(schema.redeemCode)
      .set({ redemptionCount: sql`${schema.redeemCode.redemptionCount} + 1`, lastRedeemedAt: now })
      .where(
        and(
          eq(schema.redeemCode.id, code.id),
          sql`(${schema.redeemCode.maxRedemptions} is null or ${schema.redeemCode.redemptionCount} < ${schema.redeemCode.maxRedemptions})`,
        ),
      )
      .returning({ id: schema.redeemCode.id });
    if (!counted) return { ok: false, error: 'code_exhausted' };
    await tx
      .update(schema.redeemBatch)
      .set({ redemptionCount: sql`${schema.redeemBatch.redemptionCount} + 1` })
      .where(eq(schema.redeemBatch.id, batch.id));
    const [redemption] = await tx
      .insert(schema.redeemRedemption)
      .values({
        codeId: code.id,
        batchId: batch.id,
        userId,
        kind: batch.kind,
        credits: batch.credits,
        planMonths: batch.planMonths,
        planStartsAt,
        planEndsAt,
        requestId: storedRequestId,
        ipHash: hashedIp,
        userAgent: context.userAgent ? context.userAgent.slice(0, 200) : null,
        createdAt: now,
      })
      .returning();

    if (batch.kind === 'pack') {
      await addGrant(
        tx,
        {
          userId,
          source: 'pack',
          amount: batch.credits,
          reason: 'redeem',
          refId: redemption!.id,
          redemptionId: redemption!.id,
          redemptionPeriod: 0,
          note: ledgerNote(code.codeLast4, redemption!, 0, batch.packQuantity),
        },
        now,
      );
    } else {
      /* A Plan checkout left open in another tab would start a second Plan; it is closed here and in Paddle after commit. */
      const open = await tx
        .update(schema.paddleCheckout)
        .set({ supersededAt: now })
        .where(
          and(
            eq(schema.paddleCheckout.userId, userId),
            eq(schema.paddleCheckout.kind, 'plan'),
            isNull(schema.paddleCheckout.supersededAt),
            gt(schema.paddleCheckout.createdAt, new Date(now.getTime() - CHECKOUT_REUSE_MS)),
          ),
        )
        .returning({ id: schema.paddleCheckout.paddleTransactionId });
      superseded.push(...open.map((row) => row.id));
      if (planStartsAt!.getTime() <= now.getTime()) await issuePlanMonth(tx, redemption!, code.codeLast4, 0, now);
    }
    return { ok: true, ...outcomeOf(redemption!, await balanceOf(tx, userId, now), now) };
  });

  if (!result.ok) console.info(`redeem refused: user ${userId} ip ${hashedIp?.slice(0, 8) ?? '-'} ${result.error} ${digest.slice(0, 8)}`);
  for (const id of superseded) {
    try {
      if (context.cancelCheckout) await context.cancelCheckout(id);
      else {
        const config = paddleConfig();
        if (config) await cancelCheckoutTransaction(config, id);
      }
    } catch (error) {
      console.warn(`redeem: could not cancel superseded Plan checkout ${id}`, error);
    }
  }
  return result;
}

/* -------------------------------------------------------------------- cron */

/**
 * `GET /api/cron/plan-redemptions` (hourly): each redeemed Plan in force
 * gets its current month's grant if it has not had it. Months the cron
 * missed entirely are not back-filled -- their credits would already have
 * expired. Pages of `REDEEM_PLAN_BATCH`, one transaction each, rows locked
 * with SKIP LOCKED so overlapping runs share the work. Idempotent.
 */
export async function issueRedeemedPlanMonths(now = new Date(), budgetMs = 240_000): Promise<{ issued: number }> {
  const started = Date.now();
  let issued = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await db().transaction(async (tx) => {
      const issuedPeriod = tx
        .select({ redemptionId: schema.creditGrant.redemptionId, latest: max(schema.creditGrant.redemptionPeriod).as('latest') })
        .from(schema.creditGrant)
        .where(sql`${schema.creditGrant.redemptionId} is not null`)
        .groupBy(schema.creditGrant.redemptionId)
        .as('issued_period');
      const rows = await tx
        .select({ redemption: schema.redeemRedemption, last4: schema.redeemCode.codeLast4, latest: issuedPeriod.latest })
        .from(schema.redeemRedemption)
        .innerJoin(schema.redeemCode, eq(schema.redeemCode.id, schema.redeemRedemption.codeId))
        .leftJoin(issuedPeriod, eq(issuedPeriod.redemptionId, schema.redeemRedemption.id))
        .where(
          and(
            eq(schema.redeemRedemption.kind, 'plan'),
            isNull(schema.redeemRedemption.revokedAt),
            lte(schema.redeemRedemption.planStartsAt, now),
            gt(schema.redeemRedemption.planEndsAt, now),
            gt(schema.redeemRedemption.id, after),
          ),
        )
        .orderBy(asc(schema.redeemRedemption.id))
        .limit(REDEEM_PLAN_BATCH)
        .for('update', { of: schema.redeemRedemption, skipLocked: true });
      let count = 0;
      for (const row of rows) {
        const plan = { startsAt: row.redemption.planStartsAt!, endsAt: row.redemption.planEndsAt!, months: row.redemption.planMonths! };
        const index = redeemedPeriodIndexAt(plan, now);
        if (index === null || (row.latest !== null && row.latest >= index)) continue;
        if (await issuePlanMonth(tx, row.redemption, row.last4, index, now)) count += 1;
      }
      return { count, last: rows.at(-1)?.redemption.id ?? null, size: rows.length };
    });
    issued += page.count;
    if (!page.last || page.size < REDEEM_PLAN_BATCH || Date.now() - started > budgetMs) break;
    after = page.last;
  }
  return { issued };
}

/* ------------------------------------------------------------ reading back */

/** A user's redemptions, newest first: the console's user page. */
export async function redemptionsOf(userId: string) {
  return db()
    .select({
      id: schema.redeemRedemption.id,
      batchId: schema.redeemRedemption.batchId,
      batchName: schema.redeemBatch.name,
      last4: schema.redeemCode.codeLast4,
      kind: schema.redeemRedemption.kind,
      credits: schema.redeemRedemption.credits,
      planMonths: schema.redeemRedemption.planMonths,
      planStartsAt: schema.redeemRedemption.planStartsAt,
      planEndsAt: schema.redeemRedemption.planEndsAt,
      createdAt: schema.redeemRedemption.createdAt,
    })
    .from(schema.redeemRedemption)
    .innerJoin(schema.redeemBatch, eq(schema.redeemBatch.id, schema.redeemRedemption.batchId))
    .innerJoin(schema.redeemCode, eq(schema.redeemCode.id, schema.redeemRedemption.codeId))
    .where(eq(schema.redeemRedemption.userId, userId))
    .orderBy(sql`${schema.redeemRedemption.createdAt} desc`);
}
