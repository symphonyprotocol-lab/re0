/**
 * Use cases behind the console's subscription-billing screen: the document
 * list, the figures above it, and one document in full.
 *
 * Read-only, all of it. requirement.md 5.3 makes this screen a mirror of the
 * Payment Provider and puts every human action -- refund, retry, reissue --
 * on the provider's side, so there is no mutation in this module and no server
 * action behind the screen. That is a product rule, not an unfinished feature.
 *
 * Everything here reads `billing_document`, which is written only by
 * `mirrorProviderDocument`. Nothing invents a figure: a platform whose payment
 * provider is not connected yet shows zeroes and an empty list, because a
 * billing screen that guesses is worse than one that admits it knows nothing.
 */
import { and, count, desc, eq, gte, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  BILLING_DOCUMENT_STATUSES,
  isCollected,
  isOutstanding,
  refundRateBps,
  type BillingDocumentKind,
  type BillingDocumentStatus,
  type BillingStatusFilter,
} from '@/lib/domain/billing';
import { PLAN_CURRENCY, parseUsdMinor } from '@/lib/domain/plans';
import { ref } from '@/lib/application/administration/column-ref';
import { likePattern } from '@/lib/application/administration/like-pattern';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface BillingDocumentRow {
  id: string;
  number: string;
  provider: string;
  externalId: string;
  kind: BillingDocumentKind;
  status: BillingDocumentStatus;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  /** A payment method type, never an instrument. May be absent. */
  method: string | null;
  workspaceId: string;
  workspaceName: string;
  /** The workspace owner's address -- who to write to about this document. */
  customerEmail: string | null;
  /** The tier the order was priced against, or null when nothing links it. */
  planId: string | null;
  issuedAt: Date;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export interface BillingListInput {
  query?: string;
  status?: BillingStatusFilter;
  /** Narrows to one workspace's history. */
  workspaceId?: string;
  limit?: number;
  offset?: number;
}

/**
 * The workspace owner's email, as a correlated subquery.
 *
 * A join to `workspace_member` would multiply the page: a workspace with three
 * members would take three of the page's rows and render the same document
 * three times, while `total` -- which counts documents -- still counts it once,
 * so the last page would silently drop rows. Same reasoning as the user list.
 */
function ownerEmail() {
  return sql<string | null>`(
    select u.email from ${schema.workspaceMember} wm
    join ${schema.user} u on u.id = wm.user_id
    where wm.workspace_id = ${ref(schema.billingDocument.workspaceId)} and wm.role = 'owner'
    order by wm.created_at asc
    limit 1
  )`;
}

export async function listBillingDocuments(input: BillingListInput = {}): Promise<{
  rows: BillingDocumentRow[];
  total: number;
}> {
  const database = db();
  const where = billingFilter(input);

  /*
   * The count joins `workspace` even though it selects nothing from it: the
   * search matches on the workspace name, so the filter references a table the
   * statement has to have in its FROM clause. An inner join to a `NOT NULL`
   * foreign key cannot change the count.
   */
  const [totalRow] = await database
    .select({ n: count() })
    .from(schema.billingDocument)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.billingDocument.workspaceId))
    .where(where);

  const rows = await database
    .select({
      id: schema.billingDocument.id,
      number: schema.billingDocument.number,
      provider: schema.billingDocument.provider,
      externalId: schema.billingDocument.externalId,
      kind: schema.billingDocument.kind,
      status: schema.billingDocument.status,
      amountMinor: schema.billingDocument.amountMinor,
      refundedMinor: schema.billingDocument.refundedMinor,
      currency: schema.billingDocument.currency,
      method: schema.billingDocument.method,
      workspaceId: schema.billingDocument.workspaceId,
      workspaceName: schema.workspace.name,
      customerEmail: ownerEmail(),
      planId: schema.planVersion.planId,
      issuedAt: schema.billingDocument.issuedAt,
      paidAt: schema.billingDocument.paidAt,
      periodStart: schema.billingDocument.periodStart,
      periodEnd: schema.billingDocument.periodEnd,
    })
    .from(schema.billingDocument)
    /*
     * Both joins are to at-most-one row -- a document has one workspace and at
     * most one plan version -- so neither can multiply the page the way a join
     * to `workspace_member` would.
     */
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.billingDocument.workspaceId))
    .leftJoin(schema.planVersion, eq(schema.planVersion.id, schema.billingDocument.planVersionId))
    .where(where)
    /*
     * `issued_at` alone is not a total order: a provider stamps a whole billing
     * run with one instant, and Postgres is then free to return those rows in
     * either order on either page, which loses one and repeats another. The id
     * breaks the tie, so paging is stable.
     */
    .orderBy(desc(schema.billingDocument.issuedAt), desc(schema.billingDocument.id))
    .limit(input.limit ?? 50)
    .offset(input.offset ?? 0);

  return { total: totalRow?.n ?? 0, rows };
}

/**
 * The list's WHERE, shared by the count, the page and the export.
 *
 * The search covers the three things printed in the identifying columns -- the
 * document number, the workspace and the owner's address -- plus the amount,
 * because the toolbar says it does. An amount is matched exactly rather than as
 * a substring: `5` finding every document containing a five would be a worse
 * answer than no answer.
 */
function billingFilter(input: BillingListInput) {
  const term = input.query?.trim();
  const amountMinor = term ? parseUsdMinor(term) : null;

  const conditions = [
    term
      ? or(
          ilike(schema.billingDocument.number, likePattern(term)),
          ilike(schema.billingDocument.externalId, likePattern(term)),
          ilike(schema.workspace.name, likePattern(term)),
          sql`exists (
            select 1 from ${schema.workspaceMember} wm
            join ${schema.user} u on u.id = wm.user_id
            where wm.workspace_id = ${ref(schema.billingDocument.workspaceId)}
              and u.email ilike ${likePattern(term)}
          )`,
          ...(amountMinor === null
            ? []
            : [eq(schema.billingDocument.amountMinor, amountMinor)]),
        )
      : undefined,
    input.status && input.status !== 'all'
      ? eq(schema.billingDocument.status, input.status)
      : undefined,
    input.workspaceId ? eq(schema.billingDocument.workspaceId, input.workspaceId) : undefined,
  ].filter(Boolean);

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/* ----------------------------------------------------------------- summary */

export interface BillingSummary {
  /** The currency every figure below is in. requirement.md 4.3: USD. */
  currency: string;
  /** Net of refunds, over documents the provider collected this month. */
  monthNetMinor: number;
  monthRefundedMinor: number;
  /** Refunds as a share of what was collected this month, in basis points. */
  monthRefundRateBps: number;
  /** Issued and not yet paid, plus the payments that failed. */
  outstandingMinor: number;
  outstandingCount: number;
  /** Net of refunds, over the month before this one -- the card's comparison. */
  previousMonthNetMinor: number;
  /** Subscriptions live right now on a version that costs something. */
  paidSubscriptions: number;
  /** How many of those are still in a trial and have not been charged yet. */
  trialingSubscriptions: number;
  /**
   * Documents in another currency that the figures above would otherwise have
   * counted -- collected or still owed, never drafts and voids.
   *
   * The figures deliberately ignore them rather than adding francs to dollars.
   * This is how many they are not counting, so nobody reads a total as the
   * whole picture when it is not.
   */
  foreignCurrencyDocuments: number;
  /** First instant of the month the figures cover, in UTC. */
  periodStart: Date;
}

/**
 * The four figures above the list.
 *
 * The revenue and refund numbers come from the mirror, so they are what the
 * provider says. The subscription count comes from `subscription`, so it stays
 * true even before the mirror has a single row -- which is exactly the state
 * this platform is in until the provider is connected.
 */
export async function billingSummary(now = new Date()): Promise<BillingSummary> {
  const database = db();
  const periodStart = startOfUtcMonth(now);
  /** `getUTCMonth() - 1` on January is December of the year before; Date.UTC rolls it. */
  const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  /*
   * Derived from the domain rather than restated: "which states count as money
   * in" is a rule, and a second copy of it here is a second thing to update
   * when a provider state is added.
   */
  const collected = BILLING_DOCUMENT_STATUSES.filter(isCollected);
  const owed = BILLING_DOCUMENT_STATUSES.filter(isOutstanding);

  /**
   * Collected money in one window.
   *
   * Dated by when the money arrived, not by when the document was issued: a
   * December invoice paid in January is January's revenue, and an operator
   * reconciling against the provider's payout statement is reading it that way
   * too.
   */
  const collectedBetween = async (from: Date, until?: Date) => {
    const [row] = await database
      .select({
        amount: sql<number>`coalesce(sum(${schema.billingDocument.amountMinor}), 0)::bigint`,
        refunded: sql<number>`coalesce(sum(${schema.billingDocument.refundedMinor}), 0)::bigint`,
      })
      .from(schema.billingDocument)
      .where(
        and(
          inArray(schema.billingDocument.status, collected),
          eq(schema.billingDocument.currency, PLAN_CURRENCY),
          gte(schema.billingDocument.paidAt, from),
          until ? lt(schema.billingDocument.paidAt, until) : undefined,
        ),
      );
    return { amount: Number(row?.amount ?? 0), refunded: Number(row?.refunded ?? 0) };
  };

  /*
   * Nothing here depends on anything else here, so they go together. Awaited in
   * turn they were five serial round trips on every render of the screen.
   */
  const [month, previous, [outstanding], [foreign], [subscriptions]] = await Promise.all([
    collectedBetween(periodStart),
    collectedBetween(previousStart, periodStart),

    database
      .select({
        amount: sql<number>`coalesce(sum(${schema.billingDocument.amountMinor}), 0)::bigint`,
        documents: count(),
      })
      .from(schema.billingDocument)
      .where(
        and(
          inArray(schema.billingDocument.status, owed),
          eq(schema.billingDocument.currency, PLAN_CURRENCY),
        ),
      ),

    /*
     * Only the documents that could have been in the figures above. A voided
     * or still-drafted foreign document was never a candidate for any of them,
     * so counting it would send an operator looking for money that was never
     * owed or collected in the first place.
     */
    database
      .select({ n: count() })
      .from(schema.billingDocument)
      .where(
        and(
          ne(schema.billingDocument.currency, PLAN_CURRENCY),
          inArray(schema.billingDocument.status, [...collected, ...owed]),
        ),
      ),

    /*
     * Counted from `subscription` rather than from the mirror. A workspace whose
     * invoice has not been issued yet is still a paying subscription, and a
     * platform with no payment provider connected still has whatever the seed
     * and the signup flow created.
     */
    database
      .select({
        n: count(),
        trialing: sql<number>`count(*) filter (where ${schema.subscription.status} = 'trialing')::int`,
      })
      .from(schema.subscription)
      .innerJoin(
        schema.planVersion,
        eq(schema.planVersion.id, schema.subscription.planVersionId),
      )
      .where(
        and(
          inArray(schema.subscription.status, ['active', 'trialing']),
          sql`${schema.planVersion.priceMinor} > 0`,
        ),
      ),
  ]);

  const amount = month.amount;
  const refunded = month.refunded;

  return {
    currency: PLAN_CURRENCY,
    monthNetMinor: amount - refunded,
    monthRefundedMinor: refunded,
    monthRefundRateBps: refundRateBps({ collectedMinor: amount, refundedMinor: refunded }),
    outstandingMinor: Number(outstanding?.amount ?? 0),
    outstandingCount: outstanding?.documents ?? 0,
    previousMonthNetMinor: previous.amount - previous.refunded,
    paidSubscriptions: subscriptions?.n ?? 0,
    trialingSubscriptions: subscriptions?.trialing ?? 0,
    foreignCurrencyDocuments: foreign?.n ?? 0,
    periodStart,
  };
}

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/* ------------------------------------------------------------------ detail */

export interface BillingDocumentDetail extends BillingDocumentRow {
  /** When the provider says the mirrored state was true. */
  observedAt: Date;
  /** The verified event that last wrote the row, if one did. */
  lastEventId: string | null;
  lastEventExternalId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  planVersionId: string | null;
  planPriceMinor: number | null;
  planMonthlyCalls: number | null;
  /** What a pack document actually delivered. requirement.md 4.3: never expires. */
  addonGrantId: string | null;
  addonCallsGranted: number | null;
  addonCallsConsumed: number | null;
}

/** One document in full, or null when the id matches nothing. */
export async function getBillingDocument(id: string): Promise<BillingDocumentDetail | null> {
  if (!isUuid(id)) return null;

  const [row] = await db()
    .select({
      id: schema.billingDocument.id,
      number: schema.billingDocument.number,
      provider: schema.billingDocument.provider,
      externalId: schema.billingDocument.externalId,
      kind: schema.billingDocument.kind,
      status: schema.billingDocument.status,
      amountMinor: schema.billingDocument.amountMinor,
      refundedMinor: schema.billingDocument.refundedMinor,
      currency: schema.billingDocument.currency,
      method: schema.billingDocument.method,
      workspaceId: schema.billingDocument.workspaceId,
      workspaceName: schema.workspace.name,
      customerEmail: ownerEmail(),
      planId: schema.planVersion.planId,
      issuedAt: schema.billingDocument.issuedAt,
      paidAt: schema.billingDocument.paidAt,
      periodStart: schema.billingDocument.periodStart,
      periodEnd: schema.billingDocument.periodEnd,
      observedAt: schema.billingDocument.observedAt,
      lastEventId: schema.billingDocument.lastEventId,
      lastEventExternalId: schema.paymentEvent.externalEventId,
      subscriptionId: schema.billingDocument.subscriptionId,
      subscriptionStatus: schema.subscription.status,
      planVersionId: schema.billingDocument.planVersionId,
      planPriceMinor: schema.planVersion.priceMinor,
      planMonthlyCalls: schema.planVersion.monthlyCalls,
      addonGrantId: schema.billingDocument.addonGrantId,
      addonCallsGranted: schema.addonGrant.callsGranted,
      addonCallsConsumed: schema.addonGrant.callsConsumed,
    })
    .from(schema.billingDocument)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.billingDocument.workspaceId))
    .leftJoin(schema.planVersion, eq(schema.planVersion.id, schema.billingDocument.planVersionId))
    .leftJoin(schema.subscription, eq(schema.subscription.id, schema.billingDocument.subscriptionId))
    .leftJoin(schema.addonGrant, eq(schema.addonGrant.id, schema.billingDocument.addonGrantId))
    .leftJoin(schema.paymentEvent, eq(schema.paymentEvent.id, schema.billingDocument.lastEventId))
    .where(eq(schema.billingDocument.id, id));

  return row ?? null;
}

/**
 * A hand-typed `/admin/billing/not-a-uuid` must be a 404, not a 500.
 *
 * Postgres refuses a malformed uuid literal with an error rather than an empty
 * result, so the shape is checked before the query rather than caught after it.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
