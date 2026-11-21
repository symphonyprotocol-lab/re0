import { isLocale, LOCALES } from '@/i18n/locale';
import { siteOpenGraphImage } from '@/lib/og/site-image';

/** The site's link preview in each language, `/og/site/zh` and `/og/site/en` (lib/og/site-image.tsx), drawn at build time. */
export const dynamic = 'force-static';
/* Redrawn daily: a build that could not fetch the Chinese font serves the English card until then. */
export const revalidate = 86400;

export function generateStaticParams() {
  return LOCALES.map((lang) => ({ lang }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ lang: string }> }): Promise<Response> {
  const { lang } = await params;
  if (!isLocale(lang)) return new Response('Not found', { status: 404 });
  return siteOpenGraphImage(lang);
}
