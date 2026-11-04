import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { providerRateSchema, providerRatesSchema, usdPico, type ProviderRate, type ProviderTarget } from '@/lib/domain/provider-cost';
import { perTokenUsd, type ModelConfigInput } from '@/lib/domain/models';
import { modelPricingTarget, servicePricingRate, type ServicePricingInput } from '@/lib/domain/service-pricing';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

export interface ProviderPrices { revision: string; rates: ProviderRate[] }
export function providerPricingMigrationMissing(error: unknown): boolean {
  let current = error;
  for (let at = 0; at < 4 && current && typeof current === 'object'; at += 1) {
    if ('code' in current && current.code === '42P01') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
export async function providerPrices(executor: Executor = db()): Promise<ProviderPrices> {
  // Optional bootstrapping for deployments without console settings. Never assume a missing rate is free.
  const environment = process.env.PROVIDER_COST_RATES;
  const fallback = () => ({ revision: environment ? `env:${createHash('sha256').update(environment).digest('hex')}` : 'default', rates: environment ? providerRatesSchema.parse(JSON.parse(environment)) : [] });
  try {
    const [row] = await executor.select().from(schema.providerPricing).where(eq(schema.providerPricing.id, 1)).limit(1);
    return row ? { revision: row.revision, rates: row.rates } : fallback();
  } catch (error) {
    // Rolling/local upgrades can meter from explicit environment prices before the new settings table exists.
    if (providerPricingMigrationMissing(error)) return fallback();
    throw error;
  }
}
export async function saveProviderPrices(administratorId: string, raw: Record<string, unknown>): Promise<ProviderPrices> {
  const parsed = providerRatesSchema.safeParse(raw.rates);
  if (!parsed.success || typeof raw.revision !== 'string') throw new AdminInputError('invalid_provider_pricing');
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:providers'))`);
    const before = await providerPrices(tx);
    if (raw.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const next = { revision: randomUUID(), rates: parsed.data };
    await tx.insert(schema.providerPricing).values({ id: 1, ...next, updatedBy: administratorId }).onConflictDoUpdate({
      target: schema.providerPricing.id, set: { ...next, updatedBy: administratorId, updatedAt: new Date() },
    });
    await audit(tx, { administratorId, action: 'pricing.update', target: 'providers', before, after: next });
    return next;
  });
}

export function configuredProviderRate(prices: ProviderPrices, target: ProviderTarget): ProviderRate | undefined {
  const matches = prices.rates.filter((r) => r.service === target.service && r.endpoint === target.endpoint.replace(/\/+$/, '') && r.model === target.model);
  return matches.find((r) => r.account === target.account) ?? matches.find((r) => r.account === '*');
}

/** Update only this service target under the shared lock, in the service's own
 * configuration transaction. Concurrent edits to other services are preserved. */
export async function saveServicePrice(tx: Tx, administratorId: string, target: ProviderTarget, pricing: ServicePricingInput | null | undefined, source: string): Promise<void> {
  if (pricing === undefined) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:providers'))`);
  const before = await providerPrices(tx);
  const account = target.account ?? '*';
  const matches = (rate: ProviderRate) => rate.service === target.service && rate.endpoint === target.endpoint && rate.model === target.model && rate.account === account;
  const previous = before.rates.find(matches);
  const rates = before.rates.filter((rate) => !matches(rate));
  if (pricing) {
    const rate = providerRateSchema.parse(servicePricingRate(target, pricing, source));
    // Keep existing representations on a no-op save (0.00000002 and 0.000000020000 are identical).
    for (const key of ['usdPerUnit', 'outputUsdPerUnit', 'audioInputUsdPerUnit'] as const) {
      if (previous?.[key] !== undefined && rate[key] !== undefined && usdPico(previous[key]!) === usdPico(rate[key]!)) rate[key] = previous[key]!;
    }
    rates.push(rate);
  }
  // Preserve the existing revision when editing a name/key without changing its price.
  const sorted = (items: ProviderRate[]) => [...items].sort((a, b) => JSON.stringify([a.service, a.endpoint, a.model, a.account]).localeCompare(JSON.stringify([b.service, b.endpoint, b.model, b.account])));
  if (isDeepStrictEqual(sorted(rates), sorted(before.rates))) return;
  const next = { revision: randomUUID(), rates: providerRatesSchema.parse(rates) };
  await tx.insert(schema.providerPricing).values({ id: 1, ...next, updatedBy: administratorId }).onConflictDoUpdate({ target: schema.providerPricing.id, set: { ...next, updatedBy: administratorId, updatedAt: new Date() } });
  await audit(tx, { administratorId, action: 'pricing.update', target: 'providers', before, after: next });
}

export async function saveModelProcessingPrice(tx: Tx, administratorId: string, input: ModelConfigInput): Promise<void> {
  if (input.kind === 'generation') return;
  await saveServicePrice(tx, administratorId, modelPricingTarget(input), input.costPricing, `Model configuration: ${input.name}`);
}

/** Model editing shares the existing rate store and lock with the supplier-price form. */
export async function saveModelGenerationPrice(tx: Tx, administratorId: string, input: ModelConfigInput): Promise<void> {
  if (input.kind !== 'generation' || input.transport !== 'openai_compatible' || input.generationPricing === undefined) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:providers'))`);
  const before = await providerPrices(tx);
  const endpoint = new URL(input.baseUrl!);
  endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
  const target = endpoint.href.replace(/\/+$/, '');
  const rates = before.rates.filter((rate) => !(rate.service === 'generation' && rate.endpoint === target && rate.model === input.model && rate.account === '*'));
  if (input.generationPricing) rates.push(providerRateSchema.parse({
    service: 'generation', endpoint: target, model: input.model, unit: 'tokens',
    usdPerUnit: perTokenUsd(input.generationPricing.inputUsdPerMillion),
    outputUsdPerUnit: perTokenUsd(input.generationPricing.outputUsdPerMillion), source: `Model configuration: ${input.name}`,
  }));
  const next = { revision: randomUUID(), rates: providerRatesSchema.parse(rates) };
  await tx.insert(schema.providerPricing).values({ id: 1, ...next, updatedBy: administratorId }).onConflictDoUpdate({
    target: schema.providerPricing.id, set: { ...next, updatedBy: administratorId, updatedAt: new Date() },
  });
  await audit(tx, { administratorId, action: 'pricing.update', target: 'providers', before, after: next });
}
