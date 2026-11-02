'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';

/** For pages without a signed-in user: the choice goes in a cookie. */
export function LanguageToggle() {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn-ghost"
      aria-label={t.common.language.label}
      onClick={async () => {
        await fetch('/api/locale', {
          method: 'POST',
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
