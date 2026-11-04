import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { generationCost } from '@/lib/domain/model-calls';
import type { ProviderRate } from '@/lib/domain/provider-cost';
import { gatewayGenerationPricing } from '@/lib/infra/ai/gateway-generation-pricing';
import { db, schema } from '@/lib/infra/db';
import { configuredProviderRate, providerPrices, type ProviderPrices } from '@/lib/services/provider-pricing';
import { audit } from '@/lib/services/admin';

const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v1';
type Call = typeof schema.modelCall.$inferSelect;
type Config = Pick<typeof schema.modelConfig.$inferSelect, 'id' | 'model' | 'transport' | 'baseUrl'>;
interface Target { transport: 'gateway' | 'openai_compatible'; endpoint: string }
interface Estimate { id: string; model: string; inputTokens: number; outputTokens: number; rate: ProviderRate; costUsd: string; priceRevision: string }
type SkipReason = 'missing_usage' | 'ambiguous_model' | 'missing_price';
export interface GenerationCostBackfillPlan {
  at: string; before: string; candidates: number; estimates: Estimate[];
  skipped: { id: string; model: string; reason: SkipReason }[];
}
function endpoint(raw: string | null): string | null {
  if (!raw) return null;
  try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href.replace(/\/+$/, ''); }
  catch { return null; }
}
function configTarget(config: Config): Target | null {
  const address = config.transport === 'gateway' ? GATEWAY_ENDPOINT : endpoint(config.baseUrl);
  return address ? { transport: config.transport, endpoint: address } : null;
}
function targetOf(call: Call, configs: Config[], prices: ProviderPrices): Target | 'ambiguous_model' | undefined {
  const recorded = endpoint(call.endpoint);
  if (recorded) return { transport: recorded === GATEWAY_ENDPOINT ? 'gateway' : 'openai_compatible', endpoint: recorded };
  const original = configs.find((config) => config.id === call.configId && config.model === call.model);
  if (original) return configTarget(original) ?? undefined;
  const candidates = configs.filter((config) => config.model === call.model).map(configTarget).filter((target): target is Target => target !== null);
  if (!candidates.length) candidates.push(...prices.rates.filter((rate) => rate.service === 'generation' && rate.model === call.model && rate.account === '*').map((rate): Target => ({ transport: rate.endpoint === GATEWAY_ENDPOINT ? 'gateway' : 'openai_compatible', endpoint: rate.endpoint })));
  const unique = [...new Map(candidates.map((target) => [`${target.transport}:${target.endpoint}`, target])).values()];
  if (unique.length > 1) return 'ambiguous_model';
  // A namespaced model without surviving configuration can still be identified by Gateway's catalog.
  return unique[0] ?? (call.model.includes('/') ? { transport: 'gateway', endpoint: GATEWAY_ENDPOINT } : undefined);
}

/** Resolve a finite historical selection against one set of current price snapshots. No writes. */
export async function planGenerationCostBackfill(options: { before?: Date; model?: string } = {}): Promise<GenerationCostBackfillPlan> {
  const at = new Date();
  const before = options.before ?? at;
  if (!Number.isFinite(before.getTime())) throw new Error('Invalid cutoff');
  const database = db();
  const [calls, configs, prices] = await Promise.all([
    database.select().from(schema.modelCall).where(and(eq(schema.modelCall.kind, 'generation'), isNull(schema.modelCall.costUsd), lt(schema.modelCall.createdAt, before), options.model ? eq(schema.modelCall.model, options.model) : undefined)).orderBy(asc(schema.modelCall.createdAt), asc(schema.modelCall.id)),
    database.select({ id: schema.modelConfig.id, model: schema.modelConfig.model, transport: schema.modelConfig.transport, baseUrl: schema.modelConfig.baseUrl }).from(schema.modelConfig).where(eq(schema.modelConfig.kind, 'generation')),
    providerPrices(database),
  ]);
  const plan: GenerationCostBackfillPlan = { at: at.toISOString(), before: before.toISOString(), candidates: calls.length, estimates: [], skipped: [] };
  const gatewayPrices = new Map<string, ReturnType<typeof gatewayGenerationPricing>>();
  for (const call of calls) {
    // Legacy rows lack a usage-known flag; nonzero stored counts still support a clearly labelled estimate.
    if (!call.usageKnown && (call.status !== 'unknown' || call.inputTokens + call.outputTokens === 0)) {
      plan.skipped.push({ id: call.id, model: call.model, reason: 'missing_usage' }); continue;
    }
    const target = targetOf(call, configs, prices);
    if (target === 'ambiguous_model') { plan.skipped.push({ id: call.id, model: call.model, reason: target }); continue; }
    let rate: ProviderRate | undefined;
    let revision = prices.revision;
    if (target?.transport === 'gateway') {
      if (!gatewayPrices.has(call.model)) gatewayPrices.set(call.model, gatewayGenerationPricing(call.model));
      const price = await gatewayPrices.get(call.model)!;
      rate = price?.rate; revision = price?.priceRevision ?? revision;
    } else if (target) rate = configuredProviderRate(prices, { service: 'generation', endpoint: target.endpoint, model: call.model });
    const estimate = generationCost({ gateway: false, rate, estimated: true, usage: { inputTokens: call.inputTokens, outputTokens: call.outputTokens } });
    if (!rate || estimate.costUsd === null) { plan.skipped.push({ id: call.id, model: call.model, reason: 'missing_price' }); continue; }
    plan.estimates.push({ id: call.id, model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens, rate, costUsd: estimate.costUsd, priceRevision: `backfill:${plan.at}:${revision}` });
  }
  return plan;
}

/** Atomic, idempotent backfill: never replace an existing bill or change account credits. */
export async function applyGenerationCostBackfill(plan: GenerationCostBackfillPlan) {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('model-call-cost-backfill'))`);
    let updated = 0;
    for (const estimate of plan.estimates) {
      const rows = await tx.update(schema.modelCall).set({ costUsd: estimate.costUsd, costBasis: 'estimated', rate: estimate.rate, priceRevision: estimate.priceRevision })
        .where(and(eq(schema.modelCall.id, estimate.id), eq(schema.modelCall.kind, 'generation'), isNull(schema.modelCall.costUsd), eq(schema.modelCall.model, estimate.model), eq(schema.modelCall.inputTokens, estimate.inputTokens), eq(schema.modelCall.outputTokens, estimate.outputTokens)))
        .returning({ id: schema.modelCall.id });
      updated += rows.length;
    }
    if (updated) await audit(tx, { administratorId: null, action: 'model.cost_backfill', target: 'generation', after: { at: plan.at, before: plan.before, candidates: plan.candidates, updated, skipped: plan.skipped.length, basis: 'estimated', models: [...new Set(plan.estimates.map((row) => row.model))] } });
    return { updated, unchanged: plan.estimates.length - updated, skipped: plan.skipped.length };
  });
}
