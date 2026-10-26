'use client';

import Link from 'next/link';
import { useActionState, type ReactNode } from 'react';
import { ArrowRightIcon, CircleCheckIcon, CircleXIcon, SpinnerIcon } from '@/components/ui/icons';
import { completeEnrolmentAction, type EnrolResult } from '@/app/admin/enroll/actions';

export interface EnrolCopy {
  secretLabel: string;
  secretHelp: string;
  qrAlt: string;
  secretManual: string;
  passwordLabel: string;
  passwordHelp: string;
  confirmLabel: string;
  mfaLabel: string;
  mfaHelp: string;
  submit: string;
  pending: string;
  done: string;
  backToSignIn: string;
  errors: Record<string, string>;
}

/**
 * Password and second-factor enrolment for an invited administrator.
 *
 * The code has to be entered before the account goes active, which is what
 * makes the second factor mandatory rather than encouraged: there is no path to
 * `active` that skips it (requirement.md 3.2).
 *
 * Copy arrives as props -- enrolment renders outside `LocaleProvider`, before
 * there is a session to build the console shell around.
 */
export function EnrolmentForm({
  token,
  secret,
  ticket,
  provisioningUri,
  qrSvg,
  copy,
}: {
  token: string;
  secret: string;
  /** The sealed secret, posted back so the server binds exactly the one shown. */
  ticket: string;
  provisioningUri: string;
  /** Inline SVG built on the server from `provisioningUri`; null if it failed. */
  qrSvg: string | null;
  copy: EnrolCopy;
}) {
  const [state, submit, pending] = useActionState<EnrolResult | null, FormData>(
    completeEnrolmentAction,
    null,
  );

  if (state?.ok) {
    return (
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-[8px] bg-pubsoft p-3 text-[12px] leading-[1.6] text-pubink">
          <CircleCheckIcon size={15} className="mt-px shrink-0" />
          {copy.done}
        </p>
        <Link
          href="/admin/login"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] bg-brand text-[11px] font-bold text-white transition-colors hover:bg-brand/90"
        >
          {copy.backToSignIn}
          <ArrowRightIcon size={15} />
        </Link>
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="ticket" value={ticket} />

      <div className="rounded-[8px] border-2 border-line bg-subtle p-3.5">
        <p className="text-[11px] font-semibold tracking-[-0.023em] text-steel">
          {copy.secretLabel}
        </p>
        <p className="mt-1 text-[10px] leading-[1.6] text-muted">{copy.secretHelp}</p>

        {qrSvg ? (
          <div className="mt-3 flex justify-center">
            {/*
              The markup is generated on the server from `provisioningUri` by the
              QR encoder, never from anything a request supplies.
            */}
            <span
              role="img"
              aria-label={copy.qrAlt}
              className="block w-[160px] rounded-[6px] bg-card p-2.5 [&>svg]:h-auto [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          </div>
        ) : null}

        <p className="mt-3 text-[10px] font-semibold tracking-[-0.023em] text-steel">
          {copy.secretManual}
        </p>
        <code className="mt-1 block font-mono text-[13px] break-all text-ink">{secret}</code>
        <a
          href={provisioningUri}
          className="mt-2 inline-block font-mono text-[10px] break-all text-brandink hover:underline"
        >
          {provisioningUri}
        </a>
      </div>

      {state?.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] text-err"
        >
          <CircleXIcon size={15} className="mt-px shrink-0" />
          {copy.errors[state.error] ?? copy.errors.invalid_input}
        </p>
      ) : null}

      <Field label={copy.passwordLabel} help={copy.passwordHelp}>
        <input
          name="password"
          type="password"
          required
          minLength={12}
          maxLength={256}
          autoComplete="new-password"
          className={FIELD}
        />
      </Field>
      <Field label={copy.confirmLabel}>
        <input
          name="confirm"
          type="password"
          required
          minLength={12}
          maxLength={256}
          autoComplete="new-password"
          className={FIELD}
        />
      </Field>
      <Field label={copy.mfaLabel} help={copy.mfaHelp}>
        <input
          name="mfa"
          type="text"
          required
          inputMode="numeric"
          maxLength={6}
          pattern="[0-9]{6}"
          autoComplete="one-time-code"
          className={FIELD}
        />
      </Field>

      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-brand text-[11px] font-bold tracking-[-0.023em] text-white transition-colors hover:bg-brand/90 disabled:cursor-progress disabled:bg-brand/70"
      >
        {pending ? (
          <>
            <SpinnerIcon size={15} className="motion-safe:animate-spin" />
            {copy.pending}
          </>
        ) : (
          <>
            {copy.submit}
            <ArrowRightIcon size={15} />
          </>
        )}
      </button>
    </form>
  );
}

const FIELD =
  'h-11 w-full rounded-[8px] border-2 border-line bg-card px-3.5 text-[12px] tracking-[-0.023em] text-ink focus:border-brand focus:outline-none';

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-[-0.023em] text-steel">{label}</span>
      {children}
      {help ? <span className="text-[10px] leading-[1.5] text-muted">{help}</span> : null}
    </label>
  );
}
