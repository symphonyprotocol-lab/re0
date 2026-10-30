'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import type { RequestPayoutActionResult } from '@/app/dashboard/revenue/actions';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { FIELD } from '@/components/dashboard/asset-manage';
import { CircleCheckIcon, CircleXIcon, MailIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The PayPal address and the button that asks for a cash payout. Like the
 * redeem button beside it, the amounts come from the server-rendered page and
 * the page is pulled again once the request is in, so the open request shows.
 *
 * Submitted through `submitOn`, not the form's `action`: React resets a form
 * when a function action settles, which would clear a mistyped address the
 * moment it is refused.
 */
export function PayoutRequestForm({
  action,
  defaultEmail,
  disabled = false,
}: {
  action: (
    previous: RequestPayoutActionResult | null,
    form: FormData,
  ) => Promise<RequestPayoutActionResult>;
  /** The address the last request went to. */
  defaultEmail: string | null;
  /** Below the threshold, a request already open, or the viewer may not ask. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const p = t.dashboard.revenue.payout;
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const message = state
    ? state.ok && state.outcome
      ? fill(p.done, {
          amount: `$${(state.outcome.amountMinor / 100).toFixed(2)}`,
          email: state.outcome.payeeEmail,
          statements: state.outcome.statements,
        })
      : p.errors[state.error ?? 'failed']
    : null;

  return (
    <form onSubmit={submitOn(formAction)} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* FIELD is full width; the wrapper decides how much of the row it gets. */}
        <span className="min-w-[220px] flex-1">
          <input
            type="email"
            name="payeeEmail"
            required
            maxLength={254}
            autoComplete="email"
            defaultValue={defaultEmail ?? ''}
            placeholder={p.emailPlaceholder}
            aria-label={p.emailLabel}
            disabled={disabled || pending}
            className={`${FIELD} disabled:opacity-50`}
          />
        </span>
        <button
          type="submit"
          disabled={disabled || pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-ink px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <MailIcon size={14} />}
          {pending ? p.pending : p.button}
        </button>
      </div>
      {message ? (
        <span
          role="status"
          className={`flex items-start gap-1.5 text-[11px] leading-[1.5] ${
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
