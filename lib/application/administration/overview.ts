/**
 * Use case: the operations overview -- the one console screen every
 * administrator lands on (requirement.md 5.3: 注册、付费、知识库、审核队列、收入
 * 和服务状态).
 *
 * Every figure is read from the table that owns it: accounts from `user`,
 * libraries and the review queue from `library`, money from the billing
 * mirror, activity from `audit_log`, service health from `request_log` and
 * `workflow_operation`. A platform with nothing in a table reads zero there
 * rather than a placeholder, for the same reason the billing screen does: an
 * overview that guesses is worse than one that says it knows nothing.
 *
 * The capability matrix applies here as it does to the tiles: a part the
 * session may not see is not queried, so a support administrator's page
 * never even asks the database about revenue -- and that includes who paid,
 * not only how much.
 */
import { and, count, eq, gte, inArray, isNull, or, sql, type AnyColumn } from 'drizzle-orm';
import { billingSummary, type BillingSummary } from '@/lib/application/billing';
import type { AdminCapability } from '@/lib/domain/admin';
import { BILLING_DOCUMENT_STATUSES, isCollected } from '@/lib/domain/billing';
import {
  fillDailySeries,
  overviewWindow,
  shareBps,
  type DailyPoint,
  type OverviewRange,
} from '@/lib/domain/overview';
import { PLAN_CURRENCY } from '@/lib/domain/plans';
import { isIngestionConfigured } from '@/lib/application/ingestion/dependencies';
import { isCredentialKeyConfigured } from '@/lib/infrastructure/crypto/credentials';
import { isObjectStoreConfigured } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recentAuditEntries, type ConsoleAuditRow } from './list-audit';
import { activeLlmConfig } from './manage-llm-config';
import { retrievalProviderStatus } from './manage-retrieval-config';
import {
  pendingReviewQueue,
  REVIEW_STATUSES,
  waitingSince,
  type ConsoleLibraryRow,
} from './list-libraries';

/** Total now, and how many arrived in this window and the one before it. */
export interface WindowedCount {
  total: number;
  inWindow: number;
  inPreviousWindow: number;
}

export interface ReviewQueueState {
  pending: number;
  /** How long the longest-waiting library has waited; null when nothing waits. */
  oldestWaitingMs: number | null;
  /** Pending libraries that have waited more than a day. */
  overdue: number;
}

export interface OverviewHealth {
  /** API requests in the last 24 hours; a failure is a 5xx. */
  api: { requests: number; failures: number };
  /** Live libraries by where their index stands. */
  index: { ready: number; failed: number; building: number; total: number };
  /** Build and refresh operations: waiting or running now, finished in 24 hours. */
  builds: { open: number; succeeded: number; failed: number };
  review: ReviewQueueState;
}

/**
 * Whether the services the platform leans on are wired up (requirement.md
 * 5.3: 服务状态). Every field is a configuration fact read from the
 * environment or the registry -- nothing here calls a provider, so the page
 * cannot spend money or hang on a slow endpoint just by being opened. The
 * console's LLM screen has the live probe for when an operator wants one.
 */
export interface OverviewServices {
  /** The model a subscriber's request resolves to, and whether its key is set. */
  llm: { model: string | null; keyPresent: boolean };
  retrieval: { embeddings: boolean; rerank: boolean };
  objectStore: boolean;
  /** Embeddings and storage together: whether a version could be built at all. */
  ingestion: boolean;
  /**
   * Always false: there is no payment adapter yet (publisher-revenue-share.md
   * stage 3), so payouts cannot execute. Stated rather than omitted.
   */
  payments: false;
}

export interface ConsoleOverview {
  range: OverviewRange;
  /** Present with the `users` capability. */
  users: WindowedCount | null;
  /**
   * Daily sign-ups, one point per day of the window. `paid` is filled only
   * with the `billing` capability and is zero otherwise; `growthIncludesPaid`
   * says which.
   */
  growth: DailyPoint[] | null;
  growthIncludesPaid: boolean;
  /**
   * Paying workspaces as a share of registered accounts, in basis points.
   * Needs both `users` and `billing`.
   */
  conversionBps: number | null;
  /** Workspaces on a paid plan right now. Present with the `billing` capability. */
  paidWorkspaces: number | null;
  /** Present with the `libraries` capability. */
  libraries: WindowedCount | null;
  pendingQueue: ConsoleLibraryRow[] | null;
  /** Present with the `billing` capability. */
  revenue: BillingSummary | null;
  /** Present with the `audit` capability. */
  activity: ConsoleAuditRow[] | null;
  /** Open to every administrator: aggregate counts, nothing personal. */
  health: OverviewHealth;
  services: OverviewServices;
}

export interface OverviewInput {
  range: OverviewRange;
  capabilities: readonly AdminCapability[];
  now?: Date;
  /** How many waiting libraries and recent events to list. */
  queueLimit?: number;
  activityLimit?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An operation the drain has not finished with. `OperationState` in lib/domain/ingestion. */
const OPEN_OPERATIONS = ['pending', 'running'] as const;

/** A UTC calendar day, the key `fillDailySeries` matches on. */
const utcDay = (column: AnyColumn) => sql<string>`(${column} at time zone 'UTC')::date::text`;

export async function consoleOverview(input: OverviewInput): Promise<ConsoleOverview> {
  const database = db();
  const now = input.now ?? new Date();
  const window = overviewWindow(now, input.range);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const can = (capability: AdminCapability) => input.capabilities.includes(capability);

  const liveLibrary = isNull(schema.library.deletedAt);
  const pendingUserLibrary = and(
    liveLibrary,
    eq(schema.library.isPlatformLibrary, false),
    inArray(schema.library.lifecycleStatus, [...REVIEW_STATUSES.pending]),
  );

  /*
   * Like against like: the current window runs from its first midnight to
   * now, so the previous one is cut at the same distance into itself
   * (`previousEnd`). Comparing a partial today with a full day a month ago
   * read as a fall on flat growth every morning.
   */
  const windowed = (column: AnyColumn) => ({
    total: count(),
    inWindow: sql<number>`(count(*) filter (where ${column} >= ${window.start}))::int`,
    inPreviousWindow: sql<number>`(count(*) filter (
      where ${column} >= ${window.previousStart} and ${column} < ${window.previousEnd}
    ))::int`,
  });

  const collected = BILLING_DOCUMENT_STATUSES.filter(isCollected);

  const [
    userRow,
    userDays,
    paidDays,
    paidWorkspaces,
    libraryRow,
    pendingQueue,
    revenue,
    activity,
    [apiRow],
    [indexRow],
    [buildRow],
    [reviewRow],
    subscriberModel,
  ] = await Promise.all([
    can('users')
      ? database.select(windowed(schema.user.createdAt)).from(schema.user).then((rows) => rows[0])
      : null,
    can('users')
      ? database
          .select({ day: utcDay(schema.user.createdAt), n: count() })
          .from(schema.user)
          .where(gte(schema.user.createdAt, window.start))
          .groupBy(sql`1`)
      : null,
    /*
     * A paying workspace on the day its money arrived, counted once per day
     * however many documents settled: the series is "who paid", not "how many
     * receipts". Same currency rule as the billing screen, so the chart and
     * the revenue tile agree on what counts -- and the same capability, since
     * who paid is billing data whichever table it is read from.
     */
    can('billing')
      ? database
          .select({
            day: utcDay(schema.billingDocument.paidAt),
            n: sql<number>`count(distinct ${schema.billingDocument.workspaceId})::int`,
          })
          .from(schema.billingDocument)
          .where(
            and(
              inArray(schema.billingDocument.status, collected),
              eq(schema.billingDocument.currency, PLAN_CURRENCY),
              gte(schema.billingDocument.paidAt, window.start),
            ),
          )
          .groupBy(sql`1`)
      : null,
    /*
     * Conversion counts workspaces, not subscriptions: a workspace that
     * changed plan mid-month has two subscription rows and one wallet.
     */
    can('billing')
      ? database
          .select({ n: sql<number>`count(distinct ${schema.subscription.workspaceId})::int` })
          .from(schema.subscription)
          .innerJoin(schema.planVersion, eq(schema.planVersion.id, schema.subscription.planVersionId))
          .where(
            and(
              inArray(schema.subscription.status, ['active', 'trialing']),
              sql`${schema.planVersion.priceMinor} > 0`,
            ),
          )
          .then((rows) => rows[0]?.n ?? 0)
      : null,
    can('libraries')
      ? database
          .select(windowed(schema.library.createdAt))
          .from(schema.library)
          .where(liveLibrary)
          .then((rows) => rows[0])
      : null,
    can('libraries') ? pendingReviewQueue({ limit: input.queueLimit ?? 5 }) : null,
    can('billing') ? billingSummary(now) : null,
    can('audit') ? recentAuditEntries({ limit: input.activityLimit ?? 6 }) : null,

    database
      .select({
        requests: count(),
        failures: sql<number>`(count(*) filter (where ${schema.requestLog.statusCode} >= 500))::int`,
      })
      .from(schema.requestLog)
      .where(gte(schema.requestLog.createdAt, dayAgo)),
    database
      .select({
        total: count(),
        ready: sql<number>`(count(*) filter (where ${schema.library.indexStatus} = 'ready'))::int`,
        failed: sql<number>`(count(*) filter (where ${schema.library.indexStatus} = 'failed'))::int`,
        building: sql<number>`(count(*) filter (
          where ${schema.library.indexStatus} in ('pending', 'processing', 'stale')
        ))::int`,
      })
      .from(schema.library)
      .where(liveLibrary),
    /*
     * Bounded to what the panel reads -- open now, or finished in the last
     * day -- so the operation log's whole history is not scanned for three
     * counters about today.
     */
    database
      .select({
        open: sql<number>`(count(*) filter (
          where ${schema.workflowOperation.status} in ('pending', 'running')
        ))::int`,
        succeeded: sql<number>`(count(*) filter (
          where ${schema.workflowOperation.status} in ('succeeded', 'skipped')
            and ${schema.workflowOperation.updatedAt} >= ${dayAgo}
        ))::int`,
        failed: sql<number>`(count(*) filter (
          where ${schema.workflowOperation.status} = 'failed'
            and ${schema.workflowOperation.updatedAt} >= ${dayAgo}
        ))::int`,
      })
      .from(schema.workflowOperation)
      .where(
        or(
          inArray(schema.workflowOperation.status, [...OPEN_OPERATIONS]),
          gte(schema.workflowOperation.updatedAt, dayAgo),
        ),
      ),
    database
      .select({
        pending: count(),
        oldest: sql<Date | null>`min(${waitingSince})`,
        overdue: sql<number>`(count(*) filter (where ${waitingSince} < ${dayAgo}))::int`,
      })
      .from(schema.library)
      .where(pendingUserLibrary),
    /*
     * The registry read cannot take the page down: a service row that says
     * "unknown" is honest, a landing page that 500s over it is not.
     */
    activeLlmConfig(null, 'subscriber').catch((error: unknown) => {
      console.warn(
        `overview: llm registry unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }),
  ]);

  const growth = userDays
    ? fillDailySeries(
        window.days,
        new Map(userDays.map((row) => [row.day, row.n])),
        new Map((paidDays ?? []).map((row) => [row.day, row.n])),
      )
    : null;

  const oldest = reviewRow?.oldest ? new Date(reviewRow.oldest) : null;

  return {
    range: input.range,
    users: userRow ?? null,
    growth,
    growthIncludesPaid: paidDays !== null,
    conversionBps:
      userRow && paidWorkspaces !== null ? shareBps(paidWorkspaces, userRow.total) : null,
    paidWorkspaces,
    libraries: libraryRow ?? null,
    pendingQueue,
    revenue,
    activity,
    health: {
      api: { requests: apiRow?.requests ?? 0, failures: apiRow?.failures ?? 0 },
      index: {
        total: indexRow?.total ?? 0,
        ready: indexRow?.ready ?? 0,
        failed: indexRow?.failed ?? 0,
        building: indexRow?.building ?? 0,
      },
      builds: {
        open: buildRow?.open ?? 0,
        succeeded: buildRow?.succeeded ?? 0,
        failed: buildRow?.failed ?? 0,
      },
      review: {
        pending: reviewRow?.pending ?? 0,
        oldestWaitingMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : null,
        overdue: reviewRow?.overdue ?? 0,
      },
    },
    services: {
      llm: {
        model: subscriberModel?.model ?? null,
        /* A stored key only counts when it can be opened: without the
           sealing secret every entry still has a cipher and none can be sent. */
        keyPresent: Boolean(subscriberModel?.hasCredential) && isCredentialKeyConfigured(),
      },
      retrieval: await retrievalProviderStatus(),
      objectStore: isObjectStoreConfigured(),
      ingestion: await isIngestionConfigured(),
      payments: false,
    },
  };
}

/** Whether anything on the health panel needs an operator's attention. */
export function healthNeedsAttention(health: OverviewHealth): boolean {
  const api = health.api;
  const apiDegraded = api.requests > 0 && api.failures / api.requests > 0.01;
  return (
    apiDegraded ||
    health.index.failed > 0 ||
    health.builds.failed > 0 ||
    health.review.overdue > 0
  );
}
