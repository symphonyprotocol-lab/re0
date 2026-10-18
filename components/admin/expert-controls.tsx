'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { ConsoleButton, IconButton, Monogram } from '@/components/admin/ui';
import { ReasonField, submitOn } from '@/components/admin/platform-library-shared';
import { AwardIcon, BanIcon, CircleXIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import type { ExpertAdminActionResult } from '@/app/admin/(console)/expert-libraries/actions';
import type { ExpertDecision } from '@/lib/domain/expert-library';

export type ExpertAdminAction = (
  previous: ExpertAdminActionResult | null,
  form: FormData,
) => Promise<ExpertAdminActionResult>;

/** Which application a dialog is about, so the confirmation is checkable. */
export interface ExpertTarget {
  id: string;
  libraryTitle: string;
  libraryPublicId: string;
  workspaceName: string;
  initial: string;
}

/**
 * Expert-tag controls -- expert-library-prd.md 6.
 *
 * Three confirmations with a required reason, like every other console
 * mutation. What is offered comes from the application's own state: a
 * pending one can be approved or rejected, an approved one can have its tag
 * revoked, and anything else gets no controls at all.
 *
 * `approvable` only changes the wording: when the library no longer
 * qualifies the dialog says so up front, but the button stays, because the
 * server re-checks and refuses with `library_ineligible` either way and an
 * administrator should be able to read that refusal rather than infer it.
 */
export function ExpertControls({
  target,
  status,
  approvable,
  decideAction,
  revokeAction,
  variant = 'icon',
}: {
  target: ExpertTarget;
  status: string;
  approvable: boolean;
  decideAction: ExpertAdminAction;
  revokeAction: ExpertAdminAction;
  variant?: 'icon' | 'button';
}) {
  const { t } = useI18n();
  const d = t.admin.expertDetail;
  const [move, setMove] = useState<ExpertDecision | null>(null);
  const [attempt, setAttempt] = useState(0);

  const canDecide = status === 'pending';
  const canRevoke = status === 'approved';
  if (!canDecide && !canRevoke) return null;

  const open = (next: ExpertDecision) => () => setMove(next);

  return (
    <>
      {variant === 'icon' ? (
        <>
          {canDecide ? (
            <>
              <IconButton label={d.actions.approve} onClick={open('approve')}>
                <AwardIcon size={14} />
              </IconButton>
              <IconButton label={d.actions.reject} onClick={open('reject')}>
                <CircleXIcon size={14} />
              </IconButton>
            </>
          ) : null}
          {canRevoke ? (
            <IconButton label={d.actions.revoke} onClick={open('revoke')}>
              <BanIcon size={14} />
            </IconButton>
          ) : null}
        </>
      ) : (
        <>
          {canDecide ? (
            <>
              <ConsoleButton variant="primary" onClick={open('approve')}>
                <AwardIcon size={14} />
                {d.actions.approve}
              </ConsoleButton>
              <ConsoleButton onClick={open('reject')}>{d.actions.reject}</ConsoleButton>
            </>
          ) : null}
          {canRevoke ? (
            <ConsoleButton className="text-err hover:bg-errsoft" onClick={open('revoke')}>
              <BanIcon size={14} />
              {d.actions.revoke}
            </ConsoleButton>
          ) : null}
        </>
      )}

      {move ? (
        <ExpertDialog
          key={`${move}-${attempt}`}
          move={move}
          approvable={approvable}
          action={move === 'revoke' ? revokeAction : decideAction}
          target={target}
          onClose={() => {
            setMove(null);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function ExpertDialog({
  move,
  approvable,
  action,
  target,
  onClose,
}: {
  move: ExpertDecision;
  approvable: boolean;
  action: ExpertAdminAction;
  target: ExpertTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const r = t.admin.expertDetail.dialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();

  /* Closes on success: the page behind has been revalidated and the new
     status is what the administrator wants to read. */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  const title = r[`${move}Title`];
  const description = r[`${move}Description`];
  const confirm = r[`confirm_${move}`];
  const destructive = move !== 'approve';

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={r.cancel}
      title={title}
      description={description}
      footer={(dismissBlocked) => (
        <>
          <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
            {r.cancel}
          </ConsoleButton>
          <ConsoleButton
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending}
            className={move === 'revoke' ? 'bg-err hover:bg-err/90' : ''}
          >
            {pending ? (
              <>
                <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                {r.pending}
              </>
            ) : (
              confirm
            )}
          </ConsoleButton>
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="applicationId" value={target.id} />
        {move === 'revoke' ? null : <input type="hidden" name="decision" value={move} />}

        {state?.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
          >
            <CircleXIcon size={15} className="mt-px shrink-0" />
            {r.errors[state.error as keyof typeof r.errors] ?? r.errors.unavailable}
          </p>
        ) : null}

        {move === 'approve' && !approvable ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-[8px] bg-ambersoft p-2.5 text-[11px] leading-[1.5] text-amberink"
          >
            <CircleXIcon size={15} className="mt-px shrink-0" />
            {r.ineligibleWarning}
          </p>
        ) : null}

        <div className="flex items-center gap-2.5 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2.5">
          <Monogram initial={target.initial} />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate text-[12px] font-medium tracking-[-0.023em] text-ink">
              {target.libraryTitle}
            </span>
            <span className="truncate text-[11px] tracking-[-0.023em] text-muted">
              {target.libraryPublicId} · {target.workspaceName}
            </span>
          </span>
        </div>

        <ul className="flex flex-col gap-1.5">
          {r.consequences[move].map((line) => (
            <li
              key={line}
              className="flex items-start gap-1.5 text-[11px] leading-[1.55] tracking-[-0.023em] text-steel"
            >
              <span aria-hidden className={`mt-px ${destructive ? 'text-err' : 'text-muted'}`}>
                •
              </span>
              {line}
            </li>
          ))}
        </ul>

        <ReasonField label={r.reason} placeholder={r.reasonPlaceholder[move]} ariaLabel={r.reason} />
        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{r.auditNote}</p>
      </form>
    </ConsoleDialog>
  );
}
