import { providerRateSchema, type ProviderRate } from '@/lib/domain/provider-cost';

export const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
interface Catalog { at: number; rows: { id: string; pricing?: Record<string, unknown> }[] }
let catalog: Catalog | undefined;
let fetching: Promise<Catalog | undefined> | undefined;
/** A failed read is not retried for this long, so an outage costs one timeout, not one per call. */
const FAILURE_BACKOFF_MS = 30_000;
let failedAt = -Infinity;

async function loadCatalog(): Promise<Catalog | undefined> {
  if (catalog && Date.now() - catalog.at < 60_000) return catalog;
  if (Date.now() - failedAt < FAILURE_BACKOFF_MS) return catalog;
  fetching ??= (async () => {
    try {
      const response = await fetch(GATEWAY_MODELS_URL, { cache: 'no-store', signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`catalog ${response.status}`);
      const body = await response.json() as { data?: Catalog['rows'] };
      if (!Array.isArray(body.data)) throw new Error('catalog shape');
      return catalog = { at: Date.now(), rows: body.data };
    } catch {
      failedAt = Date.now();
      return catalog;
    }
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
