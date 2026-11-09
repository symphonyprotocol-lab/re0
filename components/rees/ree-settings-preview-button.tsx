'use client';

import { createContext, useContext } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';

export const ReeSettingsPreview = createContext<(() => void) | undefined>(undefined);

export function ReeSettingsPreviewButton() {
  const open = useContext(ReeSettingsPreview);
  const { t } = useI18n();
  return (
    <button type="button" className="btn-secondary btn-sm shrink-0" onClick={open} disabled={!open}>
      <Icon name="external" />
      {t.reeSetup.settings.preview}
    </button>
  );
}
