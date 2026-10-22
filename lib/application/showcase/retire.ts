/**
 * A library's page goes with the library. Called from inside the delete
 * transaction (lib/application/libraries/delete.ts): the row is tombstoned
 * so it stops counting against the plan and answering, and its internal
 * site key is revoked so nothing can resolve it afterwards. Imports only
 * the driver, so the delete path does not pull the rest of this module in.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { removeProjectDomain } from '@/lib/infrastructure/vercel/domains';

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

export async function retireShowcaseForLibrary(tx: Tx, libraryId: string, now: Date): Promise<void> {
  const rows = await tx
    .update(schema.libraryShowcase)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(schema.libraryShowcase.libraryId, libraryId), isNull(schema.libraryShowcase.deletedAt)))
    .returning({ id: schema.libraryShowcase.id, siteKeyId: schema.libraryShowcase.siteKeyId });
  /* The visitors' contacts were given to this page: they go with it. */
  if (rows.length > 0) {
    const ids = rows.map((row) => row.id);
    await tx.delete(schema.showcaseLead).where(inArray(schema.showcaseLead.showcaseId, ids));
    /* The host leaves the Vercel project too; off the transaction, best-effort, since Vercel is not in it. */
    const domains = await tx
      .delete(schema.showcaseDomain)
      .where(inArray(schema.showcaseDomain.showcaseId, ids))
      .returning({ host: schema.showcaseDomain.host, status: schema.showcaseDomain.status });
    for (const domain of domains) {
      if (domain.status !== 'pending_ownership') removeProjectDomain(domain.host).catch(() => {});
    }
  }
  for (const row of rows) {
    await tx
      .update(schema.siteKey)
      .set({ revokedAt: now })
      .where(and(eq(schema.siteKey.id, row.siteKeyId), isNull(schema.siteKey.revokedAt)));
  }
}
