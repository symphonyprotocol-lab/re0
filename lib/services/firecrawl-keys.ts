/** Console CRUD for Firecrawl keys. Responses and audit entries never include a secret or its cipher/hash. */
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseFirecrawlKey } from '@/lib/domain/firecrawl';
import { parseServicePricing, servicePricingOf, type ServicePricingInput } from '@/lib/domain/service-pricing';
import { providerPrices, saveServicePrice, type ProviderPrices } from '@/lib/services/provider-pricing';
import { keyTail } from '@/lib/domain/models';
import { sealCredential } from '@/lib/infra/crypto/credentials';
import { sha256 } from '@/lib/infra/crypto/tokens';
import { db, schema } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

type KeyRow = typeof schema.firecrawlKey.$inferSelect;
export type FirecrawlKeyView = Pick<KeyRow, 'id' | 'name' | 'apiKeyTail' | 'enabled' | 'isFallback' | 'lastUsedAt' | 'useCount' | 'lastStatus' | 'cooldownUntil' | 'createdAt' | 'updatedAt'> & { costPricing: ServicePricingInput | null };

function priceTarget(account = '*') { return { service: 'firecrawl' as const, endpoint: (process.env.FIRECRAWL_BASE_URL?.trim() || 'https://api.firecrawl.dev').replace(/\/+$/, ''), model: 'parse', account }; }
function priceFor(prices: ProviderPrices, account = '*') {
  const target = priceTarget(account);
  // A key's editor shows an override only; null explicitly inherits the service default.
  return servicePricingOf(prices.rates.find((r) => r.service === target.service && r.endpoint === target.endpoint && r.model === target.model && r.account === account));
}

function view(row: KeyRow, costPricing: ServicePricingInput | null = null): FirecrawlKeyView {
  return { id: row.id, name: row.name, apiKeyTail: row.apiKeyTail, enabled: row.enabled, isFallback: row.isFallback, lastUsedAt: row.lastUsedAt,
    useCount: row.useCount, lastStatus: row.lastStatus, cooldownUntil: row.cooldownUntil, createdAt: row.createdAt, updatedAt: row.updatedAt, costPricing };
}
function shown(row: KeyRow) {
  return { name: row.name, apiKeyTail: row.apiKeyTail, enabled: row.enabled, isFallback: row.isFallback };
}
function validId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AdminInputError('not_found');
}

export async function listFirecrawlKeys() {
  const [rows, prices] = await Promise.all([db().select().from(schema.firecrawlKey).orderBy(asc(schema.firecrawlKey.createdAt), asc(schema.firecrawlKey.id)), providerPrices()]);
  return { keys: rows.map((row) => view(row, priceFor(prices, row.id))), defaultPricing: priceFor(prices), baseUrl: priceTarget().endpoint,
    environmentConfigured: Boolean(process.env.FIRECRAWL_API_KEY?.trim() || process.env.FIRECRAWL_BASE_URL?.trim()) };
}

export async function saveFirecrawlKey(administratorId: string, id: string | null, raw: Record<string, unknown>): Promise<FirecrawlKeyView> {
  if (id) validId(id);
  const input = parseFirecrawlKey(raw, !id);
  if ('error' in input) throw new AdminInputError(input.error!);
  const secret = input.apiKey ? { apiKeyCipher: await sealCredential(input.apiKey, 'provider'), apiKeyHash: await sha256(input.apiKey), apiKeyTail: keyTail(input.apiKey) } : null;
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:firecrawl-keys'))`);
    const [current] = id ? await tx.select().from(schema.firecrawlKey).where(eq(schema.firecrawlKey.id, id)).for('update') : [];
    if (id && !current) throw new AdminInputError('not_found');
    if (secret) {
      const [duplicate] = await tx.select({ id: schema.firecrawlKey.id }).from(schema.firecrawlKey).where(eq(schema.firecrawlKey.apiKeyHash, secret.apiKeyHash));
      if (duplicate && duplicate.id !== id) throw new AdminInputError('duplicate');
    }
    const isFallback = input.isFallback ?? current?.isFallback ?? false;
    if (isFallback) {
      const previous = await tx.select().from(schema.firecrawlKey).where(eq(schema.firecrawlKey.isFallback, true));
      for (const key of previous) {
        if (key.id === id) continue;
        const [demoted] = await tx.update(schema.firecrawlKey).set({ isFallback: false, updatedBy: administratorId, updatedAt: new Date() })
          .where(eq(schema.firecrawlKey.id, key.id)).returning();
        await audit(tx, { administratorId, action: 'firecrawl.key.update', target: key.id, before: shown(key), after: shown(demoted!) });
      }
    }
    const values = { name: input.name, enabled: input.enabled, isFallback, updatedBy: administratorId, updatedAt: new Date(),
      ...(secret ?? {}), ...(secret || (!current?.enabled && input.enabled) ? { cooldownUntil: null, lastStatus: null } : {}) };
    const [row] = id
      ? await tx.update(schema.firecrawlKey).set(values).where(eq(schema.firecrawlKey.id, id)).returning()
      : await tx.insert(schema.firecrawlKey).values({ ...values, ...secret! }).returning();
    await audit(tx, { administratorId, action: id ? 'firecrawl.key.update' : 'firecrawl.key.create', target: row!.id,
      before: current ? shown(current) : null, after: shown(row!) });
    await saveServicePrice(tx, administratorId, priceTarget(row!.id), input.costPricing, `Firecrawl key: ${input.name}`);
    return view(row!, priceFor(await providerPrices(tx), row!.id));
  });
}

export async function deleteFirecrawlKey(administratorId: string, id: string): Promise<void> {
  validId(id);
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:firecrawl-keys'))`);
    const [row] = await tx.delete(schema.firecrawlKey).where(eq(schema.firecrawlKey.id, id)).returning();
    if (!row) throw new AdminInputError('not_found');
    await saveServicePrice(tx, administratorId, priceTarget(id), null, '');
    await audit(tx, { administratorId, action: 'firecrawl.key.delete', target: id, before: shown(row) });
  });
}

export async function saveFirecrawlDefaultPricing(administratorId: string, raw: Record<string, unknown>) {
  let pricing: ServicePricingInput | null | undefined;
  try { pricing = parseServicePricing(raw.pricing, 'firecrawl'); } catch { throw new AdminInputError('cost_pricing'); }
  if (pricing === undefined) throw new AdminInputError('cost_pricing');
  await db().transaction((tx) => saveServicePrice(tx, administratorId, priceTarget(), pricing, 'Firecrawl service configuration'));
  return { pricing: priceFor(await providerPrices()) };
}
