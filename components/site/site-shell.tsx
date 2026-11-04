import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { SignInLink, SiteNav } from '@/components/site/site-nav';
import { RouteMotion } from '@/components/shell/workspace-main';
import './site.css';

/** The RE0 mark (prototype icon.svg). */
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10.6667" fill="#127ee3" />
      <g fill="#ffffff" stroke="#ffffff" strokeWidth="1" strokeLinejoin="round">
        <path d="M17.25 8.91 A 7.2 7.2 0 1 0 23.2 16" fill="none" strokeWidth="3" />
        <circle cx="17.25" cy="8.91" r="1.5" stroke="none" />
        <path d="M23.2 11.4 L 25.75 16 L 20.65 16 Z" />
        <circle cx="16" cy="16" r="2.5" stroke="none" />
      </g>
    </svg>
  );
}

export function Wordmark({ label }: { label: string }) {
  return (
    <Link href="/" className="wordmark" aria-label={label}>
      <BrandMark />
      <span>RE0</span>
    </Link>
  );
}

/**
 * The public site's frame (prototype suite.js `marketingHeader` /
 * `marketingFooter`): no sign-in needed. The header offers sign-in, or the
 * way back into the workspace for someone already signed in. Styled by
 * site.css with the prototype's class names.
 */
export async function SiteShell({ children }: { children: ReactNode }) {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const s = t.site;
  const links = [
    { href: '/', label: s.nav.home },
    { href: '/explore', label: t.discover.nav, also: ['/r'] },
    { href: '/pricing', label: s.nav.pricing, also: ['/checkout'] },
  ];
  const createHref = user ? '/rees/new' : `/login?returnTo=${encodeURIComponent('/rees/new')}`;
  const home = `RE0 ${s.nav.home}`;
  return (
    <div className="marketing-site flex min-h-dvh flex-col">
      <header className="marketing-header">
        <div className="marketing-nav">
          <Wordmark label={home} />
          <SiteNav links={links} label={s.nav.label} />
          <div className="marketing-actions">
            <LanguageToggle signedIn={Boolean(user)} className="btn ghost sm" icon={false} />
            {user ? (
              <Link href="/rees" className="btn secondary">
                {s.nav.open}
              </Link>
            ) : (
              <SignInLink label={s.nav.signIn} className="btn secondary" />
            )}
            <Link href={createHref} className="btn marketing-cta">
              {s.nav.create}
              <Icon name="arrow" />
            </Link>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        <RouteMotion className="site-route-content">{children}</RouteMotion>
      </main>
      <footer className="marketing-footer">
        <div className="marketing-wrap">
          <div className="footer-top">
            <div>
              <Wordmark label={home} />
              <p>
                {s.footer.tagline}
                <br />
                <span className="mono">A LITTLE KNOWLEDGE. A NEW POSSIBILITY.</span>
              </p>
            </div>
            <FooterColumn
              title={s.footer.product}
              links={[
                { href: '/explore', label: s.footer.discover },
                { href: '/pricing', label: s.footer.pricing },
              ]}
            />
            <FooterColumn
              title={s.footer.space}
              links={[
                { href: '/rees', label: s.footer.rees },
                { href: '/chats', label: s.footer.chats },
                { href: '/settings?tab=balance', label: s.footer.billing },
              ]}
            />
            <FooterColumn
              title={s.footer.about}
              links={[
                { href: '/legal/terms', label: s.footer.terms },
                { href: '/legal/privacy', label: s.footer.privacy },
                { href: '/admin/login', label: s.footer.admin },
              ]}
            />
          </div>
          <div className="footer-bottom">
            <span>© 2026 RE0. {s.footer.care}</span>
            <span className="footer-note">
              <i className="dot" aria-hidden="true" />
              {s.footer.paddle}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <strong>{title}</strong>
      {links.map((link) => (
        <Link key={link.href} href={link.href}>
          {link.label}
        </Link>
      ))}
    </div>
  );
}
