'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import type { RedeemEarningsActionResult } from '@/app/dashboard/revenue/actions';
import { CircleCheckIcon, CircleXIcon, PackagePlusIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The Redeem button and the one line it answers with. The amounts it quotes
 * come from the server-rendered page around it; after a successful redeem the
 * page is pulled again so the tiles and the history show the new grant.
 */
export function RedeemEarningsButton({
  action,
  disabled = false,
}: {
  action: (
    previous: RedeemEarningsActionResult | null,
    form: FormData,
  ) => Promise<RedeemEarningsActionResult>;
  /** Nothing redeemable, no pack rate, or the viewer may not redeem. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const c = t.dashboard.revenue.credit;
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const message = state
    ? state.ok && state.outcome
      ? fill(c.done, {
          amount: `$${(state.outcome.amountMinor / 100).toFixed(2)}`,
          calls: state.outcome.calls.toLocaleString(),
          statements: state.outcome.statements,
        })
      : c.errors[state.error ?? 'failed']
    : null;

  return (
    <form action={formAction} className="flex flex-col items-end gap-1.5">
      <button
        type="submit"
        disabled={disabled || pending}
        className="inline-flex h-[35px] items-center gap-1.5 rounded-md bg-ink px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <PackagePlusIcon size={14} />}
        {pending ? c.pending : c.button}
      </button>
      {message ? (
        <span
          role="status"
          className={`flex max-w-[320px] items-start gap-1.5 text-right text-[11px] leading-[1.5] ${
            state?.ok ? 'text-brandink' : 'text-rose'
          }`}
        >
          {state?.ok ? (
            <CircleCheckIcon size={13} className="mt-px shrink-0" />
          ) : (
            <CircleXIcon size={13} className="mt-px shrink-0" />
          )}
          {message}
        </span>
      ) : null}
    </form>
  );
}
