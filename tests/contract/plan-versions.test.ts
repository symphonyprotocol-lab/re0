import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import {
  BYTES_PER_MB,
  PACK_INHERITS_PRO,
  PLAN_CHANGE_ERRORS,
  PLAN_TIER_IDS,
  PlanChangeRefused,
  bytesToMb,
  capabilitiesFor,
  isPlanTierId,
  isSamePlanVersion,
  parsePlanVersionDraft,
  parseSharePercent,
  parseUsdMinor,
  readCapabilities,
  sharePercentFromBps,
  shortPlanVersionId,
  siteKeysAllowed,
  usdFromMinor,
  usdHeadline,
  type PlanChangeError,
  type PlanVersionInput,
} from '@/lib/domain/plans';

const PRO: PlanVersionInput = {
  planId: 'pro',
  currency: 'USD',
  price: '5.00',
  calls: '5000',
  libraryLimit: '25',
  librarySizeMb: '100',
  apiKeyLimit: '20',
  shareRate: '20',
  publicReviewRequired: true,
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
 * (requirement.md 4.3). The screen renders three cards; nothing stops a caller
 * posting a fourth tier to the same server action, so the refusal has to live
 * here rather than in the markup.
 */
describe('the plan catalogue', () => {
  it('is Free, Pro and the call pack, and nothing else', () => {
    expect([...PLAN_TIER_IDS]).toEqual(['free', 'pro', 'addon']);
    for (const tier of ['enterprise', 'team', 'business', '', 'Pro']) {
      expect(isPlanTierId(tier)).toBe(false);
    }
  });

  it('refuses a tier that is not in the catalogue', () => {
    expect(refusal({ ...PRO, planId: 'enterprise' })).toBe('unknown_plan');
  });

  it('refuses any currency but USD', () => {
    expect(refusal({ ...PRO, currency: 'EUR' })).toBe('unsupported_currency');
    expect(refusal({ ...PRO, currency: 'CNY' })).toBe('unsupported_currency');
    // Case and padding are the operator's, not a different currency.
    expect(refusal({ ...PRO, currency: ' usd ' })).toBe('accepted');
  });

  it('stores USD even when the caller says nothing about currency', () => {
    const { currency } = parsePlanVersionDraft({ ...PRO, currency: undefined });
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

describe('parseSharePercent', () => {
  it('reads a percentage as basis points', () => {
    expect(parseSharePercent('20')).toBe(2000);
    expect(parseSharePercent('17.5')).toBe(1750);
    expect(parseSharePercent('0')).toBe(0);
    expect(parseSharePercent('100')).toBe(10_000);
  });

  it('refuses a share that is not a percentage', () => {
    for (const raw of ['', '-1', '20%', '1e2', 'twenty']) {
      expect(parseSharePercent(raw)).toBeNull();
    }
  });

  it('round-trips through the editable form', () => {
    for (const bps of [0, 1750, 2000, 1705, 10_000]) {
      expect(parseSharePercent(sharePercentFromBps(bps))).toBe(bps);
    }
  });
});

describe('a proposed version', () => {
  it('accepts the seeded Pro values', () => {
    expect(parsePlanVersionDraft(PRO)).toEqual({
      planId: 'pro',
      priceMinor: 500,
      currency: 'USD',
      monthlyCalls: 5000,
      libraryLimit: 25,
      librarySizeBytesLimit: 100 * BYTES_PER_MB,
      apiKeyLimit: 20,
      shareRateBps: 2000,
      buildBaseCalls: 1,
      buildTokensPerCall: 20_000,
      buildPagesPerCall: 5,
      capabilities: capabilitiesFor('pro', true),
    });
  });

  it('names the field that is wrong rather than a generic refusal', () => {
    expect(refusal({ ...PRO, price: 'free' })).toBe('invalid_price');
    expect(refusal({ ...PRO, calls: '0' })).toBe('invalid_calls');
    expect(refusal({ ...PRO, libraryLimit: '' })).toBe('invalid_library_limit');
    expect(refusal({ ...PRO, librarySizeMb: '0.5' })).toBe('invalid_library_size');
    expect(refusal({ ...PRO, apiKeyLimit: 'many' })).toBe('invalid_api_key_limit');
    expect(refusal({ ...PRO, shareRate: '120' })).toBe('invalid_share_rate');
  });

  /*
   * The ceilings are the boundary between a typo and an instruction: a price
   * with an extra zero is a refund queue, and a byte ceiling with one is an
   * ingestion bill.
   */
  it('refuses a value past the ceiling a form can mean', () => {
    expect(refusal({ ...PRO, price: '10000.01' })).toBe('invalid_price');
    expect(refusal({ ...PRO, price: '10000' })).toBe('accepted');
    expect(refusal({ ...PRO, calls: '100000001' })).toBe('invalid_calls');
    expect(refusal({ ...PRO, librarySizeMb: '102401' })).toBe('invalid_library_size');
  });

  it('keeps Free free', () => {
    const free = { ...PRO, planId: 'free', price: '0', libraryLimit: '5' };
    expect(refusal(free)).toBe('accepted');
    expect(refusal({ ...free, price: '1' })).toBe('free_must_be_free');
  });

  it('does not let a Free version claim the pack-purchase capability', () => {
    const { capabilities } = parsePlanVersionDraft({ ...PRO, planId: 'free', price: '0' });
    expect(capabilities.addonPurchase).toBe(false);
  });
});

/**
 * requirement.md 4.1: a pack buys calls. Its buyer keeps the Pro entitlements
 * they already had, so a pack version must not carry a ceiling of its own --
 * not even one posted alongside the price.
 */
describe('the Additional Calls pack', () => {
  const PACK: PlanVersionInput = { planId: 'addon', currency: 'USD', price: '5', calls: '5000' };

  it('needs only a price and a call count', () => {
    expect(parsePlanVersionDraft(PACK)).toEqual({
      planId: 'addon',
      priceMinor: 500,
      currency: 'USD',
      monthlyCalls: 5000,
      libraryLimit: PACK_INHERITS_PRO,
      librarySizeBytesLimit: PACK_INHERITS_PRO,
      apiKeyLimit: PACK_INHERITS_PRO,
      shareRateBps: PACK_INHERITS_PRO,
      buildBaseCalls: PACK_INHERITS_PRO,
      buildTokensPerCall: PACK_INHERITS_PRO,
      buildPagesPerCall: PACK_INHERITS_PRO,
      capabilities: capabilitiesFor('addon', true),
    });
  });

  it('drops entitlements a caller posts anyway', () => {
    const draft = parsePlanVersionDraft({
      ...PACK,
      libraryLimit: '999',
      librarySizeMb: '999',
      apiKeyLimit: '999',
      shareRate: '90',
    });
    expect(draft.libraryLimit).toBe(PACK_INHERITS_PRO);
    expect(draft.librarySizeBytesLimit).toBe(PACK_INHERITS_PRO);
    expect(draft.apiKeyLimit).toBe(PACK_INHERITS_PRO);
    expect(draft.shareRateBps).toBe(PACK_INHERITS_PRO);
  });

  it('is still priced in USD only', () => {
    expect(refusal({ ...PACK, currency: 'JPY' })).toBe('unsupported_currency');
  });
});

describe('capabilities', () => {
  it('treats a missing public-review flag as required', () => {
    expect(readCapabilities('pro', {}).publicReviewRequired).toBe(true);
    expect(readCapabilities('pro', null).publicReviewRequired).toBe(true);
    expect(readCapabilities('pro', { publicReviewRequired: 'yes' }).publicReviewRequired).toBe(true);
  });

  it('reads a flag that was actually stored', () => {
    expect(readCapabilities('pro', { publicReviewRequired: false }).publicReviewRequired).toBe(
      false,
    );
  });

  it('derives pack purchase from the tier rather than from the form', () => {
    expect(capabilitiesFor('pro', true).addonPurchase).toBe(true);
    expect(capabilitiesFor('free', true).addonPurchase).toBe(false);
    expect(capabilitiesFor('addon', true).addonPurchase).toBe(false);
  });

  /* The website widget: Free holds one site key, Pro any number; a stored cap wins over the tier. */
  it('caps site keys on Free and lifts the cap on Pro', () => {
    expect(capabilitiesFor('free', true).siteKeys).toBe(1);
    expect(capabilitiesFor('pro', true).siteKeys).toBe(-1);
    expect(readCapabilities('free', {}).siteKeys).toBe(1);
    expect(readCapabilities('free', { siteKeys: 3 }).siteKeys).toBe(3);
    expect(readCapabilities('free', { siteKeys: 'many' }).siteKeys).toBe(1);
    expect(readCapabilities('pro', { siteKeys: -2 }).siteKeys).toBe(-1);
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
  const draft = parsePlanVersionDraft(PRO);
  const live = {
    priceMinor: 500,
    currency: 'USD',
    monthlyCalls: 5000,
    libraryLimit: 25,
    librarySizeBytesLimit: 100 * BYTES_PER_MB,
    apiKeyLimit: 20,
    shareRateBps: 2000,
    buildBaseCalls: 1,
    buildTokensPerCall: 20_000,
    buildPagesPerCall: 5,
    capabilities: capabilitiesFor('pro', true),
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
    expect(isSamePlanVersion(draft, { ...live, libraryLimit: 26 })).toBe(false);
    expect(isSamePlanVersion(draft, { ...live, librarySizeBytesLimit: 1 })).toBe(false);
    expect(isSamePlanVersion(draft, { ...live, apiKeyLimit: 21 })).toBe(false);
    expect(isSamePlanVersion(draft, { ...live, shareRateBps: 2500 })).toBe(false);
    expect(
      isSamePlanVersion(draft, {
        ...live,
        capabilities: capabilitiesFor('pro', false),
      }),
    ).toBe(false);
  });
});

describe('capacity', () => {
  it('round-trips whole megabytes, which is all the console mints', () => {
    for (const mb of [1, 20, 100, 102_400]) {
      expect(bytesToMb(mb * BYTES_PER_MB)).toBe(mb);
    }
  });

  it('matches the values the seed migration wrote', () => {
    expect(bytesToMb(20_971_520)).toBe(20);
    expect(bytesToMb(104_857_600)).toBe(100);
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
 * The pack never renders the review toggle, so an absent checkbox in a posted
 * form means "not asked" -- storing it as `false` would put a policy on a row
 * that grants none, and disagree with what the seed migration wrote.
 */
describe('a pack version', () => {
  it('keeps the platform default when the form says nothing about review', () => {
    const draft = parsePlanVersionDraft({ planId: 'addon', price: '5', calls: '5000' });
    expect(draft.capabilities.publicReviewRequired).toBe(true);
    const posted = parsePlanVersionDraft({
      planId: 'addon',
      price: '5',
      calls: '5000',
      publicReviewRequired: false,
    });
    expect(posted.capabilities.publicReviewRequired).toBe(true);
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
