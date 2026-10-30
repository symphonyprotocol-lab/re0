'use client';

import { useActionState, useId, useState } from 'react';
import { ConsoleDialog } from '@/components/admin/console-dialog';
import { submitOn } from '@/components/admin/platform-library-shared';
import { CircleCheckIcon, CircleXIcon, SpinnerIcon, TrashIcon } from '@/components/ui/icons';
import type { DeleteLibraryActionResult } from '@/app/dashboard/assets/actions';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

export type DeleteLibraryAction = (
  previous: DeleteLibraryActionResult | null,
  form: FormData,
) => Promise<DeleteLibraryActionResult>;

export interface DeleteLibraryTarget {
  id: string;
  publicId: string;
  title: string;
  initial: string;
  color: string;
}

/**
 * Delete one of the workspace's libraries. requirement.md 5.2: deletion is an
 * owner-side operation that must report a definite result.
 *
 * Irreversible, so the confirmation asks for the library id to be typed rather
 * than clicked through: the dialog holds one library's name, and a name is
 * what a tired reader skims. The dialog also says what happens in the order it
 * happens -- unreachable now, cleaned up afterwards -- and reports the outcome
 * inside itself instead of closing, so the user reads "deleted" rather than
 * inferring it from a row that vanished.
 *
 * Rendered outside the row's link on purpose: the native `<dialog>` is still a
 * DOM descendant of whatever contains it, and a click inside a dialog that
 * sits inside a link is a navigation.
 */
export function DeleteLibraryControl({
  action,
  target,
  variant = 'icon',
  onDeleted,
}: {
  action: DeleteLibraryAction;
  target: DeleteLibraryTarget;
  /** `icon` beside a list row; `button` with its label, for the detail page's toolbar. */
  variant?: 'icon' | 'button';
  /** Called when the dialog closes after a successful delete -- the detail page leaves. */
  onDeleted?: () => void;
}) {
  const { t } = useI18n();
  const label = t.dashboard.libraries.delete;
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={() => setOpen(true)}
          className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md border border-line bg-card text-muted transition-colors hover:bg-subtle hover:text-rose"
        >
          <TrashIcon size={14} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-[35px] items-center gap-1.5 rounded-md border border-line bg-card px-3 text-[12px] font-medium text-ink transition-colors hover:bg-subtle hover:text-rose"
        >
          <TrashIcon size={14} />
          {label}
        </button>
      )}

      {open ? (
        <DeleteDialog
          key={attempt}
          action={action}
          target={target}
          onClose={(deleted) => {
            setOpen(false);
            setAttempt((value) => value + 1);
            if (deleted) onDeleted?.();
          }}
        />
      ) : null}
    </>
  );
}

const BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-[12px] font-medium transition-colors disabled:opacity-60';

function DeleteDialog({
  action,
  target,
  onClose,
}: {
  action: DeleteLibraryAction;
  target: DeleteLibraryTarget;
  onClose: (deleted: boolean) => void;
}) {
  const { t } = useI18n();
  const r = t.dashboard.libraries.deleteDialog;
  const [state, submit, pending] = useActionState(action, null);
  const [typed, setTyped] = useState('');
  const formId = useId();
  const done = state?.ok === true;
  const confirmed = typed.trim() === target.publicId;

  return (
    <ConsoleDialog
      onClose={() => onClose(done)}
      busy={pending}
      closeLabel={r.close}
      title={r.title}
      description={done ? undefined : r.description}
      footer={(dismissBlocked) =>
        done ? (
          <button
            type="button"
            onClick={() => onClose(true)}
            className={`${BUTTON} border border-line bg-card text-ink hover:bg-subtle`}
          >
            {r.close}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onClose(false)}
              disabled={dismissBlocked}
              className={`${BUTTON} border border-line bg-card text-ink hover:bg-subtle`}
            >
              {r.cancel}
            </button>
            <button
              type="submit"
              form={formId}
              disabled={pending || !confirmed}
              className={`${BUTTON} bg-rose text-white hover:bg-rose/90`}
            >
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {r.pending}
                </>
              ) : (
                r.submit
              )}
            </button>
          </>
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 text-[12px] leading-[1.6] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {fill(r.done, { publicId: state?.publicId ?? target.publicId })}
        </p>
      ) : (
        <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-3">
          <input type="hidden" name="libraryId" value={target.id} />

          {state?.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
            >
              <CircleXIcon size={15} className="mt-px shrink-0" />
              {r.errors[state.error]}
            </p>
          ) : null}

          <div className="flex items-center gap-2.5 rounded-md border border-line bg-subtle px-2.5 py-2.5">
            <span
              aria-hidden
              className="flex size-[30px] shrink-0 items-center justify-center rounded-lg text-[12px] font-medium text-white"
              style={{ backgroundColor: target.color }}
            >
              {target.initial}
            </span>
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="truncate text-[12px] font-medium text-ink">
                {target.title}
              </span>
              <span className="truncate text-[11px] text-muted">
                {target.publicId}
              </span>
            </span>
          </div>

          <ul className="flex flex-col gap-1.5">
            {r.consequences.map((line) => (
              <li
                key={line}
                className="flex items-start gap-1.5 text-[11px] leading-[1.55] text-steel"
              >
                <span aria-hidden className="mt-px text-rose">
                  •
                </span>
                {line}
              </li>
            ))}
          </ul>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-steel">
              {r.confirmLabel}
            </span>
            <input
              name="confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              data-dialog-autofocus
              autoComplete="off"
              spellCheck={false}
              placeholder={target.publicId}
              aria-label={r.confirmLabel}
              className="h-9 w-full rounded-md border border-line bg-card px-2.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-rose focus:outline-none"
            />
            <span className="text-[11px] leading-[1.45] text-faint">
              {fill(r.confirmHint, { publicId: target.publicId })}
            </span>
          </label>
        </form>
      )}
    </ConsoleDialog>
  );
}
