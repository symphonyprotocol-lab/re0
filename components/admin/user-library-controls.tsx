'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { ConsoleButton, IconButton } from '@/components/admin/ui';
import { BanIcon, CircleCheckIcon, CircleXIcon, PencilIcon, SpinnerIcon } from '@/components/ui/icons';
import type { LifecycleStatus, Visibility } from '@/lib/domain';
import { reviewActionAvailable, type UserReviewAction } from '@/lib/domain/library';
import {
  checklistRequired,
  REVIEW_CHECK_NOTE_MAX_LENGTH,
  REVIEW_CHECKS,
  REVIEW_VERDICTS,
  type ReviewCheck,
  type ReviewVerdict,
} from '@/lib/domain/review';
import { useI18n } from '@/lib/i18n/client';
import {
  Refusal,
  ReasonField,
  submitOn,
  TargetCard,
  type PlatformAction as Action,
  type PlatformLibraryTarget,
} from './platform-library-shared';

/**
 * The reviewer's verbs over one user library -- approve, request changes,
 * reject -- as row controls or page buttons. Which of them are drawn follows
 * the domain rule, so a private library shows only its pause and its lifting;
 * the use case re-checks the same rule, so the prop decides what is drawn,
 * not what is allowed.
 *
 * Each verb opens a confirmation with a required reason: requirement.md 7.4
 * writes every review action to the audit log, and the reason is also the
 * feedback the owner reads on their dashboard.
 */
export function UserReviewControls({
  action,
  target,
  current,
  visibility,
  canApprove,
  variant = 'icon',
}: {
  action: Action;
  target: PlatformLibraryTarget;
  current: LifecycleStatus;
  visibility: Visibility;
  /** Whether an indexed version exists. Approval without one is refused. */
  canApprove: boolean;
  variant?: 'icon' | 'button';
}) {
  const { t } = useI18n();
  const a = t.admin.libraries.actions;
  const [open, setOpen] = useState<UserReviewAction | null>(null);
  const [attempt, setAttempt] = useState(0);

  const verbs: { intent: UserReviewAction; label: string; icon: React.ReactNode; danger: boolean }[] =
    [];
  if (reviewActionAvailable(current, visibility, 'approve')) {
    verbs.push({
      intent: 'approve',
      label: current === 'suspended' ? a.restore : a.approve,
      icon: <CircleCheckIcon size={14} />,
      danger: false,
    });
  }
  if (reviewActionAvailable(current, visibility, 'request_changes')) {
    verbs.push({ intent: 'request_changes', label: a.requestChanges, icon: <PencilIcon size={14} />, danger: false });
  }
  if (reviewActionAvailable(current, visibility, 'reject')) {
    verbs.push({
      intent: 'reject',
      label: visibility === 'private' || current === 'published' ? a.suspend : a.reject,
      icon: <BanIcon size={14} />,
      danger: true,
    });
  }
  if (verbs.length === 0) return null;

  return (
    <>
      {verbs.map((verb) =>
        variant === 'icon' ? (
          <IconButton key={verb.intent} label={verb.label} onClick={() => setOpen(verb.intent)}>
            {verb.icon}
          </IconButton>
        ) : (
          <ConsoleButton
            key={verb.intent}
            variant={verb.danger ? 'outline' : 'primary'}
            className={verb.danger ? 'text-err hover:bg-errsoft' : ''}
            onClick={() => setOpen(verb.intent)}
          >
            {verb.icon}
            {verb.label}
          </ConsoleButton>
        ),
      )}

      {open ? (
        <ReviewDialog
          key={`${open}-${attempt}`}
          action={action}
          target={target}
          intent={open}
          current={current}
          visibility={visibility}
          canApprove={canApprove}
          onClose={() => {
            setOpen(null);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function ReviewDialog({
  action,
  target,
  intent,
  current,
  visibility,
  canApprove,
  onClose,
}: {
  action: Action;
  target: PlatformLibraryTarget;
  intent: UserReviewAction;
  current: LifecycleStatus;
  visibility: Visibility;
  canApprove: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.libraries.dialogs;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  /*
   * The 7.4 checklist, on a public library (lib/domain/review.ts). The
   * verdicts are tracked so the dialog can say, before the server does,
   * that an approval cannot carry a failed check and a send-back needs one.
   */
  const withChecklist = checklistRequired(visibility);
  const [verdicts, setVerdicts] = useState<Partial<Record<ReviewCheck, ReviewVerdict>>>({});
  const failing = REVIEW_CHECKS.filter((check) => verdicts[check] === 'fail').length;
  const answered = REVIEW_CHECKS.every((check) => verdicts[check] !== undefined);
  const mismatch = withChecklist && answered && (intent === 'approve' ? failing > 0 : failing === 0);
  const incomplete = withChecklist && !answered;

  /* The page behind the dialog is revalidated by the action; the new status
     in the list or header is what the operator wants to see. */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  const restoring = intent === 'approve' && current === 'suspended';
  const pausing = intent === 'reject' && (visibility === 'private' || current === 'published');
  const copy =
    intent === 'approve' ? d.approve : intent === 'request_changes' ? d.requestChanges : d.reject;
  const title =
    intent === 'approve' && restoring
      ? d.approve.restoreTitle
      : intent === 'reject' && pausing
        ? d.reject.suspendTitle
        : copy.title;
  const description =
    intent === 'approve' && restoring
      ? d.approve.restoreDescription
      : intent === 'reject' && pausing
        ? d.reject.suspendDescription
        : copy.description;
  const blocked = intent === 'approve' && !canApprove;

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={d.close}
      title={title}
      description={description}
      footer={(dismissBlocked) => (
        <>
          <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
            {blocked ? d.close : d.cancel}
          </ConsoleButton>
          {blocked ? null : (
            <ConsoleButton
              variant="primary"
              type="submit"
              form={formId}
              disabled={pending || mismatch || incomplete}
              className={intent === 'reject' ? 'bg-err hover:bg-err/90' : ''}
            >
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {copy.pending}
                </>
              ) : (
                copy.submit
              )}
            </ConsoleButton>
          )}
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="libraryId" value={target.id} />
        <input type="hidden" name="action" value={intent} />

        <Refusal state={state} />
        <TargetCard target={target} />

        {blocked ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[8px] bg-ambersoft p-2.5 text-[11px] leading-[1.55] text-amberink"
          >
            <CircleXIcon size={15} className="mt-px shrink-0" />
            {d.approve.blocked}
          </p>
        ) : (
          <>
            {intent === 'reject' ? (
              <ul className="flex flex-col gap-1.5">
                {d.reject.consequences.map((line) => (
                  <li
                    key={line}
                    className="flex items-start gap-1.5 text-[11px] leading-[1.55] tracking-[-0.023em] text-steel"
                  >
                    <span aria-hidden className="mt-px text-err">
                      •
                    </span>
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
            {withChecklist ? (
              <fieldset className="flex flex-col gap-2 rounded-[8px] border border-line p-3">
                <legend className="px-1 text-[11px] font-semibold tracking-[-0.023em] text-steel">{d.checklist.title}</legend>
                <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.checklist.hint}</p>
                {REVIEW_CHECKS.map((check) => (
                  <div key={check} className="flex flex-col gap-1.5 border-t border-line/70 pt-2">
                    <span className="text-[11.5px] font-medium tracking-[-0.023em] text-ink">{d.checklist.items[check]}</span>
                    <div className="flex flex-wrap items-center gap-3">
                      {REVIEW_VERDICTS.map((verdict) => (
                        <label key={verdict} className="flex items-center gap-1.5 text-[11.5px] tracking-[-0.023em] text-steel">
                          <input
                            type="radio"
                            name={`check.${check}`}
                            value={verdict}
                            required
                            checked={verdicts[check] === verdict}
                            onChange={() => setVerdicts((current) => ({ ...current, [check]: verdict }))}
                          />
                          {d.checklist.verdicts[verdict]}
                        </label>
                      ))}
                    </div>
                    <input
                      name={`note.${check}`}
                      maxLength={REVIEW_CHECK_NOTE_MAX_LENGTH}
                      placeholder={d.checklist.notePlaceholder}
                      aria-label={`${d.checklist.items[check]} ${d.checklist.noteLabel}`}
                      className="h-8 rounded-[6px] border border-line bg-card px-2.5 text-[11.5px] text-ink"
                    />
                  </div>
                ))}
                {mismatch ? (
                  <p role="alert" className="text-[11px] leading-[1.55] tracking-[-0.023em] text-err">
                    {intent === 'approve' ? d.checklist.approveNeedsNoFail : d.checklist.changesNeedFail}
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            <ReasonField label={copy.reason} placeholder={copy.reasonPlaceholder} ariaLabel={copy.reason} autoFocus={!withChecklist} />
            <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
          </>
        )}
      </form>
    </ConsoleDialog>
  );
}
