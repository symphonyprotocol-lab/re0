import type { MetadataRoute } from 'next';
import { desc } from 'drizzle-orm';
import { LOCALES } from '@/i18n/locale';
import { localeAlternates } from '@/i18n/paths';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';
import { absoluteUrl, localeUrl } from '@/lib/seo';

export const dynamic = 'force-dynamic';

type Entry = MetadataRoute.Sitemap[number];

/**
 * The public site and every public Ree's page, so search engines can bring
 * people in (2.4), once per language (`/zh/...`, `/en/...`), each listing
 * the other as its hreflang alternate (i18n/paths.ts). Only `publicRee()`
 * Rees: public, published, not taken down, not deleted. The share pages
 * `/s/*` are left out; they point at `/r/*` as canonical. Explore changes
 * whenever a public Ree does.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const rees = await db()
    .select({ slug: schema.ree.slug, updatedAt: schema.ree.updatedAt })
    .from(schema.ree)
    .where(publicRee())
    .orderBy(desc(schema.ree.updatedAt))
    .limit(10_000);
  const latest = rees[0]?.updatedAt;
  const page = (path: string, entry: Omit<Entry, 'url' | 'alternates'>): Entry[] =>
    LOCALES.map((locale) => ({ url: localeUrl(locale, path), alternates: { languages: localeAlternates(path, absoluteUrl) }, ...entry }));
  return [
    ...page('/', { changeFrequency: 'weekly', priority: 1 }),
    ...page('/explore', { lastModified: latest, changeFrequency: 'daily', priority: 0.9 }),
    ...page('/pricing', { changeFrequency: 'monthly', priority: 0.7 }),
    ...page('/legal/terms', { changeFrequency: 'yearly', priority: 0.2 }),
    ...page('/legal/privacy', { changeFrequency: 'yearly', priority: 0.2 }),
    ...rees.flatMap((ree) => page(`/r/${ree.slug}`, { lastModified: ree.updatedAt, changeFrequency: 'weekly', priority: 0.8 })),
  ];
}
