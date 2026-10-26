import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignInCard } from '@/components/site/sign-in-card';
import { BookOpenCheckIcon, KeyIcon, MessagesSquareIcon } from '@/components/ui/icons';
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

  // Already signed in: go straight where the visitor was headed.
  const session = await optionalSession();
  if (session) redirect(returnTo);

  const error = isLoginError(params.error) ? params.error : null;

  return (
    <section className="flex flex-1 items-center justify-center">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center gap-5 px-5 py-[66px]">
        <SignInCard copy={l} returnTo={returnTo} error={error} />

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
