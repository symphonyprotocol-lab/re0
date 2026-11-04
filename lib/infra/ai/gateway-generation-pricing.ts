import { providerRateSchema, type ProviderRate } from '@/lib/domain/provider-cost';

export const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
interface Catalog { at: number; rows: { id: string; pricing?: Record<string, unknown> }[] }
let catalog: Catalog | undefined;
let fetching: Promise<Catalog | undefined> | undefined;

async function loadCatalog(): Promise<Catalog | undefined> {
  if (catalog && Date.now() - catalog.at < 60_000) return catalog;
  fetching ??= (async () => {
    try {
      const response = await fetch(GATEWAY_MODELS_URL, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return undefined;
      const body = await response.json() as { data?: Catalog['rows'] };
      if (!Array.isArray(body.data)) return undefined;
      return catalog = { at: Date.now(), rows: body.data };
    } catch { return undefined; }
  })();
  try { return await fetching; } finally { fetching = undefined; }
}

/** Gateway quotes are a calculation basis; the response's bill remains authoritative. */
export async function gatewayGenerationPricing(model: string): Promise<{ rate: ProviderRate; priceRevision: string; estimated: true } | undefined> {
  const current = await loadCatalog();
  const price = current?.rows.find((row) => row.id === model)?.pricing;
  if (!price || price.input === undefined || price.output === undefined) return undefined;
  const parsed = providerRateSchema.safeParse({
    service: 'generation', endpoint: 'https://ai-gateway.vercel.sh/v1', model, unit: 'tokens',
    usdPerUnit: price.input, outputUsdPerUnit: price.output, source: GATEWAY_MODELS_URL,
  });
  return parsed.success ? { rate: parsed.data, priceRevision: `gateway-catalog:${current!.at}`, estimated: true } : undefined;
}
