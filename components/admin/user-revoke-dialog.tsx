'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { ConsoleButton, IconButton } from '@/components/admin/ui';
import { CircleXIcon, LogOutIcon, SpinnerIcon, TrashIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import type { UserRevokeActionResult } from '@/app/admin/(console)/users/actions';

type Action = (
  previous: UserRevokeActionResult | null,
  form: FormData,
) => Promise<UserRevokeActionResult>;

export interface RevokeTarget {
  /** The session or key id. */
  id: string;
  /** What the operator sees they are ending: a client, or a key name and prefix. */
  title: string;
  detail: string;
}

/**
 * One revocation on the user detail screen: a session or an API key.
 *
 * requirement.md 5.3 puts a second confirmation and a recorded reason in
 * front of every high-risk action. Ending a session is reversible by signing
 * in again; revoking a key is not, and the dialog says so before asking for
 * the reason.
 */
export function UserRevokeControl({
  kind,
  action,
  userId,
  target,
}: {
  kind: 'session' | 'key';
  action: Action;
  userId: string;
  target: RevokeTarget;
}) {
  const { t } = useI18n();
  const r = t.admin.userDetail.revoke;
  const [open, setOpen] = useState(false);
  /* Bumped on close so the next opening starts from an empty form. */
  const [attempt, setAttempt] = useState(0);
  const label = kind === 'session' ? r.session : r.key;

  return (
    <>
      <IconButton label={label} onClick={() => setOpen(true)}>
        {kind === 'session' ? <LogOutIcon size={14} /> : <TrashIcon size={14} />}
      </IconButton>

      {open ? (
        <RevokeDialog
          key={attempt}
          kind={kind}
          action={action}
          userId={userId}
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

function RevokeDialog({
  kind,
  action,
  userId,
  target,
  onClose,
}: {
  kind: 'session' | 'key';
  action: Action;
  userId: string;
  target: RevokeTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const r = t.admin.userDetail.revoke;
  const [state, submit, pending] = useActionState(action, null);
  const formId = useId();

  /* The row behind the dialog has been revalidated; the new state is the result. */
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={r.cancel}
      title={kind === 'session' ? r.sessionTitle : r.keyTitle}
      description={kind === 'session' ? r.sessionDescription : r.keyDescription}
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
            className="bg-err hover:bg-err/90"
          >
            {pending ? (
              <>
                <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                {r.pending}
              </>
            ) : kind === 'session' ? (
              r.confirmSession
            ) : (
              r.confirmKey
            )}
          </ConsoleButton>
        </>
      )}
    >
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="targetId" value={target.id} />

        {state?.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
          >
            <CircleXIcon size={15} className="mt-px shrink-0" />
            {r.errors[state.error]}
          </p>
        ) : null}

        <div className="flex min-w-0 flex-col gap-[3px] rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2.5">
          <span className="truncate text-[12px] font-medium tracking-[-0.023em] text-ink">
            {target.title}
          </span>
          <span className="truncate font-mono text-[11px] tracking-[-0.023em] text-muted">
            {target.detail}
          </span>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold tracking-[-0.023em] text-steel">{r.reason}</span>
          <input
            name="reason"
            required
            maxLength={200}
            data-dialog-autofocus
            placeholder={r.reasonPlaceholder}
            className="h-9 w-full rounded-[7px] border-2 border-line bg-card px-2.5 text-[12px] tracking-[-0.023em] text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />
        </label>

        <p className="text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{r.auditNote}</p>
      </form>
    </ConsoleDialog>
  );
}
