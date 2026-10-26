import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BootstrapForm } from '@/components/admin/bootstrap-form';
import { AdminSignInButton } from '@/components/admin/sign-in-button';
import {
  AtSignIcon,
  CircleCheckIcon,
  CircleXIcon,
  HashIcon,
  LockKeyholeIcon,
  Re0Mark,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import { offerBootstrap, qrCodeSvg } from '@/lib/application/administration';
import { isAdminLoginError, safeAdminReturnTo } from '@/lib/domain/admin';
import { currentAdminSession } from '@/lib/http/admin';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.login.metaTitle };
}

/**
 * Administrator sign-in -- design source frame `pXVMU`.
 *
 * Unlike the console frames, the sign-in frames are drawn at implementation
 * scale, so the type here is taken from the source 1:1 (43px headline, 12px
 * card subtitle, 9px audit note) rather than through the console's ladder --
 * the same way `app/(public)/login` follows frame `t4czM9`.
 *
 * Deliberately not the product login: a separate entrance, separate
 * credentials and a mandatory second factor (requirement.md 3.2). All three
 * fields post together, so a single generic error covers all of them -- a
 * separate "wrong code" reply would confirm the password was right.
 *
 * On an installation with no administrator at all there is nothing to sign in
 * as, so the card becomes a registration form for the first one and stays that
 * way until it succeeds. The page is not the guard -- `offerBootstrap` reads
 * the table on every render and the action re-reads it inside its own
 * transaction -- it only decides which form to draw.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, t] = await Promise.all([searchParams, getMessages()]);
  const l = t.admin.login;
  const returnTo = safeAdminReturnTo(params.returnTo);
  const error = isAdminLoginError(params.error) ? params.error : null;

  // Already signed in: go straight where the administrator was headed.
  if (await currentAdminSession()) redirect(returnTo);

  const bootstrap = await offerBootstrap();
  /*
   * Generated from the same `otpauth://` string the form prints, so the code
   * and the typed fallback can never disagree.
   */
  const bootstrapQr = bootstrap ? await qrCodeSvg(bootstrap.provisioningUri) : null;

  const fields = [
    {
      id: 'email',
      label: l.emailLabel,
      placeholder: l.emailPlaceholder,
      type: 'email',
      Icon: AtSignIcon,
      autoComplete: 'username',
      inputMode: undefined,
    },
    {
      id: 'password',
      label: l.passwordLabel,
      placeholder: l.passwordPlaceholder,
      type: 'password',
      Icon: LockKeyholeIcon,
      autoComplete: 'current-password',
      inputMode: undefined,
    },
    {
      id: 'mfa',
      label: l.mfaLabel,
      placeholder: l.mfaPlaceholder,
      type: 'text',
      Icon: HashIcon,
      autoComplete: 'one-time-code',
      inputMode: 'numeric' as const,
    },
  ];

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[minmax(0,44%)_minmax(0,56%)]">
      <section className="console-signin-wash relative isolate flex flex-col justify-between gap-16 overflow-hidden px-8 py-[42px] md:px-14">
        <span
          aria-hidden
          className="pointer-events-none absolute top-[140px] left-[262px] -z-10 size-[440px] rounded-full border-2 border-[#82e3d1]/13"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-[245px] left-[304px] -z-10 size-[230px] rounded-full border-2 border-[#82e3d1]/13"
        />

        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-[26px] items-center justify-center rounded-md bg-white/10 text-mint"
          >
            <Re0Mark size={24} />
          </span>
          <span className="text-[17px] leading-[1.5] font-bold tracking-[-0.019em] text-white">
            re0
          </span>
        </Link>

        <div className="flex max-w-[310px] flex-col">
          <p className="flex items-center gap-2 text-[12px] leading-[1.5] font-bold tracking-[0.08em] text-[#83ead6]">
            <ShieldCheckIcon size={19} />
            {l.eyebrow}
          </p>
          <h1 className="mt-6 text-[43px] leading-[1.07] tracking-[-0.058em] text-white">
            {l.headline}
          </h1>
          <p className="mt-[17px] text-[14px] leading-[1.79] tracking-[-0.023em] text-[#b7cacd]">
            {l.subhead}
          </p>
          <ul className="mt-8 flex flex-col gap-[13px]">
            {l.perks.map((perk) => (
              <li
                key={perk}
                className="flex items-center gap-2.5 text-[12px] leading-[1.5] tracking-[-0.023em] text-[#d7e7e8]"
              >
                <CircleCheckIcon size={15} className="shrink-0 text-[#54dac0]" />
                {perk}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[10px] leading-[1.5] tracking-[-0.023em] text-[#819a9e]">
          {l.copyright}
        </p>
      </section>

      <section className="flex items-center justify-center bg-subtle px-6 py-14">
        {bootstrap ? (
          <div className="w-full max-w-[410px] rounded-[18px] border-2 border-line bg-card p-11 shadow-[0_24px_60px_rgba(29,67,73,0.08)]">
            <span
              aria-hidden
              className="flex size-[46px] items-center justify-center rounded-[12px] bg-pubsoft text-pubink"
            >
              <ShieldCheckIcon size={20} />
            </span>

            <h2 className="mt-[23px] text-[25px] leading-[1.5] tracking-[-0.028em] text-ink">
              {t.admin.bootstrap.title}
            </h2>
            <p className="mt-[6.5px] text-[12px] leading-[1.5] tracking-[-0.023em] text-muted">
              {t.admin.bootstrap.subtitle}
            </p>

            <BootstrapForm
              secret={bootstrap.secret}
              ticket={bootstrap.ticket}
              provisioningUri={bootstrap.provisioningUri}
              qrSvg={bootstrapQr}
              copy={{
                ...t.admin.bootstrap,
                errors: {
                  ...t.admin.administrators.errors,
                  mismatch: t.admin.bootstrap.mismatch,
                },
              }}
            />
          </div>
        ) : (
          <form
            method="post"
            action="/api/admin/auth/login"
            className="w-full max-w-[410px] rounded-[18px] border-2 border-line bg-card p-11 shadow-[0_24px_60px_rgba(29,67,73,0.08)]"
          >
            <input type="hidden" name="returnTo" value={returnTo} />

            <span
              aria-hidden
              className="flex size-[46px] items-center justify-center rounded-[12px] bg-pubsoft text-pubink"
            >
              <LockKeyholeIcon size={20} />
            </span>

            <h2 className="mt-[23px] text-[25px] leading-[1.5] tracking-[-0.028em] text-ink">
              {l.title}
            </h2>
            <p className="mt-[6.5px] text-[12px] leading-[1.5] tracking-[-0.023em] text-muted">
              {l.subtitle}
            </p>

            {error ? (
              <p
                role="alert"
                className="mt-[17px] flex items-start gap-2 rounded-[8px] bg-errsoft p-2.5 text-[11px] leading-[1.5] tracking-[-0.023em] text-err"
              >
                <CircleXIcon size={15} className="mt-px shrink-0" />
                {l.errors[error]}
              </p>
            ) : null}

            <div className="mt-[27px] flex flex-col gap-[17px]">
              {fields.map(({ id, label, placeholder, type, Icon, autoComplete, inputMode }) => (
                <label key={id} htmlFor={`admin-${id}`} className="flex flex-col gap-1.5">
                  <span className="text-[11px] leading-[1.55] font-semibold tracking-[-0.023em] text-steel">
                    {label}
                  </span>
                  <span className="flex h-11 items-center gap-2.5 rounded-[8px] border-2 border-line px-3.5 focus-within:border-brand">
                    <Icon size={15} className="shrink-0 text-muted" />
                    <input
                      id={`admin-${id}`}
                      name={id}
                      type={type}
                      placeholder={placeholder}
                      required
                      autoComplete={autoComplete}
                      {...(inputMode ? { inputMode, maxLength: 6, pattern: '[0-9]{6}' } : {})}
                      className="min-w-0 flex-1 bg-transparent text-[12px] tracking-[-0.023em] text-ink placeholder:text-faint focus:outline-none"
                    />
                  </span>
                </label>
              ))}
            </div>

            <div className="mt-[17px] flex items-center justify-between">
              <span className="text-[10px] leading-[1.5] tracking-[-0.023em] text-muted">
                {l.sessionNote}
              </span>
              <Link
                href="/contact"
                className="text-[10px] leading-[1.5] font-semibold tracking-[-0.023em] text-brandink hover:underline"
              >
                {l.trouble}
              </Link>
            </div>

            <AdminSignInButton label={l.submit} pendingLabel={l.submitPending} />

            <p className="mt-[18px] flex items-center justify-center gap-1.5 text-[9px] leading-[1.55] tracking-[-0.023em] text-faint">
              <ShieldCheckIcon size={14} className="text-brand" />
              {l.auditNote}
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
