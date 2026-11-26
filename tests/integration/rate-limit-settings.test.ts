/**
 * The console's rate limits (lib/services/rate-limit-settings.ts): a stored
 * row replaces a limit's code default, a limit without one keeps the
 * default, an exempt account never gets a 429, and only an administrator
 * may read or change any of it through /api/admin/rate-limits.
 */
import { freezeDateAtWindowStart, TEST_DATABASE_URL, uniqueName } from './setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { EXPLORE_RATE_LIMIT, USER_RATE_LIMITS } from '@/lib/constants';
import { POST_DAILY_LIMIT, postDayStart } from '@/lib/domain/post';
import { messages } from '@/i18n';
import { allowSearch } from '@/lib/services/explore';
import { postAllowance, publishPost } from '@/lib/services/posts';
import { publicCopyValues } from '@/lib/services/public-copy';
import * as ceilingsRoute from '@/app/api/admin/rate-limits/ceilings/route';
import { db, schema } from '@/lib/infra/db';
import { rateLimited } from '@/lib/http/rate-limit';
import { openAdminSession } from '@/lib/services/admin';
import {
  addRateLimitExemption,
  ceilingFor,
  effectiveCeiling,
  listCeilings,
  resetCeiling,
  saveCeiling,
  DEFAULT_EXEMPT_LIMITS,
  effectiveRateRules,
  forgetRateLimitSettings,
  listRateLimits,
  RATE_LIMIT_SETTINGS_RETRY_MS,
  RATE_LIMIT_SETTINGS_TTL_MS,
  removeRateLimitExemption,
  resetRateLimit,
  saveRateLimit,
} from '@/lib/services/rate-limit-settings';
import * as limitsRoute from '@/app/api/admin/rate-limits/route';
import * as exemptionsRoute from '@/app/api/admin/rate-limits/exemptions/route';
import * as exemptionRoute from '@/app/api/admin/rate-limits/exemptions/[userId]/route';

const session = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('next/headers', async () => {
  const { ADMIN_SESSION_COOKIE } = await import('@/lib/http/cookies');
  return {
    cookies: async () => ({ get: (name: string) => (name === ADMIN_SESSION_COOKIE && session.token ? { value: session.token } : undefined) }),
    headers: async () => new Headers(),
  };
});

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const base = 'http://localhost:3000';
const users: string[] = [];
let administratorId: string;

async function account(): Promise<{ id: string; email: string }> {
  const subject = uniqueName('limits');
  const email = `${subject}@example.test`;
  const [user] = await db().insert(schema.user).values({ name: 'Limits', email, provider: 'github', providerSubject: subject }).returning();
  users.push(user!.id);
  return { id: user!.id, email };
}

const caller = (userId: string) => ({ userId, headers: new Headers() });

function request(path: string, method: string, payload?: unknown, origin = base) {
  return new NextRequest(`${base}${path}`, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

suite('console rate limits and exemptions', () => {
  beforeAll(async () => {
    const [admin] = await db().insert(schema.administrator).values({ name: 'Limits', email: `${uniqueName('limits-admin')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' }).returning({ id: schema.administrator.id });
    administratorId = admin!.id;
    vi.stubEnv('APP_BASE_URL', base);
  });
  beforeEach(async () => {
    await db().delete(schema.limitCeilingSetting);
    await db().delete(schema.rateLimitSetting);
    await db().delete(schema.rateLimitExemption);
    forgetRateLimitSettings();
    freezeDateAtWindowStart(60);
  });
  afterEach(() => {
    vi.useRealTimers();
    session.token = null;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db().delete(schema.limitCeilingSetting);
    await db().delete(schema.rateLimitSetting);
    await db().delete(schema.rateLimitExemption);
    forgetRateLimitSettings();
    await db().delete(schema.rateBucket).where(like(schema.rateBucket.key, '%:user:%'));
    await db().delete(schema.rateBucket).where(like(schema.rateBucket.key, 'explore:ip:203.0.113.%'));
    if (users.length) await db().delete(schema.post).where(inArray(schema.post.userId, users));
    await db().delete(schema.adminAudit).where(eq(schema.adminAudit.administratorId, administratorId));
    await db().delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
    if (users.length) await db().delete(schema.user).where(inArray(schema.user.id, users));
  });

  it('uses the code defaults while nothing is stored', async () => {
    const { id } = await account();
    expect(await effectiveRateRules('uploadToken', id)).toEqual(USER_RATE_LIMITS.uploadToken);
    const perMinute = USER_RATE_LIMITS.domainVerify[0].limit;
    for (let i = 0; i < perMinute; i += 1) expect(await rateLimited('domainVerify', caller(id))).toBeNull();
    expect((await rateLimited('domainVerify', caller(id)))?.status).toBe(429);
  });

  it('counts against a stored override, and goes back to the default on reset', async () => {
    const { id } = await account();
    await saveRateLimit(administratorId, 'uploadToken', { perMinute: 2, perHour: 3 });
    expect(await rateLimited('uploadToken', caller(id))).toBeNull();
    expect(await rateLimited('uploadToken', caller(id))).toBeNull();
    const limited = await rateLimited('uploadToken', caller(id));
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);

    // Raised above the default: an account past the default minute window still goes ahead.
    const other = await account();
    const defaultMinute = USER_RATE_LIMITS.uploadToken[0].limit;
    await db().insert(schema.rateBucket).values({ key: `uploadToken:60:user:${other.id}`, windowStart: new Date(), hits: defaultMinute });
    await saveRateLimit(administratorId, 'uploadToken', { perMinute: defaultMinute + 10, perHour: 10_000 });
    expect(await rateLimited('uploadToken', caller(other.id))).toBeNull();

    await resetRateLimit(administratorId, 'uploadToken');
    expect(await effectiveRateRules('uploadToken', other.id)).toEqual(USER_RATE_LIMITS.uploadToken);
    expect((await rateLimited('uploadToken', caller(other.id)))?.status).toBe(429);

    const actions = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(and(eq(schema.adminAudit.administratorId, administratorId), eq(schema.adminAudit.target, 'uploadToken')));
    expect(actions.map((row) => row.action).sort()).toEqual(['rate_limit.reset', 'rate_limit.update', 'rate_limit.update']);
  });

  it('refuses values out of bounds or a minute above the hour', async () => {
    for (const input of [{ perMinute: 0, perHour: 10 }, { perMinute: 5, perHour: 4 }, { perMinute: 1.5, perHour: 10 }, { perMinute: '5', perHour: 10 }]) {
      await expect(saveRateLimit(administratorId, 'comment', input)).rejects.toMatchObject({ code: 'invalid_rate_limit' });
    }
    await expect(saveRateLimit(administratorId, 'nope', { perMinute: 1, perHour: 1 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets an exempt account through the limits it covers without counting it', async () => {
    const exempt = await account();
    const counted = await account();
    const all = Object.keys(USER_RATE_LIMITS) as (keyof typeof USER_RATE_LIMITS)[];
    await saveRateLimit(administratorId, 'comment', { perMinute: 1, perHour: 1 });
    await addRateLimitExemption(administratorId, { userId: exempt.id, limits: all, note: 'official' });
    for (let i = 0; i < 5; i += 1) {
      for (const name of all) expect(await rateLimited(name, caller(exempt.id))).toBeNull();
    }
    const buckets = await db().select().from(schema.rateBucket).where(like(schema.rateBucket.key, `%:user:${exempt.id}`));
    expect(buckets).toEqual([]);
    expect(await rateLimited('comment', caller(counted.id))).toBeNull();
    expect((await rateLimited('comment', caller(counted.id)))?.status).toBe(429);
  });

  it('scopes an exemption: uploads by default, while a model-cost limit like ask still counts', async () => {
    const official = await account();
    const added = await addRateLimitExemption(administratorId, { userId: official.id });
    expect(added.limits).toEqual([...DEFAULT_EXEMPT_LIMITS]);
    await saveRateLimit(administratorId, 'uploadToken', { perMinute: 1, perHour: 1 });
    await saveRateLimit(administratorId, 'ask', { perMinute: 1, perHour: 1 });
    for (let i = 0; i < 3; i += 1) expect(await rateLimited('uploadToken', caller(official.id))).toBeNull();
    expect(await rateLimited('ask', caller(official.id))).toBeNull();
    expect((await rateLimited('ask', caller(official.id)))?.status).toBe(429);

    // Widening the scope replaces it, audited as an update.
    const widened = await addRateLimitExemption(administratorId, { userId: official.id, limits: ['ask', 'uploadToken'] });
    expect(widened.limits).toEqual(['ask', 'uploadToken']);
    expect(await rateLimited('ask', caller(official.id))).toBeNull();
    expect((await rateLimited('browse', caller(official.id)))).toBeNull();
    await expect(addRateLimitExemption(administratorId, { userId: official.id, limits: [] })).rejects.toMatchObject({ code: 'invalid_limits' });
    await expect(addRateLimitExemption(administratorId, { userId: official.id, limits: ['nope'] })).rejects.toMatchObject({ code: 'invalid_limits' });
    const actions = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(eq(schema.adminAudit.target, official.id));
    expect(actions.map((row) => row.action).sort()).toEqual(['rate_limit.exempt.add', 'rate_limit.exempt.update']);
  });

  it('finds the account by email, ignoring case, and refuses an unknown or shared email', async () => {
    const target = await account();
    const added = await addRateLimitExemption(administratorId, { email: `  ${target.email.toUpperCase()} ` });
    expect(added.userId).toBe(target.id);
    await expect(addRateLimitExemption(administratorId, { email: 'nobody-here@example.test' })).rejects.toMatchObject({ code: 'user_not_found' });
    await expect(addRateLimitExemption(administratorId, {})).rejects.toMatchObject({ code: 'user_not_found' });

    const shared = `${uniqueName('shared')}@example.test`;
    for (const casing of [shared, shared.toUpperCase()]) {
      const [row] = await db().insert(schema.user).values({ name: 'Shared', email: casing, provider: 'github', providerSubject: uniqueName('shared') }).returning();
      users.push(row!.id);
    }
    await expect(addRateLimitExemption(administratorId, { email: shared })).rejects.toMatchObject({ code: 'ambiguous_email' });
  });

  it('answers 404 for removing an exemption that is not there', async () => {
    const target = await account();
    await expect(removeRateLimitExemption(administratorId, target.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeRateLimitExemption(administratorId, 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    session.token = (await openAdminSession(administratorId)).token;
    const response = await exemptionRoute.DELETE(request(`/api/admin/rate-limits/exemptions/${target.id}`, 'DELETE'), { params: Promise.resolve({ userId: target.id }) });
    expect(response.status).toBe(404);
  });

  it('falls back to the code defaults, with no exemptions, when the tables cannot be read', async () => {
    const exempt = await account();
    await addRateLimitExemption(administratorId, { userId: exempt.id, limits: ['domainVerify'] });
    await saveRateLimit(administratorId, 'domainVerify', { perMinute: 1, perHour: 1 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db().execute(sql`alter table rate_limit_exemption rename to rate_limit_exemption_hidden`);
    try {
      forgetRateLimitSettings();
      expect(await effectiveRateRules('domainVerify', exempt.id)).toEqual(USER_RATE_LIMITS.domainVerify);
      const perMinute = USER_RATE_LIMITS.domainVerify[0].limit;
      for (let i = 0; i < perMinute; i += 1) expect(await rateLimited('domainVerify', caller(exempt.id))).toBeNull();
      expect((await rateLimited('domainVerify', caller(exempt.id)))?.status).toBe(429);
      expect(errors).toHaveBeenCalled();
    } finally {
      await db().execute(sql`alter table rate_limit_exemption_hidden rename to rate_limit_exemption`);
      errors.mockRestore();
    }
    // The failure is kept only briefly: once the retry delay passes, the stored values are back.
    vi.setSystemTime(new Date(Date.now() + RATE_LIMIT_SETTINGS_RETRY_MS + 1));
    expect(await effectiveRateRules('domainVerify', exempt.id)).toBeNull();
  });

  it('picks up a value stored elsewhere once the cache expires, without being told', async () => {
    const { id } = await account();
    expect(await effectiveRateRules('comment', id)).toEqual(USER_RATE_LIMITS.comment);
    // Another instance saved it: the row is there, this instance's cache was not cleared.
    await db().insert(schema.rateLimitSetting).values({ name: 'comment', perMinute: 2, perHour: 3 });
    vi.setSystemTime(new Date(Date.now() + RATE_LIMIT_SETTINGS_TTL_MS - 1_000));
    expect(await effectiveRateRules('comment', id)).toEqual(USER_RATE_LIMITS.comment);
    vi.setSystemTime(new Date(Date.now() + 2_000));
    expect(await effectiveRateRules('comment', id)).toEqual([{ windowSeconds: 60, limit: 2 }, { windowSeconds: 3_600, limit: 3 }]);
  });

  it('keeps the default window set and never reports a missing window as zero', async () => {
    const limits = await listRateLimits();
    for (const row of limits) {
      expect(row.defaultRules).toEqual(USER_RATE_LIMITS[row.name].map((rule) => ({ ...rule })));
      if (row.editable) {
        expect(row.perMinute).toBeGreaterThan(0);
        expect(row.perHour).toBeGreaterThan(0);
      } else {
        expect(row.perMinute).toBeNull();
      }
    }
    const saved = await saveRateLimit(administratorId, 'browse', { perMinute: 9, perHour: 99 });
    expect(saved).toMatchObject({ editable: true, overridden: true, perMinute: 9, perHour: 99 });
    expect(await effectiveRateRules('browse', null)).toEqual(USER_RATE_LIMITS.browse.map((rule) => ({ windowSeconds: rule.windowSeconds, limit: rule.windowSeconds === 60 ? 9 : 99 })));
  });

  it('answers only an administrator, and only from the same origin', async () => {
    const target = await account();
    const userContext = { params: Promise.resolve({ userId: target.id }) };

    expect((await limitsRoute.GET(request('/api/admin/rate-limits', 'GET'))).status).toBe(401);
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 1, perHour: 1 }))).status).toBe(401);
    expect((await limitsRoute.DELETE(request('/api/admin/rate-limits', 'DELETE', { name: 'browse' }))).status).toBe(401);
    expect((await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { userId: target.id }))).status).toBe(401);
    expect((await exemptionRoute.DELETE(request(`/api/admin/rate-limits/exemptions/${target.id}`, 'DELETE'), userContext)).status).toBe(401);
    expect(await db().select().from(schema.rateLimitSetting)).toEqual([]);
    expect(await db().select().from(schema.rateLimitExemption)).toEqual([]);

    session.token = (await openAdminSession(administratorId)).token;
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 1, perHour: 1 }, 'https://attacker.test'))).status).toBe(403);
    expect((await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { userId: target.id }, 'https://attacker.test'))).status).toBe(403);
    expect(await db().select().from(schema.rateLimitSetting)).toEqual([]);

    const saved = await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 7, perHour: 70 }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).limit).toMatchObject({ name: 'browse', perMinute: 7, perHour: 70, overridden: true });
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 0, perHour: 70 }))).status).toBe(422);
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'nope', perMinute: 1, perHour: 1 }))).status).toBe(404);

    const added = await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { email: target.email, note: 'RE0 Official' }));
    expect(added.status).toBe(200);
    expect((await added.json()).exemption).toMatchObject({ userId: target.id, email: target.email, note: 'RE0 Official' });
    expect((await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { email: 'nobody@example.test' }))).status).toBe(404);

    const read = await (await limitsRoute.GET(request('/api/admin/rate-limits', 'GET'))).json();
    expect(read.limits.find((row: { name: string }) => row.name === 'browse')).toMatchObject({ perMinute: 7, perHour: 70, defaultRules: USER_RATE_LIMITS.browse.map((rule) => ({ ...rule })) });
    expect(read.limits.find((row: { name: string }) => row.name === 'ask')).toMatchObject({ overridden: false, perMinute: USER_RATE_LIMITS.ask[0].limit });
    expect(read.exemptions.map((row: { userId: string }) => row.userId)).toEqual([target.id]);

    expect((await exemptionRoute.DELETE(request(`/api/admin/rate-limits/exemptions/${target.id}`, 'DELETE'), userContext)).status).toBe(200);
    expect((await exemptionRoute.DELETE(request(`/api/admin/rate-limits/exemptions/${target.id}`, 'DELETE'), userContext)).status).toBe(404);
    const reset = await limitsRoute.DELETE(request('/api/admin/rate-limits', 'DELETE', { name: 'browse' }));
    expect((await reset.json()).limit).toMatchObject({ overridden: false, perMinute: USER_RATE_LIMITS.browse[0].limit });

    const audited = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(eq(schema.adminAudit.target, target.id));
    expect(audited.map((row) => row.action).sort()).toEqual(['rate_limit.exempt.add', 'rate_limit.exempt.remove']);
  });

  /** `count` posts by `userId`, made at `at`: refused ones, so they count against the day but no sweep picks them up. */
  async function postsAt(userId: string, count: number, at: Date) {
    await db()
      .insert(schema.post)
      .values(Array.from({ length: count }, (_, index) => ({ userId, source: 'post' as const, visibility: 'public' as const, question: `Ceiling ${index}`, lang: 'en' as const, status: 'rejected' as const, createdAt: at })));
  }

  it('daily ceilings: the code defaults while nothing is stored, everywhere they are shown', async () => {
    const { id } = await account();
    expect((await listCeilings()).every((row) => !row.overridden && row.value === row.defaultValue)).toBe(true);
    expect(await effectiveCeiling('postsPerDay')).toBe(POST_DAILY_LIMIT);
    expect((await postAllowance(id)).dailyLimit).toBe(POST_DAILY_LIMIT);
    expect((await publicCopyValues(messages('en'), 'en')).postDailyLimit).toBe(String(POST_DAILY_LIMIT));
  });

  it('daily ceilings: a stored value is what posting, the composer and the public copy use; reset goes back', async () => {
    const { id } = await account();
    await postsAt(id, 2, new Date());
    expect((await publishPost(id, { question: 'Under the default ceiling, refused only for credits', lang: 'en' }))).toMatchObject({ ok: false, error: 'insufficient_credits' });
    await saveCeiling(administratorId, { key: 'postsPerDay', value: 2 });
    expect(await publishPost(id, { question: 'Past the stored ceiling', lang: 'en' })).toEqual({ ok: false, error: 'daily_limit' });
    expect(await postAllowance(id)).toMatchObject({ postedToday: 2, dailyLimit: 2 });
    expect((await publicCopyValues(messages('en'), 'en')).postDailyLimit).toBe('2');

    await saveCeiling(administratorId, { key: 'postsPerDay', value: 3 });
    expect(await publishPost(id, { question: 'Raised again', lang: 'en' })).toMatchObject({ ok: false, error: 'insufficient_credits' });
    await resetCeiling(administratorId, { key: 'postsPerDay' });
    expect((await postAllowance(id)).dailyLimit).toBe(POST_DAILY_LIMIT);
    const actions = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(and(eq(schema.adminAudit.administratorId, administratorId), eq(schema.adminAudit.target, 'postsPerDay')));
    expect(actions.map((row) => row.action).sort()).toEqual(['rate_limit.ceiling.reset', 'rate_limit.ceiling.update', 'rate_limit.ceiling.update']);
  });

  it('daily ceilings: only a `post` exemption lifts posts and follow-ups a day; none lifts Explore questions', async () => {
    const { id } = await account();
    const others = Object.keys(USER_RATE_LIMITS).filter((name) => name !== 'post');
    await addRateLimitExemption(administratorId, { userId: id, limits: others });
    await saveCeiling(administratorId, { key: 'postsPerDay', value: 1 });
    await postsAt(id, 1, new Date());
    expect(await publishPost(id, { question: 'Exempt from everything but post, still counted', lang: 'en' })).toEqual({ ok: false, error: 'daily_limit' });
    expect(await ceilingFor('followupsPerDay', id)).toBe(await effectiveCeiling('followupsPerDay'));

    await addRateLimitExemption(administratorId, { userId: id, limits: ['post'] });
    expect(await publishPost(id, { question: 'Exempt from post: past the ceiling, refused only for credits', lang: 'en' })).toMatchObject({ ok: false, error: 'insufficient_credits' });
    expect((await postAllowance(id)).dailyLimit).toBeNull();
    for (const key of ['postsPerDay', 'followupsPerDay', 'followupsPerPostPerDay'] as const) expect(await ceilingFor(key, id)).toBeNull();
    await addRateLimitExemption(administratorId, { userId: id, limits: Object.keys(USER_RATE_LIMITS) });
    expect(await ceilingFor('exploreQuestions', id)).toBe(EXPLORE_RATE_LIMIT.perUser);
    expect((await listCeilings()).map((row) => [row.key, row.exemptedBy])).toEqual([
      ['postsPerDay', 'post'], ['followupsPerDay', 'post'], ['followupsPerPostPerDay', 'post'], ['exploreQuestions', null], ['visitorAsksPerDay', null],
      ['workspaceWritesPerDay', null], ['workspaceDebtLimit', null], ['workspaceFreeMb', null], ['workspaceIndexBudget', null],
      ['publishFileMaxMb', null], ['publishMaxFiles', null], ['publishFreeMbMonth', null], ['publishDailyMb', null], ['publishFileDailyMb', null],
    ]);
  });

  it('a day restarts at 00:00 UTC, whatever the session time zone', async () => {
    const { id } = await account();
    const now = new Date('2026-11-24T00:30:00Z');
    expect(postDayStart(now)).toBe('2026-11-24T00:00:00Z');
    await postsAt(id, 3, new Date('2026-11-23T23:59:00Z'));
    await postsAt(id, 1, new Date('2026-11-24T00:01:00Z'));
    expect((await postAllowance(id, now)).postedToday).toBe(1);
    const [row] = await db().transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'Asia/Shanghai'`);
      return tx
        .select({ today: sql<number>`count(*) filter (where ${schema.post.createdAt} >= ${postDayStart(now)}::timestamptz)::int` })
        .from(schema.post)
        .where(eq(schema.post.userId, id));
    });
    expect(row!.today).toBe(1);
  });

  it('Explore questions: the stored per-minute ceiling applies to the account and the address', async () => {
    const { id } = await account();
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    expect(await effectiveCeiling('exploreQuestions')).toBe(EXPLORE_RATE_LIMIT.perUser);
    await saveCeiling(administratorId, { key: 'exploreQuestions', value: 2 });
    expect(await allowSearch({ ip: null, userId: id })).toBe(true);
    expect(await allowSearch({ ip: null, userId: id })).toBe(true);
    expect(await allowSearch({ ip: null, userId: id })).toBe(false);
    expect(await allowSearch({ ip, userId: null })).toBe(true);
    expect(await allowSearch({ ip, userId: null })).toBe(true);
    expect(await allowSearch({ ip, userId: null })).toBe(false);
  });

  it('daily ceilings: values out of bounds are refused, and an unreadable table falls back to the defaults', async () => {
    for (const value of [0, 100_001, 1.5, '5']) {
      await expect(saveCeiling(administratorId, { key: 'postsPerDay', value })).rejects.toMatchObject({ code: 'invalid_ceiling' });
    }
    await expect(saveCeiling(administratorId, { key: 'nope', value: 5 })).rejects.toMatchObject({ code: 'not_found' });
    await saveCeiling(administratorId, { key: 'postsPerDay', value: 7 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db().execute(sql`alter table limit_ceiling_setting rename to limit_ceiling_setting_hidden`);
    try {
      forgetRateLimitSettings();
      expect(await effectiveCeiling('postsPerDay')).toBe(POST_DAILY_LIMIT);
      expect(errors).toHaveBeenCalled();
    } finally {
      await db().execute(sql`alter table limit_ceiling_setting_hidden rename to limit_ceiling_setting`);
      errors.mockRestore();
    }
    vi.setSystemTime(new Date(Date.now() + RATE_LIMIT_SETTINGS_RETRY_MS + 1));
    expect(await effectiveCeiling('postsPerDay')).toBe(7);
  });

  it('daily ceilings through the API: administrators only, same origin, bounds, unknown keys', async () => {
    const put = (payload: unknown, origin = base) => ceilingsRoute.PUT(request('/api/admin/rate-limits/ceilings', 'PUT', payload, origin));
    expect((await put({ key: 'postsPerDay', value: 50 })).status).toBe(401);
    expect((await ceilingsRoute.DELETE(request('/api/admin/rate-limits/ceilings', 'DELETE', { key: 'postsPerDay' }))).status).toBe(401);
    expect(await db().select().from(schema.limitCeilingSetting)).toEqual([]);
    session.token = (await openAdminSession(administratorId)).token;
    expect((await put({ key: 'postsPerDay', value: 50 }, 'https://attacker.test')).status).toBe(403);
    expect((await put({ key: 'postsPerDay', value: 0 })).status).toBe(422);
    expect((await put({ key: 'nope', value: 5 })).status).toBe(404);
    const saved = await put({ key: 'postsPerDay', value: 50 });
    expect(saved.status).toBe(200);
    expect((await saved.json()).ceiling).toMatchObject({ key: 'postsPerDay', value: 50, defaultValue: POST_DAILY_LIMIT, per: 'day', overridden: true });
    const read = await (await limitsRoute.GET(request('/api/admin/rate-limits', 'GET'))).json();
    expect(read.ceilings.find((row: { key: string }) => row.key === 'postsPerDay')).toMatchObject({ value: 50, overridden: true });
    const reset = await ceilingsRoute.DELETE(request('/api/admin/rate-limits/ceilings', 'DELETE', { key: 'postsPerDay' }));
    expect((await reset.json()).ceiling).toMatchObject({ value: POST_DAILY_LIMIT, overridden: false });
  });
});
