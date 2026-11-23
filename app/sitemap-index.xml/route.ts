import { sitemapIds, sitemapIndexXml } from '@/lib/sitemaps';

export const dynamic = 'force-dynamic';

/**
 * The index of the sitemap's parts (lib/sitemaps.ts), served at
 * `/sitemap.xml` -- the URL robots.txt names and Search Console was given
 * -- by a rewrite in middleware.ts. Next 15 serves the parts of a split
 * `app/sitemap.ts` at `/sitemap/<id>.xml` but writes no index for them, and
 * a route of its own at `app/sitemap.xml/` would collide with that file.
 */
export async function GET(): Promise<Response> {
  return new Response(sitemapIndexXml(await sitemapIds()), {
    headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=0, must-revalidate' },
  });
}
