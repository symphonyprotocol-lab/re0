/** The document parser's credential pool. Never imported as a value by client components. */
import { and, eq, notInArray, or, isNull, lte, sql } from 'drizzle-orm';
import { firecrawlCooldown } from '@/lib/domain/firecrawl';
import { openCredential } from '@/lib/infra/crypto/credentials';
import { db, schema } from '@/lib/infra/db';

export interface FirecrawlCredential {
  id: string | null;
  apiKey: string | null;
  hash?: string;
}

export interface FirecrawlKeyClaim {
  managed: boolean;
  credential: FirecrawlCredential | null;
}

/** Rotate ordinary keys first; reserve the main key only after that pool is unavailable. */
export async function claimFirecrawlKey(excluded: readonly string[] = []): Promise<FirecrawlKeyClaim> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:firecrawl-keys'))`);
    const [configured] = await tx.select({ id: schema.firecrawlKey.id }).from(schema.firecrawlKey).limit(1);
    if (!configured) return { managed: false, credential: null };
    const candidates = await tx.select().from(schema.firecrawlKey)
      .where(and(
        eq(schema.firecrawlKey.enabled, true),
        or(isNull(schema.firecrawlKey.cooldownUntil), lte(schema.firecrawlKey.cooldownUntil, sql`clock_timestamp()`)),
        excluded.length ? notInArray(schema.firecrawlKey.id, [...excluded]) : undefined,
      ))
      .orderBy(schema.firecrawlKey.isFallback, sql`${schema.firecrawlKey.lastUsedAt} asc nulls first`, schema.firecrawlKey.createdAt, schema.firecrawlKey.id);
    for (const row of candidates) {
      const apiKey = await openCredential(row.apiKeyCipher, 'provider');
      if (!apiKey) {
        await tx.update(schema.firecrawlKey).set({ lastStatus: 0, cooldownUntil: firecrawlCooldown(0, null) }).where(eq(schema.firecrawlKey.id, row.id));
        continue;
      }
      await tx.update(schema.firecrawlKey)
        .set({ lastUsedAt: sql`clock_timestamp()`, useCount: sql`${schema.firecrawlKey.useCount} + 1` })
        .where(eq(schema.firecrawlKey.id, row.id));
      return { managed: true, credential: { id: row.id, apiKey, hash: row.apiKeyHash } };
    }
    return { managed: true, credential: null };
  });
}

export async function recordFirecrawlKeyResult(credential: FirecrawlCredential, status: number, retryAfter: string | null = null): Promise<void> {
  if (!credential.id) return;
  const cooldownUntil = firecrawlCooldown(status, retryAfter);
  await db().update(schema.firecrawlKey)
    .set({ lastStatus: status, ...(cooldownUntil ? { cooldownUntil } : {}) })
    .where(and(eq(schema.firecrawlKey.id, credential.id), eq(schema.firecrawlKey.apiKeyHash, credential.hash!)));
}
