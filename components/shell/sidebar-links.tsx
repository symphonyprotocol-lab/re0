'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { LanguageMenu } from '@/components/ui/language-menu';
import { useI18n } from '@/i18n/client';

/**
 * The sidebar's last line (v6), signed in or not: 隐私 · 条款 · the language,
 * one row of small grey links. The language is the one switch on every
 * user page -- the top bar has none. In the icon rail only the language's
 * globe is left (columns.css).
 */
export function SidebarLinks({ signedIn = false }: { signedIn?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="xnav-links">
      <Link href="/legal/privacy">{t.site.visitor.privacy}</Link>
      <Link href="/legal/terms">{t.site.visitor.terms}</Link>
      <LanguageMenu signedIn={signedIn} quiet className="xnav-language" />
    </div>
  );
}
