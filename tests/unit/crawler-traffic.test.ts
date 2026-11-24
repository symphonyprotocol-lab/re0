import { describe, expect, it } from 'vitest';
import {
  billingDay,
  crawlerAgent,
  crawlerFamily,
  EMPTY_AGENT,
  estimateFamilyCost,
  foldAgents,
  observabilityGroups,
  observabilityKey,
  parseCharges,
  VercelApiError,
} from '@/lib/domain/crawler-traffic';
import { vercelApiConfig } from '@/lib/infra/vercel-api';

/* User agents as Vercel Observability reported them for re0.io in November 2026. */
const CLAUDE = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)';
const GOOGLE_OTHER = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.78 Mobile Safari/537.36 (compatible; GoogleOther)';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BING = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36';
const META = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))';
const AMAZON = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

describe('crawler traffic: user agent families (crawlerFamily)', () => {
  it('names the large crawlers', () => {
    expect(crawlerFamily(CLAUDE)).toBe('claude');
    expect(crawlerFamily('Claude-User/1.0')).toBe('claude');
    expect(crawlerFamily(GPT)).toBe('openai');
    expect(crawlerFamily('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot')).toBe('openai');
    expect(crawlerFamily('OAI-SearchBot/1.0; +https://openai.com/searchbot')).toBe('openai');
    expect(crawlerFamily(GOOGLE_OTHER)).toBe('google');
    expect(crawlerFamily(GOOGLEBOT)).toBe('google');
    expect(crawlerFamily(BING)).toBe('bing');
    expect(crawlerFamily(META)).toBe('meta');
    expect(crawlerFamily('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toBe('meta');
  });

  it('puts every other bot, script and empty agent in `bot`, people in `human`', () => {
    expect(crawlerFamily(AMAZON)).toBe('bot');
    expect(crawlerFamily('curl/8.4.0')).toBe('bot');
    expect(crawlerFamily('python-requests/2.32.3')).toBe('bot');
    expect(crawlerFamily('Twitterbot/1.0')).toBe('bot');
    expect(crawlerFamily('')).toBe('bot');
    expect(crawlerFamily(null)).toBe('bot');
    expect(crawlerFamily(CHROME)).toBe('human');
    expect(crawlerFamily(IPHONE)).toBe('human');
  });
});

describe('crawler traffic: agent names (crawlerAgent)', () => {
  it('keeps only the bot’s own token', () => {
    expect(crawlerAgent(CLAUDE)).toBe('ClaudeBot');
    expect(crawlerAgent(GPT)).toBe('GPTBot');
    expect(crawlerAgent(GOOGLE_OTHER)).toBe('GoogleOther');
    expect(crawlerAgent(GOOGLEBOT)).toBe('Googlebot');
    expect(crawlerAgent(BING)).toBe('bingbot');
    expect(crawlerAgent(META)).toBe('meta-externalagent');
    expect(crawlerAgent(AMAZON)).toBe('Amazonbot');
    expect(crawlerAgent('curl/8.4.0')).toBe('curl');
    expect(crawlerAgent('python-requests/2.32.3')).toBe('python-requests');
    expect(crawlerAgent('Go-http-client/2.0')).toBe('Go-http-client');
  });

  it('stores nothing of a person’s agent, and names a missing one', () => {
    expect(crawlerAgent(CHROME)).toBe('');
    expect(crawlerAgent(IPHONE)).toBe('');
    expect(crawlerAgent('')).toBe(EMPTY_AGENT);
    expect(crawlerAgent(`${'x'.repeat(80)}bot/1`).length).toBeLessThanOrEqual(60);
  });
});

describe('crawler traffic: Observability payloads', () => {
  const metric = 'vercel.function_invocation.fot_total_bytes';

  it('names the rollup column as the API does', () => {
    expect(observabilityKey('vercel.request.count')).toBe('vercel_request_count_sum');
    expect(observabilityKey(metric)).toBe('vercel_function_invocation_fot_total_bytes_sum');
  });

  it('reads the summary rows by their snake-case dimensions', () => {
    const payload = {
      data: [{ timestamp: '2026-11-22T16:00:00.000Z', route: '/r/[slug]', vercel_function_invocation_fot_total_bytes_sum: 1 }],
      summary: [
        { route: '/r/[slug]', client_user_agent: CLAUDE, vercel_function_invocation_fot_total_bytes_sum: 99234279711 },
        { route: '/login', client_user_agent: CHROME, vercel_function_invocation_fot_total_bytes_sum: 1500.4 },
        { route: '/x', client_user_agent: CHROME, vercel_function_invocation_fot_total_bytes_sum: 0 },
        { client_user_agent: GPT, vercel_function_invocation_fot_total_bytes_sum: 10 },
      ],
    };
    expect(observabilityGroups(payload, metric, ['route', 'client_user_agent'])).toEqual([
      { dims: { route: '/r/[slug]', client_user_agent: CLAUDE }, value: 99234279711 },
      { dims: { route: '/login', client_user_agent: CHROME }, value: 1500 },
      { dims: { route: '', client_user_agent: GPT }, value: 10 },
    ]);
    expect(observabilityGroups({ summary: [{ vercel_function_invocation_fot_total_bytes_sum: 7 }] }, metric, [])).toEqual([{ dims: {}, value: 7 }]);
  });

  it('throws on an error payload or a missing summary', () => {
    const rejected = { error: { code: 'invalid_query', message: 'Observability query was rejected.' } };
    expect(() => observabilityGroups(rejected, metric, [])).toThrow(VercelApiError);
    expect(() => observabilityGroups(rejected, metric, [])).toThrow(/rejected/);
    expect(() => observabilityGroups({ data: [] }, metric, [])).toThrow(/no summary/);
    expect(() => observabilityGroups(null, metric, [])).toThrow(VercelApiError);
  });

  it('folds agents into families and names, and gives the unlisted tail to `human`', () => {
    const groups = [CLAUDE, GPT, CHROME, IPHONE, AMAZON, 'curl/8.4.0', 'curl/7.0'].map((agent, index) => ({ dims: { client_user_agent: agent }, value: (index + 1) * 10 }));
    const folded = foldAgents(groups, 1_000);
    const of = (family: string, agent: string) => folded.find((row) => row.family === family && row.agent === agent)?.value;
    expect(of('claude', 'ClaudeBot')).toBe(10);
    expect(of('openai', 'GPTBot')).toBe(20);
    expect(of('bot', 'Amazonbot')).toBe(50);
    expect(of('bot', 'curl')).toBe(60 + 70);
    /* Both browsers, and the 720 the groups did not list. */
    expect(of('human', '')).toBe(30 + 40 + 720);
    expect(folded.reduce((sum, row) => sum + row.value, 0)).toBe(1_000);
    /* A total below the groups' sum (the API rounds) adds no negative tail. */
    expect(foldAgents(groups, 0).reduce((sum, row) => sum + row.value, 0)).toBe(280);
  });
});

describe('crawler traffic: billing charges', () => {
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({
      BilledCost: 0,
      ChargePeriodStart: '2026-11-22T08:00:00.000Z',
      ChargePeriodEnd: '2026-11-23T08:00:00.000Z',
      ServiceName: 'Fast Origin Transfer',
      ConsumedQuantity: 0,
      ConsumedUnit: 'GB',
      Tags: { ProjectId: 'prj_mine', ProjectName: 'recall0' },
      ...fields,
    });

  it('cuts billing days in US Pacific time', () => {
    expect(billingDay('2026-11-22T08:00:00.000Z')).toBe('2026-11-22');
    expect(billingDay('2026-07-01T07:00:00.000Z')).toBe('2026-07-01');
    expect(billingDay('2026-11-22T07:59:00.000Z')).toBe('2026-11-21');
    expect(billingDay('nonsense')).toBeNull();
  });

  it('keeps this project’s lines and the team’s own, sums them per day and service, and drops empty ones', () => {
    const jsonl = [
      line({ BilledCost: 31.0069, ConsumedQuantity: 516.78 }),
      line({ BilledCost: 0.5, ConsumedQuantity: 8, RegionId: 'sfo1' }),
      line({ BilledCost: 12, Tags: { ProjectId: 'prj_other' } }),
      line({ ServiceName: 'Pro', BilledCost: 0.6667, ConsumedQuantity: 1, ConsumedUnit: 'Seat', Tags: {} }),
      line({ ServiceName: 'Speed Insights Plus Events', BilledCost: 0, ConsumedQuantity: 0, Tags: {} }),
      line({ ChargePeriodStart: '2026-11-23T08:00:00.000Z', BilledCost: 2 }),
      '',
      'not json',
    ].join('\n');
    const lines = parseCharges(jsonl, 'prj_mine').sort((a, b) => a.day.localeCompare(b.day) || a.service.localeCompare(b.service));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ day: '2026-11-22', service: 'Fast Origin Transfer', scope: 'project', unit: 'GB', quantity: 524.78 });
    expect(lines[0]!.cost).toBeCloseTo(31.5069, 6);
    expect(lines[1]).toEqual({ day: '2026-11-22', service: 'Pro', scope: 'team', cost: 0.6667, quantity: 1, unit: 'Seat' });
    expect(lines[2]).toMatchObject({ day: '2026-11-23', service: 'Fast Origin Transfer', cost: 2 });
  });

  it('shares the traffic-driven services out by each family’s part of their driver', () => {
    const cost = estimateFamilyCost(
      [
        { service: 'Fast Origin Transfer', cost: 100 },
        { service: 'Function Invocations', cost: 10 },
        { service: 'Pro', cost: 20 },
      ],
      [
        { family: 'claude', requests: 0, invocations: 90, originBytes: 750 },
        { family: 'human', requests: 0, invocations: 10, originBytes: 250 },
      ],
    );
    expect(cost.get('claude')).toBeCloseTo(75 + 9, 6);
    expect(cost.get('human')).toBeCloseTo(25 + 1, 6);
  });
});

describe('crawler traffic: configuration', () => {
  it('is off without a token and defaults to re0’s team and project', () => {
    expect(vercelApiConfig({})).toBeNull();
    expect(vercelApiConfig({ VERCEL_OBSERVABILITY_TOKEN: '  ' })).toBeNull();
    expect(vercelApiConfig({ VERCEL_OBSERVABILITY_TOKEN: 'tok' })).toEqual({ token: 'tok', teamId: 'team_gQB9RyFYxD5ff0CnXE5JAbDc', projectId: 'prj_lRE4xUOnAwhlrkaOHhvqlKy3thMk' });
    expect(vercelApiConfig({ VERCEL_OBSERVABILITY_TOKEN: 'tok', VERCEL_OBSERVABILITY_TEAM_ID: 'team_x', VERCEL_OBSERVABILITY_PROJECT_ID: 'prj_x' })).toMatchObject({ teamId: 'team_x', projectId: 'prj_x' });
  });
});
