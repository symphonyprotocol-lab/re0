'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { ConsoleButton, IconButton, Monogram } from '@/components/admin/ui';
import { ReasonField, submitOn } from '@/components/admin/platform-asset-shared';
import { BanIcon, CircleXIcon, ScaleIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import type { ClaimAdminActionResult } from '@/app/admin/(console)/claims/actions';

export type ClaimAdminAction = (
  previous: ClaimAdminActionResult | null,
  form: FormData,
) => Promise<ClaimAdminActionResult>;

/** Which claim a dialog is about, so the confirmation is checkable. */
export interface ClaimTarget {
  id: string;
  assetTitle: string;
  assetPublicId: string;
  claimantName: string;
  initial: string;
}

/** The three moves, named the way `ruleDispute` and `revokeClaim` name them. */
export type ClaimMove = 'grant' | 'dismiss' | 'revoke';

/**
 * Ownership controls -- requirement.md 5.3, 7.3.5.
 *
 * All three are confirmations with a required reason, like every other console
 * mutation. Two of them are also the only writes in the product that move
 * `asset.owner_workspace_id` without a source check, so the dialog spells
 * out the consequence in the claimant's and the owner's terms before the
 * operator commits to it.
 *
 * What is offered comes from the claim's own state rather than a prop the
 * caller has to keep in step: a dispute can be ruled on, anything revocable
 * can be revoked, and a claim that is neither gets no controls at all.
 */
export function ClaimControls({
  target,
  status,
  disputed,
  ruleAction,
  revokeAction,
  variant = 'icon',
}: {
  target: ClaimTarget;
  status: string;
  disputed: boolean;
  ruleAction: ClaimAdminAction;
  revokeAction: ClaimAdminAction;
  variant?: 'icon' | 'button';
}) {
  const { t } = useI18n();
  const d = t.admin.claimDetail;
  const [move, setMove] = useState<ClaimMove | null>(null);
  const [attempt, setAttempt] = useState(0);

  /*
   * `nextClaimStatus` is the authority; this mirrors the two rules it encodes
   * that decide whether a control is worth drawing. A pending claim on an
   * unowned asset is the claimant's to prove and cannot be ruled on
   * (`ruleDispute` refuses it as "not a dispute"), and only pending, verified
   * and failed claims can be revoked.
   */
  const canRule = status === 'pending' && disputed;
  const canRevoke = status === 'pending' || status === 'verified' || status === 'failed';
  if (!canRule && !canRevoke) return null;

  const open = (next: ClaimMove) => () => setMove(next);
  const action = move === 'revoke' ? revokeAction : ruleAction;

  return (
    <>
      {variant === 'icon' ? (
        <>
          {canRule ? (
            <IconButton label={d.actions.grant} onClick={open('grant')}>
              <ScaleIcon size={14} />
            </IconButton>
          ) : null}
          {canRevoke ? (
            <IconButton label={d.actions.revoke} onClick={open('revoke')}>
              <BanIcon size={14} />
            </IconButton>
          ) : null}
        </>
      ) : (
        <>
          {canRule ? (
            <>
              <ConsoleButton variant="primary" onClick={open('grant')}>
                <ScaleIcon size={14} />
                {d.actions.grant}
              </ConsoleButton>
              <ConsoleButton onClick={open('dismiss')}>{d.actions.dismiss}</ConsoleButton>
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
        <ClaimDialog
          key={`${move}-${attempt}`}
          move={move}
          action={action}
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

function ClaimDialog({
  move,
  action,
  target,
  onClose,
}: {
  move: ClaimMove;
  action: ClaimAdminAction;
  target: ClaimTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.admin.claimDetail;
  const r = d.dialog;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();

  /*
   * Closes on success rather than reporting inside itself: the page behind
   * has been revalidated and the new status is what the operator wants to
   * read. It also stops the submit staying live over a change that already
   * happened -- a second click would be refused as `invalid_input` and read
   * as if the first had failed.
   */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  const title =
    move === 'grant' ? r.grantTitle : move === 'dismiss' ? r.dismissTitle : r.revokeTitle;
  const description =
    move === 'grant'
      ? r.grantDescription
      : move === 'dismiss'
        ? r.dismissDescription
        : r.revokeDescription;
  const confirm =
    move === 'grant' ? r.confirmGrant : move === 'dismiss' ? r.confirmDismiss : r.confirmRevoke;
  const destructive = move !== 'dismiss';

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
        <input type="hidden" name="claimId" value={target.id} />
        {move === 'revoke' ? null : <input type="hidden" name="decision" value={move} />}

        {state?.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
          >
            <CircleXIcon size={15} className="mt-px shrink-0" />
            {state.error === 'unavailable'
              ? t.admin.platformAssets.errors.unavailable
              : r.errors[state.error]}
          </p>
        ) : null}

        <div className="flex items-center gap-2.5 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2.5">
          <Monogram initial={target.initial} />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate text-[12px] font-medium tracking-[-0.023em] text-ink">
              {target.assetTitle}
            </span>
            <span className="truncate text-[11px] tracking-[-0.023em] text-muted">
              {target.assetPublicId} · {target.claimantName}
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

        <ReasonField label={r.reason} placeholder={r.reasonPlaceholder} ariaLabel={r.reason} />
        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{r.auditNote}</p>
      </form>
    </ConsoleDialog>
  );
}
