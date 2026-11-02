/**
 * The console's purchase records (2.5 "充值记录"): every Plan and Pack
 * payment, every subscription, read-only. Refunds happen in Paddle; the
 * detail shows what the webhook did with them ("webhook 冲回结果").
 */
import { and, asc, count, desc, eq, gte, ilike, or, sql, type SQL } from 'drizzle-orm';
import { periodStart, type PurchasesView } from '@/lib/domain/admin-lists';
import { clampPage, likePattern, type ListResult } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';

export interface PurchaseRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  kind: 'plan' | 'pack';
  quantity: number;
  paddleTransactionId: string;
  status: 'paid' | 'refunded' | 'chargeback';
  amountMinor: number;
  currency: string;
  credits: number;
  reversedCredits: number;
  createdAt: Date;
}

export interface SubscriptionRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  paddleSubscriptionId: string;
  status: 'active' | 'cancelled' | 'expired';
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function search(view: PurchasesView, columns: SQL[]): SQL | undefined {
  if (!view.q) return undefined;
  const pattern = likePattern(view.q);
  return or(ilike(schema.user.name, pattern), ilike(schema.user.email, pattern), ...columns.map((column) => sql`${column} ilike ${pattern}`));
}

export async function listPurchases(view: PurchasesView, options: { all?: boolean } = {}, now = new Date()): Promise<ListResult<PurchaseRow>> {
  const conditions: SQL[] = [];
  if (view.status !== 'all') conditions.push(eq(schema.purchase.status, view.status as PurchaseRow['status']));
  if (view.kind !== 'all') conditions.push(eq(schema.purchase.kind, view.kind as PurchaseRow['kind']));
  const since = periodStart(view.period, now);
  if (since) conditions.push(gte(schema.purchase.createdAt, since));
  const q = search(view, [sql`${schema.purchase.paddleTransactionId}`, sql`${schema.purchase.id}::text`]);
  if (q) conditions.push(q);
  const where = conditions.length ? and(...conditions) : undefined;
  const database = db();
  const [counted] = await database
    .select({ total: count() })
    .from(schema.purchase)
    .innerJoin(schema.user, eq(schema.user.id, schema.purchase.userId))
    .where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  const order = {
    newest: [desc(schema.purchase.createdAt)],
    oldest: [asc(schema.purchase.createdAt)],
    'amount-high': [desc(schema.purchase.amountMinor), desc(schema.purchase.createdAt)],
    'amount-low': [asc(schema.purchase.amountMinor), desc(schema.purchase.createdAt)],
  }[view.sort];
  let query = database
    .select({
      id: schema.purchase.id,
      userId: schema.purchase.userId,
      name: schema.user.name,
      email: schema.user.email,
      kind: schema.purchase.kind,
      quantity: schema.purchase.quantity,
      paddleTransactionId: schema.purchase.paddleTransactionId,
      status: schema.purchase.status,
      amountMinor: schema.purchase.amountMinor,
      currency: schema.purchase.currency,
      credits: schema.purchase.credits,
      reversedCredits: schema.purchase.reversedCredits,
      createdAt: schema.purchase.createdAt,
    })
    .from(schema.purchase)
    .innerJoin(schema.user, eq(schema.user.id, schema.purchase.userId))
    .where(where)
    .orderBy(...order, asc(schema.purchase.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  return { items: await query, total, page, size: view.size };
}

export async function listSubscriptions(view: PurchasesView, options: { all?: boolean } = {}, now = new Date()): Promise<ListResult<SubscriptionRow>> {
  const conditions: SQL[] = [];
  if (view.status !== 'all') conditions.push(eq(schema.subscription.status, view.status as SubscriptionRow['status']));
  const since = periodStart(view.period, now);
  if (since) conditions.push(gte(schema.subscription.createdAt, since));
  const q = search(view, [sql`${schema.subscription.paddleSubscriptionId}`]);
  if (q) conditions.push(q);
  const where = conditions.length ? and(...conditions) : undefined;
  const database = db();
  const [counted] = await database
    .select({ total: count() })
    .from(schema.subscription)
    .innerJoin(schema.user, eq(schema.user.id, schema.subscription.userId))
    .where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = database
    .select({
      id: schema.subscription.id,
      userId: schema.subscription.userId,
      name: schema.user.name,
      email: schema.user.email,
      paddleSubscriptionId: schema.subscription.paddleSubscriptionId,
      status: schema.subscription.status,
      cancelAtPeriodEnd: schema.subscription.cancelAtPeriodEnd,
      currentPeriodStart: schema.subscription.currentPeriodStart,
      currentPeriodEnd: schema.subscription.currentPeriodEnd,
      createdAt: schema.subscription.createdAt,
      updatedAt: schema.subscription.updatedAt,
    })
    .from(schema.subscription)
    .innerJoin(schema.user, eq(schema.user.id, schema.subscription.userId))
    .where(where)
    .orderBy(view.sort === 'oldest' ? asc(schema.subscription.createdAt) : desc(schema.subscription.createdAt), asc(schema.subscription.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  return { items: await query, total, page, size: view.size };
}

export async function purchaseCounts() {
  const database = db();
  const [purchases] = await database
    .select({
      total: count(),
      paid: sql<number>`count(*) filter (where ${schema.purchase.status} = 'paid')::int`,
      refunded: sql<number>`count(*) filter (where ${schema.purchase.status} = 'refunded')::int`,
      chargeback: sql<number>`count(*) filter (where ${schema.purchase.status} = 'chargeback')::int`,
    })
    .from(schema.purchase);
  const [subscriptions] = await database
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${schema.subscription.status} = 'active')::int`,
      cancelled: sql<number>`count(*) filter (where ${schema.subscription.status} = 'cancelled')::int`,
      expired: sql<number>`count(*) filter (where ${schema.subscription.status} = 'expired')::int`,
    })
    .from(schema.subscription);
  return { purchases: purchases!, subscriptions: subscriptions! };
}

/**
 * One payment: the row, its grant, the ledger rows that point at it
 * (purchase, refunds, chargebacks) and every Paddle notification about the
 * transaction, as stored.
 */
export async function purchaseDetail(id: string) {
  const database = db();
  const [row] = await database
    .select({ purchase: schema.purchase, name: schema.user.name, email: schema.user.email })
    .from(schema.purchase)
    .innerJoin(schema.user, eq(schema.user.id, schema.purchase.userId))
    .where(eq(schema.purchase.id, id))
    .limit(1);
  if (!row) return null;
  const txn = row.purchase.paddleTransactionId;
  const [grant, entries, events, debts] = await Promise.all([
    database.select().from(schema.creditGrant).where(eq(schema.creditGrant.purchaseId, id)).limit(1),
    database.select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt)),
    database
      .select({ id: schema.billingEvent.id, eventType: schema.billingEvent.eventType, outcome: schema.billingEvent.outcome, occurredAt: schema.billingEvent.occurredAt, receivedAt: schema.billingEvent.receivedAt, payload: schema.billingEvent.payload })
      .from(schema.billingEvent)
      .where(or(sql`${schema.billingEvent.payload} -> 'data' ->> 'id' = ${txn}`, sql`${schema.billingEvent.payload} -> 'data' ->> 'transaction_id' = ${txn}`))
      .orderBy(asc(schema.billingEvent.receivedAt)),
    database.select().from(schema.creditDebt).where(eq(schema.creditDebt.purchaseId, id)),
  ]);
  return { ...row, grant: grant[0] ?? null, entries, events, debts };
}
