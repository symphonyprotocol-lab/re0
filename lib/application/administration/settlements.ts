/**
 * Use cases behind the settlements screen: the statements a period produced,
 * the periods that exist, and the step that turns a locked period's earning
 * ledger into statement rows.
 *
 * agent-first-proposal.md 6.9: the ledger keeps the books and the console
 * shows them; neither moves money. `generateSettlements` is the console end of
 * the close: it locks a finished period (`closePeriod`, which freezes the
 * per-owner sums) and writes one `settlement` row per publisher account from
 * the unflagged events. Nothing here writes a `payout`. Statements leave the
 * books two ways: the creator redeems them as Additional Calls from their
 * dashboard (lib/application/revenue/redeem-credit), which is why `redeemed`
 * is a status the console filters and totals but never sets; or the creator
 * requests a PayPal payout, which an operator pays by hand and closes in
 * ./payouts -- the only place a statement becomes `paid`.
 *
 * Every write takes a reason and lands in the audit chain (requirement.md
 * 5.3): generating statements is the one console action that puts a number
 * against a creator's name.
 */
import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { closePeriod } from '@/lib/application/revenue';
import { PAYOUT_HOLD_DAYS, PAYOUT_THRESHOLD_MINOR } from '@/lib/domain';
import {
  AdminChangeRefused,
  holdEndsAt,
  isSettleablePeriod,
  normalizeReason,
  planSettlementStatements,
} from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import { sha256 } from '@/lib/infrastructure/crypto/tokens';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { likePattern } from './like-pattern';
import { recordAudit } from './audit';

export const SETTLEMENT_STATUS_FILTERS = [
  'all',
  'accrued',
  'held',
  'paid',
  'redeemed',
  'clawed_back',
  'voided',
] as const;

export type SettlementStatusFilter = (typeof SETTLEMENT_STATUS_FILTERS)[number];

export function isSettlementStatusFilter(value: unknown): value is SettlementStatusFilter {
  return (
    typeof value === 'string' && (SETTLEMENT_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

export type SettlementStatus = Exclude<SettlementStatusFilter, 'all'>;

export interface ConsoleSettlementRow {
  id: string;
  periodId: string;
  /** The owning workspace's name -- the creator as the console knows them. */
  publisherName: string;
  publisherWorkspaceId: string;
  amountMinor: number;
  currency: string;
  status: SettlementStatus;
  statementDigest: string | null;
  createdAt: Date;
  /** When the period locked, and when its hold window ends; null if unlocked. */
  lockedAt: Date | null;
  holdEndsAt: Date | null;
}

export interface SettlementListInput {
  query?: string;
  status?: SettlementStatusFilter;
  /** A period id, or undefined for every period. */
  period?: string;
  limit?: number;
  offset?: number;
}

export interface SettlementList {
  rows: ConsoleSettlementRow[];
  total: number;
}

/** A period id as it arrives from a query string, or nothing. */
export function periodParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : undefined;
}

export async function listSettlements(input: SettlementListInput = {}): Promise<SettlementList> {
  const database = db();
  const term = input.query?.trim();

  const conditions = [
    term
      ? or(
          ilike(schema.workspace.name, likePattern(term)),
          sql`${schema.settlement.id}::text ilike ${likePattern(term)}`,
        )
      : undefined,
    input.status && input.status !== 'all' ? eq(schema.settlement.status, input.status) : undefined,
    input.period ? eq(schema.settlement.periodId, input.period) : undefined,
  ].filter(Boolean);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const base = () =>
    database
      .select({
        id: schema.settlement.id,
        periodId: schema.settlement.periodId,
        publisherName: schema.workspace.name,
        publisherWorkspaceId: schema.workspace.id,
        amountMinor: schema.settlement.amountMinor,
        currency: schema.settlement.currency,
        status: schema.settlement.status,
        statementDigest: schema.settlement.statementDigest,
        createdAt: schema.settlement.createdAt,
        lockedAt: schema.revenuePeriod.lockedAt,
      })
      .from(schema.settlement)
      .innerJoin(
        schema.publisherAccount,
        eq(schema.publisherAccount.id, schema.settlement.publisherAccountId),
      )
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.publisherAccount.workspaceId))
      .innerJoin(schema.revenuePeriod, eq(schema.revenuePeriod.id, schema.settlement.periodId))
      .where(where);

  const [rows, [totalRow]] = await Promise.all([
    base()
      .orderBy(...settlementPageOrder())
      .limit(input.limit ?? 50)
      .offset(input.offset ?? 0),
    database
      .select({ n: count() })
      .from(schema.settlement)
      .innerJoin(
        schema.publisherAccount,
        eq(schema.publisherAccount.id, schema.settlement.publisherAccountId),
      )
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.publisherAccount.workspaceId))
      .where(where),
  ]);

  return {
    total: totalRow?.n ?? 0,
    rows: rows.map((row) => ({
      ...row,
      amountMinor: Number(row.amountMinor),
      status: row.status as SettlementStatus,
      holdEndsAt: row.lockedAt ? holdEndsAt(row.lockedAt, PAYOUT_HOLD_DAYS) : null,
    })),
  };
}

/**
 * The order every paged read of the settlement ledger uses.
 *
 * `settlement.id` is the tiebreaker, and must be: `generateSettlements`
 * inserts a whole run in one statement, so every row of a period shares one
 * `created_at` (`now()` is `transaction_timestamp()`). Ordering by
 * `(period_id, created_at)` alone leaves rows within a period unordered, and
 * limit/offset paging over a period larger than one page then repeats some
 * rows and drops others, differently on each request. Ids are uuidv7, so
 * `desc(id)` also reads newest-first inside the tie.
 *
 * Exported so the contract test can assert the tiebreaker is still there.
 */
export function settlementPageOrder() {
  return [
    desc(schema.settlement.periodId),
    desc(schema.settlement.createdAt),
    desc(schema.settlement.id),
  ];
}

export interface SettlementPeriodView {
  id: string;
  locked: boolean;
  lockedAt: Date | null;
  /** Frozen by the close; zero while the period is open. */
  totalAmountMinor: number;
  currency: string;
  /** Unflagged earning events recorded against the period so far. */
  events: number;
  /** Their amounts summed, as they stand -- the close freezes this into `totalAmountMinor`. */
  eventsMinor: number;
  /** Statement rows written, and the amount they carry. */
  statements: number;
  settledMinor: number;
  /** Whether the console may generate statements for it now. */
  settleable: boolean;
}

/** How many periods the console offers; older ones are reachable by URL. */
const PERIODS_SHOWN = 24;

/**
 * Every period the ledger knows: those with a `revenue_period` row and those
 * that only exist as earning events so far, newest first.
 */
export async function settlementPeriods(now: Date = new Date()): Promise<SettlementPeriodView[]> {
  const database = db();

  const [periodRows, eventRows, statementRows] = await Promise.all([
    database.select().from(schema.revenuePeriod).orderBy(desc(schema.revenuePeriod.id)),
    database
      .select({
        periodId: schema.earningEvent.periodId,
        n: count(),
        minor: sql<number>`coalesce(sum(${schema.earningEvent.amountMinor}), 0)::bigint`,
      })
      .from(schema.earningEvent)
      .where(eq(schema.earningEvent.flagged, false))
      .groupBy(schema.earningEvent.periodId),
    database
      .select({
        periodId: schema.settlement.periodId,
        n: count(),
        minor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}), 0)::bigint`,
      })
      .from(schema.settlement)
      .groupBy(schema.settlement.periodId),
  ]);

  const eventsById = new Map(eventRows.map((row) => [row.periodId, row]));
  const statementsById = new Map(statementRows.map((row) => [row.periodId, row]));
  const periodById = new Map(periodRows.map((row) => [row.id, row]));

  const ids = new Set<string>([...periodById.keys(), ...eventsById.keys()]);

  return [...ids]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, PERIODS_SHOWN)
    .map((id) => {
      const period = periodById.get(id);
      const events = eventsById.get(id);
      const statements = statementsById.get(id);
      return {
        id,
        locked: Boolean(period?.lockedAt),
        lockedAt: period?.lockedAt ?? null,
        totalAmountMinor: Number(period?.totalAmountMinor ?? 0),
        currency: period?.currency ?? 'USD',
        events: events?.n ?? 0,
        eventsMinor: Number(events?.minor ?? 0),
        statements: statements?.n ?? 0,
        settledMinor: Number(statements?.minor ?? 0),
        settleable: isSettleablePeriod(id, now),
      };
    });
}

export interface SettlementSummary {
  /** The newest locked period, whose figures the tiles quote. */
  latest: SettlementPeriodView | null;
  /**
   * Statements owed and not yet discharged, across every period: `accrued`,
   * plus `held` -- in a payout request an operator has not paid yet.
   */
  accruedMinor: number;
  accruedCount: number;
  /** Creators with something owed. */
  publishers: number;
  /** The `held` part of `accruedMinor`: waiting in the payout queue. */
  inPayoutMinor: number;
  /** Money that left the books, and money that came back or was voided. */
  paidMinor: number;
  /** Statements discharged as Additional Calls instead. */
  redeemedMinor: number;
  reversedMinor: number;
  currency: string;
  payoutThresholdMinor: number;
  holdDays: number;
}

export async function settlementSummary(
  periods?: SettlementPeriodView[],
): Promise<SettlementSummary> {
  const database = db();
  const known = periods ?? (await settlementPeriods());

  const [totals] = await database
    .select({
      accruedMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where ${schema.settlement.status} in ('accrued', 'held')), 0)::bigint`,
      accruedCount: sql<number>`(count(*) filter (where ${schema.settlement.status} in ('accrued', 'held')))::int`,
      publishers: sql<number>`(count(distinct ${schema.settlement.publisherAccountId}) filter (where ${schema.settlement.status} in ('accrued', 'held')))::int`,
      inPayoutMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where ${schema.settlement.status} = 'held'), 0)::bigint`,
      paidMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where ${schema.settlement.status} = 'paid'), 0)::bigint`,
      redeemedMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where ${schema.settlement.status} = 'redeemed'), 0)::bigint`,
      reversedMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where ${schema.settlement.status} in ('clawed_back', 'voided')), 0)::bigint`,
    })
    .from(schema.settlement);

  const latest = known.find((period) => period.locked) ?? null;

  return {
    latest,
    accruedMinor: Number(totals?.accruedMinor ?? 0),
    accruedCount: totals?.accruedCount ?? 0,
    publishers: Number(totals?.publishers ?? 0),
    inPayoutMinor: Number(totals?.inPayoutMinor ?? 0),
    paidMinor: Number(totals?.paidMinor ?? 0),
    redeemedMinor: Number(totals?.redeemedMinor ?? 0),
    reversedMinor: Number(totals?.reversedMinor ?? 0),
    currency: latest?.currency ?? 'USD',
    payoutThresholdMinor: PAYOUT_THRESHOLD_MINOR,
    holdDays: PAYOUT_HOLD_DAYS,
  };
}

export interface GenerateSettlementsResult {
  periodId: string;
  /** Whether the period was already locked before this run. */
  alreadyLocked: boolean;
  /** The period's frozen total, all owners together. */
  totalAmountMinor: number;
  created: number;
  createdMinor: number;
  withoutAccount: number;
  alreadyPresent: number;
}

/**
 * The statement digest: a stable hash of what the row asserts, so the
 * earning anchor (`earningStatementLeaf`) has something to commit to and a
 * creator can check their statement was not rewritten afterwards.
 * Length-prefixed like the audit hash, for the same reason.
 */
async function statementDigest(row: {
  periodId: string;
  publisherAccountId: string;
  amountMinor: number;
  currency: string;
}): Promise<string> {
  const parts = [row.periodId, row.publisherAccountId, String(row.amountMinor), row.currency];
  return sha256(parts.map((part) => `${part.length}:${part}`).join('|'));
}

/**
 * Lock a finished period and write the statements its ledger earned.
 *
 * Idempotent in both halves: `closePeriod` returns the frozen total of a
 * period that is already locked rather than recomputing it, and the plan
 * writes only the difference between an account's events and what its
 * statements already assert. So a second press writes nothing -- unless a
 * creator accepted the agreement in between (their row appears), or an event
 * landed in the locked period since (one correction row for the difference).
 * Owners without a publisher account are counted and left for next time;
 * their events are not lost.
 */
export async function generateSettlements(input: {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  periodId: string;
  reason: string;
}): Promise<GenerateSettlementsResult> {
  const reason = normalizeReason(input.reason);
  const now = new Date();
  if (!isSettleablePeriod(input.periodId, now)) {
    throw new AdminChangeRefused('period_invalid', 'a settlement period is a past YYYY-MM');
  }

  const closed = await closePeriod(input.periodId);

  const database = db();
  const outcome = await database.transaction(async (tx) => {
    /* The period row is the lock, exactly as in `closePeriod`. */
    const [period] = await tx
      .select()
      .from(schema.revenuePeriod)
      .where(eq(schema.revenuePeriod.id, input.periodId))
      .for('update');
    if (!period?.lockedAt) {
      throw new AdminChangeRefused('period_invalid', 'the period did not lock');
    }

    /*
     * Summed again under the lock rather than trusted from `closed`: the
     * events are frozen in practice once the period locks, but the statement
     * is what the creator is owed and must be derived from the rows this
     * transaction can see.
     */
    const owners = await tx
      .select({
        ownerWorkspaceId: schema.earningEvent.ownerWorkspaceId,
        amountMinor: sql<number>`coalesce(sum(${schema.earningEvent.amountMinor}), 0)::bigint`,
      })
      .from(schema.earningEvent)
      .where(
        and(
          eq(schema.earningEvent.periodId, input.periodId),
          eq(schema.earningEvent.flagged, false),
        ),
      )
      .groupBy(schema.earningEvent.ownerWorkspaceId)
      .orderBy(schema.earningEvent.ownerWorkspaceId);

    const workspaceIds = owners.map((owner) => owner.ownerWorkspaceId);
    const accountRows =
      workspaceIds.length === 0
        ? []
        : await tx
            .select({ id: schema.publisherAccount.id, workspaceId: schema.publisherAccount.workspaceId })
            .from(schema.publisherAccount)
            .where(inArray(schema.publisherAccount.workspaceId, workspaceIds));
    /*
     * What each account's statements for the period already assert, so a
     * late event (a chargeback booked back into a locked month) becomes one
     * more row for the difference rather than nothing. A voided statement
     * asserted nothing and is left out of the sum.
     */
    const existingRows = await tx
      .select({
        publisherAccountId: schema.settlement.publisherAccountId,
        amountMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}), 0)::bigint`,
      })
      .from(schema.settlement)
      .where(and(eq(schema.settlement.periodId, input.periodId), ne(schema.settlement.status, 'voided')))
      .groupBy(schema.settlement.publisherAccountId);

    const plan = planSettlementStatements({
      period: { id: input.periodId, currency: period.currency },
      owners: owners.map((owner) => ({
        ownerWorkspaceId: owner.ownerWorkspaceId,
        amountMinor: Number(owner.amountMinor),
      })),
      accounts: new Map(accountRows.map((row) => [row.workspaceId, row.id])),
      existing: new Map(existingRows.map((row) => [row.publisherAccountId, Number(row.amountMinor)])),
    });

    if (plan.rows.length > 0) {
      await tx.insert(schema.settlement).values(
        await Promise.all(
          plan.rows.map(async (row) => ({
            id: uuidv7(),
            ...row,
            status: 'accrued' as const,
            statementDigest: await statementDigest(row),
          })),
        ),
      );
    }

    return { plan, existing: existingRows.length, totalAmountMinor: Number(period.totalAmountMinor) };
  });

  const createdMinor = outcome.plan.rows.reduce((sum, row) => sum + row.amountMinor, 0);

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'settlement.generate',
    targetType: 'revenue_period',
    targetId: input.periodId,
    reason,
    beforeValue: {
      locked: closed.alreadyLocked,
      statements: outcome.existing,
    },
    afterValue: {
      locked: true,
      totalAmountMinor: outcome.totalAmountMinor,
      statements: outcome.existing + outcome.plan.rows.length,
      created: outcome.plan.rows.length,
      createdMinor,
      withoutAccount: outcome.plan.withoutAccount,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return {
    periodId: input.periodId,
    alreadyLocked: closed.alreadyLocked,
    totalAmountMinor: outcome.totalAmountMinor,
    created: outcome.plan.rows.length,
    createdMinor,
    withoutAccount: outcome.plan.withoutAccount,
    alreadyPresent: outcome.plan.alreadyPresent,
  };
}
