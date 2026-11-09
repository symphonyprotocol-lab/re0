import { z } from 'zod';
import { parseServicePricing, type ServicePricingInput } from '@/lib/domain/service-pricing';

const keyInput = z.object({
  name: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().max(512).regex(/^\S*$/).default(''),
  enabled: z.boolean(),
  isFallback: z.boolean().optional(),
  costPricing: z.unknown().optional(),
});

export function parseFirecrawlKey(raw: Record<string, unknown>, creating = false) {
  const parsed = keyInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.path[0] === 'name' ? 'name' : parsed.error.issues[0]?.path[0] === 'enabled' ? 'enabled' : parsed.error.issues[0]?.path[0] === 'isFallback' ? 'is_fallback' : 'api_key' } as const;
  if (creating && parsed.data.apiKey.length < 8) return { error: 'api_key' } as const;
  if (parsed.data.apiKey && parsed.data.apiKey.length < 8) return { error: 'api_key' } as const;
  let costPricing: ServicePricingInput | null | undefined;
  try { costPricing = parseServicePricing(parsed.data.costPricing, 'firecrawl'); }
  catch { return { error: 'cost_pricing' } as const; }
  const { costPricing: _rawPrice, ...fields } = parsed.data;
  return { ...fields, ...(costPricing !== undefined ? { costPricing } : {}) };
}

/** Only definite key failures are retried; uncertain network failures may already be billed. */
export function rotatesFirecrawlKey(status: number): boolean {
  return [401, 402, 403, 429].includes(status);
}

export function firecrawlCooldown(status: number, retryAfter: string | null, now = Date.now()): Date | null {
  if (!rotatesFirecrawlKey(status) && status !== 0) return null;
  let delay = status === 429 ? 60_000 : 300_000;
  if (status === 429 && retryAfter) {
    const seconds = Number(retryAfter);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(duration)) delay = Math.max(1000, Math.min(duration, 86_400_000));
  }
  return new Date(now + delay);
}
