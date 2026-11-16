'use client';

import { useI18n } from '@/i18n/client';
import { useToast } from '@/components/ui/toast';
import { I } from '@/components/settings/icon';

/** The invite tab's copy button: the link to the clipboard, or a toast saying to copy it by hand. */
export function InviteCopy({ link }: { link: string }) {
  const { t } = useI18n();
  const p = t.invites.panel;
  const toast = useToast();
  async function copy() {
    await navigator.clipboard.writeText(link).then(
      () => toast(p.copied),
      () => toast(p.copyFailed),
    );
  }
  return (
    <button type="button" className="btn" onClick={copy}>
      <I name="copy" />
      {p.copy}
    </button>
  );
}
