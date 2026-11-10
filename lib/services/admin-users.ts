/**
 * The console's users (rebuild-proposal.md 2.5 "用户"): the list with its
 * combined filters, one user's whole account, disabling and restoring, and
 * manual credit adjustments. Every write is audited; a credit adjustment
 * also leaves the user a notice.
 */
import { and, asc, count, desc, eq, gte, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { parseAdjustment, type AdjustmentBucket } from '@/lib/domain/adjustments';
import { deductFromBucket } from '@/lib/domain/adjustments';
import { periodStart, type UsersView } from '@/lib/domain/admin-lists';
import { clampPage, likePattern, type ListResult } from '@/lib/domain/list';
import type { UserRole } from '@/lib/domain/roles';
import { db, schema } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';
import { addGrant, grantsOf, moveGrants } from '@/lib/services/credits';
import { planStateOf } from '@/lib/services/billing';
import { notify } from '@/lib/services/notices';
import { roleHistory, roleMetrics } from '@/lib/services/roles';
import type { KycState } from '@/lib/domain/kyc';
import { userKycState } from '@/lib/services/kyc';

/* Written qualified: inside drizzle's sql a column renders bare and would bind to the inner table. */
const membership = sql<'active' | 'cancelled' | 'expired' | 'none'>`coalesce((select s.status from ${schema.subscription} s where s.user_id = "user"."id" order by s.updated_at desc limit 1), 'none')`;
const bucket = (source: string) =>
  sql<number>`(select coalesce(sum(g.remaining), 0)::bigint from ${schema.creditGrant} g where g.user_id = "user"."id" and g.source = ${source} and (g.expires_at is null or g.expires_at > now()))`;

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'active' | 'disabled';
  membership: 'active' | 'cancelled' | 'expired' | 'none';
  plan: number;
  pack: number;
  earned: number;
  welcome: number;
  /** The newest `kyc_record`'s status, `none` without one (step 6). */
  kyc: KycState;
  createdAt: Date;
  lastLoginAt: Date | null;
}

function usersWhere(view: UsersView, now: Date): SQL | undefined {
  const conditions: SQL[] = [];
  if (view.status === 'active') conditions.push(isNull(schema.user.disabledAt));
  if (view.status === 'disabled') conditions.push(sql`${schema.user.disabledAt} is not null`);
  if (view.role !== 'all') conditions.push(eq(schema.user.role, view.role));
  if (view.membership !== 'all') conditions.push(sql`${membership} = ${view.membership}`);
  if (view.kyc !== 'all') conditions.push(sql`${userKycState} = ${view.kyc}`);
  const since = periodStart(view.period, now);
  if (since) conditions.push(gte(schema.user.createdAt, since));
  if (view.q) {
    const pattern = likePattern(view.q);
    conditions.push(or(ilike(schema.user.name, pattern), ilike(schema.user.email, pattern), sql`${schema.user.id}::text ilike ${pattern}`)!);
  }
  return conditions.length ? and(...conditions) : undefined;
}

export async function listUsers(view: UsersView, options: { all?: boolean } = {}, now = new Date()): Promise<ListResult<AdminUserRow>> {
  const database = db();
  const where = usersWhere(view, now);
  const [counted] = await database.select({ total: count() }).from(schema.user).where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = database
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      disabledAt: schema.user.disabledAt,
      membership,
      plan: bucket('plan'),
      pack: bucket('pack'),
      earned: bucket('earned'),
      welcome: bucket('welcome'),
      kyc: userKycState,
      createdAt: schema.user.createdAt,
      lastLoginAt: schema.user.lastLoginAt,
    })
    .from(schema.user)
    .where(where)
    .orderBy(view.sort === 'oldest' ? asc(schema.user.createdAt) : desc(schema.user.createdAt), asc(schema.user.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  const rows = await query;
  return {
    items: rows.map(({ disabledAt, plan, pack, earned, welcome, ...row }) => ({
      ...row,
      status: disabledAt ? 'disabled' : 'active',
      plan: Number(plan),
      pack: Number(pack),
      earned: Number(earned),
      welcome: Number(welcome),
    })),
    total,
    page,
    size: view.size,
  };
}

/** The summary cards above the list: whole-catalogue figures, filters ignored. */
export async function userCounts() {
  const [row] = await db()
    .select({
      total: count(),
      disabled: sql<number>`count(*) filter (where ${schema.user.disabledAt} is not null)::int`,
      activePlans: sql<number>`count(*) filter (where ${membership} = 'active')::int`,
      verified: sql<number>`count(*) filter (where ${schema.user.role} = 'verified')::int`,
      official: sql<number>`count(*) filter (where ${schema.user.role} = 'official')::int`,
      kycVerified: sql<number>`count(*) filter (where ${userKycState} = 'verified')::int`,
    })
    .from(schema.user);
  return row ?? { total: 0, disabled: 0, activePlans: 0, verified: 0, official: 0, kycVerified: 0 };
}

export async function adminUser(id: string, now = new Date()) {
  const database = db();
  const [account] = await database.select().from(schema.user).where(eq(schema.user.id, id)).limit(1);
  if (!account) return null;
  const [balances] = await database
    .select({ plan: bucket('plan'), pack: bucket('pack'), earned: bucket('earned'), welcome: bucket('welcome'), membership })
    .from(schema.user)
    .where(eq(schema.user.id, id));
  const [subscription] = await database
    .select()
    .from(schema.subscription)
    .where(eq(schema.subscription.userId, id))
    .orderBy(desc(schema.subscription.updatedAt))
    .limit(1);
  const [debt] = await database
    .select({ remaining: sql<number>`coalesce(sum(${schema.creditDebt.remaining}), 0)::bigint` })
    .from(schema.creditDebt)
    .where(eq(schema.creditDebt.userId, id));
  const plan = await planStateOf(database, id, now);
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    provider: account.provider,
    providerHandle: account.providerHandle,
    role: account.role,
    roleChangedAt: account.roleChangedAt,
    disabledAt: account.disabledAt,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
    balances: {
      plan: Number(balances?.plan ?? 0),
      pack: Number(balances?.pack ?? 0),
      earned: Number(balances?.earned ?? 0),
      welcome: Number(balances?.welcome ?? 0),
    },
    debt: Number(debt?.remaining ?? 0),
    membership: balances?.membership ?? 'none',
    subscription: subscription ?? null,
    planActive: plan.active,
    /** Where the Plan comes from (`paddle` or `redeemed`), and how far redeemed Plans reach. */
    planSource: plan.source,
    redeemedUntil: plan.redeemedUntil,
  };
}
export type AdminUserDetail = NonNullable<Awaited<ReturnType<typeof adminUser>>>;

export async function userRoles(id: string, now = new Date()) {
  const database = db();
  const [metrics, events, requests] = await Promise.all([
    roleMetrics(database, id, now),
    roleHistory(database, id),
    database.select().from(schema.verificationRequest).where(eq(schema.verificationRequest.userId, id)).orderBy(desc(schema.verificationRequest.createdAt)),
  ]);
  return { metrics, events, requests };
}

export async function userEntries(id: string, page: number, size: number) {
  const database = db();
  const where = eq(schema.creditEntry.userId, id);
  const [counted] = await database.select({ total: count() }).from(schema.creditEntry).where(where);
  const total = counted?.total ?? 0;
  const current = clampPage(page, total, size);
  const items = await database
    .select()
    .from(schema.creditEntry)
    .where(where)
    .orderBy(desc(schema.creditEntry.createdAt), desc(schema.creditEntry.id))
    .limit(size)
    .offset((current - 1) * size);
  return { items, total, page: current, size };
}

export async function userPurchases(id: string) {
  const database = db();
  const [purchases, subscriptions] = await Promise.all([
    database.select().from(schema.purchase).where(eq(schema.purchase.userId, id)).orderBy(desc(schema.purchase.createdAt)),
    database.select().from(schema.subscription).where(eq(schema.subscription.userId, id)).orderBy(desc(schema.subscription.updatedAt)),
  ]);
  return { purchases, subscriptions };
}

export async function userRees(id: string) {
  return db()
    .select({
      id: schema.ree.id,
      name: schema.ree.name,
      slug: schema.ree.slug,
      avatarBlob: schema.ree.avatarBlob,
      color: schema.ree.color,
      isPublic: schema.ree.isPublic,
      moderatedAt: schema.ree.moderatedAt,
      deletedAt: schema.ree.deletedAt,
      createdAt: schema.ree.createdAt,
      queryFee: schema.ree.queryFee,
      sources: sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = "ree"."id" and k.deleted_at is null)`,
      readySources: sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = "ree"."id" and k.deleted_at is null and k.status = 'ready')`,
    })
    .from(schema.ree)
    .where(eq(schema.ree.ownerId, id))
    .orderBy(desc(schema.ree.createdAt));
}

/* --------------------------------------------------------------- writes */

/** Disabling signs the user out everywhere; restoring lets them sign in again. */
export async function setUserDisabled(administratorId: string, id: string, disabled: boolean, now = new Date()): Promise<void> {
  await db().transaction(async (tx) => {
    const [account] = await tx.select().from(schema.user).where(eq(schema.user.id, id)).for('update');
    if (!account) throw new AdminInputError('not_found');
    if (Boolean(account.disabledAt) === disabled) throw new AdminInputError('stale');
    await tx.update(schema.user).set({ disabledAt: disabled ? now : null }).where(eq(schema.user.id, id));
    if (disabled) await tx.delete(schema.session).where(eq(schema.session.userId, id));
    await audit(tx, {
      administratorId,
      action: disabled ? 'user.disable' : 'user.restore',
      target: id,
      before: { status: disabled ? 'active' : 'disabled' },
      after: { status: disabled ? 'disabled' : 'active' },
    });
  });
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A grant or deduction on the Pack or Plan bucket. A Plan grant expires with
 * the current period, so it needs an active Plan; a deduction takes only
 * what the bucket has.
 *
 * `requestId` (a UUID the console mints per dialog) becomes the entry's
 * `refId`: a retry or double submit with the same one answers the first
 * adjustment again (`replayed: true`) instead of adjusting twice. The check
 * runs under the user's row lock, so two copies in flight meet there.
 */
export async function adjustCredits(administratorId: string, id: string, raw: Record<string, unknown>, now = new Date()) {
  const input = parseAdjustment(raw);
  if ('error' in input) throw new AdminInputError(input.error);
  if (raw.requestId !== undefined && (typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId))) throw new AdminInputError('request_id');
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.toLowerCase() : null;
  return db().transaction(async (tx) => {
    const [account] = await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, id)).for('update');
    if (!account) throw new AdminInputError('not_found');
    if (requestId) {
      const [earlier] = await tx
        .select({ after: schema.adminAudit.after })
        .from(schema.adminAudit)
        .where(and(eq(schema.adminAudit.action, 'user.credits.adjust'), eq(schema.adminAudit.target, id), sql`${schema.adminAudit.after}->>'entry' = ${requestId}`))
        .limit(1);
      if (earlier) {
        const after = earlier.after as { bucket: AdjustmentBucket; credits: number; adjustment: number; debtPaid: number };
        return { delta: after.adjustment - after.debtPaid, debtPaid: after.debtPaid, bucket: after.bucket, balance: after.credits, replayed: true };
      }
    }
    const grants = await grantsOf(tx, id, true);
    const before = grants.filter((grant) => grant.source === input.bucket && (grant.expiresAt === null || grant.expiresAt > now)).reduce((sum, grant) => sum + grant.remaining, 0);
    const refId = requestId ?? crypto.randomUUID();
    /* A grant pays open debts first (addGrant): the bucket grows by what is left. */
    let debtPaid = 0;
    if (input.direction === 'grant') {
      let expiresAt: Date | null = null;
      let periodStartAt: Date | null = null;
      if (input.bucket === 'plan') {
        /* Paid or redeemed: the grant lasts to the end of the current period either way. */
        const plan = await planStateOf(tx, id, now);
        if (!plan.active) throw new AdminInputError('no_plan');
        expiresAt = plan.periodEnd;
        periodStartAt = plan.periodStart;
      }
      const granted = await addGrant(
        tx,
        { userId: id, source: input.bucket, amount: input.amount, reason: 'admin_adjust', refId, expiresAt, periodStart: periodStartAt, note: input.reason },
        now,
      );
      debtPaid = granted.offset;
    } else {
      const allocations = deductFromBucket(grants, input.bucket, input.amount, now);
      if (!allocations) throw new AdminInputError('insufficient');
      await moveGrants(tx, allocations, -1);
      await tx.insert(schema.creditEntry).values({
        userId: id,
        delta: -input.amount,
        reason: 'admin_adjust',
        refId,
        note: input.reason,
        allocations,
        createdAt: now,
      });
    }
    const adjustment = input.direction === 'grant' ? input.amount : -input.amount;
    const delta = adjustment - debtPaid;
    await audit(tx, {
      administratorId,
      action: 'user.credits.adjust',
      target: id,
      before: { bucket: input.bucket, credits: before },
      after: { bucket: input.bucket, credits: before + delta, adjustment, debtPaid, reason: input.reason, entry: refId },
    });
    await notify(tx, { userId: id, kind: 'credits_adjust', text: input.reason, params: { bucket: input.bucket, delta, debtPaid }, refId });
    return { delta, debtPaid, bucket: input.bucket, balance: before + delta, replayed: false };
  });
}
