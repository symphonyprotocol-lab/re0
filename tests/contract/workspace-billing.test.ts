/**
 * The arithmetic behind the overview's "current cost" tile and the snippets
 * the install and quickstart panels print. Both are pure: the tile is wrong
 * for every workspace if the window is off by an instant, and a snippet with
 * the wrong host or field name fails on the user's machine, not ours.
 */
import { describe, expect, it } from 'vitest';
import { calendarMonth, periodCost } from '@/lib/application/plans/billing';
import {
  API_KEY_PLACEHOLDER,
  installCommand,
  mcpEndpoint,
  quickstartTabs,
} from '@/lib/dashboard/snippets';
import { API_KEY_PREFIXES } from '@/lib/application/auth/api-key';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';

const periodStart = new Date('2026-09-01T00:00:00Z');
const periodEnd = new Date('2026-10-01T00:00:00Z');

describe('periodCost', () => {
  it('is the plan price alone when no pack was bought', () => {
    const cost = periodCost({
      planPriceMinor: 500,
      packPriceMinor: 500,
      packs: [],
      periodStart,
      periodEnd,
    });
    expect(cost).toEqual({ planMinor: 500, packsBought: 0, packsMinor: 0, totalMinor: 500 });
  });

  it('is zero on Free with nothing bought', () => {
    const cost = periodCost({
      planPriceMinor: 0,
      packPriceMinor: 500,
      packs: [],
      periodStart,
      periodEnd,
    });
    expect(cost.totalMinor).toBe(0);
  });

  it('adds each pack bought inside the period at the pack price', () => {
    const cost = periodCost({
      planPriceMinor: 500,
      packPriceMinor: 500,
      packs: [
        { createdAt: new Date('2026-09-03T10:00:00Z') },
        { createdAt: new Date('2026-09-20T23:59:59Z') },
      ],
      periodStart,
      periodEnd,
    });
    expect(cost.packsBought).toBe(2);
    expect(cost.packsMinor).toBe(1000);
    expect(cost.totalMinor).toBe(1500);
  });

  it('treats the window as half-open: the start instant is in, the end instant is out', () => {
    const cost = periodCost({
      planPriceMinor: 0,
      packPriceMinor: 500,
      packs: [{ createdAt: periodStart }, { createdAt: periodEnd }],
      periodStart,
      periodEnd,
    });
    expect(cost.packsBought).toBe(1);
  });

  it('does not bill packs bought in an earlier period again, though their balance carries over', () => {
    const cost = periodCost({
      planPriceMinor: 500,
      packPriceMinor: 500,
      packs: [{ createdAt: new Date('2026-08-15T00:00:00Z') }],
      periodStart,
      periodEnd,
    });
    expect(cost.packsBought).toBe(0);
    expect(cost.totalMinor).toBe(500);
  });

  it('never goes negative on a malformed price', () => {
    const cost = periodCost({
      planPriceMinor: -500,
      packPriceMinor: -100,
      packs: [{ createdAt: new Date('2026-09-03T00:00:00Z') }],
      periodStart,
      periodEnd,
    });
    expect(cost.totalMinor).toBe(0);
  });
});

describe('calendarMonth', () => {
  it('is the UTC month around the instant, rolling over the year', () => {
    const window = calendarMonth(new Date('2026-12-31T23:30:00Z'));
    expect(window.periodStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(window.periodEnd.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('install and quickstart snippets', () => {
  const baseUrl = 'https://staging.example.com/';

  it('uses a placeholder that carries the real key prefix', () => {
    expect(API_KEY_PREFIXES.some((prefix) => API_KEY_PLACEHOLDER.startsWith(prefix))).toBe(true);
  });

  it('installs through the published CLI against this deployment', () => {
    const command = installCommand(baseUrl);
    expect(command).toBe(
      'npx @symphonyprotocollab/re0 setup --url https://staging.example.com/mcp --key mm_live_YOUR_KEY',
    );
    expect(mcpEndpoint(baseUrl)).toBe('https://staging.example.com/mcp');
  });

  it('calls the authoritative REST routes with the authoritative field names', () => {
    const [search, context] = quickstartTabs({
      baseUrl,
      assetId: '/acme/handbook',
      title: 'Handbook',
      labels: { search: 'Search', context: 'Context' },
    });
    expect(search.request).toContain('https://staging.example.com/api/v1/libraries/search?');
    expect(search.request).toContain('assetName=handbook');
    expect(search.request).toContain('query=getting+started');
    expect(search.request).toContain(`Bearer ${API_KEY_PLACEHOLDER}`);
    expect(search.request).not.toContain('asset_name');

    expect(context!.request).toContain('https://staging.example.com/api/v1/context?');
    expect(context!.request).toContain('assetId=%2Facme%2Fhandbook');
    expect(context!.request).not.toContain('asset_id');
  });

  it('prints responses in the contract shapes, naming the chosen asset', () => {
    const [search, context] = quickstartTabs({
      baseUrl,
      assetId: '/acme/handbook',
      title: 'Handbook',
      labels: { search: 'Search', context: 'Context' },
    });
    const searchBody = JSON.parse(search.response) as {
      results: { assetId: string; title: string; evidence: unknown }[];
      requestId: string;
    };
    expect(searchBody.results[0]?.assetId).toBe('/acme/handbook');
    expect(searchBody.results[0]?.title).toBe('Handbook');
    expect(searchBody.results[0]?.evidence).toBeDefined();
    expect(typeof searchBody.requestId).toBe('string');

    const contextBody = JSON.parse(context!.response) as {
      assetId: string;
      chunks: { citation: { sourceUrl: string } }[];
      usage: { callsUsed: number };
    };
    expect(contextBody.assetId).toBe('/acme/handbook');
    expect(contextBody.chunks[0]?.citation.sourceUrl).toMatch(/^https:/);
    expect(contextBody.usage.callsUsed).toBe(1);
  });

  it('is labelled in both languages', () => {
    for (const dictionary of [zh, en]) {
      const live = dictionary.dashboard.overview.live;
      expect(live.tabSearch.length).toBeGreaterThan(0);
      expect(live.tabContext.length).toBeGreaterThan(0);
      expect(live.costUnbilled.length).toBeGreaterThan(0);
      expect(dictionary.dashboard.settings.billing.empty.length).toBeGreaterThan(0);
    }
  });
});
