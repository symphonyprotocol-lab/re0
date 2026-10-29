'use client';

import { useActionState, useId, useState, type ReactNode } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { submitOn } from '@/components/admin/platform-library-shared';
import { ConsoleButton, Pill } from '@/components/admin/ui';
import { CircleCheckIcon, CircleXIcon, PencilIcon, SpinnerIcon } from '@/components/ui/icons';
import { shortPlanVersionId, type PlanTierId } from '@/lib/domain/plans';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import type { PlanActionResult } from '@/app/admin/(console)/plans/actions';

/** What the dialog needs to know about the tier it is superseding. */
export interface PlanVersionTarget {
  planId: PlanTierId;
  name: string;
  /** Null when the tier has no version yet -- then this mints the first one. */
  live: {
    id: string;
    label: string;
    summary: string;
    subscriptions: number;
  } | null;
  /** Prefilled from the live version, so the form opens on today's values. */
  defaults: {
    price: string;
    calls: string;
    apiKeyLimit: string;
    buildBaseCalls: string;
    buildTokensPerCall: string;
    buildPagesPerCall: string;
  };
}

type Action = (previous: PlanActionResult | null, form: FormData) => Promise<PlanActionResult>;

/**
 * "New version" on a plan card -- design source frame `新建套餐版本`.
 *
 * The control is not called "edit" and the dialog does not pretend to be one: a
 * Plan Version is immutable (requirement.md 4.3), so what this does is mint a
 * successor and leave every existing subscription billing against the row it
 * was sold. The dialog says so twice -- once before the operator types, and
 * once afterwards with the number of subscriptions that stayed behind, because
 * "the price is now $6" and "the price is $6 for new customers" are different
 * facts and only the second one is true.
 */
export function PlanVersionControl({
  action,
  target,
}: {
  action: Action;
  target: PlanVersionTarget;
}) {
  const { t } = useI18n();
  const p = t.admin.plans;
  const [open, setOpen] = useState(false);
  /*
   * Bumped on close so the body is a fresh component next time it opens:
   * `useActionState` has no reset, and the previous attempt's refusal -- or its
   * success panel -- would otherwise still be on screen over an untouched form.
   */
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton
        size="sm"
        variant={target.planId === 'addon' ? 'primary' : 'outline'}
        className={
          target.planId === 'addon'
            ? 'border-2 border-white/16 bg-white/8 text-white hover:bg-white/14'
            : ''
        }
        onClick={() => setOpen(true)}
      >
        <PencilIcon size={13} />
        {p.newVersion}
      </ConsoleButton>

      {open ? (
        <PlanVersionDialog
          key={attempt}
          action={action}
          target={target}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function PlanVersionDialog({
  action,
  target,
  onClose,
}: {
  action: Action;
  target: PlanVersionTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const p = t.admin.plans;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  const done = state?.ok === true;

  /*
   * The tier decides which fields exist at all. A pack grants calls and nothing
   * else (agent-first-proposal.md 8.1), so offering it a key ceiling would be
   * offering a value nothing ever reads.
   */
  const isPack = target.planId === 'addon';
  const isFree = target.planId === 'free';

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={p.close}
      title={done ? p.doneTitle : fill(p.dialogTitle, { name: target.name })}
      description={done ? undefined : p.dialogDescription}
      footer={(dismissBlocked) =>
        done ? (
          <ConsoleButton onClick={onClose}>{p.close}</ConsoleButton>
        ) : (
          <>
            {/* Follows the dialog's own guard rather than `pending`, so a
                request that never settles cannot leave this disabled forever. */}
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {p.cancel}
            </ConsoleButton>
            <ConsoleButton variant="primary" type="submit" form={formId} disabled={pending}>
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {p.pending}
                </>
              ) : (
                p.submit
              )}
            </ConsoleButton>
          </>
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {state?.supersededSubscriptions
            ? fill(p.doneBody, {
                id: shortPlanVersionId(state.planVersionId ?? ''),
                count: state.supersededSubscriptions,
              })
            : fill(p.doneBodyFirst, { id: shortPlanVersionId(state?.planVersionId ?? '') })}
        </p>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          <input type="hidden" name="planId" value={target.planId} />
          <input type="hidden" name="currency" value="USD" />
          {/* What this form is a diff against. The server refuses the submit if
              the live version moved while the dialog was open. */}
          <input type="hidden" name="liveVersionId" value={target.live?.id ?? ''} />

          {state?.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
            >
              <CircleXIcon size={15} className="mt-px shrink-0" />
              {p.errors[state.error]}
            </p>
          ) : null}

          <div className="flex items-center gap-2.5 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              {target.live ? (
                <>
                  <span className="truncate text-[11px] font-semibold tracking-[-0.023em] text-steel">
                    {fill(p.currentLive, {
                      name: target.live.label,
                      id: shortPlanVersionId(target.live.id),
                    })}
                  </span>
                  <span className="text-[11px] leading-[1.5] tracking-[-0.023em] text-muted">
                    {target.live.summary}
                  </span>
                </>
              ) : (
                <span className="text-[11px] leading-[1.5] tracking-[-0.023em] text-muted">
                  {p.currentNone}
                </span>
              )}
            </span>
            {target.live && target.live.subscriptions > 0 ? (
              <Pill>{fill(p.subscriberCount, { count: target.live.subscriptions })}</Pill>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={isPack ? p.fieldPackPrice : p.fieldPrice}
              hint={isFree ? p.hintFreePrice : isPack ? p.hintPackPrice : p.hintPrice}
            >
              <input
                name="price"
                required
                inputMode="decimal"
                /* The Free tier is $0 by rule, not by default -- the domain
                   refuses anything else, so the control agrees rather than
                   letting an operator type a value that will bounce. */
                readOnly={isFree}
                defaultValue={target.defaults.price}
                data-dialog-autofocus={isFree ? undefined : true}
                className={isFree ? `${FIELD} bg-subtle text-muted` : FIELD}
              />
            </Field>
            <Field
              label={isPack ? p.fieldPackCalls : p.fieldCalls}
              hint={isPack ? p.hintPackCalls : p.hintCalls}
            >
              <input
                name="calls"
                required
                inputMode="numeric"
                defaultValue={target.defaults.calls}
                data-dialog-autofocus={isFree ? true : undefined}
                className={FIELD}
              />
            </Field>

            {isPack ? null : (
              <>
                <Field label={p.fieldApiKeyLimit} hint={p.hintApiKeyLimit}>
                  <input
                    name="apiKeyLimit"
                    required
                    inputMode="numeric"
                    defaultValue={target.defaults.apiKeyLimit}
                    className={FIELD}
                  />
                </Field>
                <Field label={p.fieldBuildBaseCalls} hint={p.hintBuildBaseCalls}>
                  <input
                    name="buildBaseCalls"
                    required
                    inputMode="numeric"
                    defaultValue={target.defaults.buildBaseCalls}
                    className={FIELD}
                  />
                </Field>
                <Field label={p.fieldBuildTokensPerCall} hint={p.hintBuildTokensPerCall}>
                  <input
                    name="buildTokensPerCall"
                    required
                    inputMode="numeric"
                    defaultValue={target.defaults.buildTokensPerCall}
                    className={FIELD}
                  />
                </Field>
                <Field label={p.fieldBuildPagesPerCall} hint={p.hintBuildPagesPerCall}>
                  <input
                    name="buildPagesPerCall"
                    required
                    inputMode="numeric"
                    defaultValue={target.defaults.buildPagesPerCall}
                    className={FIELD}
                  />
                </Field>
              </>
            )}
          </div>

          {isPack ? (
            <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{p.packNote}</p>
          ) : null}

          <Field label={p.reason}>
            <input
              name="reason"
              required
              maxLength={200}
              placeholder={p.reasonPlaceholder}
              className={FIELD}
            />
          </Field>
        </form>
      )}
    </ConsoleDialog>
  );
}

const FIELD =
  'h-9 w-full rounded-[7px] border-2 border-line bg-card px-2.5 text-[12px] tracking-[-0.023em] text-ink placeholder:text-faint focus:border-brand focus:outline-none';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-[-0.023em] text-steel">{label}</span>
      {children}
      {hint ? (
        <span className="text-[11px] leading-[1.45] tracking-[-0.023em] text-faint">{hint}</span>
      ) : null}
    </label>
  );
}
