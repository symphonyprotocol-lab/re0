import { z } from 'zod';
import { CREDIT_USD } from '@/lib/constants';

/** Unit prices allow 12 decimal places; upstream billed amounts retain their full precision. */
const SCALE = 1_000_000_000_000n;
const CREDIT_PICO_USD = BigInt(Math.round(CREDIT_USD * Number(SCALE)));
const money = z.string().regex(/^\d{1,8}(?:\.\d{1,12})?$/);
export const providerRateSchema = z.object({
  service: z.enum(['firecrawl', 'embedding', 'transcription', 'generation']),
  endpoint: z.string().url().max(500).transform((value, ctx) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'invalid endpoint' });
      return z.NEVER;
    }
    return url.href.replace(/\/+$/, '');
  }),
  model: z.string().trim().min(1).max(160),
  /** Firecrawl key ID when accounts have different plans; * applies to every key. */
  account: z.string().trim().min(1).max(100).default('*'),
  unit: z.enum(['tokens', 'seconds', 'firecrawl_credits']),
  usdPerUnit: money,
  outputUsdPerUnit: money.optional(),
  audioInputUsdPerUnit: money.optional(),
  minimumUnits: z.number().finite().nonnegative().max(1_000_000).default(0),
  incrementUnits: z.number().finite().nonnegative().max(1_000_000).default(0),
  source: z.string().trim().min(1).max(500),
}).superRefine((rate, ctx) => {
  if ((rate.service === 'firecrawl') !== (rate.unit === 'firecrawl_credits') || (['embedding', 'generation'].includes(rate.service) && rate.unit !== 'tokens')) {
    ctx.addIssue({ code: 'custom', message: 'invalid service unit' });
  }
});
export type ProviderRate = z.infer<typeof providerRateSchema>;
export const providerRatesSchema = z.array(providerRateSchema).max(100).superRefine((rates, ctx) => {
  const keys = rates.map((r) => JSON.stringify([r.service, r.endpoint, r.model, r.account]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'duplicate provider price' });
});
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  audioInputTokens?: number;
  seconds?: number;
  firecrawlCredits?: number;
}
export interface ProviderTarget {
  service: ProviderRate['service'];
  endpoint: string;
  model: string;
  account?: string;
}
export interface ProviderCharge extends ProviderTarget {
  id: string;
  runId: string;
  at: string;
  usage: ProviderUsage;
  costUsd: string | null;
  basis: 'provider_reported' | 'configured_rate' | 'gateway_catalog' | 'unresolved';
  rate?: ProviderRate;
  priceRevision?: string;
  requestId?: string;
  generationId?: string;
}

export class ProviderCostUnavailable extends Error {
  constructor(readonly code: 'pricing_unavailable' | 'usage_unavailable') { super(code); this.name = 'ProviderCostUnavailable'; }
}

export function usdPico(value: string | number): bigint {
  const normalized = typeof value === 'number' ? (Number.isFinite(value) && value >= 0 ? value.toFixed(12) : '') : value;
  if (!money.safeParse(normalized).success) throw new Error('invalid provider cost');
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
export function picoUsd(value: bigint): string {
  return `${value / SCALE}.${(value % SCALE).toString().padStart(12, '0')}`;
}
const ceilDiv = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

/** Upstream bills may contain more precision than configurable unit prices, or use scientific notation. */
function decimalUsd(value: string | number): { units: bigint; scale: number } {
  const text = String(value);
  const match = /^(\d{1,100})(?:\.(\d{1,100}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match) throw new Error('invalid provider cost');
  const exponent = Number(match[3] ?? 0);
  let scale = (match[2]?.length ?? 0) - exponent;
  if (Math.abs(exponent) > 100 || scale > 100) throw new Error('invalid provider cost');
  let units = BigInt(match[1]! + (match[2] ?? ''));
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  if (units !== 0n && units.toString().length - scale > 8) throw new Error('invalid provider cost');
  return { units, scale };
}

function exactUsd(units: bigint, scale: number): string {
  if (scale < 12) { units *= 10n ** BigInt(12 - scale); scale = 12; }
  while (scale > 12 && units % 10n === 0n) { units /= 10n; scale -= 1; }
  const divisor = 10n ** BigInt(scale);
  return `${units / divisor}.${(units % divisor).toString().padStart(scale, '0')}`;
}

/** Missing usage is never treated as zero, and audio is never inferred from text size. */
export function rateCost(rate: ProviderRate, usage: ProviderUsage): string {
  const quantity = rate.unit === 'tokens' ? usage.inputTokens : rate.unit === 'seconds' ? usage.seconds : usage.firecrawlCredits;
  if (quantity === undefined || !Number.isFinite(quantity) || quantity < 0) throw new ProviderCostUnavailable('usage_unavailable');
  const units = (amount: number, up = false) => {
    if (!Number.isFinite(amount) || amount < 0) throw new ProviderCostUnavailable('usage_unavailable');
    const scaled = amount * 1_000_000;
    const nearest = Math.round(scaled);
    // Measured usage rounds up past floating-point noise: a real fraction of a micro-unit is billed, never dropped.
    return BigInt(up && scaled - nearest > 1e-6 ? Math.ceil(scaled) : nearest);
  };
  // Integer micro-units avoid false extra billing increments from e.g. 0.14 / 0.01.
  const step = units(rate.incrementUnits);
  const measured = units(quantity, true);
  const rounded = step > 0n ? ceilDiv(measured, step) * step : measured;
  const minimum = units(rate.minimumUnits);
  const billable = rounded > minimum ? rounded : minimum;
  const multiply = (amount: bigint, price: string) => amount * usdPico(price);
  let cost = multiply(billable, rate.usdPerUnit);
  if (rate.unit === 'tokens') {
    if (rate.outputUsdPerUnit !== undefined && usage.outputTokens === undefined) throw new ProviderCostUnavailable('usage_unavailable');
    if (rate.audioInputUsdPerUnit !== undefined && usage.audioInputTokens === undefined) throw new ProviderCostUnavailable('usage_unavailable');
    if (usage.audioInputTokens !== undefined && rate.audioInputUsdPerUnit !== undefined) {
      if (units(usage.audioInputTokens) > billable) throw new ProviderCostUnavailable('usage_unavailable');
      cost = multiply(billable - units(usage.audioInputTokens), rate.usdPerUnit) + multiply(units(usage.audioInputTokens), rate.audioInputUsdPerUnit);
    }
    if (rate.outputUsdPerUnit !== undefined) cost += multiply(units(usage.outputTokens!), rate.outputUsdPerUnit);
  }
  return exactUsd(cost, 18);
}

export function providerTotal(charges: readonly Pick<ProviderCharge, 'costUsd'>[]) {
  if (charges.some((charge) => charge.costUsd === null)) throw new ProviderCostUnavailable('usage_unavailable');
  const amounts = charges.map((charge) => decimalUsd(charge.costUsd!));
  const scale = Math.max(12, ...amounts.map((amount) => amount.scale));
  const total = amounts.reduce((sum, amount) => sum + amount.units * 10n ** BigInt(scale - amount.scale), 0n);
  const credits = Number(ceilDiv(total, CREDIT_PICO_USD * 10n ** BigInt(scale - 12)));
  if (!Number.isSafeInteger(credits)) throw new Error('provider charge exceeds ledger range');
  return { costUsd: exactUsd(total, scale), credits };
}

export function reportedGatewayCost(metadata: unknown): string | null {
  const parsed = z.object({ gateway: z.object({ cost: z.union([z.string(), z.number()]) }) }).safeParse(metadata);
  if (!parsed.success) return null;
  try {
    const amount = decimalUsd(parsed.data.gateway.cost);
    return exactUsd(amount.units, amount.scale);
  } catch { throw new ProviderCostUnavailable('usage_unavailable'); }
}
