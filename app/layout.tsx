import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n/client';
import { serverMessages } from '@/i18n/server';
import { appBaseUrl } from '@/lib/http/cookies';
import { ogLocale, SITE_NAME } from '@/lib/seo';
import { ToastProvider } from '@/components/ui/toast';
import { NavigationProvider } from '@/components/shell/navigation-provider';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

/**
 * The site-wide defaults: absolute URLs resolve against `APP_BASE_URL`, the
 * description is in the request's language like the page, and the preview
 * image is ./opengraph-image.tsx unless a route has its own. Each public
 * page sets its own canonical URL (lib/seo.ts); none is inherited here, or
 * every page would claim to be the home page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await serverMessages();
  const description = t.site.seo.description;
  return {
    metadataBase: new URL(appBaseUrl()),
    applicationName: SITE_NAME,
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description,
    keywords: t.site.seo.keywords.split(/,\s*/),
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } },
    openGraph: { type: 'website', siteName: SITE_NAME, locale: ogLocale(locale), title: SITE_NAME, description },
    twitter: { card: 'summary_large_image', title: SITE_NAME, description },
    /* Optional: the meta-tag way to prove ownership to Google Search Console and Bing Webmaster Tools. */
    verification: {
      google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
      other: process.env.BING_SITE_VERIFICATION ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION } : undefined,
    },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f5f3ff' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, t } = await serverMessages();
  return (
    <html lang={locale === 'zh' ? 'zh-CN' : 'en'} className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh font-sans">
        <I18nProvider locale={locale} t={t}>
          <ToastProvider><NavigationProvider>{children}</NavigationProvider></ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
