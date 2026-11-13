import { welcomeCredits } from '@/lib/services/signup-reward';
import { inviteLanding } from '@/lib/services/invites';
import { fill, formatNumber } from '@/i18n/format';
import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { redirect } from 'next/navigation';
import { isLoginError, safeReturnTo } from '@/lib/domain/auth';
import { currentUser } from '@/lib/http/session';
import { UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { BrandMark } from '@/components/ui/brand-mark';
import { LanguageMenu } from '@/components/ui/language-menu';
import { Wordmark } from '@/components/site/site-shell';
import { LoginIcon } from './login-icons';
import './login.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.login.title, robots: UNLISTED_ROBOTS };
}

/**
 * `/login`: Google or GitHub, then back where the visitor was going. The
 * prototype's `#/login` (suite.js `login()`), styled by login.css with its
 * class names. `?invite=CODE` (an inviter's link) rides through the OAuth
 * round trip and counts only if the sign-in creates a new account.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (await currentUser()) redirect(returnTo);
  const [{ t, locale }, welcome, invite] = await Promise.all([serverMessages(), welcomeCredits(), params.invite ? inviteLanding(params.invite) : null]);
  const l = t.login;
  const il = t.invites.login;
  /* A bad link says so; switched-off invitations simply show no invitation. */
  const inviteNote = invite?.state === 'unknown' ? il.unknown : null;
  const error = isLoginError(params.error) ? l.errors[params.error] : null;
  return (
    <div className="suite-login">
      <section className="suite-login-story">
        <Wordmark label={`RE0 ${t.site.nav.home}`} />
        <div>
          <p className="eyebrow">{l.eyebrowLeft}</p>
          <h1>
            {l.headline1}
            <br />
            {l.headline2a}
            <em>{l.headline2b}</em>
          </h1>
          <p>
            {l.lede1}
            <br />
            {l.lede2}
          </p>
          <div className="login-story-card">
            <div className="login-story-ree">
              <span className="dot-avatar" aria-hidden="true">
                <LoginIcon name="ree" strokeWidth={1.6} />
              </span>
              <div>
                <strong>{l.previewTitle}</strong>
                <small>{l.previewBody}</small>
              </div>
            </div>
            <div className="login-source-chain">
              <LoginIcon name="file" />
              <i />
              <LoginIcon name="ree" />
              <i />
              <LoginIcon name="chat" />
              <i />
              <LoginIcon name="light" />
            </div>
          </div>
        </div>
        <span className="mono">RE0 / YOUR KNOWLEDGE. A NEW VOICE.</span>
      </section>
      <main id="main" tabIndex={-1} className="suite-login-form">
        <div>
          <div className="login-top-link">
            <Link href="/" className="text-link">
              <LoginIcon name="arrow" />
              {l.back}
            </Link>
            <LanguageMenu />
          </div>
          <BrandMark className="login-mobile-mark" size={33} />
          <p className="eyebrow">{l.eyebrow}</p>
          <h2>
            {l.hello1}
            <br />
            {l.hello2}
          </h2>
          <p>{l.subtitle}</p>
          {invite?.state === 'open' && invite.inviterName && (
            <div className="login-welcome login-invite">
              <LoginIcon name="sparkle" />
              <div>
                <strong>{fill(il.invited, { name: invite.inviterName })}</strong>
                <span>{il.invitedBody}</span>
              </div>
            </div>
          )}
          {inviteNote && (
            <p role="status" className="login-invite-note">
              {inviteNote}
            </p>
          )}
          <div className="oauth-buttons">
            <form action="/api/auth/google/start" method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
              {invite?.code && <input type="hidden" name="invite" value={invite.code} />}
              <button type="submit" className="btn secondary full">
                <span className="google-letter" aria-hidden="true">
                  G
                </span>
                {l.google}
              </button>
            </form>
            <form action="/api/auth/github/start" method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
              {invite?.code && <input type="hidden" name="invite" value={invite.code} />}
              <button type="submit" className="btn secondary full">
                <LoginIcon name="github" />
                {l.github}
              </button>
            </form>
          </div>
          {error && (
            <p role="alert" className="login-error">
              {error}
            </p>
          )}
          {welcome.credits > 0 && <div className="login-welcome">
            <LoginIcon name="sparkle" />
            <div>
              <strong>{fill(l.giftAmount, { welcomeCredits: formatNumber(welcome.credits, locale) })}</strong>
              <span>{l.giftText}</span>
            </div>
          </div>
          }
          <p className="login-terms">
            {l.termsBefore}{' '}
            <Link href="/legal/terms" className="text-link">
              {l.termsLink}
            </Link>{' '}
            {l.termsAnd}{' '}
            <Link href="/legal/privacy" className="text-link">
              {l.privacyLink}
            </Link>
            {l.termsAfter}
          </p>
          <div className="login-other">
            <Link href="/explore" className="text-link">
              {l.explore}
            </Link>
            <Link href="/admin/login" className="text-link">
              {l.admin}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
