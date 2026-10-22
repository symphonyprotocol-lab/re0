import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ProviderSignInButton } from '@/components/site/provider-sign-in-button';
import { Wordmark } from '@/components/site/wordmark';
import {
  BookOpenCheckIcon,
  GitHubIcon,
  GoogleIcon,
  KeyIcon,
  LockKeyholeIcon,
  MessagesSquareIcon,
  ShieldCheckIcon,
  CircleXIcon,
} from '@/components/ui/icons';
import { isLoginError, safeReturnTo } from '@/lib/domain/auth';
import { optionalSession } from '@/lib/http/session';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { login } = await getMessages();
  return { title: login.metaTitle, description: login.metaDescription };
}

const PERK_ICONS = [MessagesSquareIcon, KeyIcon, BookOpenCheckIcon];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, t] = await Promise.all([searchParams, getMessages()]);
  const returnTo = safeReturnTo(params.returnTo);
  const l = t.login;

  /** Error copy comes from `lib/domain/auth` codes, which carry no provider detail. */
  const providers = [
    { id: 'github', ...l.providers.github, icon: <GitHubIcon size={18} className="text-ink" /> },
    { id: 'google', ...l.providers.google, icon: <GoogleIcon size={18} /> },
  ];

  // Already signed in: go straight where the visitor was headed.
  const session = await optionalSession();
  if (session) redirect(returnTo);

  const error = isLoginError(params.error) ? params.error : null;

  return (
    <section className="flex flex-1 items-center justify-center">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center gap-5 px-5 py-[66px]">
        <div className="w-full max-w-[430px] rounded-lg bg-card/85 pt-9 shadow-md backdrop-blur-sm">
          <div className="flex justify-center px-[30px]">
            <Wordmark />
          </div>

          <div className="mt-[23px] flex flex-col gap-[9px] px-[30px]">
            <h1 className="text-center text-[28px] leading-[1.5] font-medium text-ink">
              {l.title}
            </h1>
            <p className="mx-auto max-w-[310px] text-center text-[11px] leading-[1.65] text-muted">
              {l.subtitle}
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-4 mx-[30px] flex items-start gap-2 rounded-md bg-warnsoft p-2.5 text-[9px] leading-[1.5] text-warn"
            >
              <CircleXIcon size={15} className="mt-px" />
              {l.errors[error]}
            </p>
          ) : null}

          <div className="mt-[27px] flex flex-col gap-[9px] px-[30px]">
            {providers.map((p) => (
              <form key={p.id} method="post" action={`/api/auth/${p.id}/start`}>
                <input type="hidden" name="returnTo" value={returnTo} />
                <ProviderSignInButton icon={p.icon} name={p.name} hint={p.hint} />
              </form>
            ))}
          </div>

          <div className="mt-5 px-[30px]">
            <p className="flex items-start gap-2 rounded-md bg-mutedbg p-2.5 text-[9px] leading-[1.5] text-muted">
              <ShieldCheckIcon size={15} className="mt-px text-brandink" />
              {l.passwordNote}
            </p>
          </div>

          <p className="mt-4 px-[30px] text-center text-[8px] leading-[1.5] text-muted">
            {l.termsLead}
            <Link href="/legal" className="mx-0.5 text-brandink hover:underline">
              {l.termsLink}
            </Link>
            {l.termsTail}
          </p>

          <p className="mt-[22px] flex items-center justify-center gap-1.5 border-t border-line pt-[18px] pb-4 text-[9px] leading-[1.5] text-muted">
            <LockKeyholeIcon size={13} className="text-brandink" />
            {l.autoCreate}
          </p>
        </div>

        <ul className="flex flex-wrap items-center justify-center gap-x-[18px] gap-y-2">
          {l.perks.map((label, index) => {
            const PerkIcon = PERK_ICONS[index] ?? KeyIcon;
            return (
              <li
                key={label}
                className="flex items-center gap-[5px] text-[9px] leading-[1.5] text-muted"
              >
                <PerkIcon size={14} className="text-brandink" />
                {label}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
