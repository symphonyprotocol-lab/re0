import type { MetadataRoute } from 'next';
import { desc } from 'drizzle-orm';
import { appBaseUrl } from '@/lib/http/cookies';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';

export const dynamic = 'force-dynamic';

/** The public site and every public Ree's page, so search engines can bring people in (2.4). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = appBaseUrl();
  const rees = await db()
    .select({ slug: schema.ree.slug, updatedAt: schema.ree.updatedAt })
    .from(schema.ree)
    .where(publicRee())
    .orderBy(desc(schema.ree.updatedAt))
    .limit(10_000);
  return [
    { url: `${base}/`, changeFrequency: 'weekly' },
    { url: `${base}/explore`, changeFrequency: 'daily' },
    { url: `${base}/pricing`, changeFrequency: 'monthly' },
    ...rees.map((ree) => ({ url: `${base}/r/${ree.slug}`, lastModified: ree.updatedAt, changeFrequency: 'weekly' as const })),
  ];
}
