'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/client';
import { localePath, splitLocale } from '@/i18n/paths';
import { Icon } from '@/components/ui/icons';

/**
 * The choice goes in the language cookie (which the middleware reads to
 * send plain public URLs to a language), and onto the account when someone
 * is signed in (it outranks the cookie; saving it sets the cookie too). On a language URL (`/en/...`) it then loads
 * the same page in the other language -- a full load, since a client-side
 * one would keep the root layout in the old language; elsewhere the page
 * re-renders.
 */
export function LanguageToggle({ signedIn = false, className = 'btn-ghost', icon = true }: { signedIn?: boolean; className?: string; icon?: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <button
      type="button"
      className={className}
      aria-label={t.common.language.label}
      onClick={async () => {
        const lang = locale === 'zh' ? 'en' : 'zh';
        /* Either sets the cookie; the account's PATCH also saves it on the account. */
        await fetch(signedIn ? '/api/account' : '/api/locale', {
          method: signedIn ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lang }),
        });
        const here = splitLocale(window.location.pathname);
        if (here) window.location.replace(localePath(lang, here.path) + window.location.search + window.location.hash);
        else router.refresh();
      }}
    >
      {icon && <Icon name="globe" />}
      {t.common.language.short}
    </button>
  );
}
