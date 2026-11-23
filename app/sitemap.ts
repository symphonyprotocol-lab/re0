import type { MetadataRoute } from 'next';
import { notFound } from 'next/navigation';
import { parseSitemapId, sitemapPart } from '@/lib/sitemaps';

export const dynamic = 'force-dynamic';

/**
 * The parts of the sitemap that always exist (lib/sitemaps.ts), served at
 * `/sitemap/<id>.xml`; `/sitemap.xml` is their index
 * (app/sitemap-index.xml/route.ts), which lists the later Ree and post files as
 * they fill up -- those are served on demand like these. No database here:
 * Next calls this at build time for the route's static params.
 */
export async function generateSitemaps(): Promise<{ id: string }[]> {
  return [{ id: 'pages' }, { id: 'rees-1' }, { id: 'posts-1' }];
}

/**
 * One part of the sitemap: the public site, public Rees, or public posts a
 * Ree answered (v5), so search engines can bring people in (2.4). A part
 * that does not exist is a 404.
 */
export default async function sitemap({ id }: { id?: string }): Promise<MetadataRoute.Sitemap> {
  const part = parseSitemapId(id);
  const entries = part && (await sitemapPart(part));
  if (!entries) notFound();
  return entries;
}
