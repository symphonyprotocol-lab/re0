/**
 * Build billing rules, as decisions. library-build-billing.md 3.
 *
 * The formula is what the Pricing page promises and what the console's rate
 * fields feed, so a change here is a change to the product's price list and
 * must be made on purpose.
 */
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import {
  BUILD_BILLING_MODES,
  DEFAULT_BUILD_RATES,
  buildBillingMode,
  buildRequestId,
  estimateTokens,
  priceBuild,
  quoteBuildCap,
} from '@/lib/domain/build-billing';
import { INGESTION_ERRORS, OPERATION_TRIGGERS } from '@/lib/domain/ingestion';
import { PACK_NO_ENTITLEMENT, parsePlanVersionDraft, PlanChangeRefused } from '@/lib/domain/plans';

const facts = (freshTokens: number, pagesFetched = 0, platformRebuild = false) => ({
  freshTokens,
  carriedTokens: 0,
  pagesFetched,
  platformRebuild,
});

describe('priceBuild', () => {
  it('charges the base, then a call per started block of fresh tokens and fetched pages', () => {
    expect(priceBuild(facts(0), DEFAULT_BUILD_RATES)).toBe(1);
    expect(priceBuild(facts(1), DEFAULT_BUILD_RATES)).toBe(2);
    expect(priceBuild(facts(20_000), DEFAULT_BUILD_RATES)).toBe(2);
    expect(priceBuild(facts(20_001), DEFAULT_BUILD_RATES)).toBe(3);
    expect(priceBuild(facts(750_000, 196), DEFAULT_BUILD_RATES)).toBe(1 + 38 + 40);
  });

  it('matches the worked examples in library-build-billing.md 3.4', () => {
    /* A full 20 MB Free library: about five million tokens. */
    expect(priceBuild(facts(estimateTokens(20 * 1_048_576)), DEFAULT_BUILD_RATES)).toBe(1 + 263);
    /* A 2 MB manual. */
    expect(priceBuild(facts(estimateTokens(2 * 1_000_000)), DEFAULT_BUILD_RATES)).toBe(26);
  });

  it('never bills carried-forward content: only fresh tokens enter the formula', () => {
    expect(
      priceBuild({ freshTokens: 0, carriedTokens: 5_000_000, pagesFetched: 0, platformRebuild: false }, DEFAULT_BUILD_RATES),
    ).toBe(1);
  });

  it('prices a platform-forced rebuild at zero, whatever it measured', () => {
    expect(priceBuild(facts(5_000_000, 200, true), DEFAULT_BUILD_RATES)).toBe(0);
  });

  it('treats the pack sentinel rates as no charge rather than a division by zero', () => {
    const pack = { baseCalls: PACK_NO_ENTITLEMENT, tokensPerCall: PACK_NO_ENTITLEMENT, pagesPerCall: PACK_NO_ENTITLEMENT };
    expect(priceBuild(facts(100_000, 50), pack)).toBe(0);
  });
});

describe('quoteBuildCap', () => {
  it('is bounded by the storage left in the workspace and the crawl limit', () => {
    const cap = quoteBuildCap({
      rates: DEFAULT_BUILD_RATES,
      capacityBytes: 20 * 1_048_576,
      pageLimit: 200,
    });
    expect(cap).toBe(1 + 263 + 40);
  });

  it('uses a tighter estimate when the wizard has one, but never above the storage left', () => {
    const rates = DEFAULT_BUILD_RATES;
    expect(quoteBuildCap({ rates, capacityBytes: 1_000_000, pageLimit: 0, estimatedBytes: 40_000 })).toBe(2);
    expect(quoteBuildCap({ rates, capacityBytes: 1_000_000, pageLimit: 0, estimatedBytes: 9_999_999 })).toBe(
      quoteBuildCap({ rates, capacityBytes: 1_000_000, pageLimit: 0 }),
    );
  });
});

describe('build billing mode', () => {
  it('defaults to shadow and only recognises the two phases', () => {
    expect(BUILD_BILLING_MODES).toEqual(['shadow', 'enforce']);
    expect(buildBillingMode(undefined)).toBe('shadow');
    expect(buildBillingMode('ENFORCE ')).toBe('enforce');
    expect(buildBillingMode('on')).toBe('shadow');
  });

  it('bills one operation under one request id', () => {
    expect(buildRequestId('op-1')).toBe('build:op-1');
  });
});

describe('plan version build rates', () => {
  const free = {
    planId: 'free',
    currency: 'USD',
    price: '0',
    calls: '1000',
    apiKeyLimit: '20',
  };

  it('defaults a form that never asked for them', () => {
    const draft = parsePlanVersionDraft(free);
    expect(draft.buildBaseCalls).toBe(DEFAULT_BUILD_RATES.baseCalls);
    expect(draft.buildTokensPerCall).toBe(DEFAULT_BUILD_RATES.tokensPerCall);
    expect(draft.buildPagesPerCall).toBe(DEFAULT_BUILD_RATES.pagesPerCall);
  });

  it('accepts typed rates and refuses a rate that is not a whole number in range', () => {
    const draft = parsePlanVersionDraft({ ...free, buildBaseCalls: '2', buildTokensPerCall: '10000', buildPagesPerCall: '3' });
    expect([draft.buildBaseCalls, draft.buildTokensPerCall, draft.buildPagesPerCall]).toEqual([2, 10_000, 3]);
    for (const bad of [{ buildTokensPerCall: '0' }, { buildPagesPerCall: '1.5' }, { buildBaseCalls: '-1' }]) {
      expect(() => parsePlanVersionDraft({ ...free, ...bad })).toThrow(PlanChangeRefused);
      try {
        parsePlanVersionDraft({ ...free, ...bad });
      } catch (error) {
        expect((error as PlanChangeRefused).code).toBe('invalid_build_rate');
      }
    }
  });

  it('stores the sentinel on the pack, whatever was posted', () => {
    const pack = parsePlanVersionDraft({ planId: 'addon', price: '5', calls: '5000', buildBaseCalls: '9' });
    expect([pack.buildBaseCalls, pack.buildTokensPerCall, pack.buildPagesPerCall]).toEqual([0, 0, 0]);
  });

  it('has copy for the refusal, the failure and the trigger in both languages', () => {
    expect(en.admin.plans.errors.invalid_build_rate).toBeTruthy();
    expect(zh.admin.plans.errors.invalid_build_rate).toBeTruthy();
    expect(INGESTION_ERRORS).toContain('quota_exceeded');
    expect(en.admin.ingestionErrors.quota_exceeded).toBeTruthy();
    expect(zh.admin.ingestionErrors.quota_exceeded).toBeTruthy();
    expect(OPERATION_TRIGGERS).toContain('platform');
  });
});
