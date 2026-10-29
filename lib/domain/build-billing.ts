/**
 * Library build billing, as pure functions. library-build-billing.md.
 *
 * A build is priced in the same unit as everything else the platform sells --
 * whole API Calls -- and never in tokens or provider dollars. The price is a
 * function of what the build actually added (fresh tokens embedded, pages
 * fetched) at rates frozen on the caller's Plan Version, so the owner can
 * work the worst case out from the capacity ceiling before pressing the
 * button. Nothing here reads a database.
 */

/** The three rates a Plan Version freezes. library-build-billing.md 3.3. */
export interface BuildRates {
  /** The fixed part of every priced build. */
  baseCalls: number;
  /** Fresh tokens per Call; 0 only on the pack sentinel (`PACK_NO_ENTITLEMENT`). */
  tokensPerCall: number;
  /** Fetched pages per Call; 0 only on the pack sentinel. */
  pagesPerCall: number;
}

/** What the seed migration writes and what a tier without a rate falls back to. */
export const DEFAULT_BUILD_RATES: BuildRates = {
  baseCalls: 1,
  tokensPerCall: 20_000,
  pagesPerCall: 5,
};

/**
 * Ceilings on what the console may mint, like `PLAN_LIMITS`: the boundary
 * between a typo and an instruction, not a product rule.
 */
export const BUILD_RATE_LIMITS = {
  baseCalls: { min: 0, max: 10_000 },
  tokensPerCall: { min: 1, max: 100_000_000 },
  pagesPerCall: { min: 1, max: 1_000_000 },
} as const;

/** What one build measured about itself once chunking was done. */
export interface BuildFacts {
  /** Tokens of chunks parsed and embedded by this build. */
  freshTokens: number;
  /** Tokens copied forward from the current version, never re-embedded. */
  carriedTokens: number;
  /** Files a connector fetched from a host this build; 0 for github, notion, pdf. */
  pagesFetched: number;
  /**
   * The build re-parsed unchanged sources because the platform changed the
   * parser, the chunker or the embedding model. library-build-billing.md 1.1:
   * that is the platform's decision, so it is not the owner's bill.
   */
  platformRebuild: boolean;
}

/**
 * library-build-billing.md 3.2:
 *
 *   build_calls = base + ceil(fresh_tokens / tokens_per_call)
 *                      + ceil(pages_fetched / pages_per_call)
 *
 * A platform rebuild prices at zero. A rate of 0 (the pack sentinel) prices
 * that term at zero rather than dividing by it -- a pack never bills a
 * build, and a defensive zero beats a NaN in a ledger.
 */
export function priceBuild(facts: BuildFacts, rates: BuildRates): number {
  if (facts.platformRebuild) return 0;
  const tokens = rates.tokensPerCall > 0 ? Math.ceil(Math.max(0, facts.freshTokens) / rates.tokensPerCall) : 0;
  const pages = rates.pagesPerCall > 0 ? Math.ceil(Math.max(0, facts.pagesFetched) / rates.pagesPerCall) : 0;
  return Math.max(0, rates.baseCalls) + tokens + pages;
}

/**
 * The most a build can cost before anything is fetched: the storage the
 * workspace has left turned into tokens at four bytes each, plus the crawl
 * page limit for sources that fetch pages. What the wizard shows and what
 * the reservation holds until the real figure is known.
 */
export function quoteBuildCap(input: {
  rates: BuildRates;
  /** The most content this build may add to the workspace, in bytes. */
  capacityBytes: number;
  /** The most pages the connector may fetch; 0 for sources that fetch none. */
  pageLimit: number;
  /** A tighter content estimate when the wizard has one (upload bytes, repository size). */
  estimatedBytes?: number;
}): number {
  const bytes =
    input.estimatedBytes !== undefined
      ? Math.min(Math.max(0, input.estimatedBytes), input.capacityBytes)
      : input.capacityBytes;
  return priceBuild(
    {
      freshTokens: estimateTokens(bytes),
      carriedTokens: 0,
      pagesFetched: Math.max(0, input.pageLimit),
      platformRebuild: false,
    },
    input.rates,
  );
}

/** library-build-billing.md 4.1: tokens ≈ bytes / 4. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}

/**
 * What the usage event keeps of a priced build, so a dispute is answered by
 * reading the row rather than by recomputing anything.
 */
export interface BuildDetail extends BuildFacts {
  planVersionId: string | null;
  baseCalls: number;
  tokensPerCall: number;
  pagesPerCall: number;
  /** The price the formula gave, whatever `calls` was actually debited. */
  billedCalls: number;
  /** How the debit split; empty in shadow mode. */
  planCalls: number;
  addonCalls: number;
  mode: BuildBillingMode;
}

/**
 * library-build-billing.md 11: phase 1 records what a build *would* cost
 * without debiting it, so the rates can be checked against real builds
 * before anyone is charged. `enforce` is phase 2.
 */
export const BUILD_BILLING_MODES = ['shadow', 'enforce'] as const;

export type BuildBillingMode = (typeof BUILD_BILLING_MODES)[number];

export function isBuildBillingMode(value: unknown): value is BuildBillingMode {
  return typeof value === 'string' && (BUILD_BILLING_MODES as readonly string[]).includes(value);
}

/** Reads the mode from configuration; anything unrecognised is the safe phase. */
export function buildBillingMode(raw: string | undefined): BuildBillingMode {
  const value = raw?.trim().toLowerCase();
  return isBuildBillingMode(value) ? value : 'shadow';
}

/** The `entrypoint` a build's usage event carries, which every count filters on. */
export const BUILD_ENTRYPOINT = 'build';

/** The `request_id` a build bills under: one per operation, so a retry is a replay. */
export function buildRequestId(operationId: string): string {
  return `build:${operationId}`;
}
