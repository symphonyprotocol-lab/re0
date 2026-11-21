/**
 * The user-route limits as the console sets them: `USER_RATE_LIMITS` are the
 * defaults, a `rate_limit_setting` row replaces one name's per-minute and
 * per-hour values, and accounts in `rate_limit_exemption` pass every limit
 * (official batch work such as QA runs and cover uploads). The limiter reads
 * both through a short in-process cache, so a change reaches every instance
 * within `RATE_LIMIT_SETTINGS_TTL_MS`; the instance that saved it sees it at
 * once. Every change is audited.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { USER_RATE_LIMITS } from '@/lib/constants';
import { isUuid } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

export type RateLimitName = keyof typeof USER_RATE_LIMITS;
export const RATE_LIMIT_NAMES = Object.keys(USER_RATE_LIMITS) as RateLimitName[];
export const RATE_LIMIT_SETTINGS_TTL_MS = 30_000;
/** Bounds of one window's value, as the table's checks hold them. */
export const RATE_LIMIT_VALUE_BOUNDS = { min: 1, max: 1_000_000 } as const;
const NOTE_MAX = 200;

export interface RateRuleValue {
  windowSeconds: number;
  limit: number;
}

export interface RateLimitRow {
  name: RateLimitName;
  perMinute: number;
  perHour: number;
  defaults: { perMinute: number; perHour: number };
  overridden: boolean;
  updatedAt: string | null;
}

export interface RateLimitExemptionRow {
  userId: string;
  name: string;
  email: string;
  note: string | null;
  createdAt: string;
}

function defaultsOf(name: RateLimitName): { perMinute: number; perHour: number } {
  const rules = USER_RATE_LIMITS[name] as readonly RateRuleValue[];
  return {
    perMinute: rules.find((rule) => rule.windowSeconds === 60)?.limit ?? 0,
    perHour: rules.find((rule) => rule.windowSeconds === 3_600)?.limit ?? 0,
  };
}

function isRateLimitName(value: unknown): value is RateLimitName {
  return typeof value === 'string' && Object.hasOwn(USER_RATE_LIMITS, value);
}

/* ------------------------------------------------------------ the hot path */

interface Snapshot {
  rules: Map<RateLimitName, readonly RateRuleValue[]>;
  exempt: Set<string>;
  expiresAt: number;
}

let cached: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;
/* Bumped by every save, so a read that started before it is not cached after it. */
let generation = 0;

async function load(): Promise<Snapshot> {
  const [settings, exemptions] = await Promise.all([
    db().select().from(schema.rateLimitSetting),
    db().select({ userId: schema.rateLimitExemption.userId }).from(schema.rateLimitExemption),
  ]);
  const rules = new Map<RateLimitName, readonly RateRuleValue[]>();
  for (const row of settings) {
    if (!isRateLimitName(row.name)) continue;
    rules.set(row.name, [
      { windowSeconds: 60, limit: row.perMinute },
      { windowSeconds: 3_600, limit: row.perHour },
    ]);
  }
  return { rules, exempt: new Set(exemptions.map((row) => row.userId)), expiresAt: Date.now() + RATE_LIMIT_SETTINGS_TTL_MS };
}

async function snapshot(): Promise<Snapshot> {
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (loading) return loading;
  const started = generation;
  const pending = load()
    .then((next) => {
      if (started === generation) cached = next;
      return next;
    })
    .finally(() => {
      if (loading === pending) loading = null;
    });
  loading = pending;
  return pending;
}

/** Drops the cache, so the next request reads the tables (after a save here, and in tests). */
export function forgetRateLimitSettings(): void {
  generation += 1;
  cached = null;
  loading = null;
}

/** The windows `rateLimited` counts for `name`, or `null` for an exempt account. */
export async function effectiveRateRules(name: RateLimitName, userId: string | null): Promise<readonly RateRuleValue[] | null> {
  const current = await snapshot();
  if (userId && current.exempt.has(userId)) return null;
  return current.rules.get(name) ?? USER_RATE_LIMITS[name];
}

/* ----------------------------------------------------------------- console */

/** Every limit, stored value or default, for the console page. */
export async function listRateLimits(): Promise<RateLimitRow[]> {
  const rows = await db().select().from(schema.rateLimitSetting);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return RATE_LIMIT_NAMES.map((name) => {
    const defaults = defaultsOf(name);
    const row = byName.get(name);
    return {
      name,
      perMinute: row?.perMinute ?? defaults.perMinute,
      perHour: row?.perHour ?? defaults.perHour,
      defaults,
      overridden: Boolean(row),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
}

export async function listRateLimitExemptions(): Promise<RateLimitExemptionRow[]> {
  const rows = await db()
    .select({
      userId: schema.rateLimitExemption.userId,
      name: schema.user.name,
      email: schema.user.email,
      note: schema.rateLimitExemption.note,
      createdAt: schema.rateLimitExemption.createdAt,
    })
    .from(schema.rateLimitExemption)
    .innerJoin(schema.user, eq(schema.user.id, schema.rateLimitExemption.userId))
    .orderBy(asc(schema.rateLimitExemption.createdAt));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

function validValue(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= RATE_LIMIT_VALUE_BOUNDS.min && (value as number) <= RATE_LIMIT_VALUE_BOUNDS.max;
}

/** Saves one limit's per-minute and per-hour values (`{ perMinute, perHour }`). */
export async function saveRateLimit(administratorId: string, name: string, input: Record<string, unknown>): Promise<RateLimitRow> {
  if (!isRateLimitName(name)) throw new AdminInputError('not_found');
  const { perMinute, perHour } = input;
  if (!validValue(perMinute) || !validValue(perHour) || perMinute > perHour) throw new AdminInputError('invalid_rate_limit');
  await db().transaction(async (tx) => {
    const [before] = await tx.select().from(schema.rateLimitSetting).where(eq(schema.rateLimitSetting.name, name)).for('update');
    await tx
      .insert(schema.rateLimitSetting)
      .values({ name, perMinute, perHour, updatedBy: administratorId })
      .onConflictDoUpdate({ target: schema.rateLimitSetting.name, set: { perMinute, perHour, updatedBy: administratorId, updatedAt: new Date() } });
    await audit(tx, {
      administratorId,
      action: 'rate_limit.update',
      target: name,
      before: before ? { perMinute: before.perMinute, perHour: before.perHour } : { ...defaultsOf(name), default: true },
      after: { perMinute, perHour },
    });
  });
  forgetRateLimitSettings();
  return (await listRateLimits()).find((row) => row.name === name)!;
}

/** Drops one limit's stored values, back to the code default. */
export async function resetRateLimit(administratorId: string, name: string): Promise<RateLimitRow> {
  if (!isRateLimitName(name)) throw new AdminInputError('not_found');
  await db().transaction(async (tx) => {
    const [before] = await tx.delete(schema.rateLimitSetting).where(eq(schema.rateLimitSetting.name, name)).returning();
    if (!before) return;
    await audit(tx, {
      administratorId,
      action: 'rate_limit.reset',
      target: name,
      before: { perMinute: before.perMinute, perHour: before.perHour },
      after: { ...defaultsOf(name), default: true },
    });
  });
  forgetRateLimitSettings();
  return (await listRateLimits()).find((row) => row.name === name)!;
}

/** Exempts an account (`{ userId }` or `{ email }`, optional `note`). Already exempt is fine. */
export async function addRateLimitExemption(administratorId: string, input: Record<string, unknown>): Promise<RateLimitExemptionRow> {
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  if (note && note.length > NOTE_MAX) throw new AdminInputError('invalid_note');
  let userId: string;
  if (isUuid(input.userId)) {
    const [account] = await db().select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, input.userId)).limit(1);
    if (!account) throw new AdminInputError('user_not_found');
    userId = account.id;
  } else if (typeof input.email === 'string' && input.email.trim()) {
    const accounts = await db()
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(sql`lower(${schema.user.email}) = ${input.email.trim().toLowerCase()}`)
      .limit(2);
    if (accounts.length === 0) throw new AdminInputError('user_not_found');
    if (accounts.length > 1) throw new AdminInputError('ambiguous_email');
    userId = accounts[0]!.id;
  } else {
    throw new AdminInputError('user_not_found');
  }
  await db().transaction(async (tx) => {
    const [added] = await tx
      .insert(schema.rateLimitExemption)
      .values({ userId, note, createdBy: administratorId })
      .onConflictDoNothing()
      .returning({ userId: schema.rateLimitExemption.userId });
    if (added) await audit(tx, { administratorId, action: 'rate_limit.exempt.add', target: userId, after: { note } });
  });
  forgetRateLimitSettings();
  return (await listRateLimitExemptions()).find((row) => row.userId === userId)!;
}

export async function removeRateLimitExemption(administratorId: string, userId: string): Promise<void> {
  if (!isUuid(userId)) throw new AdminInputError('not_found');
  await db().transaction(async (tx) => {
    const [removed] = await tx.delete(schema.rateLimitExemption).where(eq(schema.rateLimitExemption.userId, userId)).returning();
    if (!removed) throw new AdminInputError('not_found');
    await audit(tx, { administratorId, action: 'rate_limit.exempt.remove', target: userId, before: { note: removed.note } });
  });
  forgetRateLimitSettings();
}
