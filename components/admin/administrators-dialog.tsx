'use client';

import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';

/** The top bar's "管理员" button and its dialog (add, disable); filled in with the console's Rees/audit pages. */
export function AdministratorsButton() {
  const { t } = useI18n();
  return (
    <button type="button" className="btn-secondary btn-sm" aria-label={t.console.nav.administrators}>
      <Icon name="user" className="size-3.5" />
      <span className="hidden sm:inline">{t.console.nav.administrators}</span>
    </button>
  );
}
