'use client';

import { useActionState } from 'react';
import { FIELD } from '@/components/admin/form-fields';
import { ConsoleButton } from '@/components/admin/ui';
import { CircleCheckIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { Refusal, submitOn, type PlatformAction } from './platform-library-shared';

/**
 * Closing a sample (review-visibility-proposal.md 6.3): the reviewer looked
 * at an auto-published library and found nothing wrong. A reason is kept,
 * as with every review action. Anything wrong goes through the ordinary
 * verbs on the page, which close the sample too.
 */
export function SampleClose({ libraryId, action }: { libraryId: string; action: PlatformAction }) {
  const { t } = useI18n();
  const s = t.admin.libraries.detail.sample;
  const [state, submit, pending] = useActionState(action, null);
  return (
    <form onSubmit={submitOn(submit)} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="libraryId" value={libraryId} />
      <input name="reason" required maxLength={200} placeholder={s.reasonPlaceholder} aria-label={s.reason} className={`${FIELD} sm:w-[320px]`} />
      <ConsoleButton type="submit" variant="primary" disabled={pending}>
        <CircleCheckIcon size={14} />
        {s.close}
      </ConsoleButton>
      <Refusal state={state} />
    </form>
  );
}
