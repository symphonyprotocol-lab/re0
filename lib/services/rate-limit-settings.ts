/**
 * The user-route limits as the console sets them: `USER_RATE_LIMITS` are the
 * defaults, a `rate_limit_setting` row replaces one name's per-minute and
 * per-hour values, and an account in `rate_limit_exemption` passes the
 * limits its row names (official batch work such as QA runs and cover
 * uploads), and only those. The limiter reads both through a short
 * in-process cache, so a change reaches every instance within
 * `RATE_LIMIT_SETTINGS_TTL_MS`; the instance that saved it sees it at once.
 * If the tables cannot be read the limiter keeps the code defaults, with no
 * exemptions, and tries again shortly. Every change is audited.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { RATE_LIMIT_EXEMPT_DEFAULT, USER_RATE_LIMITS } from '@/lib/constants';
import { isUuid } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

export type RateLimitName = keyof typeof USER_RATE_LIMITS;
export const RATE_LIMIT_NAMES = Object.keys(USER_RATE_LIMITS) as RateLimitName[];
export const RATE_LIMIT_SETTINGS_TTL_MS = 30_000;
/** After a failed read, the defaults are kept this long before the tables are tried again. */
export const RATE_LIMIT_SETTINGS_RETRY_MS = 5_000;
export const DEFAULT_EXEMPT_LIMITS: readonly RateLimitName[] = RATE_LIMIT_EXEMPT_DEFAULT;
/** Bounds of one window's value, as the table's checks hold them. */
export const RATE_LIMIT_VALUE_BOUNDS = { min: 1, max: 1_000_000 } as const;
const NOTE_MAX = 200;
const MINUTE = 60;
const HOUR = 3_600;

export interface RateRuleValue {
  windowSeconds: number;
  limit: number;
}

export interface RateLimitRow {
  name: RateLimitName;
  /** The code default's windows, as `rateLimited` counts them without a stored row. */
  defaultRules: RateRuleValue[];
  /** Only a limit whose default is exactly one minute and one hour window can be changed here. */
  editable: boolean;
  /** Current values; `null` when not editable. */
  perMinute: number | null;
  perHour: number | null;
  overridden: boolean;
  updatedAt: string | null;
}

export interface RateLimitExemptionRow {
  userId: string;
  name: string;
  email: string;
  limits: RateLimitName[];
  note: string | null;
  createdAt: string;
}

function defaultRulesOf(name: RateLimitName): RateRuleValue[] {
  return (USER_RATE_LIMITS[name] as readonly RateRuleValue[]).map((rule) => ({ windowSeconds: rule.windowSeconds, limit: rule.limit }));
}

/** The default's minute and hour values, or `null` unless its windows are exactly those two. */
function editableDefaults(name: RateLimitName): { perMinute: number; perHour: number } | null {
  const rules = defaultRulesOf(name);
  const windows = rules.map((rule) => rule.windowSeconds).sort((a, b) => a - b);
  if (windows.length !== 2 || windows[0] !== MINUTE || windows[1] !== HOUR) return null;
  return { perMinute: rules.find((rule) => rule.windowSeconds === MINUTE)!.limit, perHour: rules.find((rule) => rule.windowSeconds === HOUR)!.limit };
}

/** The default's own windows, in its order, with the stored values put in. */
function overriddenRules(name: RateLimitName, perMinute: number, perHour: number): RateRuleValue[] {
  return defaultRulesOf(name).map((rule) => ({ windowSeconds: rule.windowSeconds, limit: rule.windowSeconds === MINUTE ? perMinute : perHour }));
}

function isRateLimitName(value: unknown): value is RateLimitName {
  return typeof value === 'string' && Object.hasOwn(USER_RATE_LIMITS, value);
}

function knownLimits(values: readonly string[]): RateLimitName[] {
  return RATE_LIMIT_NAMES.filter((name) => values.includes(name));
}

/* ------------------------------------------------------------ the hot path */

interface Snapshot {
  rules: Map<RateLimitName, readonly RateRuleValue[]>;
  exempt: Map<string, ReadonlySet<RateLimitName>>;
  expiresAt: number;
}

let cached: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;
/* Bumped by every save, so a read that started before it is not cached after it. */
let generation = 0;

async function load(): Promise<Snapshot> {
  try {
    const [settings, exemptions] = await Promise.all([
      db().select().from(schema.rateLimitSetting),
      db().select({ userId: schema.rateLimitExemption.userId, limits: schema.rateLimitExemption.limits }).from(schema.rateLimitExemption),
    ]);
    const rules = new Map<RateLimitName, readonly RateRuleValue[]>();
    for (const row of settings) {
      if (!isRateLimitName(row.name) || !editableDefaults(row.name)) continue;
      rules.set(row.name, overriddenRules(row.name, row.perMinute, row.perHour));
    }
    const exempt = new Map(exemptions.map((row) => [row.userId, new Set(knownLimits(row.limits))] as const));
    return { rules, exempt, expiresAt: Date.now() + RATE_LIMIT_SETTINGS_TTL_MS };
  } catch (error) {
    console.error('rate limit settings unreadable; using the code defaults', error);
    return { rules: new Map(), exempt: new Map(), expiresAt: Date.now() + RATE_LIMIT_SETTINGS_RETRY_MS };
  }
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

/** The windows `rateLimited` counts for `name`, or `null` for an account exempt from `name`. */
export async function effectiveRateRules(name: RateLimitName, userId: string | null): Promise<readonly RateRuleValue[] | null> {
  const current = await snapshot();
  if (userId && current.exempt.get(userId)?.has(name)) return null;
  return current.rules.get(name) ?? USER_RATE_LIMITS[name];
}

/* ----------------------------------------------------------------- console */

/** Every limit, stored value or default, for the console page. */
export async function listRateLimits(): Promise<RateLimitRow[]> {
  const rows = await db().select().from(schema.rateLimitSetting);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return RATE_LIMIT_NAMES.map((name) => {
    const defaults = editableDefaults(name);
    const row = defaults ? byName.get(name) : undefined;
    return {
      name,
      defaultRules: defaultRulesOf(name),
      editable: Boolean(defaults),
      perMinute: row?.perMinute ?? defaults?.perMinute ?? null,
      perHour: row?.perHour ?? defaults?.perHour ?? null,
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
      limits: schema.rateLimitExemption.limits,
      note: schema.rateLimitExemption.note,
      createdAt: schema.rateLimitExemption.createdAt,
    })
    .from(schema.rateLimitExemption)
    .innerJoin(schema.user, eq(schema.user.id, schema.rateLimitExemption.userId))
    .orderBy(asc(schema.rateLimitExemption.createdAt));
  return rows.map((row) => ({ ...row, limits: knownLimits(row.limits), createdAt: row.createdAt.toISOString() }));
}

function validValue(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= RATE_LIMIT_VALUE_BOUNDS.min && (value as number) <= RATE_LIMIT_VALUE_BOUNDS.max;
}

/** Saves one limit's per-minute and per-hour values (`{ perMinute, perHour }`). */
export async function saveRateLimit(administratorId: string, name: string, input: Record<string, unknown>): Promise<RateLimitRow> {
  if (!isRateLimitName(name)) throw new AdminInputError('not_found');
  const defaults = editableDefaults(name);
  if (!defaults) throw new AdminInputError('not_editable');
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
      before: before ? { perMinute: before.perMinute, perHour: before.perHour } : { ...defaults, default: true },
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
      after: { rules: defaultRulesOf(name), default: true },
    });
  });
  forgetRateLimitSettings();
  return (await listRateLimits()).find((row) => row.name === name)!;
}

/**
 * Exempts an account (`{ userId }` or `{ email }`) from the limits in
 * `limits` (default `DEFAULT_EXEMPT_LIMITS`), with an optional `note`. For
 * an account already exempt this replaces its limits (and its note, when
 * one is given).
 */
export async function addRateLimitExemption(administratorId: string, input: Record<string, unknown>): Promise<RateLimitExemptionRow> {
  const note = typeof input.note === 'string' ? input.note.trim() || null : undefined;
  if (note && note.length > NOTE_MAX) throw new AdminInputError('invalid_note');
  let limits: RateLimitName[] | undefined;
  if (input.limits !== undefined) {
    if (!Array.isArray(input.limits) || input.limits.length === 0 || !input.limits.every(isRateLimitName)) throw new AdminInputError('invalid_limits');
    limits = knownLimits(input.limits as string[]);
  }
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
    const [before] = await tx.select().from(schema.rateLimitExemption).where(eq(schema.rateLimitExemption.userId, userId)).for('update');
    if (!before) {
      const next = { limits: limits ?? [...DEFAULT_EXEMPT_LIMITS], note: note ?? null };
      await tx.insert(schema.rateLimitExemption).values({ userId, ...next, createdBy: administratorId });
      await audit(tx, { administratorId, action: 'rate_limit.exempt.add', target: userId, after: next });
      return;
    }
    const next = { limits: limits ?? knownLimits(before.limits), note: note === undefined ? before.note : note };
    await tx.update(schema.rateLimitExemption).set(next).where(eq(schema.rateLimitExemption.userId, userId));
    await audit(tx, { administratorId, action: 'rate_limit.exempt.update', target: userId, before: { limits: before.limits, note: before.note }, after: next });
  });
  forgetRateLimitSettings();
  return (await listRateLimitExemptions()).find((row) => row.userId === userId)!;
}

export async function removeRateLimitExemption(administratorId: string, userId: string): Promise<void> {
  if (!isUuid(userId)) throw new AdminInputError('not_found');
  await db().transaction(async (tx) => {
    const [removed] = await tx.delete(schema.rateLimitExemption).where(eq(schema.rateLimitExemption.userId, userId)).returning();
    if (!removed) throw new AdminInputError('not_found');
    await audit(tx, { administratorId, action: 'rate_limit.exempt.remove', target: userId, before: { limits: removed.limits, note: removed.note } });
  });
  forgetRateLimitSettings();
}
