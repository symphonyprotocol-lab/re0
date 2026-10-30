'use client';

import { useActionState, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { FIELD, Field } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { ConsoleButton } from '@/components/admin/ui';
import { CircleCheckIcon, CircleXIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { money } from '@/app/admin/(console)/list-params';
import type { PayoutActionResult } from '@/app/admin/(console)/settlements/actions';

type Action = (previous: PayoutActionResult | null, form: FormData) => Promise<PayoutActionResult>;

export interface OpenPayout {
  id: string;
  amountMinor: number;
  currency: string;
  payeeEmail: string | null;
}

/**
 * The two ways an operator closes a manual payout request: "paid", with the
 * PayPal transaction id, once the money has been sent from the platform's
 * PayPal account; or "failed", with the reason, which hands the statements
 * back to the publisher. Both are high-risk console writes (requirement.md
 * 5.3), so each is a modal with a recorded reason, never a one-click action.
 */
export function PayoutControls({
  payout,
  paidAction,
  failedAction,
}: {
  payout: OpenPayout;
  paidAction: Action;
  failedAction: Action;
}) {
  const { t } = useI18n();
  const p = t.admin.settlements.payouts;
  const [open, setOpen] = useState<'paid' | 'failed' | null>(null);

  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      <ConsoleButton size="sm" variant="primary" onClick={() => setOpen('paid')}>
        {p.markPaid}
      </ConsoleButton>
      <ConsoleButton size="sm" onClick={() => setOpen('failed')}>
        {p.markFailed}
      </ConsoleButton>
      {open ? (
        <ResolveDialog
          kind={open}
          payout={payout}
          action={open === 'paid' ? paidAction : failedAction}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </span>
  );
}

function ResolveDialog({
  kind,
  payout,
  action,
  onClose,
}: {
  kind: 'paid' | 'failed';
  payout: OpenPayout;
  action: Action;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const p = t.admin.settlements.payouts;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok && state.outcome ? state.outcome : null;
  const amount = money(payout.amountMinor, payout.currency);

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={p.close}
      title={kind === 'paid' ? p.paidTitle : p.failedTitle}
      description={
        done
          ? undefined
          : fill(kind === 'paid' ? p.paidDescription : p.failedDescription, {
              amount,
              email: payout.payeeEmail ?? '',
            })
      }
      footer={(dismissBlocked) =>
        done ? (
          <ConsoleButton onClick={onClose}>{p.close}</ConsoleButton>
        ) : (
          <>
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {p.cancel}
            </ConsoleButton>
            <ConsoleButton variant="primary" type="submit" form={formId} disabled={pending}>
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {p.pending}
                </>
              ) : kind === 'paid' ? (
                p.confirmPaid
              ) : (
                p.confirmFailed
              )}
            </ConsoleButton>
          </>
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {fill(done.status === 'paid' ? p.donePaid : p.doneFailed, {
            amount,
            statements: done.statements,
          })}
        </p>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          <input type="hidden" name="payoutId" value={payout.id} />
          {state?.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
            >
              <CircleXIcon size={15} className="mt-px shrink-0" />
              {p.errors[state.error]}
            </p>
          ) : null}

          {kind === 'paid' ? (
            <Field label={p.reference}>
              <input
                name="reference"
                required
                maxLength={120}
                placeholder={p.referencePlaceholder}
                className={`${FIELD} font-mono`}
                data-dialog-autofocus
              />
            </Field>
          ) : null}

          <Field label={kind === 'paid' ? p.reason : p.failureReason}>
            <input
              name="reason"
              required
              maxLength={200}
              placeholder={kind === 'paid' ? p.reasonPlaceholder : p.failureReasonPlaceholder}
              className={FIELD}
              {...(kind === 'failed' ? { 'data-dialog-autofocus': true } : {})}
            />
          </Field>
        </form>
      )}
    </ConsoleDialog>
  );
}
