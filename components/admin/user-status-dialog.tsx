'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { ConsoleButton, IconButton, Monogram } from '@/components/admin/ui';
import { BanIcon, CircleCheckIcon, CircleXIcon, SpinnerIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import type { UserActionResult } from '@/app/admin/(console)/users/actions';

export interface UserStatusTarget {
  id: string;
  displayName: string;
  email: string;
  initial: string;
  status: string;
  /** What the change covers, so the operator confirms against real numbers. */
  liveSessions: number;
  liveApiKeys: number;
  publishedAssets: number;
}

type Action = (previous: UserActionResult | null, form: FormData) => Promise<UserActionResult>;

/**
 * Enable or suspend one registered account -- design source frame `ijG4g`.
 *
 * requirement.md 5.3 puts a second confirmation and a recorded reason in front
 * of every high-risk action, which is why this is a modal with a required
 * field rather than a button that acts on the first click. The consequences
 * are counted from the account itself rather than described in the abstract:
 * "ends 3 sessions" is a decision an operator can check, "ends their sessions"
 * is not.
 */
export function UserStatusControl({
  action,
  target,
  variant = 'icon',
}: {
  action: Action;
  target: UserStatusTarget;
  variant?: 'icon' | 'button';
}) {
  const { t } = useI18n();
  const u = t.admin.users;
  const [open, setOpen] = useState(false);
  /*
   * Bumped on close so the dialog body is a fresh component next time it
   * opens: `useActionState` has no reset, and a previous refusal would
   * otherwise still be on screen over an untouched form.
   */
  const [attempt, setAttempt] = useState(0);

  const suspending = target.status === 'active';
  const label = suspending ? u.suspend : u.enable;

  return (
    <>
      {variant === 'icon' ? (
        <IconButton label={label} onClick={() => setOpen(true)}>
          {suspending ? <BanIcon size={14} /> : <CircleCheckIcon size={14} />}
        </IconButton>
      ) : (
        <ConsoleButton
          variant={suspending ? 'primary' : 'outline'}
          className={suspending ? 'bg-err hover:bg-err/90' : ''}
          onClick={() => setOpen(true)}
        >
          {suspending ? <BanIcon size={14} /> : <CircleCheckIcon size={14} />}
          {label}
        </ConsoleButton>
      )}

      {open ? (
        <StatusDialog
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

function StatusDialog({
  action,
  target,
  onClose,
}: {
  action: Action;
  target: UserStatusTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const u = t.admin.users;
  const [state, submit, pending] = useActionState(action, null);
  const suspending = target.status === 'active';
  // The submit sits in the dialog footer, outside the form, so the two are
  // joined by `form=` -- which needs an id no second dialog can collide with.
  const formId = useId();

  /*
   * A successful change is not something to celebrate inside the modal: the
   * list and the detail screen behind it have already been revalidated, and
   * the new status is what the operator wants to see.
   */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  /*
   * Two bullets, and the split between them is the point: the first is what
   * confirming does, the second is what the suspension covers but no running
   * code enforces yet. Stating both as effects would have the console promise
   * an operator that keys stopped answering when nothing checks them.
   */
  const consequences = suspending
    ? [
        fill(u.consequenceSessions, { count: target.liveSessions }),
        fill(u.consequenceCovered, {
          keys: target.liveApiKeys,
          assets: target.publishedAssets,
        }),
      ]
    : [];

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={u.cancel}
      title={suspending ? u.suspendTitle : u.enableTitle}
      description={suspending ? u.suspendDescription : u.enableDescription}
      footer={(dismissBlocked) => (
        <>
          <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
            {u.cancel}
          </ConsoleButton>
          <ConsoleButton
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending}
            className={suspending ? 'bg-err hover:bg-err/90' : ''}
          >
            {pending ? (
              <>
                <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                {u.pending}
              </>
            ) : suspending ? (
              u.confirmSuspend
            ) : (
              u.confirmEnable
            )}
          </ConsoleButton>
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="userId" value={target.id} />
        <input type="hidden" name="status" value={suspending ? 'suspended' : 'active'} />

        {state?.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
          >
            <CircleXIcon size={15} className="mt-px shrink-0" />
            {u.errors[state.error]}
          </p>
        ) : null}

        <div className="flex items-center gap-2.5 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2.5">
          <Monogram initial={target.initial} />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate text-[12px] font-medium tracking-[-0.023em] text-ink">
              {target.displayName}
            </span>
            <span className="truncate text-[11px] tracking-[-0.023em] text-muted">
              {target.email}
            </span>
          </span>
        </div>

        {consequences.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {consequences.map((line) => (
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

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold tracking-[-0.023em] text-steel">
            {suspending ? u.reasonSuspend : u.reasonEnable}
          </span>
          <input
            name="reason"
            required
            maxLength={200}
            data-dialog-autofocus
            placeholder={u.reasonPlaceholder}
            aria-label={u.reason}
            className="h-9 w-full rounded-[7px] border-2 border-line bg-card px-2.5 text-[12px] tracking-[-0.023em] text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />
        </label>

        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{u.auditNote}</p>
      </form>
    </ConsoleDialog>
  );
}
