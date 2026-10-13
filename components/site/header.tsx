import Link from 'next/link';

import { LocaleSwitcher } from '@/components/site/locale-switcher';
import { MobileNav } from '@/components/site/mobile-nav';
import { Wordmark } from '@/components/site/wordmark';
import { HeaderShell } from '@/components/site/header-shell';
import { RepoLink } from '@/components/site/repo-link';
import { ThemeToggle } from '@/components/site/theme-toggle';
import { getMessages } from '@/lib/i18n/server';
import { optionalSession } from '@/lib/http/session';

/**
 * Marketing chrome: the logo left, and everything else -- the destinations
 * followed by the action cluster -- gathered against the right edge, so the
 * links run straight into the GitHub mark. The capsule around all of it belongs
 * to `HeaderShell`, and nothing in here needs to know which plane it is on:
 * every label is spelled as a token, so the contents repaint with whichever the
 * shell hands them.
 *
 * The one session-aware bit is the filled pill: a signed-in visitor is offered
 * their dashboard instead of a login they already have. The GitHub mark, the
 * theme toggle and the language switcher sit ahead of it, see `RepoLink`.
 */
export async function SiteHeader() {
  const [session, t] = await Promise.all([optionalSession(), getMessages()]);

  const nav = [
    { href: '/pricing', label: t.nav.pricing },
    { href: '/playground', label: t.nav.playground },
  ];

  return (
    <HeaderShell width="max-w-[1200px]">
      <Wordmark />

      <div className="flex items-center gap-3">
        <nav className="hidden items-center gap-8 pr-3 md:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-body text-muted transition-colors hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <MobileNav items={nav} label={t.nav.menu} />
        <RepoLink label={t.nav.github} />
        <ThemeToggle label={t.nav.theme} />
        <LocaleSwitcher />
        <Link
          href={session ? '/dashboard' : '/login'}
          className="inline-flex h-10 shrink-0 items-center rounded-md bg-brand px-4 text-caption font-medium whitespace-nowrap text-onbrand transition-colors hover:bg-brand/90 sm:text-body"
        >
          {session ? t.nav.dashboard : t.nav.signIn}
        </Link>
      </div>
    </HeaderShell>
  );
}
