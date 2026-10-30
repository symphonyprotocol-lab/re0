import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import {
  BYTES_PER_MB,
  DEFAULT_CAPABILITIES,
  PACK_NO_ENTITLEMENT,
  PLAN_CHANGE_ERRORS,
  PLAN_TIER_IDS,
  PlanChangeRefused,
  STORAGE_TIERS,
  bytesToMb,
  capabilitiesFor,
  isPlanTierId,
  isSamePlanVersion,
  isStorageTier,
  parsePlanVersionDraft,
  parseUsdMinor,
  readCapabilities,
  shortPlanVersionId,
  siteKeysAllowed,
  storageCapacityBytes,
  usdFromMinor,
  usdHeadline,
  type PlanChangeError,
  type PlanVersionInput,
} from '@/lib/domain/plans';

const FREE: PlanVersionInput = {
  planId: 'free',
  currency: 'USD',
  price: '0',
  calls: '1000',
  apiKeyLimit: '20',
};

function refusal(input: PlanVersionInput): PlanChangeError | 'accepted' {
  try {
    parsePlanVersionDraft(input);
    return 'accepted';
  } catch (error) {
    if (error instanceof PlanChangeRefused) return error.code;
    throw error;
  }
}

/**
 * The catalogue is closed by product rule, not by what a form happens to offer
 * (agent-first-proposal.md 8.1). The screen renders two cards; nothing stops a
 * caller posting a third tier to the same server action, so the refusal has to
 * live here rather than in the markup.
 */
describe('the plan catalogue', () => {
  it('is Free and the call pack, and nothing else', () => {
    expect([...PLAN_TIER_IDS]).toEqual(['free', 'addon']);
    for (const tier of ['pro', 'enterprise', 'team', 'business', '', 'Free']) {
      expect(isPlanTierId(tier)).toBe(false);
    }
  });

  it('refuses a tier that is not in the catalogue', () => {
    expect(refusal({ ...FREE, planId: 'pro' })).toBe('unknown_plan');
    expect(refusal({ ...FREE, planId: 'enterprise' })).toBe('unknown_plan');
  });

  it('refuses any currency but USD', () => {
    expect(refusal({ ...FREE, currency: 'EUR' })).toBe('unsupported_currency');
    expect(refusal({ ...FREE, currency: 'CNY' })).toBe('unsupported_currency');
    // Case and padding are the operator's, not a different currency.
    expect(refusal({ ...FREE, currency: ' usd ' })).toBe('accepted');
  });

  it('stores USD even when the caller says nothing about currency', () => {
    const { currency } = parsePlanVersionDraft({ ...FREE, currency: undefined });
    expect(currency).toBe('USD');
  });
});

/**
 * Money is parsed from digits rather than through a float. `1.005 * 100` is
 * 100.49999999999999, and a cent that is occasionally wrong is worse than an
 * amount that refuses to parse.
 */
describe('parseUsdMinor', () => {
  it('reads whole dollars, one decimal and two', () => {
    expect(parseUsdMinor('5')).toBe(500);
    expect(parseUsdMinor('5.5')).toBe(550);
    expect(parseUsdMinor('5.50')).toBe(550);
    expect(parseUsdMinor('0')).toBe(0);
    // The float route gives 100.49999999999999 for this one.
    expect(parseUsdMinor('1.00')).toBe(100);
    expect(parseUsdMinor('1.01')).toBe(101);
  });

  it('refuses anything that is not a plain amount', () => {
    for (const raw of ['', '-5', '5.555', '1e3', '$5', '5,00', 'five', '5.']) {
      expect(parseUsdMinor(raw)).toBeNull();
    }
  });

  it('round-trips through the editable form', () => {
    for (const minor of [0, 5, 500, 1999, 1_000_000]) {
      expect(parseUsdMinor(usdFromMinor(minor))).toBe(minor);
    }
  });
});

describe('a proposed Free version', () => {
  it('accepts the seeded values', () => {
    expect(parsePlanVersionDraft(FREE)).toEqual({
      planId: 'free',
      priceMinor: 0,
      currency: 'USD',
      monthlyCalls: 1000,
      apiKeyLimit: 20,
      buildBaseCalls: 1,
      buildTokensPerCall: 20_000,
      buildPagesPerCall: 5,
      capabilities: capabilitiesFor(),
    });
  });

  it('names the field that is wrong rather than a generic refusal', () => {
    expect(refusal({ ...FREE, price: 'free' })).toBe('invalid_price');
    expect(refusal({ ...FREE, calls: '0' })).toBe('invalid_calls');
    expect(refusal({ ...FREE, apiKeyLimit: 'many' })).toBe('invalid_api_key_limit');
    expect(refusal({ ...FREE, apiKeyLimit: '' })).toBe('invalid_api_key_limit');
  });

  /*
   * The ceilings are the boundary between a typo and an instruction: a price
   * with an extra zero is a refund queue.
   */
  it('refuses a value past the ceiling a form can mean', () => {
    expect(refusal({ ...FREE, planId: 'addon', price: '10000.01' })).toBe('invalid_price');
    expect(refusal({ ...FREE, planId: 'addon', price: '10000' })).toBe('accepted');
    expect(refusal({ ...FREE, calls: '100000001' })).toBe('invalid_calls');
    expect(refusal({ ...FREE, apiKeyLimit: '10001' })).toBe('invalid_api_key_limit');
  });

  it('keeps Free free', () => {
    expect(refusal(FREE)).toBe('accepted');
    expect(refusal({ ...FREE, price: '1' })).toBe('free_must_be_free');
  });
});

/**
 * agent-first-proposal.md 8.1: a pack buys calls, anyone may buy one, and the
 * buyer keeps Free's key ceiling and build rates -- so a pack version must not
 * carry a ceiling of its own, not even one posted alongside the price.
 */
describe('the Additional Calls pack', () => {
  const PACK: PlanVersionInput = { planId: 'addon', currency: 'USD', price: '5', calls: '5000' };

  it('needs only a price and a call count', () => {
    expect(parsePlanVersionDraft(PACK)).toEqual({
      planId: 'addon',
      priceMinor: 500,
      currency: 'USD',
      monthlyCalls: 5000,
      apiKeyLimit: PACK_NO_ENTITLEMENT,
      buildBaseCalls: PACK_NO_ENTITLEMENT,
      buildTokensPerCall: PACK_NO_ENTITLEMENT,
      buildPagesPerCall: PACK_NO_ENTITLEMENT,
      capabilities: capabilitiesFor(),
    });
  });

  it('drops entitlements a caller posts anyway', () => {
    const draft = parsePlanVersionDraft({ ...PACK, apiKeyLimit: '999', buildBaseCalls: '9' });
    expect(draft.apiKeyLimit).toBe(PACK_NO_ENTITLEMENT);
    expect(draft.buildBaseCalls).toBe(PACK_NO_ENTITLEMENT);
  });

  it('is still priced in USD only', () => {
    expect(refusal({ ...PACK, currency: 'JPY' })).toBe('unsupported_currency');
  });
});

/**
 * The capability blob outlived the tiers that varied it: only the switched-off
 * widget and showcase modules read it, and every version now shares one default.
 */
describe('capabilities', () => {
  it('ignores the flags older versions still carry', () => {
    expect(readCapabilities({ publicReviewRequired: false })).not.toHaveProperty('publicReviewRequired');
    expect(readCapabilities({ addonPurchase: true })).not.toHaveProperty('addonPurchase');
    expect(readCapabilities({ publicReviewRequired: true, addonPurchase: true })).toEqual(DEFAULT_CAPABILITIES);
  });

  /* The website widget: one site key by default; a stored cap wins over the default. */
  it('caps site keys at the default unless the version stores a cap', () => {
    expect(capabilitiesFor().siteKeys).toBe(1);
    expect(readCapabilities({}).siteKeys).toBe(1);
    expect(readCapabilities({ siteKeys: 3 }).siteKeys).toBe(3);
    expect(readCapabilities({ siteKeys: -1 }).siteKeys).toBe(-1);
    expect(readCapabilities({ siteKeys: 'many' }).siteKeys).toBe(1);
    expect(readCapabilities({ siteKeys: -2 }).siteKeys).toBe(1);
  });

  it('counts live site keys against the cap', () => {
    expect(siteKeysAllowed(1, 0)).toBe(true);
    expect(siteKeysAllowed(1, 1)).toBe(false);
    expect(siteKeysAllowed(-1, 99)).toBe(true);
  });
});

/**
 * Minting a version identical to the live one is not harmless: it is a row an
 * operator has to read past on the history, and a run of them hides the change
 * that mattered.
 */
describe('isSamePlanVersion', () => {
  const draft = parsePlanVersionDraft(FREE);
  const live = {
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls: 1000,
    apiKeyLimit: 20,
    buildBaseCalls: 1,
    buildTokensPerCall: 20_000,
    buildPagesPerCall: 5,
    capabilities: capabilitiesFor(),
  };

  it('recognises a no-op', () => {
    expect(isSamePlanVersion(draft, live)).toBe(true);
  });

  it('is false when the tier has no live version to repeat', () => {
    expect(isSamePlanVersion(draft, null)).toBe(false);
  });

  it('notices a change in any billed field', () => {
    expect(isSamePlanVersion(draft, { ...live, priceMinor: 600 })).toBe(false);
    expect(isSamePlanVersion(draft, { ...live, monthlyCalls: 6000 })).toBe(false);
    expect(isSamePlanVersion(draft, { ...live, apiKeyLimit: 21 })).toBe(false);
    expect(isSamePlanVersion(draft, { ...live, buildTokensPerCall: 10_000 })).toBe(false);
    expect(
      isSamePlanVersion(draft, {
        ...live,
        capabilities: { ...capabilitiesFor(), siteKeys: 3 },
      }),
    ).toBe(false);
  });
});

/**
 * agent-first-proposal.md 8.1: storage is bounded per workspace, by the
 * owner's tier -- 500 MB until the first purchase, 2 GB from then on.
 */
describe('storage tiers', () => {
  it('are base and extended, and nothing else', () => {
    expect([...STORAGE_TIERS]).toEqual(['base', 'extended']);
    expect(isStorageTier('base')).toBe(true);
    expect(isStorageTier('extended')).toBe(true);
    for (const value of ['pro', 'Base', '', null, 2]) expect(isStorageTier(value)).toBe(false);
  });

  it('hold 500 MB and 2 GB', () => {
    expect(bytesToMb(storageCapacityBytes('base'))).toBe(500);
    expect(bytesToMb(storageCapacityBytes('extended'))).toBe(2_048);
    expect(storageCapacityBytes('extended')).toBeGreaterThan(storageCapacityBytes('base'));
  });

  it('round-trips whole megabytes', () => {
    for (const mb of [1, 20, 100, 500, 2_048]) {
      expect(bytesToMb(mb * BYTES_PER_MB)).toBe(mb);
    }
  });
});

describe('shortPlanVersionId', () => {
  it('is short enough to read and long enough to tell rows apart', () => {
    expect(shortPlanVersionId('01920000-0000-7000-8000-000000000002')).toBe('#01920000');
  });
});

describe('usdHeadline', () => {
  it('drops cents that are not there, and keeps the ones that are', () => {
    expect(usdHeadline(0)).toBe('$0');
    expect(usdHeadline(500)).toBe('$5');
    expect(usdHeadline(550)).toBe('$5.50');
    expect(usdHeadline(599)).toBe('$5.99');
  });
});

/**
 * The catalogue's failure codes are what the console renders, so a code that
 * exists in the domain and not in the dictionary is a raw machine string on
 * screen. Both dictionaries are checked, because only one of them is the
 * reference the other is typed against.
 */
describe('every refusal has words for it', () => {
  it('is spelled out in both languages', () => {
    for (const code of PLAN_CHANGE_ERRORS) {
      expect(zh.admin.plans.errors[code]).toBeTruthy();
      expect(en.admin.plans.errors[code]).toBeTruthy();
    }
  });
});

/**
 * requirement.md 5.3: the audit log records plan, user and permission actions.
 * The audit screen falls back to printing the raw action code, so a missing
 * label is not a crash -- it is `plan.create_version` sitting in a column of
 * sentences.
 */
describe('every audited action has words for it', () => {
  const WRITTEN_ACTIONS = [
    'admin.sign_in',
    'admin.sign_out',
    'admin.invite',
    'admin.enrol',
    'admin.change_role',
    'admin.enable',
    'admin.disable',
    'admin.revoke_sessions',
    'admin.export',
    'user.suspend',
    'user.enable',
    'plan.create_version',
  ];

  it('is spelled out in both languages', () => {
    for (const action of WRITTEN_ACTIONS) {
      expect(zh.admin.audit.actions).toHaveProperty(action);
      expect(en.admin.audit.actions).toHaveProperty(action);
    }
  });
});
