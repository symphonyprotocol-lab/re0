import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ProviderCostUnavailable, providerRateSchema, rateCost, reportedGatewayCost,
  type ProviderCharge, type ProviderRate, type ProviderTarget, type ProviderUsage,
} from '@/lib/domain/provider-cost';
import { configuredProviderRate, type ProviderPrices } from '@/lib/services/provider-pricing';

interface Meter {
  runId: string;
  prices: ProviderPrices;
  record(charge: ProviderCharge): Promise<void>;
  pending?: Set<Promise<void>>;
}
const context = new AsyncLocalStorage<Meter>();
export const withProviderMeter = <T>(meter: Meter, work: () => Promise<T>) => context.run(meter, work);
export async function providerWork<T>(work: () => Promise<T>): Promise<T> {
  const meter = context.getStore();
  if (!meter) return work();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  (meter.pending ??= new Set()).add(pending);
  try { return await work(); } finally { finish(); meter.pending.delete(pending); }
}
export async function drainProviderCalls(): Promise<void> {
  const pending = context.getStore()?.pending;
  while (pending?.size) await Promise.all([...pending]);
}
const CATALOG_URL = 'https://ai-gateway.vercel.sh/v1/models';
let catalog: { at: number; rows: CatalogModel[] } | undefined;
interface CatalogModel { id: string; pricing?: Record<string, unknown> }

/** Short cache; snapshots are attached to individual calls so later prices cannot rewrite history. */
async function catalogRate(target: ProviderTarget): Promise<ProviderRate | undefined> {
  if (!target.endpoint.startsWith('https://ai-gateway.vercel.sh/')) return undefined;
  try {
    if (!catalog || Date.now() - catalog.at >= 60_000) {
      const response = await fetch(CATALOG_URL, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return undefined;
      const body = await response.json() as { data?: CatalogModel[] };
      if (!Array.isArray(body.data)) return undefined;
      catalog = { at: Date.now(), rows: body.data };
    }
    const price = catalog.rows.find((model) => model.id === target.model)?.pricing;
    // Tiered/provider-dependent prices require the billed cost or an explicit contract rate.
    if (!price || price.varies_by_provider || price.input_tiers || price.inputTiers) return undefined;
    const seconds = target.service === 'transcription' && typeof price.transcription_duration_cost_per_second === 'string';
    const parsed = providerRateSchema.safeParse({
      ...target, account: '*', unit: seconds ? 'seconds' : 'tokens',
      usdPerUnit: seconds ? price.transcription_duration_cost_per_second : price.input,
      ...(!seconds && target.service === 'transcription' ? { outputUsdPerUnit: price.output, audioInputUsdPerUnit: price.audio_input_token_cost } : {}),
      source: CATALOG_URL,
    });
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

export function modelCostTarget(endpoint: { transport: string; baseUrl: string | null; model: string }, service: 'embedding' | 'transcription'): ProviderTarget {
  const url = new URL(endpoint.transport === 'gateway' ? 'https://ai-gateway.vercel.sh/v1' : endpoint.baseUrl!);
  // Billing snapshots never copy credentials or query-string secrets from an endpoint.
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return { service, endpoint: url.href.replace(/\/+$/, ''), model: endpoint.model };
}

/** Resolve a custom account's rate BEFORE making a paid request. Gateway can report its exact cost instead. */
export async function prepareProviderCall(target: ProviderTarget) {
  const meter = context.getStore();
  if (!meter) return null;
  const configured = configuredProviderRate(meter.prices, target);
  const rate = configured ?? await catalogRate(target);
  const gateway = target.endpoint.startsWith('https://ai-gateway.vercel.sh/');
  if (!rate && !gateway) {
    // An operator error, not the user's: name the price the console (or PROVIDER_COST_RATES) is missing.
    console.warn(`no supplier price for ${target.service} ${target.endpoint} ${target.model} account=${target.account ?? '*'}; set it in the console`);
    throw new ProviderCostUnavailable('pricing_unavailable');
  }
  return {
    /**
     * `acceptUnknownCost`: the supplier gives no usage we can price (a Word parse
     * without `creditsUsed`, audio without a duration). The receipt is kept as
     * unresolved for reconciliation instead of failing the source; it is never
     * billed as zero or estimated.
     */
    async complete(input: { usage: ProviderUsage; providerMetadata?: unknown; requestId?: string; acceptUnknownCost?: boolean }) {
      let direct: string | null = null;
      let invalidReportedCost = false;
      try { direct = gateway ? reportedGatewayCost(input.providerMetadata) : null; }
      catch (error) { if (!(error instanceof ProviderCostUnavailable)) throw error; invalidReportedCost = true; }
      let costUsd = direct;
      if (costUsd === null && rate && !invalidReportedCost) {
        try { costUsd = rateCost(rate, input.usage); } catch (error) { if (!(error instanceof ProviderCostUnavailable)) throw error; }
      }
      const generationId = (input.providerMetadata as { gateway?: { generationId?: unknown } } | undefined)?.gateway?.generationId;
      const charge: ProviderCharge = {
        ...target, id: crypto.randomUUID(), runId: meter.runId, at: new Date().toISOString(),
        usage: input.usage, costUsd,
        basis: direct !== null ? 'provider_reported' : costUsd === null ? 'unresolved' : configured ? 'configured_rate' : 'gateway_catalog',
        ...(rate ? { rate, priceRevision: configured ? meter.prices.revision : `catalog:${catalog?.at}` } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(typeof generationId === 'string' ? { generationId } : {}),
      };
      await meter.record(charge);
      if (costUsd === null && !input.acceptUnknownCost) throw new ProviderCostUnavailable('usage_unavailable');
    },
  };
}

export function tokenUsage(value: unknown): ProviderUsage {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const details = raw.input_token_details && typeof raw.input_token_details === 'object' ? raw.input_token_details as Record<string, unknown> : {};
  const number = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  return { inputTokens: number(raw.input_tokens ?? raw.prompt_tokens ?? raw.tokens), outputTokens: number(raw.output_tokens ?? raw.completion_tokens), audioInputTokens: number(details.audio_tokens) };
}
