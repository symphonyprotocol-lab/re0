import { siteOpenGraphImage } from '@/lib/og/site-image';
import { siteImage } from '@/lib/seo';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = siteImage('en').alt;

/**
 * The link preview of every page that names no image of its own: the
 * site's English card (lib/og/site-image.tsx), drawn once at build time.
 * The public pages name the card in their own language (lib/seo.ts
 * `siteImage`), `/og/site/zh` or `/og/site/en`.
 */
export default function OpenGraphImage() {
  return siteOpenGraphImage('en');
}
