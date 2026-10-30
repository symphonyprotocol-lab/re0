'use client';

import { useActionState, useId, useState, type ReactNode } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { ConsoleButton } from '@/components/admin/ui';
import { CopyButton } from '@/components/dashboard/copy-button';
import { CircleCheckIcon, CircleXIcon, PlusIcon, SpinnerIcon } from '@/components/ui/icons';
import type { AdminRoleId } from '@/lib/domain/admin';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import type { ActionResult } from '@/app/admin/(console)/administrators/actions';

interface InviteProps {
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  inviteTtlDays: number;
  roles: { id: AdminRoleId; label: string }[];
}

/**
 * "Add administrator" -- design source frame `BWeHH`.
 *
 * The console never sets someone else's password: an invitation creates the
 * account and hands back a one-time enrolment link, and the invitee chooses
 * their own credential and binds their own second factor. That is also what
 * makes MFA enforceable -- the account cannot reach `active` without one.
 */
export function InviteAdministrator(props: InviteProps) {
  const { t } = useI18n();
  const a = t.admin.administrators;
  const [open, setOpen] = useState(false);
  /*
   * Closing bumps the key so the dialog body is a new component next time it
   * opens. `useActionState` has no reset, so without this the previous
   * invitation's one-time link is what renders on reopen -- and a second
   * invitation becomes impossible without reloading the page.
   */
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      <ConsoleButton variant="primary" onClick={() => setOpen(true)}>
        <PlusIcon size={14} />
        {a.invite}
      </ConsoleButton>

      {open ? (
        <InviteDialog
          key={attempt}
          {...props}
          onClose={() => {
            setOpen(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function InviteDialog({
  action,
  inviteTtlDays,
  roles,
  onClose,
}: InviteProps & { onClose: () => void }) {
  const { t } = useI18n();
  const a = t.admin.administrators;
  const [state, submit, pending] = useActionState(action, null);
  const done = state?.ok && state.enrolmentPath ? state.enrolmentPath : null;
  // The submit lives in the dialog footer, outside the form, so the two are
  // joined by `form=` -- which needs an id no second dialog can collide with.
  const formId = useId();

  return (
    <ConsoleDialog
      onClose={onClose}
      busy={pending}
      closeLabel={a.close}
      title={a.inviteTitle}
      description={done ? undefined : a.inviteDescription}
      footer={(dismissBlocked) =>
        done ? (
          <ConsoleButton onClick={onClose}>{a.close}</ConsoleButton>
        ) : (
          <>
            {/* Follows the dialog's own guard rather than `pending`, so a
                request that never settles cannot leave this disabled forever. */}
            <ConsoleButton onClick={onClose} disabled={dismissBlocked}>
              {a.inviteCancel}
            </ConsoleButton>
            <ConsoleButton variant="primary" type="submit" form={formId} disabled={pending}>
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {a.invitePending}
                </>
              ) : (
                a.inviteSubmit
              )}
            </ConsoleButton>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-3">
          <p className="flex items-start gap-2 text-[12px] leading-[1.6] tracking-[-0.023em] text-pubink">
            <CircleCheckIcon size={15} className="mt-px shrink-0" />
            {fill(a.inviteDone, { days: inviteTtlDays })}
          </p>
          <div className="flex items-center gap-2 rounded-[8px] border-2 border-line bg-subtle px-2.5 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-steel">
              {enrolmentLink(done)}
            </code>
            <CopyButton value={enrolmentLink(done)} label={a.inviteCopy} />
          </div>
        </div>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          {state?.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
            >
              <CircleXIcon size={15} className="mt-px shrink-0" />
              {a.errors[state.error]}
            </p>
          ) : null}

          <Field label={a.inviteEmail}>
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              data-dialog-autofocus
              placeholder="name@example.com"
              className={FIELD}
            />
          </Field>
          <Field label={a.inviteUsername}>
            <input
              name="username"
              type="text"
              required
              maxLength={80}
              placeholder={a.inviteUsernamePlaceholder}
              className={FIELD}
            />
          </Field>
          <Field label={a.inviteRole}>
            <select name="role" defaultValue="support" className={FIELD}>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </Field>
        </form>
      )}
    </ConsoleDialog>
  );
}

const FIELD =
  'h-9 w-full rounded-[7px] border-2 border-line bg-card px-2.5 text-[12px] tracking-[-0.023em] text-ink placeholder:text-faint focus:border-brand focus:outline-none';

/** The link is only ever built in the browser, where the origin is known. */
function enrolmentLink(path: string): string {
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-[-0.023em] text-steel">{label}</span>
      {children}
    </label>
  );
}
