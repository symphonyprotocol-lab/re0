/**
 * What the public pricing page prints, from the plan versions in force.
 *
 * The page used to carry its own copy of every figure -- "$5", "5,000
 * calls" -- while checkout charged whatever the console's newest version
 * said. A price raised in the console therefore charged the new amount under
 * a card that still advertised the old one. The figures now come from the
 * same rows checkout and the quota read
 * (lib/application/plans/configuration.ts `currentPlanVersion`); only the
 * words are the dictionary's, as templates. Pure, so the arithmetic is
 * checked without a database.
 *
 * Storage is not a plan figure: agent-first-proposal.md 8.1 bounds a
 * workspace by the owner's storage tier, so the two capacities come from
 * `lib/domain/plans.ts` rather than from a version.
 */
import { bytesToMb, storageCapacityBytes } from './plans';

/** The part of a plan version the page reads. */
export interface PricedVersion {
  priceMinor: number;
  monthlyCalls: number;
  apiKeyLimit: number;
  buildBaseCalls: number;
  buildTokensPerCall: number;
  buildPagesPerCall: number;
}

export interface PricingVersions {
  free: PricedVersion;
  addon: PricedVersion;
}

/**
 * What the seed migration wrote, for a database that has no version of a
 * tier yet. A fresh deployment still renders a page; it never invents a
 * price that checkout would not charge, because checkout refuses a tier with
 * no version at all.
 */
export const FALLBACK_PRICING: PricingVersions = {
  free: {
    priceMinor: 0,
    monthlyCalls: 1_000,
    apiKeyLimit: 20,
    buildBaseCalls: 1,
    buildTokensPerCall: 20_000,
    buildPagesPerCall: 5,
  },
  addon: {
    priceMinor: 500,
    monthlyCalls: 5_000,
    apiKeyLimit: 0,
    buildBaseCalls: 0,
    buildTokensPerCall: 0,
    buildPagesPerCall: 0,
  },
};

/** USD minor units as a price: `$10`, `$9.50`, `$0`. */
export function formatUsd(minor: number, number: Intl.NumberFormat): string {
  const whole = minor % 100 === 0;
  return `$${whole ? number.format(minor / 100) : (minor / 100).toFixed(2)}`;
}

/** A storage capacity as the page prints it: whole megabytes below a gigabyte, gigabytes above. */
export function formatCapacity(bytes: number, number: Intl.NumberFormat): string {
  const mb = bytesToMb(bytes);
  return mb >= 1_024 && mb % 1_024 === 0 ? `${number.format(mb / 1_024)} GB` : `${number.format(mb)} MB`;
}

/** The figures every template on the page may ask for, already formatted. */
export function pricingFigures(versions: PricingVersions, number: Intl.NumberFormat) {
  const tier = (version: PricedVersion) => ({
    price: formatUsd(version.priceMinor, number),
    calls: number.format(version.monthlyCalls),
    keys: number.format(version.apiKeyLimit),
    tokens: number.format(version.buildTokensPerCall),
    pages: number.format(version.buildPagesPerCall),
    base: number.format(version.buildBaseCalls),
  });
  return {
    free: tier(versions.free),
    addon: tier(versions.addon),
    storage: {
      base: formatCapacity(storageCapacityBytes('base'), number),
      extended: formatCapacity(storageCapacityBytes('extended'), number),
    },
  };
}
