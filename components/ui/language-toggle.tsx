'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';

/** The choice goes in a cookie, or onto the account when someone is signed in (it outranks the cookie). */
export function LanguageToggle({ signedIn = false }: { signedIn?: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn-ghost"
      aria-label={t.common.language.label}
      onClick={async () => {
        await fetch(signedIn ? '/api/account' : '/api/locale', {
          method: signedIn ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lang: locale === 'zh' ? 'en' : 'zh' }),
        });
        router.refresh();
      }}
    >
      <Icon name="globe" />
      {t.common.language.short}
    </button>
  );
}
