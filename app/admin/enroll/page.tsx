import type { Metadata } from 'next';
import Link from 'next/link';
import { EnrolmentForm } from '@/components/admin/enrolment-form';
import { CircleXIcon, LockKeyholeIcon, Re0Mark } from '@/components/ui/icons';
import { offerEnrolment, qrCodeSvg } from '@/lib/application/administration';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.enroll.metaTitle };
}

/** Nothing here may be cached: the secret is minted per render. */
export const dynamic = 'force-dynamic';

/**
 * Enrolment for an invited administrator -- the far end of the invitation the
 * administrators screen hands out.
 *
 * Reached without a session, on a single-use expiring token, which is why it
 * sits outside the console shell and outside the middleware gate. The TOTP
 * secret is generated on render and only stored once the invitee has proved
 * they can produce a code from it.
 */
export default async function AdminEnrolPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, t] = await Promise.all([searchParams, getMessages()]);
  const e = t.admin.enroll;
  const token = typeof params.token === 'string' ? params.token : '';

  const offer = token ? await offerEnrolment(token).catch(() => null) : null;
  /*
   * Generated from the same `otpauth://` string the page prints, so the code
   * and the typed fallback can never disagree.
   */
  const qr = offer ? await qrCodeSvg(offer.provisioningUri) : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-subtle px-6 py-14">
      <div className="w-full max-w-[440px] rounded-[18px] border-2 border-line bg-card p-11 shadow-[0_24px_60px_rgba(29,67,73,0.08)]">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-6 items-center justify-center rounded-md bg-brand text-white"
          >
            <Re0Mark size={24} />
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.03em] text-ink">re0</span>
        </Link>

        {offer ? (
          <>
            <span
              aria-hidden
              className="mt-7 flex size-[46px] items-center justify-center rounded-[12px] bg-pubsoft text-pubink"
            >
              <LockKeyholeIcon size={20} />
            </span>
            <h1 className="mt-[23px] text-[22px] leading-[1.4] font-[650] tracking-[-0.03em] text-ink">
              {e.title}
            </h1>
            <p className="mt-1.5 mb-6 text-[12px] leading-[1.6] tracking-[-0.023em] text-muted">
              {fill(e.subtitle, { email: offer.email })}
            </p>

            <EnrolmentForm
              token={token}
              secret={offer.secret}
              ticket={offer.ticket}
              provisioningUri={offer.provisioningUri}
              qrSvg={qr}
              copy={{
                secretLabel: e.secretLabel,
                secretHelp: e.secretHelp,
                qrAlt: e.qrAlt,
                secretManual: e.secretManual,
                passwordLabel: e.passwordLabel,
                passwordHelp: e.passwordHelp,
                confirmLabel: e.confirmLabel,
                mfaLabel: e.mfaLabel,
                mfaHelp: e.mfaHelp,
                submit: e.submit,
                pending: e.pending,
                done: e.done,
                backToSignIn: e.backToSignIn,
                errors: { ...t.admin.administrators.errors, mismatch: e.mismatch },
              }}
            />
          </>
        ) : (
          <>
            <span
              aria-hidden
              className="mt-7 flex size-[46px] items-center justify-center rounded-[12px] bg-errsoft text-err"
            >
              <CircleXIcon size={20} />
            </span>
            <h1 className="mt-[23px] text-[22px] leading-[1.4] font-[650] tracking-[-0.03em] text-ink">
              {e.invalidTitle}
            </h1>
            <p className="mt-1.5 text-[12px] leading-[1.6] tracking-[-0.023em] text-muted">
              {e.invalidBody}
            </p>
            <Link
              href="/admin/login"
              className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-[8px] border-2 border-line bg-card text-[11px] font-bold text-steel transition-colors hover:bg-subtle"
            >
              {e.backToSignIn}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
