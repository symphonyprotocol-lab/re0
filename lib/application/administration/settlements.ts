/**
 * Use cases behind the settlements screen: the statements a period produced,
 * the periods that exist, and the step that turns a locked period's earning
 * events into statement rows.
 *
 * publisher-revenue-share.md stage 1 keeps the books and stage 2 shows them;
 * neither moves money. `generateSettlements` is the console end of stage 1:
 * it locks a finished period (`closePeriod`, which is what freezes the pool)
 * and writes one `settlement` row per publisher library from the unflagged
 * events. Nothing here writes a `payout` -- there is no payment adapter, and a
 * payout row that no provider executed would be a claim the ledger cannot
 * back (3.4: the platform holds no funds). Statements do leave the books one
 * way: the publisher redeems them as Additional Calls from their dashboard
 * (lib/application/revenue/redeem-credit), which is why `redeemed` is a status
 * the console filters and totals but never sets.
 *
 * Every write takes a reason and lands in the audit chain (requirement.md
 * 5.3): generating statements is the one console action that puts a number
 * against a publisher's name.
 */
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
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
  /** The owning workspace's name -- the publisher as the console knows them. */
  publisherName: string;
  publisherWorkspaceId: string;
  libraryPublicId: string;
  libraryTitle: string;
  attributableCalls: number;
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
          ilike(schema.library.publicId, likePattern(term)),
          ilike(schema.library.title, likePattern(term)),
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
        libraryPublicId: schema.library.publicId,
        libraryTitle: schema.library.title,
        attributableCalls: schema.settlement.attributableCalls,
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
      .innerJoin(schema.library, eq(schema.library.id, schema.settlement.libraryId))
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
      .innerJoin(schema.library, eq(schema.library.id, schema.settlement.libraryId))
      .where(where),
  ]);

  return {
    total: totalRow?.n ?? 0,
    rows: rows.map((row) => ({
      ...row,
      attributableCalls: Number(row.attributableCalls),
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
  netRevenueMinor: number;
  poolMinor: number;
  totalBilledCalls: number;
  totalAttributableCalls: number;
  shareRateBps: number;
  currency: string;
  /** Unflagged earning events recorded against the period so far. */
  events: number;
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
      .select({ periodId: schema.earningEvent.periodId, n: count() })
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

  const eventsById = new Map(eventRows.map((row) => [row.periodId, row.n]));
  const statementsById = new Map(statementRows.map((row) => [row.periodId, row]));
  const periodById = new Map(periodRows.map((row) => [row.id, row]));

  const ids = new Set<string>([...periodById.keys(), ...eventsById.keys()]);

  return [...ids]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, PERIODS_SHOWN)
    .map((id) => {
      const period = periodById.get(id);
      const statements = statementsById.get(id);
      return {
        id,
        locked: Boolean(period?.lockedAt),
        lockedAt: period?.lockedAt ?? null,
        netRevenueMinor: Number(period?.netRevenueMinor ?? 0),
        poolMinor: Number(period?.poolMinor ?? 0),
        totalBilledCalls: Number(period?.totalBilledCalls ?? 0),
        totalAttributableCalls: Number(period?.totalAttributableCalls ?? 0),
        shareRateBps: period?.shareRateBps ?? 0,
        currency: period?.currency ?? 'USD',
        events: eventsById.get(id) ?? 0,
        statements: statements?.n ?? 0,
        settledMinor: Number(statements?.minor ?? 0),
        settleable: isSettleablePeriod(id, now),
      };
    });
}

export interface SettlementSummary {
  /** The newest locked period, whose figures the tiles quote. */
  latest: SettlementPeriodView | null;
  /** Statements accrued and not yet paid, across every period. */
  accruedMinor: number;
  accruedCount: number;
  /** Publishers with something accrued. */
  publishers: number;
  /** Money that left the books, and money that came back or was voided. */
  paidMinor: number;
  /** Statements discharged as Additional Calls instead (share doc 3.4). */
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
      accruedMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where ${schema.settlement.status} = 'accrued'), 0)::bigint`,
      accruedCount: sql<number>`(count(*) filter (where ${schema.settlement.status} = 'accrued'))::int`,
      publishers: sql<number>`(count(distinct ${schema.settlement.publisherAccountId}) filter (where ${schema.settlement.status} = 'accrued'))::int`,
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
  poolMinor: number;
  totalAttributableCalls: number;
  created: number;
  createdMinor: number;
  withoutAccount: number;
  alreadyPresent: number;
}

/**
 * The statement digest: a stable hash of what the row asserts, so a later
 * Earning Anchor (publisher-revenue-share.md 6.4) has something to commit to
 * and a publisher can check their statement was not rewritten afterwards.
 * Length-prefixed like the audit hash, for the same reason.
 */
async function statementDigest(row: {
  periodId: string;
  publisherAccountId: string;
  libraryId: string;
  attributableCalls: number;
  amountMinor: number;
  currency: string;
}): Promise<string> {
  const parts = [
    row.periodId,
    row.publisherAccountId,
    row.libraryId,
    String(row.attributableCalls),
    String(row.amountMinor),
    row.currency,
  ];
  return sha256(parts.map((part) => `${part.length}:${part}`).join('|'));
}

/**
 * Lock a finished period and write the statements its events earned.
 *
 * Idempotent in both halves: `closePeriod` returns the frozen figures of a
 * period that is already locked rather than recomputing them, and the plan
 * skips any library that already has a statement for the period. So a second
 * press writes nothing -- unless a publisher accepted the agreement in between,
 * in which case only their rows appear. Owners without a publisher account are
 * counted and left for next time; their events are not lost.
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

    const groups = await tx
      .select({
        ownerWorkspaceId: schema.earningEvent.ownerWorkspaceId,
        libraryId: schema.earningEvent.libraryId,
        calls: sql<number>`count(*)::int`,
      })
      .from(schema.earningEvent)
      .where(
        and(
          eq(schema.earningEvent.periodId, input.periodId),
          eq(schema.earningEvent.flagged, false),
        ),
      )
      .groupBy(schema.earningEvent.ownerWorkspaceId, schema.earningEvent.libraryId)
      .orderBy(schema.earningEvent.ownerWorkspaceId, schema.earningEvent.libraryId);

    const owners = [...new Set(groups.map((group) => group.ownerWorkspaceId))];
    const accountRows =
      owners.length === 0
        ? []
        : await tx
            .select({ id: schema.publisherAccount.id, workspaceId: schema.publisherAccount.workspaceId })
            .from(schema.publisherAccount)
            .where(inArray(schema.publisherAccount.workspaceId, owners));
    const existingRows = await tx
      .select({ libraryId: schema.settlement.libraryId })
      .from(schema.settlement)
      .where(eq(schema.settlement.periodId, input.periodId));

    const plan = planSettlementStatements({
      period: {
        id: input.periodId,
        poolMinor: Number(period.poolMinor),
        totalAttributableCalls: Number(period.totalAttributableCalls),
        currency: period.currency,
      },
      groups,
      accounts: new Map(accountRows.map((row) => [row.workspaceId, row.id])),
      existing: new Set(existingRows.map((row) => row.libraryId)),
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

    return {
      plan,
      existing: existingRows.length,
      poolMinor: Number(period.poolMinor),
      totalAttributableCalls: Number(period.totalAttributableCalls),
    };
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
      poolMinor: outcome.poolMinor,
      totalAttributableCalls: outcome.totalAttributableCalls,
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
    poolMinor: outcome.poolMinor,
    totalAttributableCalls: outcome.totalAttributableCalls,
    created: outcome.plan.rows.length,
    createdMinor,
    withoutAccount: outcome.plan.withoutAccount,
    alreadyPresent: outcome.plan.alreadyPresent,
  };
}
