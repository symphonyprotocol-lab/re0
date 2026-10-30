'use client';

import { useActionState, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { FIELD, Field } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-library-shared';
import { ConsoleButton } from '@/components/admin/ui';
import { CircleCheckIcon, CircleXIcon, PackagePlusIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { money } from '@/app/admin/(console)/list-params';
import type { SettlementActionResult } from '@/app/admin/(console)/settlements/actions';

export interface SettleablePeriod {
  id: string;
  locked: boolean;
  events: number;
  statements: number;
}

type Action = (
  previous: SettlementActionResult | null,
  form: FormData,
) => Promise<SettlementActionResult>;

/**
 * "Generate statements" -- the console end of the monthly close
 * (agent-first-proposal.md 6.9). requirement.md 5.3 puts a second
 * confirmation and a recorded reason in front of every high-risk action;
 * locking a period and writing numbers against creators' names is one, so
 * this is a modal with a required reason rather than a button that acts on
 * the first click.
 */
export function GenerateSettlements({
  action,
  periods,
  currency,
}: {
  action: Action;
  periods: SettleablePeriod[];
  /**
   * The ledger's currency code, not a formatter: a function cannot cross the
   * server-to-client boundary, and React refuses to render the page at all
   * when one is handed to a `'use client'` component. The amounts this dialog
   * shows come back from the action, so they are formatted here.
   */
  currency: string;
}) {
  const { t } = useI18n();
  const s = t.admin.settlements;
  const [open, setOpen] = useState(false);
  /* Bumped on close so the next opening starts from an empty form. */
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton variant="primary" onClick={() => setOpen(true)}>
        <PackagePlusIcon size={14} />
        {s.generate}
      </ConsoleButton>

      {open ? (
        <GenerateDialog
          key={attempt}
          action={action}
          periods={periods}
          currency={currency}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function GenerateDialog({
  action,
  periods,
  currency,
  onClose,
}: {
  action: Action;
  periods: SettleablePeriod[];
  currency: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const l = t.admin.settlements.ledger;
  const cash = (minor: number) => money(minor, currency);
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok && state.outcome ? state.outcome : null;

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={l.close}
      title={l.generateTitle}
      description={done ? undefined : l.generateDescription}
      footer={(dismissBlocked) =>
        done ? (
          <ConsoleButton onClick={onClose}>{l.close}</ConsoleButton>
        ) : (
          <>
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {l.cancel}
            </ConsoleButton>
            <ConsoleButton
              variant="primary"
              type="submit"
              form={formId}
              disabled={pending || periods.length === 0}
            >
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {l.pending}
                </>
              ) : (
                l.confirm
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
            {fill(l.done, { period: done.periodId, total: cash(done.totalAmountMinor) })}
          </p>
          <p>
            {done.created > 0
              ? fill(l.doneCreated, { count: done.created, amount: cash(done.createdMinor) })
              : l.doneNone}
          </p>
          {done.withoutAccount > 0 ? (
            <p className="text-amberink">{fill(l.doneSkipped, { count: done.withoutAccount })}</p>
          ) : null}
          {done.alreadyPresent > 0 ? (
            <p className="text-muted">{fill(l.doneExisting, { count: done.alreadyPresent })}</p>
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
              {l.errors[state.error]}
            </p>
          ) : null}

          <Field label={l.generatePeriod}>
            {periods.length === 0 ? (
              <p className="text-[11px] leading-[1.5] text-muted">{l.generateNoPeriods}</p>
            ) : (
              <select name="period" defaultValue={periods[0]!.id} className={FIELD} data-dialog-autofocus>
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {fill(l.generatePeriodOption, {
                      period: `${period.id} (${period.locked ? l.periodLocked : l.periodOpen})`,
                      events: period.events,
                      statements: period.statements,
                    })}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{l.generateNote}</p>

          <Field label={l.reason}>
            <input
              name="reason"
              required
              maxLength={200}
              placeholder={l.reasonPlaceholder}
              className={FIELD}
            />
          </Field>
        </form>
      )}
    </ConsoleDialog>
  );
}
