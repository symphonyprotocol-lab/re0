/**
 * The one reading of "the host a page is live on": a `showcase_domain` row
 * in `ready`, and nothing else. Used as a column beside a page row and as a
 * lookup by page id, so the readiness rule is written once.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';

/** As a column of a query over `asset_showcase`: the live host, or null. */
export const liveHostSql = sql<string | null>`(select ${schema.showcaseDomain.host} from ${schema.showcaseDomain} where ${schema.showcaseDomain.showcaseId} = ${schema.assetShowcase.id} and ${schema.showcaseDomain.status} = 'ready' limit 1)`;

/** The live host of one page, with the workspace that owns it; null when none. */
export async function liveHostOf(showcaseId: string): Promise<{ host: string; workspaceId: string } | null> {
  const [row] = await db()
    .select({ host: schema.showcaseDomain.host, workspaceId: schema.showcaseDomain.workspaceId })
    .from(schema.showcaseDomain)
    .where(and(eq(schema.showcaseDomain.showcaseId, showcaseId), eq(schema.showcaseDomain.status, 'ready')))
    .limit(1);
  return row ?? null;
}
