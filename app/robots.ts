import type { MetadataRoute } from 'next';
import { appBaseUrl } from '@/lib/http/cookies';

export const dynamic = 'force-dynamic';

/*
 * Signed-in and console areas and the API: crawling them only finds the
 * sign-in redirect. `/login`, `/checkout` and the share pages `/s/*` stay
 * crawlable on purpose: they carry `noindex` (and `/s/*` a canonical to
 * `/r/*`), which a crawler can only read on a page it may fetch.
 */
const PRIVATE = ['/admin', '/api/', '/billing', '/redeem', '/dashboard', '/rees', '/settings', '/talk', '/chats', '/workspace', '/videos'];

/** `/robots.txt`: the public site is open; anything but production is closed. */
export default function robots(): MetadataRoute.Robots {
  const base = appBaseUrl();
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: { userAgent: '*', allow: '/', disallow: PRIVATE },
    sitemap: `${base}/sitemap.xml`,
  };
}
