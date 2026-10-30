'use client';

import { useActionState, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { FIELD, Field } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-library-shared';
import { ConsoleButton } from '@/components/admin/ui';
import { CircleCheckIcon, CircleXIcon, RefreshIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import type { BackfillActionResult } from '@/app/admin/(console)/billing/actions';

type Action = (
  previous: BackfillActionResult | null,
  form: FormData,
) => Promise<BackfillActionResult>;

/**
 * "Backfill from provider" -- catches the mirror up on one document whose
 * webhook never arrived. The operator types the provider's id and a reason,
 * nothing more: the figures are read back from the provider
 * (lib/application/billing/backfill.ts). It writes a customer's bill and can
 * grant calls, so requirement.md 5.3's confirmation and recorded reason apply,
 * and it is a modal rather than a field that acts on Enter.
 */
export function BackfillDocument({ action }: { action: Action }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  /* Bumped on close so the next opening starts from an empty form. */
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton onClick={() => setOpen(true)}>
        <RefreshIcon size={14} />
        {t.admin.billing.backfill.open}
      </ConsoleButton>

      {open ? (
        <BackfillDialog
          key={attempt}
          action={action}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function BackfillDialog({ action, onClose }: { action: Action; onClose: () => void }) {
  const { t } = useI18n();
  const b = t.admin.billing;
  const f = b.backfill;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok && state.outcome ? state.outcome : null;

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={f.close}
      title={f.title}
      description={done ? undefined : f.description}
      footer={(dismissBlocked) =>
        done ? (
          <>
            <ConsoleButton onClick={onClose}>{f.close}</ConsoleButton>
            <ConsoleButton variant="primary" href={`/admin/billing/${done.documentId}`}>
              {f.view}
            </ConsoleButton>
          </>
        ) : (
          <>
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {f.cancel}
            </ConsoleButton>
            <ConsoleButton variant="primary" type="submit" form={formId} disabled={pending}>
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {f.pending}
                </>
              ) : (
                f.confirm
              )}
            </ConsoleButton>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-steel">
          <p className="flex items-start gap-2 text-pubink">
            <CircleCheckIcon size={15} className="mt-px shrink-0" />
            {done.created
              ? fill(f.doneCreated, { status: b.statuses[done.status] })
              : done.previousStatus === done.status
                ? fill(f.doneUnchanged, { status: b.statuses[done.status] })
                : fill(f.doneUpdated, {
                    from: b.statuses[done.previousStatus ?? done.status],
                    to: b.statuses[done.status],
                  })}
          </p>
          {done.grantedCalls !== null ? (
            <p>{fill(f.doneGranted, { calls: done.grantedCalls.toLocaleString('en-US') })}</p>
          ) : null}
        </div>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          {state?.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
            >
              <CircleXIcon size={15} className="mt-px shrink-0" />
              {f.errors[state.error]}
            </p>
          ) : null}

          <Field label={f.externalId}>
            <input
              name="externalId"
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="txn_01…"
              className={`${FIELD} font-mono`}
              data-dialog-autofocus
            />
          </Field>

          <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{f.note}</p>

          <Field label={f.reason}>
            <input
              name="reason"
              required
              maxLength={200}
              placeholder={f.reasonPlaceholder}
              className={FIELD}
            />
          </Field>
        </form>
      )}
    </ConsoleDialog>
  );
}
