import type { MetadataRoute } from 'next';
import { listPublicAssetLocations } from '@/lib/application/assets';
import { publicCardSubjects } from '@/lib/application/channels';
import { isPromoted, scenarioPath, SCENARIOS } from '@/lib/domain/scenarios';
import { publicUrl } from '@/lib/site/origin';

/**
 * Rebuilt at most hourly: the directory changes when an asset publishes or
 * refreshes, which is far slower than a crawler's visits, and a file served
 * straight from the database on every fetch would be a free read of the
 * whole catalogue for anyone.
 */
export const revalidate = 3600;

/**
 * The public pages a crawler should know about, then every public channel
 * and user page with their Agent Cards (agent-first-proposal.md 7.1), then
 * every asset shared with everyone. The static pages carry no `lastModified`: a date we cannot vouch
 * for is worse than none, and a crawler that reads one as "changed today"
 * on every fetch learns to ignore it. An asset's date is its last
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
    { url: publicUrl('/channels'), changeFrequency: 'daily', priority: 0.9 },
    { url: publicUrl('/.well-known/agent-card.json'), changeFrequency: 'weekly', priority: 0.6 },
    { url: publicUrl('/playground'), changeFrequency: 'monthly', priority: 0.8 },
    { url: publicUrl('/pricing'), changeFrequency: 'monthly', priority: 0.8 },
    { url: publicUrl('/about'), changeFrequency: 'monthly', priority: 0.6 },
    { url: publicUrl('/status'), changeFrequency: 'hourly', priority: 0.4 },
    { url: publicUrl('/contact'), changeFrequency: 'yearly', priority: 0.5 },
    { url: publicUrl('/legal'), changeFrequency: 'yearly', priority: 0.3 },
    { url: publicUrl('/legal/terms'), changeFrequency: 'yearly', priority: 0.3 },
    { url: publicUrl('/legal/privacy'), changeFrequency: 'yearly', priority: 0.3 },
    /* The scenario pages (proposal 2.2): Life is listed, at the bottom, until it is promoted. */
    ...SCENARIOS.map((scenario) => ({
      url: publicUrl(scenarioPath(scenario)),
      changeFrequency: 'monthly' as const,
      priority: isPromoted(scenario) ? 0.7 : 0.1,
    })),
  ];

  const subjects = await publicCardSubjects();
  const channels = subjects.channels.flatMap((channel) => {
    const lastModified = channel.lastUpdatedAt ? new Date(channel.lastUpdatedAt) : undefined;
    return [
      { url: publicUrl(`/channels/${channel.slug}`), lastModified, changeFrequency: 'daily' as const, priority: 0.8 },
      { url: publicUrl(`/a2a/channels/${channel.slug}/agent-card.json`), lastModified, changeFrequency: 'weekly' as const, priority: 0.5 },
    ];
  });
  const users = subjects.handles.flatMap((handle) => [
    { url: publicUrl(`/u/${handle}`), changeFrequency: 'weekly' as const, priority: 0.6 },
    { url: publicUrl(`/a2a/users/${handle}/agent-card.json`), changeFrequency: 'weekly' as const, priority: 0.4 },
  ]);

  const assets = (await listPublicAssetLocations()).map((asset) => ({
    url: publicUrl(`/assets${asset.publicId}`),
    lastModified: asset.updatedAt ? new Date(asset.updatedAt) : undefined,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  return [...pages, ...channels, ...users, ...assets];
}
