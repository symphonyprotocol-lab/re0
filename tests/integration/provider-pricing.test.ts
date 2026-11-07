import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { db, schema } from '@/lib/infra/db';
import { configuredProviderRate, DEFAULT_PROVIDER_RATES, providerPrices, saveProviderPrices } from '@/lib/services/provider-pricing';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
describeWithDb('supplier contract price configuration', () => {
  let administratorId: string;
  beforeAll(async () => {
    delete process.env.PROVIDER_COST_RATES;
    await db().delete(schema.providerPricing);
    const [admin] = await db().insert(schema.administrator).values({ email: `${uniqueName('rates-admin')}@example.test`, name: 'Pricing owner', passwordHash: 'test', totpSecretCipher: 'test' }).returning();
    administratorId = admin!.id;
  });
  afterAll(async () => { await db().delete(schema.providerPricing); });
  const baseRate = { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev/', model: 'parse', unit: 'firecrawl_credits', usdPerUnit: '0.001', source: 'Plan invoice: $1/1000 credits' };
  it('starts from the documented Firecrawl account price only, versions changes, and audits the full rate', async () => {
    const initial = await providerPrices();
    expect(initial).toEqual({ rates: DEFAULT_PROVIDER_RATES, revision: 'default' });
    expect(configuredProviderRate(initial, { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse', account: 'key-a' })).toMatchObject({ usdPerUnit: '0.0038' });
    expect(configuredProviderRate(initial, { service: 'embedding', endpoint: 'https://provider.example/v1', model: 'custom' })).toBeUndefined();
    const saved = await saveProviderPrices(administratorId, { revision: 'default', rates: [baseRate] });
    expect(saved.revision).not.toBe('default');
    expect(await providerPrices()).toEqual(saved);
    const [audit] = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.administratorId, administratorId));
    expect(audit).toMatchObject({ action: 'pricing.update', target: 'providers', after: saved });
    expect(configuredProviderRate(saved, { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse', account: 'key-a' })).toMatchObject({ usdPerUnit: '0.001' });
  });
  it('prefers account-specific plan costs, rejects invalid rates, and serializes competing edits', async () => {
    const before = await providerPrices();
    await expect(saveProviderPrices(administratorId, { revision: before.revision, rates: [{ ...baseRate, usdPerUnit: '-1' }] })).rejects.toMatchObject({ code: 'invalid_provider_pricing' });
    const first = { revision: before.revision, rates: [baseRate, { ...baseRate, account: 'key-b', usdPerUnit: '0.0005' }] };
    const results = await Promise.allSettled([saveProviderPrices(administratorId, first), saveProviderPrices(administratorId, first)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'pricing_conflict' } });
    const prices = await providerPrices();
    expect(configuredProviderRate(prices, { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse', account: 'key-b' })?.usdPerUnit).toBe('0.0005');
    expect(before.rates[0]?.usdPerUnit).toBe('0.001');
  });
});
