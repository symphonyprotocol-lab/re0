/**
 * Our own infrastructure rates (docs/audit/credit-import-audit.md P4): their
 * shape, validation, and the costs they price. The values are configured in
 * the console (`lib/services/infra-pricing.ts`); `DEFAULT_INFRA_COST_RATES`
 * applies when nothing is.
 */
import { DEFAULT_INFRA_COST_RATES, EMBEDDING_DIMENSIONS, INFRA_COST_UNITS } from '@/lib/constants';
import { picoUsd, usdPico } from '@/lib/domain/provider-cost';

export interface InfraCostRates {
  /** USD per GB transferred while processing. */
  transferPerGb: string;
  /** USD per GB-month of Blob storage. */
  blobStoragePerGbMonth: string;
  /** USD per GB-month of database storage. */
  databaseStoragePerGbMonth: string;
  /** Stored database bytes count this many times over (indexes); at least 1. */
  databaseIndexFactor: string;
  /** Bytes per stored passage beyond its text and vector. */
  chunkRowBytes: number;
}

export interface InfraCostRatesView extends InfraCostRates {
  /** The row's id, or `default`: what a save must name to replace it. */
  revision: string;
  /** When these rates began to apply (ISO); null for the defaults. */
  effectiveFrom: string | null;
}

export const INFRA_RATE_KEYS = ['transferPerGb', 'blobStoragePerGbMonth', 'databaseStoragePerGbMonth'] as const;

/** A USD amount with at most 12 decimals and 8 whole digits, as the supplier rates take. */
const MONEY = /^\d{1,8}(?:\.\d{1,12})?$/;
const FACTOR = /^\d{1,3}(?:\.\d{1,4})?$/;

/** Canonical decimal text: no leading zeros, no trailing fractional zeros. */
function canonical(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${BigInt(whole!).toString()}${trimmed ? `.${trimmed}` : ''}`;
}

/**
 * Admin input to rates, or null. Every rate must be above zero -- nothing
 * may be billed below cost -- the index factor at least 1 (fewer bytes than
 * are stored would undercount), and the passage overhead a whole number of
 * bytes from 1 to 100,000.
 */
export function parseInfraCostRates(raw: Record<string, unknown>): InfraCostRates | null {
  const text = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '');
  const rates: Partial<InfraCostRates> = {};
  for (const key of INFRA_RATE_KEYS) {
    const value = text(raw[key]);
    if (!MONEY.test(value) || usdPico(value) <= 0n) return null;
    rates[key] = canonical(value);
  }
  const factor = text(raw.databaseIndexFactor);
  if (!FACTOR.test(factor) || Number(factor) < 1 || Number(factor) > 100) return null;
  const overhead = raw.chunkRowBytes;
  if (typeof overhead !== 'number' || !Number.isSafeInteger(overhead) || overhead < 1 || overhead > 100_000) return null;
  return { ...(rates as Pick<InfraCostRates, (typeof INFRA_RATE_KEYS)[number]>), databaseIndexFactor: canonical(factor), chunkRowBytes: overhead };
}

export function defaultInfraCostRates(): InfraCostRatesView {
  return { ...DEFAULT_INFRA_COST_RATES, revision: 'default', effectiveFrom: null };
}

const ceilDiv = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

/** The index factor as a fraction of 10^4, exact. */
function factorTenThousandths(factor: string): bigint {
  const [whole, fraction = ''] = factor.split('.');
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
}

/** Our transfer cost for `bytes` at `rates`, rounded up to the pico-dollar. */
export function transferCostUsd(bytes: number, rates: Pick<InfraCostRates, 'transferPerGb'>): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid byte count');
  return picoUsd(ceilDiv(BigInt(bytes) * usdPico(rates.transferPerGb), BigInt(INFRA_COST_UNITS.bytesPerGb)));
}

/** Bytes a stored passage takes in the database beyond its text, at `rates`. */
export function chunkOverheadBytes(rates: Pick<InfraCostRates, 'chunkRowBytes'>): number {
  return EMBEDDING_DIMENSIONS * 4 + rates.chunkRowBytes;
}

/**
 * Storage cost in pico-dollars at `rates`, rounded up: `blobByteMs` of Blob
 * and `databaseByteMs` of database (before the index factor), in byte-milliseconds.
 */
export function storageCostPico(blobByteMs: bigint, databaseByteMs: bigint, rates: InfraCostRates): bigint {
  const per = BigInt(INFRA_COST_UNITS.bytesPerGb) * BigInt(INFRA_COST_UNITS.monthMs);
  const blob = blobByteMs * usdPico(rates.blobStoragePerGbMonth) * 10_000n;
  const database = databaseByteMs * factorTenThousandths(rates.databaseIndexFactor) * usdPico(rates.databaseStoragePerGbMonth);
  return ceilDiv(blob + database, per * 10_000n);
}
