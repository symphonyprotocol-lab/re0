import type { MetadataRoute } from 'next';
import { PUBLIC_ORIGIN, publicUrl } from '@/lib/site/origin';

/**
 * Crawler rules, generated so the host is the public origin wherever the
 * build runs (the static file it replaces still named a domain the product
 * had left). Signed-in surfaces, the API, file downloads and the two flows
 * that only make sense mid-action stay out; a shared page under `/s/` is
 * admitted here and decides for itself with its `robots` meta
 * (app/s/[slug]/render.tsx), since whether one may be indexed is a setting
 * of that page.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/admin/',
        '/dashboard/',
        '/playground',
        '/api/',
        '/files/',
        '/embed',
        '/mcp',
        '/login',
        '/checkout',
        '/libraries/claim',
      ],
    },
    sitemap: publicUrl('/sitemap.xml'),
    host: PUBLIC_ORIGIN,
  };
}
