import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site/header';
import { SiteFooter } from '@/components/site/footer';
import { JsonLd } from '@/components/seo/json-ld';
import { PUBLIC_ORIGIN, publicUrl } from '@/lib/site/origin';
import { LocaleProvider } from '@/lib/i18n/client';
import { translations } from '@/lib/i18n/server';

/**
 * What the site is, for a crawler: the organisation behind it and the site
 * with its one search box, so a search engine can offer the directory's
 * search on its own results page. Static by design -- nothing here reads a
 * row -- and in the visitor's language like the rest of the page.
 */
function siteStructuredData(t: Awaited<ReturnType<typeof translations>>['t']) {
  const organization = {
    '@type': 'Organization',
    '@id': `${PUBLIC_ORIGIN}/#organization`,
    name: t.meta.siteName,
    url: PUBLIC_ORIGIN,
    logo: publicUrl('/apple-icon.png'),
  };
  const website = {
    '@type': 'WebSite',
    '@id': `${PUBLIC_ORIGIN}/#website`,
    name: t.meta.siteName,
    description: t.meta.description,
    url: PUBLIC_ORIGIN,
    publisher: { '@id': organization['@id'] },
  };
  return { '@context': 'https://schema.org', '@graph': [organization, website] };
}

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const { locale, t } = await translations();

  return (
    <LocaleProvider locale={locale} messages={t}>
      <JsonLd data={siteStructuredData(t)} />
      <div className="product-surface site-surface flex min-h-screen flex-col">
        <SiteHeader />
        <main className="flex flex-1 flex-col">{children}</main>
        <SiteFooter />
      </div>
    </LocaleProvider>
  );
}
