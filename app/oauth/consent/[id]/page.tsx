import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { consentCookieName } from '@/lib/http/oauth';
import { pendingAuthorization } from '@/lib/services/oauth';
import { UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { fill } from '@/i18n/format';
import { BrandMark } from '@/components/ui/brand-mark';
import { LanguageMenu } from '@/components/ui/language-menu';
import { I } from '@/components/settings/icon';
import { ConsentForm } from '@/components/oauth/consent-form';
import '@/components/settings/settings.css';
import '@/components/oauth/oauth.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.oauth.title, robots: UNLISTED_ROBOTS };
}

/**
 * `/oauth/consent/[id]`: an MCP client asks to connect to the signed-in
 * account (lib/services/oauth.ts). Shows who is asking -- its name, whether
 * a metadata document vouches for it, where approval sends the user, with
 * a warning for a loopback address -- and the same permissions an API key
 * has, narrowest first. Signed-out visitors sign in and come back here; a
 * request that was decided, has expired or belongs to another browser shows
 * only that.
 */
export default async function ConsentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/oauth/consent/${id}`)}`);
  const { t } = await serverMessages();
  const o = t.oauth;
  const pending = await pendingAuthorization(id, (await cookies()).get(consentCookieName())?.value);
  return (
    <main className="settings-page oauth-page">
      <div className="oauth-top">
        <BrandMark size={30} />
        <LanguageMenu />
      </div>
      <section className="card settings-card oauth-card">
        {!pending ? (
          <>
            <h1>{o.error.title}</h1>
            <p className="muted">{o.errors.expired}</p>
          </>
        ) : (
          <>
            <p className="eyebrow">{o.eyebrow}</p>
            <h1>{fill(o.heading, { client: pending.client.name })}</h1>
            <p className="muted">{o.lede}</p>
            <dl className="oauth-facts">
              <div>
                <dt>{o.client.label}</dt>
                <dd>
                  <strong>{pending.client.name}</strong>
                  <small className={pending.client.documentHost ? 'oauth-verified' : undefined}>
                    <I name={pending.client.documentHost ? 'shield' : 'info'} />
                    {pending.client.documentHost ? fill(o.client.verified, { host: pending.client.documentHost }) : o.client.registered}
                  </small>
                  {pending.client.uri && (
                    <small>
                      {o.client.website}: <span className="mono">{pending.client.uri}</span>
                    </small>
                  )}
                </dd>
              </div>
              <div>
                <dt>{o.client.redirect}</dt>
                <dd>
                  <strong className="mono">{pending.redirectLabel}</strong>
                  <small className="mono oauth-uri">{pending.redirectUri}</small>
                </dd>
              </div>
              <div>
                <dt>{o.signedInAs}</dt>
                <dd>
                  <strong>{user.name}</strong>
                  {user.email && <small>{user.email}</small>}
                </dd>
              </div>
            </dl>
            {pending.loopbackRedirect && (
              <div className="info-strip oauth-warning" role="note">
                <I name="info" />
                <span>{fill(o.client.loopback, { host: pending.redirectLabel })}</span>
              </div>
            )}
            <ConsentForm id={pending.id} suggested={pending.suggested} />
          </>
        )}
      </section>
    </main>
  );
}
