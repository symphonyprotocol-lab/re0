import type { MetadataRoute } from 'next';
import { listPublicLibraryLocations } from '@/lib/application/libraries';
import { publicUrl } from '@/lib/site/origin';

/**
 * Rebuilt at most hourly: the directory changes when a library publishes or
 * refreshes, which is far slower than a crawler's visits, and a file served
 * straight from the database on every fetch would be a free read of the
 * whole catalogue for anyone.
 */
export const revalidate = 3600;

/**
 * The public pages a crawler should know about, then every routable
 * library. The static pages carry no `lastModified`: a date we cannot vouch
 * for is worse than none, and a crawler that reads one as "changed today"
 * on every fetch learns to ignore it. A library's date is its last
 * successful refresh, which is when its content actually moved.
 *
 * Absent on purpose: the sign-in, the checkout, the claim flow and
 * everything behind a session (app/robots.ts keeps crawlers off those), and
 * shared pages under `/s/`, which are a customer's and are indexed, or not,
 * by their own setting.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = [
    { url: publicUrl('/'), changeFrequency: 'daily', priority: 1 },
    { url: publicUrl('/libraries'), changeFrequency: 'daily', priority: 0.9 },
    { url: publicUrl('/playground'), changeFrequency: 'monthly', priority: 0.8 },
    { url: publicUrl('/pricing'), changeFrequency: 'monthly', priority: 0.8 },
    { url: publicUrl('/about'), changeFrequency: 'monthly', priority: 0.6 },
    { url: publicUrl('/status'), changeFrequency: 'hourly', priority: 0.4 },
    { url: publicUrl('/contact'), changeFrequency: 'yearly', priority: 0.5 },
    { url: publicUrl('/legal'), changeFrequency: 'yearly', priority: 0.3 },
    { url: publicUrl('/legal/terms'), changeFrequency: 'yearly', priority: 0.3 },
    { url: publicUrl('/legal/privacy'), changeFrequency: 'yearly', priority: 0.3 },
  ];

  const libraries = (await listPublicLibraryLocations()).map((library) => ({
    url: publicUrl(`/libraries${library.publicId}`),
    lastModified: library.updatedAt ? new Date(library.updatedAt) : undefined,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  return [...pages, ...libraries];
}
