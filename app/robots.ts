import type { MetadataRoute } from 'next';
import { appBaseUrl } from '@/lib/http/cookies';
import { CRAWL_DISALLOWED } from '@/lib/http/private-paths';

export const dynamic = 'force-dynamic';

/** `/robots.txt`: the public site is open; anything but production is closed. */
export default function robots(): MetadataRoute.Robots {
  const base = appBaseUrl();
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: { userAgent: '*', allow: '/', disallow: [...CRAWL_DISALLOWED] },
    sitemap: `${base}/sitemap.xml`,
  };
}
