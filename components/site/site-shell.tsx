import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';
import { LanguageMenu } from '@/components/ui/language-menu';
import { SignInLink, SiteNav } from '@/components/site/site-nav';
import { RouteMotion } from '@/components/shell/workspace-main';
import './site.css';

export function Wordmark({ label }: { label: string }) {
  return (
    <Link href="/" className="wordmark" aria-label={label}>
      <BrandMark />
      <BrandName />
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
            <LanguageMenu signedIn={Boolean(user)} />
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
