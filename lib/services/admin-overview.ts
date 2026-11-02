/**
 * The console's overview (2.5 "概览"), on live figures: users, Rees,
 * sources, questions and earned credits over the last 30 days, what waits
 * for an administrator, and this month's model calls with an estimated cost
 * from the call log (`model_call`).
 */
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { MODEL_KINDS, MODEL_PRICES, type ModelKind } from '@/lib/constants';
import { periodRange, reportingDate } from '@/lib/domain/statistics';
import { endpointFor } from '@/lib/infra/ai/models';
import { db, schema } from '@/lib/infra/db';
import { listAudit } from '@/lib/services/admin-audit';
import { pendingVerifications } from '@/lib/services/roles';
import { pendingKyc } from '@/lib/services/kyc';
import { openPayoutCount } from '@/lib/services/payouts';
import { runningReembedJob } from '@/lib/services/reembed';

const DAY = 24 * 60 * 60 * 1000;

/** USD for a model's usage, or null when its price is not on file. */
export function estimateCost(model: string, usage: { inputTokens: number; outputTokens: number; seconds: number }): number | null {
  const price = MODEL_PRICES[model] ?? MODEL_PRICES[model.split('/').pop() ?? ''];
  if (!price) return null;
  return (
    (usage.inputTokens / 1_000_000) * (price.input ?? 0) +
    (usage.outputTokens / 1_000_000) * (price.output ?? 0) +
    (usage.seconds / 60) * (price.perMinute ?? 0)
  );
}

export async function adminOverview(now = new Date()) {
  const database = db();
  const since = new Date(now.getTime() - 30 * DAY);
  const month = periodRange({ period: 'month', date: reportingDate(now) })!;
  const [users, rees, sources, questions, earned, revenue, verifications, job, calls, trend, recent] = await Promise.all([
    database.select({ total: count(), disabled: sql<number>`count(*) filter (where ${schema.user.disabledAt} is not null)::int` }).from(schema.user),
    database
      .select({ total: count(), public: sql<number>`count(*) filter (where ${schema.ree.isPublic})::int`, moderated: sql<number>`count(*) filter (where ${schema.ree.moderatedAt} is not null)::int` })
      .from(schema.ree)
      .where(isNull(schema.ree.deletedAt)),
    database.select({ total: count(), ready: sql<number>`count(*) filter (where ${schema.knowledge.status} = 'ready')::int` }).from(schema.knowledge).where(isNull(schema.knowledge.deletedAt)),
    database.select({ total: count() }).from(schema.message).where(and(eq(schema.message.role, 'user'), gte(schema.message.createdAt, since))),
    database
      .select({ sum: sql<number>`coalesce(sum(${schema.creditEntry.delta}), 0)::bigint` })
      .from(schema.creditEntry)
      .where(and(eq(schema.creditEntry.reason, 'query_fee_earned'), gte(schema.creditEntry.createdAt, since))),
    database
      .select({ minor: sql<number>`coalesce(sum(${schema.purchase.amountMinor}), 0)::bigint`, n: count() })
      .from(schema.purchase)
      .where(and(eq(schema.purchase.status, 'paid'), gte(schema.purchase.createdAt, since))),
    pendingVerifications(database),
    runningReembedJob(database),
    database
      .select({
        kind: schema.modelCall.kind,
        model: schema.modelCall.model,
        calls: count(),
        inputTokens: sql<number>`coalesce(sum(${schema.modelCall.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${schema.modelCall.outputTokens}), 0)::bigint`,
        seconds: sql<number>`coalesce(sum(${schema.modelCall.seconds}), 0)::bigint`,
      })
      .from(schema.modelCall)
      .where(and(gte(schema.modelCall.createdAt, new Date(month.start)), sql`${schema.modelCall.createdAt} < ${new Date(month.end)}`))
      .groupBy(schema.modelCall.kind, schema.modelCall.model)
      .orderBy(desc(count())),
    /* Successful answers per reporting day, the last 30 days. */
    database
      .select({
        day: sql<string>`to_char(${schema.creditEntry.createdAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
        n: sql<number>`count(distinct (${schema.creditEntry.refId}, ${schema.creditEntry.reeId}))::int`,
      })
      .from(schema.creditEntry)
      .where(and(eq(schema.creditEntry.reason, 'query_base'), gte(schema.creditEntry.createdAt, new Date(now.getTime() - 30 * DAY))))
      .groupBy(sql`1`),
    listAudit({ q: '', action: 'all', period: 'all', sort: 'newest', size: 5, page: 1 }),
  ]);
  const byDay = new Map(trend.map((row) => [row.day, row.n]));
  const days = Array.from({ length: 30 }, (_, index) => reportingDate(now.getTime() - (29 - index) * DAY)).map((day) => ({ day, answers: byDay.get(day) ?? 0 }));
  const models = await Promise.all(
    MODEL_KINDS.map(async (kind: ModelKind) => {
      const endpoint = await endpointFor(kind);
      const rows = calls.filter((row) => row.kind === kind).map((row) => {
        const usage = { inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), seconds: Number(row.seconds) };
        return { model: row.model, calls: row.calls, ...usage, cost: estimateCost(row.model, usage) };
      });
      const known = rows.filter((row) => row.cost !== null);
      return {
        kind,
        active: endpoint.model,
        source: endpoint.source,
        calls: rows.reduce((sum, row) => sum + row.calls, 0),
        cost: known.length ? known.reduce((sum, row) => sum + row.cost!, 0) : null,
        unpriced: rows.some((row) => row.cost === null),
        rows,
      };
    }),
  );
  return {
    users: users[0]!,
    rees: rees[0]!,
    sources: sources[0]!,
    questions30: questions[0]?.total ?? 0,
    earned30: Number(earned[0]?.sum ?? 0),
    revenue30: { usd: Number(revenue[0]?.minor ?? 0) / 100, payments: revenue[0]?.n ?? 0 },
    pending: { verifications, reembed: job ? 1 : 0, kyc: await pendingKyc(), payouts: await openPayoutCount() },
    trend: days,
    month: { start: reportingDate(month.start), end: reportingDate(month.end - 1) },
    models,
    recent: recent.items,
  };
}
