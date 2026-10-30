'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { ConsoleButton, IconButton } from '@/components/admin/ui';
import { BanIcon, CircleCheckIcon, CircleXIcon, SpinnerIcon } from '@/components/ui/icons';
import type { LifecycleStatus } from '@/lib/domain';
import { reviewActionAvailable, type UserReviewAction } from '@/lib/domain/asset';
import { useI18n } from '@/lib/i18n/client';
import {
  Refusal,
  ReasonField,
  submitOn,
  TargetCard,
  type PlatformAction as Action,
  type PlatformAssetTarget,
} from './platform-asset-shared';

/**
 * The platform's verbs over one user asset -- suspend, restore -- as row
 * controls or page buttons. Which of them are drawn follows the domain
 * rule; the use case re-checks the same rule, so the prop decides what is
 * drawn, not what is allowed. Public review before publication ended on
 * 2026-10-23; these are the compliance hand over content that is live.
 *
 * Each verb opens a confirmation with a required reason: requirement.md 7.4
 * writes every such action to the audit log, and the reason is also the
 * note the owner reads on their dashboard.
 */
export function UserReviewControls({
  action,
  target,
  current,
  visibility = 'private',
  canApprove,
  variant = 'icon',
}: {
  action: Action;
  target: PlatformAssetTarget;
  current: LifecycleStatus;
  /** Listed in a public channel or not; shown by the caller, not decisive here. */
  visibility?: 'public' | 'private';
  /** Whether an indexed version exists. A restoration without one is refused. */
  canApprove: boolean;
  variant?: 'icon' | 'button';
}) {
  const { t } = useI18n();
  const a = t.admin.assets.actions;
  const [open, setOpen] = useState<UserReviewAction | null>(null);
  const [attempt, setAttempt] = useState(0);

  const verbs: { intent: UserReviewAction; label: string; icon: React.ReactNode; danger: boolean }[] =
    [];
  if (reviewActionAvailable(current, 'approve')) {
    verbs.push({ intent: 'approve', label: a.restore, icon: <CircleCheckIcon size={14} />, danger: false });
  }
  if (reviewActionAvailable(current, 'reject')) {
    verbs.push({ intent: 'reject', label: a.suspend, icon: <BanIcon size={14} />, danger: true });
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
  canApprove,
  onClose,
}: {
  action: Action;
  target: PlatformAssetTarget;
  intent: UserReviewAction;
  current: LifecycleStatus;
  /** Listed in a public channel or not; shown by the caller, not decisive here. */
  visibility?: 'public' | 'private';
  canApprove: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.assets.dialogs;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();
  /* The page behind the dialog is revalidated by the action; the new status
     in the list or header is what the operator wants to see. */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  /* Every restoration lifts a suspension and every rejection is one: the dialog says so, whatever the visibility. */
  const copy = intent === 'approve' ? d.approve : d.reject;
  const title = intent === 'approve' ? d.approve.restoreTitle : d.reject.suspendTitle;
  const description = intent === 'approve' ? d.approve.restoreDescription : d.reject.suspendDescription;
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
              disabled={pending}
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
        <input type="hidden" name="assetId" value={target.id} />
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
            <ReasonField label={copy.reason} placeholder={copy.reasonPlaceholder} ariaLabel={copy.reason} autoFocus />
            <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{d.auditNote}</p>
          </>
        )}
      </form>
    </ConsoleDialog>
  );
}
