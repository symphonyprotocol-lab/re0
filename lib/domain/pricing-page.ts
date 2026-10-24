/**
 * What the public pricing page prints, from the plan versions in force.
 *
 * The page used to carry its own copy of every figure -- "$5", "5,000
 * calls", "25 libraries" -- while checkout charged whatever the console's
 * newest version said. A price raised in the console therefore charged the
 * new amount under a card that still advertised the old one. The figures now
 * come from the same rows checkout and the quota read
 * (lib/application/plans/configuration.ts `currentPlanVersion`); only the
 * words are the dictionary's, as templates. Pure, so the arithmetic is
 * checked without a database.
 */
import { bytesToMb, sharePercentFromBps } from './plans';

/** The part of a plan version the page reads. */
export interface PricedVersion {
  priceMinor: number;
  monthlyCalls: number;
  libraryLimit: number;
  librarySizeBytesLimit: number;
  shareRateBps: number;
  buildBaseCalls: number;
  buildTokensPerCall: number;
  buildPagesPerCall: number;
  capabilities: { siteKeys: number; showcasePages: number };
}

export interface PricingVersions {
  free: PricedVersion;
  pro: PricedVersion;
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
    libraryLimit: 5,
    librarySizeBytesLimit: 20 * 1024 * 1024,
    shareRateBps: 2_000,
    buildBaseCalls: 1,
    buildTokensPerCall: 20_000,
    buildPagesPerCall: 5,
    capabilities: { siteKeys: 1, showcasePages: 1 },
  },
  pro: {
    priceMinor: 500,
    monthlyCalls: 5_000,
    libraryLimit: 25,
    librarySizeBytesLimit: 100 * 1024 * 1024,
    shareRateBps: 2_000,
    buildBaseCalls: 1,
    buildTokensPerCall: 20_000,
    buildPagesPerCall: 5,
    capabilities: { siteKeys: -1, showcasePages: -1 },
  },
  addon: {
    priceMinor: 500,
    monthlyCalls: 5_000,
    libraryLimit: 0,
    librarySizeBytesLimit: 0,
    shareRateBps: 0,
    buildBaseCalls: 0,
    buildTokensPerCall: 0,
    buildPagesPerCall: 0,
    capabilities: { siteKeys: 0, showcasePages: 0 },
  },
};

/** USD minor units as a price: `$10`, `$9.50`, `$0`. */
export function formatUsd(minor: number, number: Intl.NumberFormat): string {
  const whole = minor % 100 === 0;
  return `$${whole ? number.format(minor / 100) : (minor / 100).toFixed(2)}`;
}

export interface SurfaceWords {
  keys: string;
  keysMany: string;
  keysUnlimited: string;
  pages: string;
  pagesMany: string;
  pagesUnlimited: string;
  join: string;
  unlimited: string;
}

const fillIn = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key]! : match));

/** "1 website widget key and 1 shared page", "Unlimited widget keys and unlimited shared pages". */
export function surfacesLine(version: PricedVersion, words: SurfaceWords, number: Intl.NumberFormat): string {
  const { siteKeys, showcasePages } = version.capabilities;
  const keys =
    siteKeys < 0 ? words.keysUnlimited : fillIn(siteKeys === 1 ? words.keys : words.keysMany, { n: number.format(siteKeys) });
  const pages =
    showcasePages < 0
      ? words.pagesUnlimited
      : fillIn(showcasePages === 1 ? words.pages : words.pagesMany, { n: number.format(showcasePages) });
  return fillIn(words.join, { keys, pages });
}

/** A cap as a table cell: the number, or "Unlimited" for -1. */
export function capCell(cap: number, words: SurfaceWords, number: Intl.NumberFormat): string {
  return cap < 0 ? words.unlimited : number.format(cap);
}

/** The figures every template on the page may ask for, already formatted. */
export function pricingFigures(versions: PricingVersions, number: Intl.NumberFormat, words: SurfaceWords) {
  const mb = (bytes: number) => `${number.format(bytesToMb(bytes))} MB`;
  const tier = (version: PricedVersion) => ({
    price: formatUsd(version.priceMinor, number),
    calls: number.format(version.monthlyCalls),
    libraries: number.format(version.libraryLimit),
    size: mb(version.librarySizeBytesLimit),
    surfaces: surfacesLine(version, words, number),
    tokens: number.format(version.buildTokensPerCall),
    pages: number.format(version.buildPagesPerCall),
    base: number.format(version.buildBaseCalls),
    share: `${sharePercentFromBps(version.shareRateBps)}%`,
    siteKeys: capCell(version.capabilities.siteKeys, words, number),
    showcasePages: capCell(version.capabilities.showcasePages, words, number),
  });
  return { free: tier(versions.free), pro: tier(versions.pro), addon: tier(versions.addon) };
}
