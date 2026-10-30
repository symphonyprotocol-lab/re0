'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { ConsoleButton, IconButton } from '@/components/admin/ui';
import { FIELD, submitOn } from '@/components/admin/platform-asset-shared';
import { BanIcon, RefreshIcon } from '@/components/ui/icons';
import type { ShowcaseAdminActionResult } from '@/app/admin/(console)/showcases/actions';
import { useI18n } from '@/lib/i18n/client';

type ShowcaseAdminAction = (previous: ShowcaseAdminActionResult | null, form: FormData) => Promise<ShowcaseAdminActionResult>;

/**
 * Take a page down or reinstate it, with the reason every console mutation
 * requires. Inline rather than a dialog: one field, one button, and the
 * server refuses a move that does not apply to the page's state anyway.
 */
export function ShowcaseControls({ showcaseId, slug, status, action }: { showcaseId: string; slug: string; status: string; action: ShowcaseAdminAction }) {
  const { t } = useI18n();
  const x = t.admin.showcases;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, dispatch, pending] = useActionState(action, null);
  const verb = status === 'taken_down' ? 'reinstate' : 'take_down';

  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);

  if (!open) {
    return (
      <IconButton label={verb === 'take_down' ? x.takeDown : x.reinstate} onClick={() => setOpen(true)}>
        {verb === 'take_down' ? <BanIcon size={14} /> : <RefreshIcon size={14} />}
      </IconButton>
    );
  }

  return (
    <form onSubmit={submitOn(dispatch)} className="flex flex-col gap-1.5">
      <input type="hidden" name="showcaseId" value={showcaseId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="verb" value={verb} />
      <input name="reason" required maxLength={200} placeholder={x.reasonPlaceholder} aria-label={x.reason} className={FIELD} />
      <span className="flex items-center gap-1.5">
        <ConsoleButton type="submit" variant="primary" disabled={pending}>
          {verb === 'take_down' ? x.takeDown : x.reinstate}
        </ConsoleButton>
        <ConsoleButton type="button" variant="ghost" onClick={() => setOpen(false)}>
          {x.cancel}
        </ConsoleButton>
      </span>
      {result && !result.ok ? <span className="text-[11px] text-rose">{x.errors[result.error ?? 'unavailable']}</span> : null}
    </form>
  );
}
