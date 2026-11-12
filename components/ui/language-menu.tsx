'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { HTML_LANG, LOCALE_NAMES, LOCALES, type Locale } from '@/i18n/locale';
import { HREFLANG, localePath, splitLocale } from '@/i18n/paths';
import { Icon } from '@/components/ui/icons';
import { RowMenu, type MenuItem } from '@/components/ui/row-menu';
import './language-menu.css';

/**
 * The language menu: the current language on the button, every language
 * of `LOCALES` in the menu by its own name, the current one checked.
 *
 * The choice goes in the language cookie (which the middleware reads to
 * send plain public URLs to a language), through the account when someone
 * is signed in (it outranks the cookie, and saving it sets the cookie too).
 *
 * On a language URL (`/en/...`) the other languages are links to the same
 * page in that language, with `hreflang`, kept in the HTML while the menu
 * is closed so crawlers can follow them; a click saves the choice without
 * waiting and the browser loads the page.
 * Elsewhere they are buttons: the choice is saved, then the page renders
 * again in it. Until then the button is busy and ignores another choice.
 */
export function LanguageMenu({ signedIn = false, className = 'btn ghost sm' }: { signedIn?: boolean; className?: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const here = splitLocale(usePathname());
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const busy = saving || refreshing;

  const save = (lang: Locale, keepalive = false) =>
    fetch(signedIn ? '/api/account' : '/api/locale', {
      method: signedIn ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang }),
      keepalive,
    });

  const choose = async (lang: Locale) => {
    if (lang === locale || busy) return;
    setSaving(true);
    try {
      await save(lang);
      startRefresh(() => router.refresh());
    } finally {
      setSaving(false);
    }
  };

  const items: MenuItem[] = LOCALES.map((lang) => {
    const item = { label: LOCALE_NAMES[lang], lang: HTML_LANG[lang], checked: lang === locale };
    if (!here || lang === locale) return { ...item, onSelect: () => void choose(lang) };
    const href = localePath(lang, here.path);
    return {
      ...item,
      href,
      hrefLang: HREFLANG[lang],
      localeSwitch: true,
      onSelect: (event) => {
        if (busy) return event?.preventDefault();
        setSaving(true);
        void save(lang, true);
        /* The link names the page; the visitor's query and place on it come along. */
        if (window.location.search || window.location.hash) {
          event?.preventDefault();
          window.location.assign(href + window.location.search + window.location.hash);
        }
      },
    };
  });

  return (
    <RowMenu
      label={t.common.language.label}
      triggerLabel={fill(t.common.language.current, { name: LOCALE_NAMES[locale] })}
      triggerClassName={`${className} language-menu-trigger`}
      width={168}
      busy={busy}
      prerender={Boolean(here)}
      items={items}
      trigger={
        <>
          <Icon name="globe" className="language-menu-globe" />
          <span lang={HTML_LANG[locale]}>{LOCALE_NAMES[locale]}</span>
          <Icon name="chevronDown" className="language-menu-caret" />
        </>
      }
    />
  );
}
