import { welcomeCredits } from '@/lib/services/signup-reward';
import { fill, formatNumber } from '@/i18n/format';
import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { redirect } from 'next/navigation';
import { isLoginError, safeReturnTo } from '@/lib/domain/auth';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { Wordmark } from '@/components/site/site-shell';
import { LoginIcon } from './login-icons';
import './login.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.login.title };
}

/**
 * `/login`: Google or GitHub, then back where the visitor was going. The
 * prototype's `#/login` (suite.js `login()`), styled by login.css with its
 * class names.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (await currentUser()) redirect(returnTo);
  const [{ t, locale }, welcome] = await Promise.all([serverMessages(), welcomeCredits()]);
  const l = t.login;
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
            <LanguageToggle className="btn ghost sm" icon={false} />
          </div>
          <p className="eyebrow">{l.eyebrow}</p>
          <h2>
            {l.hello1}
            <br />
            {l.hello2}
          </h2>
          <p>{l.subtitle}</p>
          <div className="oauth-buttons">
            <form action="/api/auth/google/start" method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
              <button type="submit" className="btn secondary full">
                <span className="google-letter" aria-hidden="true">
                  G
                </span>
                {l.google}
              </button>
            </form>
            <form action="/api/auth/github/start" method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
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
