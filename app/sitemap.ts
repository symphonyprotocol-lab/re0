import type { MetadataRoute } from 'next';
import { desc } from 'drizzle-orm';
import { appBaseUrl } from '@/lib/http/cookies';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';

export const dynamic = 'force-dynamic';

/**
 * The public site and every public Ree's page, so search engines can bring
 * people in (2.4). Only `publicRee()` Rees: public, published, not taken
 * down, not deleted. The share pages `/s/*` are left out; they point at
 * `/r/*` as canonical. Explore changes whenever a public Ree does.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = appBaseUrl();
  const rees = await db()
    .select({ slug: schema.ree.slug, updatedAt: schema.ree.updatedAt })
    .from(schema.ree)
    .where(publicRee())
    .orderBy(desc(schema.ree.updatedAt))
    .limit(10_000);
  const latest = rees[0]?.updatedAt;
  return [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/explore`, lastModified: latest, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/pricing`, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/legal/terms`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/legal/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    ...rees.map((ree) => ({ url: `${base}/r/${ree.slug}`, lastModified: ree.updatedAt, changeFrequency: 'weekly' as const, priority: 0.8 })),
  ];
}
