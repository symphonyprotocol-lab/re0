/**
 * Site-wide traffic (console 「流量」): the beacon route counts same-origin
 * page views of people's browsers only -- not crawlers, not the console --
 * after the visitor-cookie handshake, within an IP limit; a visit lands
 * once (concurrent beacons included) and later views inherit its source;
 * the daily rollup is idempotent and the report reads the same figures
 * before and after it; raw views past retention are deleted, their days
 * kept in the rollup.
 */
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/http/cookies';
import { VISITOR_COOKIE } from '@/lib/http/share';
import { consoleAdministrator } from '../fixtures/console-administrator';

let token: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const { db, schema } = await import('@/lib/infra/db');
const { sessionTokenHash } = await import('@/lib/services/auth');
const traffic = await import('@/lib/services/traffic');
const { POST: view } = await import('@/app/api/track/view/route');
const { GET: cron } = await import('@/app/api/cron/traffic/route');
const { dayStart } = await import('@/lib/domain/statistics');

const BASE = 'http://localhost:3000';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DAY = 86_400_000;

function beacon(body: Record<string, unknown>, options: { origin?: string | null; visitor?: string; agent?: string; ip?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'user-agent': options.agent ?? BROWSER, 'x-real-ip': options.ip ?? `198.51.100.${Math.floor(Math.random() * 250)}` });
  if (options.origin !== null) headers.set('origin', options.origin ?? BASE);
  if (options.visitor) headers.set('cookie', `${VISITOR_COOKIE}=${options.visitor}`);
  return view(new NextRequest(`${BASE}/api/track/view`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

const viewsOf = (visitorId: string) => db().select().from(schema.siteView).where(eq(schema.siteView.visitorId, visitorId)).orderBy(schema.siteView.createdAt);

/** One view at a fixed moment, straight into the service. */
const at = (visitorId: string, iso: string, path: string, referrer = '', utmSource?: string) =>
  traffic.recordPageView({ path, referrer, utmSource, utmMedium: null, utmCampaign: null, visitorId, freshVisitor: false, userId: null, ip: null, ownHosts: ['re0.test'] }, new Date(iso));

suite('traffic beacon route', () => {
  beforeEach(() => {
    token = undefined;
  });

  it('refuses another origin and stores nothing', async () => {
    const visitor = randomUUID();
    expect((await beacon({ path: '/' }, { origin: 'https://attacker.test', visitor })).status).toBe(403);
    expect((await beacon({ path: '/' }, { origin: null, visitor })).status).toBe(403);
    expect(await viewsOf(visitor)).toHaveLength(0);
  });

  it('ignores crawlers, link previews, the console and API paths, without storing or setting a cookie', async () => {
    const visitor = randomUUID();
    for (const agent of ['Twitterbot/1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0', '']) {
      const response = await beacon({ path: '/' }, { agent, visitor });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: 'ignored' });
    }
    for (const path of ['/admin', '/admin/traffic', '/api/explore', 42]) {
      const response = await beacon({ path });
      expect(await response.json()).toEqual({ result: 'ignored' });
      expect(response.cookies.get(VISITOR_COOKIE)).toBeUndefined();
    }
    expect(await viewsOf(visitor)).toHaveLength(0);
    expect((await beacon({}, { visitor })).status).toBe(200);
  });

  it('hands a new browser a cookie first, then counts the view once, normalised, with its source', async () => {
    const first = await beacon({ path: '/en?utm_source=x', referrer: 'https://t.co/abc', utm_source: 'X', utm_medium: 'Social', utm_campaign: 'Launch Week' });
    expect(await first.json()).toEqual({ result: 'cookie' });
    const visitor = first.cookies.get(VISITOR_COOKIE)?.value;
    expect(visitor).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.cookies.get(VISITOR_COOKIE)?.httpOnly).toBe(true);
    expect(await viewsOf(visitor!)).toHaveLength(0);

    const second = await beacon({ path: '/en?utm_source=x', referrer: 'https://t.co/abc', utm_source: 'X', utm_medium: 'Social', utm_campaign: 'Launch Week' }, { visitor });
    expect(await second.json()).toEqual({ result: 'recorded' });
    expect(second.cookies.get(VISITOR_COOKIE)).toBeUndefined();
    // A client-side move: the referrer is the page it came from, on this site.
    await beacon({ path: '/zh/r/Some-Ree', referrer: `${BASE}/en` }, { visitor });

    const rows = await viewsOf(visitor!);
    expect(rows.map(({ path, pageKind, landing, source }) => ({ path, pageKind, landing, source }))).toEqual([
      { path: '/', pageKind: 'home', landing: true, source: 'twitter' },
      { path: '/r/some-ree', pageKind: 'ree', landing: false, source: 'twitter' },
    ]);
    expect(rows[0]).toMatchObject({ referrerHost: 't.co', utmSource: 'x', utmMedium: 'social', utmCampaign: 'Launch Week', userId: null });
    expect(rows[1]).toMatchObject({ referrerHost: null, utmSource: null });
    // No IP or user agent column exists to be filled.
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'id', 'landing', 'pageKind', 'path', 'referrerHost', 'source', 'userId', 'utmCampaign', 'utmMedium', 'utmSource', 'visitorId']);
  });

  it('records the signed-in user', async () => {
    const subject = uniqueName('traffic');
    const [user] = await db().insert(schema.user).values({ name: 'Traffic', email: `${subject}@example.test`, provider: 'github', providerSubject: subject }).returning();
    token = randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: user!.id, expiresAt: new Date(Date.now() + 60_000) });
    const visitor = randomUUID();
    expect(await (await beacon({ path: '/pricing' }, { visitor })).json()).toEqual({ result: 'recorded' });
    expect((await viewsOf(visitor))[0]).toMatchObject({ userId: user!.id, source: 'direct', pageKind: 'pricing' });
  });

  it('limits one IP per minute, storing nothing past it', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await db().insert(schema.rateBucket).values({ key: `traffic:ip:${ip}`, windowStart, hits: traffic.TRAFFIC_IP_PER_MINUTE }).onConflictDoUpdate({ target: [schema.rateBucket.key, schema.rateBucket.windowStart], set: { hits: traffic.TRAFFIC_IP_PER_MINUTE } });
    const visitor = randomUUID();
    const response = await beacon({ path: '/' }, { ip, visitor });
    expect(response.status).toBe(429);
    expect(await viewsOf(visitor)).toHaveLength(0);
    expect((await beacon({ path: '/' }, { visitor })).status).toBe(200);
  });

  it('lands one visit when beacons of a new visit arrive at once', async () => {
    const visitor = randomUUID();
    const now = new Date();
    await Promise.all(['/', '/explore', '/pricing', '/about', '/r/a'].map((path) => traffic.recordPageView({ path, referrer: 'https://www.google.com/', utmSource: null, utmMedium: null, utmCampaign: null, visitorId: visitor, freshVisitor: false, userId: null, ip: null, ownHosts: ['localhost'] }, now)));
    const rows = await viewsOf(visitor);
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.landing)).toHaveLength(1);
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(['google']));
  });
});

suite('traffic rollup and report', () => {
  /* Days far from the route tests' "now", so the rollup and the report only see these. UTC+8: 02:00Z is 10:00. */
  const D1 = '2026-06-01';
  const D2 = '2026-06-02';
  const NOW = new Date('2026-06-05T04:00:00Z');
  const range = { start: dayStart(D1), end: dayStart(D2) + DAY };
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    await db().delete(schema.siteTrafficDay);
    await db().delete(schema.siteTrafficLanding);
    await db().delete(schema.siteTrafficRollup);
    await db().delete(schema.siteView).where(lt(schema.siteView.createdAt, new Date('2026-07-01T00:00:00Z')));
    // A: from a tweet, on through the site.
    await at(a, '2026-06-01T02:00:00Z', '/r/alpha', 'https://t.co/x');
    await at(a, '2026-06-01T02:05:00Z', '/explore', 'https://re0.test/r/alpha');
    await at(a, '2026-06-01T02:10:00Z', '/en/r/beta', 'https://re0.test/explore');
    // B: a tweet link with utm and no referrer; later, a new visit from Google.
    await at(b, '2026-06-01T03:00:00Z', '/', '', 'twitter');
    await at(b, '2026-06-01T04:00:00Z', '/pricing', 'https://www.google.com/');
    // C: typed the address.
    await at(c, '2026-06-01T03:30:00Z', '/zh');
    // A again after a long pause, moving inside the site, across midnight UTC+8.
    await at(a, '2026-06-01T15:50:00Z', '/explore', 'https://re0.test/r/beta');
    await at(a, '2026-06-01T16:10:00Z', '/r/alpha', 'https://re0.test/explore');
  });

  const expected = {
    totals: { views: 8, visitors: 3, inbound: 4, internal: 1, exactVisitors: true },
    trend: { unit: 'day', points: [{ day: D1, views: 7, visitors: 3, inbound: 4 }, { day: D2, views: 1, visitors: 1, inbound: 0 }] },
    sources: [
      { source: 'twitter', channel: 'social', views: 4, visitors: 2, inbound: 2 },
      { source: 'direct', channel: 'direct', views: 1, visitors: 1, inbound: 1 },
      { source: 'google', channel: 'search', views: 1, visitors: 1, inbound: 1 },
      { source: 'internal', channel: 'internal', views: 2, visitors: 1, inbound: 0 },
    ],
    landing: {
      all: [
        { path: '/', kind: 'home', visits: 2 },
        { path: '/pricing', kind: 'pricing', visits: 1 },
        { path: '/r/alpha', kind: 'ree', visits: 1 },
      ],
      bySource: [
        { source: 'twitter', pages: [{ path: '/', kind: 'home', visits: 1 }, { path: '/r/alpha', kind: 'ree', visits: 1 }] },
        { source: 'direct', pages: [{ path: '/', kind: 'home', visits: 1 }] },
        { source: 'google', pages: [{ path: '/pricing', kind: 'pricing', visits: 1 }] },
        { source: 'internal', pages: [{ path: '/explore', kind: 'explore', visits: 1 }] },
      ],
    },
  };

  it('reads unrolled days from raw views, and the same figures from the rollup after it', async () => {
    const administrator = await consoleAdministrator();
    const before = await traffic.trafficReport(administrator, range, NOW);
    expect(before).toMatchObject(expected);
    expect(before.kinds).toEqual(
      expect.arrayContaining([
        { kind: 'ree', views: 3, visitors: 1, inbound: 1 },
        { kind: 'home', views: 2, visitors: 2, inbound: 2 },
        { kind: 'explore', views: 2, visitors: 1, inbound: 0 },
        { kind: 'pricing', views: 1, visitors: 1, inbound: 1 },
      ]),
    );

    const run = await traffic.rollUpTraffic(NOW);
    expect(run.days).toEqual([D1, D2]);
    expect(await traffic.trafficReport(administrator, range, NOW)).toEqual(before);

    // Once the raw views are gone (past retention), the rollup alone answers; visitors are then summed per day.
    const later = await traffic.trafficReport(administrator, range, new Date('2026-12-01T00:00:00Z'));
    expect(later.totals).toEqual({ views: 8, visitors: 4, inbound: 4, internal: 1, exactVisitors: false });
    expect(later.trend).toEqual(before.trend);
    expect(later.landing).toEqual(before.landing);
    expect(later.sources.find((row) => row.source === 'twitter')).toEqual({ source: 'twitter', channel: 'social', views: 4, visitors: 2, inbound: 2 });
  });

  it('rolls each day up once: a second run changes nothing', async () => {
    const count = async () => (await db().execute<{ n: number }>(sql`select (select count(*) from ${schema.siteTrafficDay})::int + (select count(*) from ${schema.siteTrafficLanding})::int as n`)).rows[0]!.n;
    const rows = await count();
    expect((await traffic.rollUpTraffic(NOW)).days).toEqual([]);
    expect(await count()).toBe(rows);
    const [day] = await db().select().from(schema.siteTrafficDay).where(and(eq(schema.siteTrafficDay.day, D1), eq(schema.siteTrafficDay.source, ''), eq(schema.siteTrafficDay.pageKind, '')));
    expect(day).toEqual({ day: D1, source: '', pageKind: '', views: 7, visitors: 3, visits: 5 });
  });

  it('never rolls up today; a view after the rollup counts from raw', async () => {
    const administrator = await consoleAdministrator();
    const today = '2026-06-05';
    await at(c, '2026-06-05T01:00:00Z', '/explore', 'https://github.com/x');
    expect((await traffic.rollUpTraffic(NOW)).days).toEqual([]);
    const report = await traffic.trafficReport(administrator, { start: dayStart(D1), end: dayStart(today) + DAY }, NOW);
    expect(report.totals).toMatchObject({ views: 9, inbound: 5, visitors: 3 });
    expect(report.trend.points.map((point) => point.day)).toEqual([D1, D2, '2026-06-03', '2026-06-04', today]);
    expect(report.sources.find((row) => row.source === 'github')).toMatchObject({ channel: 'referral', inbound: 1 });
  });

  it('deletes raw views past retention after rolling their day up', async () => {
    const old = randomUUID();
    await at(old, '2026-02-01T02:00:00Z', '/', 'https://x.com/');
    const run = await traffic.rollUpTraffic(NOW);
    expect(run.days).toEqual(['2026-02-01']);
    expect(run.purged).toBe(1);
    expect(await viewsOf(old)).toHaveLength(0);
    expect(await db().select().from(schema.siteView).where(and(gte(schema.siteView.createdAt, new Date(range.start)), lt(schema.siteView.createdAt, new Date(range.end))))).toHaveLength(8);
    const administrator = await consoleAdministrator();
    const february = await traffic.trafficReport(administrator, { start: dayStart('2026-02-01'), end: dayStart('2026-02-02') }, NOW);
    expect(february.totals).toEqual({ views: 1, visitors: 1, inbound: 1, internal: 0, exactVisitors: false });
    expect(february.landing.bySource).toEqual([{ source: 'twitter', pages: [{ path: '/', kind: 'home', visits: 1 }] }]);
  });

  it('reports all time from the first day it knows', async () => {
    const report = await traffic.trafficReport(await consoleAdministrator(), null, NOW);
    expect(report.totals.views).toBe(10);
    expect(report.trend.unit).toBe('month');
    expect(report.trend.points[0]).toMatchObject({ day: '2026-02', views: 1 });
  });

  it('the cron route is shut without the secret and rolls up with it', async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'traffic-cron-secret';
    try {
      expect((await cron(new NextRequest(`${BASE}/api/cron/traffic`))).status).toBe(401);
      expect((await cron(new NextRequest(`${BASE}/api/cron/traffic`, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
      const response = await cron(new NextRequest(`${BASE}/api/cron/traffic`, { headers: { authorization: 'Bearer traffic-cron-secret' } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ rolledUp: expect.any(Number), purged: expect.any(Number) });
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
