/**
 * Plan configuration rules, as pure functions. No Next.js, no driver, no fetch.
 *
 * A Plan Version is immutable (architecture.md 6.1): changing a price or a
 * ceiling means minting a new row, never updating one. Everything here exists
 * to decide whether a proposed row is allowed to be minted at all, so the
 * console, the tests and any future admin API answer the same way.
 *
 * The catalogue is closed by product decision, not by convenience:
 * requirement.md 4.3 says the self-serve catalogue is Free, Pro and the
 * Additional Calls pack, with no Enterprise tier and no currency but USD, and
 * that the console maintains the Plan Version of exactly those three.
 */

import { BUILD_RATE_LIMITS, DEFAULT_BUILD_RATES } from './build-billing';

export const PLAN_TIER_IDS = ['free', 'pro', 'addon'] as const;

export type PlanTierId = (typeof PLAN_TIER_IDS)[number];

export function isPlanTierId(value: unknown): value is PlanTierId {
  return typeof value === 'string' && (PLAN_TIER_IDS as readonly string[]).includes(value);
}

/** requirement.md 4.3: orders keep the original amount and currency, and it is USD. */
export const PLAN_CURRENCY = 'USD';

/**
 * The pack is not a subscription tier (architecture.md 6.1). It buys calls and
 * nothing else: its buyer keeps the Pro entitlements they already had
 * (requirement.md 4.1, "沿用 Pro 权限"), so a pack version carries no library,
 * capacity or key ceiling of its own, and no share rate -- a settlement reads
 * the rate off the subscription's plan version, and no subscription points at
 * a pack.
 *
 * Those columns are `NOT NULL`, so a pack version stores this sentinel rather
 * than a number that would read as a real ceiling of zero.
 */
export const PACK_INHERITS_PRO = 0;

export function tierHasEntitlements(tier: PlanTierId): boolean {
  return tier !== 'addon';
}

/** Free is not sold, so its price is fixed at zero rather than merely defaulted. */
export function tierIsFree(tier: PlanTierId): boolean {
  return tier === 'free';
}

/* ------------------------------------------------------------------ limits */

/**
 * Ceilings on what a console form may mint.
 *
 * These are not product limits -- they are the boundary between a typo and an
 * instruction. A mistyped price with an extra zero is a real refund queue, and
 * a mistyped byte ceiling is an ingestion bill, so both are refused here rather
 * than discovered later.
 */
export const PLAN_LIMITS = {
  /** $0 to $10,000 a month, in cents. */
  priceMinor: { min: 0, max: 1_000_000 },
  monthlyCalls: { min: 1, max: 100_000_000 },
  libraryLimit: { min: 1, max: 100_000 },
  /** 1 MB to 100 GB, held in whole megabytes because that is how it is edited. */
  librarySizeMb: { min: 1, max: 102_400 },
  apiKeyLimit: { min: 1, max: 10_000 },
  /** requirement.md 4.4: the publisher share, in basis points. */
  shareRateBps: { min: 0, max: 10_000 },
} as const;

export const BYTES_PER_MB = 1_048_576;

export function mbToBytes(megabytes: number): number {
  return megabytes * BYTES_PER_MB;
}

/** Exact when the stored value is a whole number of MB, which every minted one is. */
export function bytesToMb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

/* ------------------------------------------------------------------ shapes */

/**
 * The entitlements a version carries beyond its numeric columns, stored in
 * its capability JSON so they freeze with the rest of the row.
 *
 * `publicReviewRequired` used to be one: whether a tier's public libraries
 * waited for review. Public review before publication ended on 2026-10-23,
 * so the flag is no longer read or written; versions minted before then
 * still carry it in their JSON, and it is ignored there.
 */
export interface PlanCapabilities {
  /** requirement.md 4.1: only Pro may buy call packs. Derived, not edited. */
  addonPurchase: boolean;
  /**
   * Showcase pages (lib/domain/showcase.ts): how many of the workspace's
   * libraries may have one, -1 for no cap. Free gets one, Pro any number;
   * a stored value on the version overrides the tier default.
   */
  showcasePages: number;
  /** Whether the showcase page's footer brand may be switched off. */
  showcaseBranding: boolean;
  /** How many leads a showcase page keeps for its owner to read, -1 for no cap. Free 100, Pro any number. */
  showcaseLeadsRetained: number;
  /** Whether a showcase page may sit on the owner's own subdomain. Pro only. */
  showcaseCustomDomain: boolean;
  /**
   * Website widget (lib/domain/site-key.ts): how many live site keys the
   * workspace may hold across its libraries, -1 for no cap. Free gets one,
   * Pro any number; a stored value on the version overrides the tier default.
   */
  siteKeys: number;
}

export interface ShowcaseCapabilities {
  showcasePages: number;
  showcaseBranding: boolean;
  showcaseLeadsRetained: number;
  showcaseCustomDomain: boolean;
}

export interface WidgetCapabilities {
  siteKeys: number;
}

/** The tier's default for the widget entitlement, before any stored override. */
export function widgetDefaultsFor(tier: PlanTierId): WidgetCapabilities {
  return { siteKeys: tier === 'pro' ? -1 : 1 };
}

/** Whether one more site key fits under the plan's cap (-1 = no cap). */
export function siteKeysAllowed(limit: number, liveKeys: number): boolean {
  return limit < 0 || liveKeys < limit;
}

/** The tier's defaults for the showcase entitlements, before any stored override. */
export function showcaseDefaultsFor(tier: PlanTierId): ShowcaseCapabilities {
  return tier === 'pro'
    ? { showcasePages: -1, showcaseBranding: true, showcaseLeadsRetained: -1, showcaseCustomDomain: true }
    : { showcasePages: 1, showcaseBranding: false, showcaseLeadsRetained: 100, showcaseCustomDomain: false };
}

export function capabilitiesFor(
  tier: PlanTierId,
  surfaces: Partial<ShowcaseCapabilities & WidgetCapabilities> = {},
): PlanCapabilities {
  const defaults = showcaseDefaultsFor(tier);
  const widget = widgetDefaultsFor(tier);
  return {
    addonPurchase: tier === 'pro',
    showcasePages: surfaces.showcasePages ?? defaults.showcasePages,
    showcaseBranding: surfaces.showcaseBranding ?? defaults.showcaseBranding,
    showcaseLeadsRetained: surfaces.showcaseLeadsRetained ?? defaults.showcaseLeadsRetained,
    showcaseCustomDomain: surfaces.showcaseCustomDomain ?? defaults.showcaseCustomDomain,
    siteKeys: surfaces.siteKeys ?? widget.siteKeys,
  };
}

/** Reads a stored capability blob without trusting its shape. */
export function readCapabilities(
  tier: PlanTierId,
  stored: Record<string, unknown> | null | undefined,
): PlanCapabilities {
  const pages = stored?.showcasePages;
  const branding = stored?.showcaseBranding;
  const leads = stored?.showcaseLeadsRetained;
  const domain = stored?.showcaseCustomDomain;
  const keys = stored?.siteKeys;
  const cap = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= -1;
  return capabilitiesFor(tier, {
    ...(cap(pages) ? { showcasePages: pages } : {}),
    ...(typeof branding === 'boolean' ? { showcaseBranding: branding } : {}),
    ...(cap(leads) ? { showcaseLeadsRetained: leads } : {}),
    ...(typeof domain === 'boolean' ? { showcaseCustomDomain: domain } : {}),
    ...(cap(keys) ? { siteKeys: keys } : {}),
  });
}

/** A validated row, ready to insert. Amounts are minor units; capacity is bytes. */
export interface PlanVersionDraft {
  planId: PlanTierId;
  priceMinor: number;
  currency: typeof PLAN_CURRENCY;
  monthlyCalls: number;
  libraryLimit: number;
  librarySizeBytesLimit: number;
  apiKeyLimit: number;
  shareRateBps: number;
  /** library-build-billing.md 3.3; the pack carries the 0 sentinel in all three. */
  buildBaseCalls: number;
  buildTokensPerCall: number;
  buildPagesPerCall: number;
  capabilities: PlanCapabilities;
}

/* ------------------------------------------------------------------ errors */

export const PLAN_CHANGE_ERRORS = [
  'unknown_plan',
  'unsupported_currency',
  'invalid_price',
  'invalid_calls',
  'invalid_library_limit',
  'invalid_library_size',
  'invalid_api_key_limit',
  'invalid_share_rate',
  'invalid_build_rate',
  'free_must_be_free',
  'no_change',
  'superseded',
  'reason_required',
  'unavailable',
] as const;

export type PlanChangeError = (typeof PLAN_CHANGE_ERRORS)[number];

export function isPlanChangeError(value: unknown): value is PlanChangeError {
  return typeof value === 'string' && (PLAN_CHANGE_ERRORS as readonly string[]).includes(value);
}

export class PlanChangeRefused extends Error {
  constructor(
    readonly code: PlanChangeError,
    message: string,
  ) {
    super(message);
    this.name = 'PlanChangeRefused';
  }
}

/* -------------------------------------------------------------- validation */

/**
 * A whole number typed into a form field.
 *
 * Deliberately strict: `Number('')` is 0 and `Number('1e3')` is 1000, and
 * neither is something an operator meant to type into a call ceiling.
 */
function wholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,12}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A USD amount as typed -- "5", "5.5", "5.50" -- as an integer number of cents.
 *
 * Parsed from the digits rather than through a float: `Math.round(5.7 * 100)`
 * happens to be right and `Math.round(1.005 * 100)` is not, and money that is
 * occasionally a cent out is worse than money that refuses to parse.
 */
export function parseUsdMinor(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const cents = (match[2] ?? '').padEnd(2, '0');
  return Number(match[1]) * 100 + Number(cents);
}

function within(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}

export interface PlanVersionInput {
  planId: string;
  currency?: string;
  /** As typed: dollars, optionally with cents. */
  price: string;
  /** Monthly allowance for a tier; calls per pack for the addon. */
  calls: string;
  libraryLimit?: string;
  librarySizeMb?: string;
  apiKeyLimit?: string;
  shareRate?: string;
  /** library-build-billing.md 3.3, as typed. Absent means "keep the defaults". */
  buildBaseCalls?: string;
  buildTokensPerCall?: string;
  buildPagesPerCall?: string;
}

/**
 * Turns what a form posted into a row that may be minted, or refuses it.
 *
 * The refusals are specific because the audience is an entitled operator who
 * needs to know which field to fix -- unlike the sign-in codes, there is no
 * oracle to deny anyone here.
 */
export function parsePlanVersionDraft(input: PlanVersionInput): PlanVersionDraft {
  const planId = input.planId.trim();
  if (!isPlanTierId(planId)) {
    throw new PlanChangeRefused('unknown_plan', `the catalogue has no "${planId}" tier`);
  }

  /*
   * requirement.md 4.3 forbids a non-USD price outright, so the currency is
   * checked rather than coerced: a form that manages to post something else is
   * asking for a row the product does not allow, not for a conversion.
   */
  if (input.currency !== undefined && input.currency.trim().toUpperCase() !== PLAN_CURRENCY) {
    throw new PlanChangeRefused('unsupported_currency', 'plans are priced in USD only');
  }

  const priceMinor = parseUsdMinor(input.price);
  if (priceMinor === null || !within(priceMinor, PLAN_LIMITS.priceMinor)) {
    throw new PlanChangeRefused('invalid_price', 'price must be a USD amount within range');
  }
  if (tierIsFree(planId) && priceMinor !== 0) {
    throw new PlanChangeRefused('free_must_be_free', 'the Free tier cannot carry a price');
  }

  const monthlyCalls = wholeNumber(input.calls);
  if (monthlyCalls === null || !within(monthlyCalls, PLAN_LIMITS.monthlyCalls)) {
    throw new PlanChangeRefused('invalid_calls', 'the call allowance must be a whole number');
  }

  if (!tierHasEntitlements(planId)) {
    /*
     * A pack version carries only its price and its calls. Any entitlement
     * posted alongside them is ignored rather than stored, so nothing can ever
     * read a ceiling off a row that does not grant one.
     */
    return {
      planId,
      priceMinor,
      currency: PLAN_CURRENCY,
      monthlyCalls,
      libraryLimit: PACK_INHERITS_PRO,
      librarySizeBytesLimit: PACK_INHERITS_PRO,
      apiKeyLimit: PACK_INHERITS_PRO,
      shareRateBps: PACK_INHERITS_PRO,
      buildBaseCalls: PACK_INHERITS_PRO,
      buildTokensPerCall: PACK_INHERITS_PRO,
      buildPagesPerCall: PACK_INHERITS_PRO,
      capabilities: capabilitiesFor(planId),
    };
  }

  const libraryLimit = wholeNumber(input.libraryLimit ?? '');
  if (libraryLimit === null || !within(libraryLimit, PLAN_LIMITS.libraryLimit)) {
    throw new PlanChangeRefused('invalid_library_limit', 'the library ceiling must be a number');
  }

  const librarySizeMb = wholeNumber(input.librarySizeMb ?? '');
  if (librarySizeMb === null || !within(librarySizeMb, PLAN_LIMITS.librarySizeMb)) {
    throw new PlanChangeRefused('invalid_library_size', 'the capacity ceiling must be in whole MB');
  }

  const apiKeyLimit = wholeNumber(input.apiKeyLimit ?? '');
  if (apiKeyLimit === null || !within(apiKeyLimit, PLAN_LIMITS.apiKeyLimit)) {
    throw new PlanChangeRefused('invalid_api_key_limit', 'the API key ceiling must be a number');
  }

  const shareRateBps = parseSharePercent(input.shareRate ?? '');
  if (shareRateBps === null || !within(shareRateBps, PLAN_LIMITS.shareRateBps)) {
    throw new PlanChangeRefused('invalid_share_rate', 'the publisher share must be 0-100%');
  }

  /*
   * The build rates default rather than demand: a form written before they
   * existed still mints a valid row, and the defaults are what the migration
   * wrote onto every tier. A typed value is held to its ceiling like the rest.
   */
  const buildRate = (raw: string | undefined, fallback: number, range: { min: number; max: number }) => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = wholeNumber(raw);
    if (value === null || !within(value, range)) {
      throw new PlanChangeRefused('invalid_build_rate', 'a build rate must be a whole number within range');
    }
    return value;
  };
  const buildBaseCalls = buildRate(
    input.buildBaseCalls,
    DEFAULT_BUILD_RATES.baseCalls,
    BUILD_RATE_LIMITS.baseCalls,
  );
  const buildTokensPerCall = buildRate(
    input.buildTokensPerCall,
    DEFAULT_BUILD_RATES.tokensPerCall,
    BUILD_RATE_LIMITS.tokensPerCall,
  );
  const buildPagesPerCall = buildRate(
    input.buildPagesPerCall,
    DEFAULT_BUILD_RATES.pagesPerCall,
    BUILD_RATE_LIMITS.pagesPerCall,
  );

  return {
    planId,
    priceMinor,
    currency: PLAN_CURRENCY,
    monthlyCalls,
    libraryLimit,
    librarySizeBytesLimit: mbToBytes(librarySizeMb),
    apiKeyLimit,
    shareRateBps,
    buildBaseCalls,
    buildTokensPerCall,
    buildPagesPerCall,
    capabilities: capabilitiesFor(planId),
  };
}

/** A percentage as typed -- "20", "17.5" -- as basis points. */
export function parseSharePercent(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return Number(match[1]) * 100 + Number(fraction);
}

export function sharePercentFromBps(bps: number): string {
  const percent = bps / 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0$/, '');
}

/** A minor-unit amount as an editable string: 500 -> "5.00". */
export function usdFromMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** The same amount as a headline: 500 -> "$5", 550 -> "$5.50". */
export function usdHeadline(minor: number): string {
  return `$${minor % 100 === 0 ? String(minor / 100) : usdFromMinor(minor)}`;
}

/**
 * Whether a draft would change anything about the live version.
 *
 * Minting an identical version is not harmless: every version is a row an
 * operator has to read past on the history, and a run of them hides the change
 * that mattered. It also invites the wrong conclusion -- that "save" is how
 * this screen confirms a value, rather than how it supersedes one.
 */
export function isSamePlanVersion(
  draft: PlanVersionDraft,
  live: {
    priceMinor: number;
    currency: string;
    monthlyCalls: number;
    libraryLimit: number;
    librarySizeBytesLimit: number;
    apiKeyLimit: number;
    shareRateBps: number;
    buildBaseCalls: number;
    buildTokensPerCall: number;
    buildPagesPerCall: number;
    capabilities: PlanCapabilities;
  } | null,
): boolean {
  if (live === null) return false;
  return (
    draft.priceMinor === live.priceMinor &&
    draft.currency === live.currency &&
    draft.monthlyCalls === live.monthlyCalls &&
    draft.libraryLimit === live.libraryLimit &&
    draft.librarySizeBytesLimit === live.librarySizeBytesLimit &&
    draft.apiKeyLimit === live.apiKeyLimit &&
    draft.shareRateBps === live.shareRateBps &&
    draft.buildBaseCalls === live.buildBaseCalls &&
    draft.buildTokensPerCall === live.buildTokensPerCall &&
    draft.buildPagesPerCall === live.buildPagesPerCall &&
    draft.capabilities.showcasePages === live.capabilities.showcasePages &&
    draft.capabilities.showcaseBranding === live.capabilities.showcaseBranding &&
    draft.capabilities.showcaseLeadsRetained === live.capabilities.showcaseLeadsRetained &&
    draft.capabilities.showcaseCustomDomain === live.capabilities.showcaseCustomDomain &&
    draft.capabilities.siteKeys === live.capabilities.siteKeys
  );
}

/**
 * Enough of a version id to recognise a row by, and short enough to sit in a
 * sentence. The console never shows the full UUID: it is a join key, and a
 * table column of them is unreadable.
 */
export function shortPlanVersionId(id: string): string {
  return `#${id.replace(/-/g, '').slice(0, 8)}`;
}
