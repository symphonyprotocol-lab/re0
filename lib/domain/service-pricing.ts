import { z } from 'zod';
import { picoUsd, usdPico, type ProviderRate, type ProviderTarget } from '@/lib/domain/provider-cost';

/** Editors use USD / 1M tokens; the meter retains USD / token. */
export interface ServicePricingInput {
  unit: 'million_tokens' | 'seconds' | 'firecrawl_credits';
  price: string;
  outputPrice?: string;
  audioPrice?: string;
  minimumUnits: number;
  incrementUnits: number;
  source: string;
}
const decimal = z.string().regex(/^\d{1,8}(?:\.\d{1,12})?$/);
const inputSchema = z.object({
  unit: z.enum(['million_tokens', 'seconds', 'firecrawl_credits']),
  price: decimal,
  outputPrice: decimal.optional(), audioPrice: decimal.optional(),
  minimumUnits: z.number().finite().nonnegative().max(1_000_000).default(0),
  incrementUnits: z.number().finite().nonnegative().max(1_000_000).default(0),
  source: z.string().trim().max(500).default(''),
});
export function parseServicePricing(raw: unknown, service: ProviderRate['service']): ServicePricingInput | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const result = inputSchema.safeParse(raw);
  if (!result.success) throw new Error('cost_pricing');
  const p = result.data;
  if ((service === 'firecrawl') !== (p.unit === 'firecrawl_credits') || (service === 'embedding' && p.unit !== 'million_tokens')) throw new Error('cost_pricing');
  if (p.unit === 'million_tokens' && [p.price, p.outputPrice, p.audioPrice].some((v) => v !== undefined && !/^\d{1,8}(?:\.\d{1,6})?$/.test(v))) throw new Error('cost_pricing');
  if ((service !== 'transcription' || p.unit !== 'million_tokens') && (p.outputPrice !== undefined || p.audioPrice !== undefined)) throw new Error('cost_pricing');
  return p;
}
const trim = (value: string) => value.replace(/\.?0+$/, '');
export function servicePricingOf(rate: ProviderRate | undefined): ServicePricingInput | null {
  if (!rate) return null;
  const price = (v: string) => rate.unit === 'tokens' ? trim(picoUsd(usdPico(v) * 1_000_000n)) : v;
  return {
    unit: rate.unit === 'tokens' ? 'million_tokens' : rate.unit,
    price: price(rate.usdPerUnit),
    ...(rate.outputUsdPerUnit !== undefined ? { outputPrice: price(rate.outputUsdPerUnit) } : {}),
    ...(rate.audioInputUsdPerUnit !== undefined ? { audioPrice: price(rate.audioInputUsdPerUnit) } : {}),
    minimumUnits: rate.minimumUnits, incrementUnits: rate.incrementUnits, source: rate.source,
  };
}
export function servicePricingRate(target: ProviderTarget, pricing: ServicePricingInput, source: string): ProviderRate {
  const price = (value: string) => pricing.unit === 'million_tokens' ? picoUsd(usdPico(value) / 1_000_000n) : value;
  return {
    ...target, account: target.account ?? '*', unit: pricing.unit === 'million_tokens' ? 'tokens' : pricing.unit,
    usdPerUnit: price(pricing.price),
    ...(pricing.outputPrice !== undefined ? { outputUsdPerUnit: price(pricing.outputPrice) } : {}),
    ...(pricing.audioPrice !== undefined ? { audioInputUsdPerUnit: price(pricing.audioPrice) } : {}),
    minimumUnits: pricing.minimumUnits, incrementUnits: pricing.incrementUnits, source: pricing.source || source,
  };
}
export function modelPricingTarget(input: { kind: 'embedding' | 'transcription' | 'generation'; transport: string; baseUrl: string | null; model: string }): ProviderTarget {
  const endpoint = new URL(input.transport === 'gateway' ? 'https://ai-gateway.vercel.sh/v1' : input.baseUrl!);
  endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
  return { service: input.kind, endpoint: endpoint.href.replace(/\/+$/, ''), model: input.model, account: '*' };
}
