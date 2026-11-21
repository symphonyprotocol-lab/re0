import type { Metadata } from 'next';
import type { Locale } from '@/i18n/locale';
import { localeAlternates } from '@/i18n/paths';
import { coverVersion } from '@/lib/og/text';
import { absoluteUrl, localeUrl, oneLine, siteImage, SITE_NAME, UNLISTED_ROBOTS } from '@/lib/seo';
import type { PostCover } from '@/lib/services/posts';

type Shown = Extract<PostCover, { state: 'shown' }>;

/** The `?v=` of a shown post's cover (lib/og/text.ts `coverVersion`). */
export function postCoverVersion(cover: Shown): string {
  return coverVersion({ question: cover.question, lang: cover.lang, answers: cover.answers, firstAnswerId: cover.first?.id ?? null, firstText: cover.first?.text ?? null });
}

/** A post's cover (app/og/p/[id]), at its current version. */
export function postCoverPath(id: string, cover: Shown): string {
  return `/og/p/${id}?v=${postCoverVersion(cover)}`;
}

/**
 * `/p/[id]`'s metadata, from `postCover`. Indexed only once a Ree's answer
 * may be read (P11). A shown post names its cover outright, for Open Graph
 * and a large Twitter card. A private one -- or none at all -- gives away
 * nothing: the site's name, no image (its own `openGraph` keeps the root
 * file's out too), not indexed. A hidden, deleted or unapproved one shows
 * the site's image in the page's language.
 */
export function postMetadata(id: string, cover: PostCover | null, locale: Locale): Metadata {
  if (!cover || cover.state === 'private') {
    return { title: { absolute: SITE_NAME }, robots: UNLISTED_ROBOTS, openGraph: { type: 'website', siteName: SITE_NAME, title: SITE_NAME }, twitter: { card: 'summary', title: SITE_NAME } };
  }
  if (cover.state === 'gone') {
    const image = siteImage(locale);
    return { title: { absolute: SITE_NAME }, robots: UNLISTED_ROBOTS, openGraph: { type: 'website', siteName: SITE_NAME, title: SITE_NAME, images: [image] }, twitter: { card: 'summary_large_image', title: SITE_NAME, images: [image] } };
  }
  const path = `/p/${id}`;
  const url = localeUrl(locale, path);
  const title = oneLine(cover.question, 70);
  const description = oneLine(cover.detail || cover.question, 160);
  const image = { url: postCoverPath(id, cover), width: 1200, height: 630, alt: title };
  return {
    title,
    description,
    alternates: { canonical: url, languages: localeAlternates(path, absoluteUrl) },
    openGraph: { type: 'article', siteName: SITE_NAME, url, title, description, images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
    ...(cover.answers > 0 ? {} : { robots: UNLISTED_ROBOTS }),
  };
}
