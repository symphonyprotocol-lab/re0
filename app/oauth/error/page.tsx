import type { Metadata } from 'next';
import Link from 'next/link';
import { UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { BrandMark } from '@/components/ui/brand-mark';
import { LanguageMenu } from '@/components/ui/language-menu';
import '@/components/settings/settings.css';
import '@/components/oauth/oauth.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.oauth.error.title, robots: UNLISTED_ROBOTS };
}

/**
 * `/oauth/error?reason=…`: an authorization request whose client or
 * redirect URI did not check out. It stays here instead of going back to an
 * address re0 cannot vouch for.
 */
export default async function OAuthErrorPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { reason } = await searchParams;
  const { t } = await serverMessages();
  const e = t.oauth.error;
  const message = reason === 'invalid_client' ? e.invalid_client : reason === 'invalid_redirect_uri' ? e.invalid_redirect_uri : e.unknown;
  return (
    <main className="settings-page oauth-page">
      <div className="oauth-top">
        <BrandMark size={30} />
        <LanguageMenu />
      </div>
      <section className="card settings-card oauth-card">
        <h1>{e.title}</h1>
        <p className="muted">{message}</p>
        <Link href="/" className="btn secondary mt16">
          {e.back}
        </Link>
      </section>
    </main>
  );
}
