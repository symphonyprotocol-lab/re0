import Link from 'next/link';
import type { ReactNode } from 'react';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { SignInLink, SiteNav } from '@/components/site/site-nav';

export function Wordmark() {
  return (
    <Link href="/" className="flex flex-none items-center gap-2 text-[17px] font-extrabold tracking-tight">
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-blue text-white">
        <Icon name="ree" className="size-5" />
      </span>
      RE0
    </Link>
  );
}

/**
 * The public site's frame (prototype suite.js `marketingHeader` /
 * `marketingFooter`): no sign-in needed. The header offers sign-in, or the
 * way back into the workspace for someone already signed in.
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
  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="sticky top-0 z-30 border-b border-[#e7eaf3] bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-4 px-4 sm:px-6">
          <Wordmark />
          <SiteNav links={links} label={s.nav.label} className="hidden h-16 md:flex" />
          <div className="ml-auto flex items-center gap-2">
            <LanguageToggle signedIn={Boolean(user)} />
            {user ? (
              <Link href="/dashboard" className="btn-secondary">
                {s.nav.open}
              </Link>
            ) : (
              <SignInLink label={s.nav.signIn} />
            )}
            <Link href={createHref} className="btn hidden md:inline-flex">
              {s.nav.create}
              <Icon name="arrow" />
            </Link>
          </div>
        </div>
        <SiteNav links={links} label={s.nav.label} className="grid h-11 grid-cols-3 border-t border-[#eef0f6] px-2 md:hidden" />
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-line bg-[#fbfaff]">
        <div className="mx-auto grid max-w-[1200px] gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Wordmark />
            <p className="mt-4 text-[13px] text-muted">{s.footer.tagline}</p>
            <p className="mt-1 font-mono text-[10px] tracking-[0.18em] text-muted">A LITTLE KNOWLEDGE. A NEW POSSIBILITY.</p>
          </div>
          <FooterColumn
            title={s.footer.product}
            links={[
              { href: '/explore', label: t.discover.nav },
              { href: '/pricing', label: s.footer.pricing },
              { href: '/dashboard', label: s.footer.workspace },
            ]}
          />
          <FooterColumn
            title={s.footer.space}
            links={[
              { href: '/rees', label: s.footer.rees },
              { href: '/chats', label: s.footer.chats },
              { href: '/settings?tab=billing', label: s.footer.billing },
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
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-5 text-[11px] text-muted sm:px-6">
          <span>© 2026 RE0. {s.footer.care}</span>
          <span className="flex items-center gap-1.5">
            <Icon name="shield" className="size-3.5" />
            {s.footer.paddle}
          </span>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      <strong className="text-[12px] text-ink">{title}</strong>
      {links.map((link) => (
        <Link key={link.href} href={link.href} className="text-muted hover:text-blue">
          {link.label}
        </Link>
      ))}
    </div>
  );
}
