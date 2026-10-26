import Link from 'next/link';
import { ProviderSignInButton } from '@/components/site/provider-sign-in-button';
import { Wordmark } from '@/components/site/wordmark';
import {
  CircleXIcon,
  GitHubIcon,
  GoogleIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import type { LoginError } from '@/lib/domain/auth';
import type { Dictionary } from '@/lib/i18n/dictionary';

/**
 * The sign-in card: the provider choices and the notes around them.
 *
 * Shared by the login page and the playground's sign-in dialog, so the two
 * cannot drift into different promises about what signing in does. No
 * directive and no server-only imports, so either side of the boundary can
 * render it. Each provider is a plain form POST to its start route, which
 * checks the Origin and carries `returnTo` through the OAuth handshake.
 */
export function SignInCard({
  copy,
  returnTo,
  error = null,
  title = copy.title,
  subtitle = copy.subtitle,
  titleAs: Title = 'h1',
  titleId,
}: {
  copy: Dictionary['login'];
  returnTo: string;
  /** Error copy comes from `lib/domain/auth` codes, which carry no provider detail. */
  error?: LoginError | null;
  title?: string;
  subtitle?: string;
  /** `h2` inside a dialog, whose page already has its own h1. */
  titleAs?: 'h1' | 'h2';
  /** For a dialog's `aria-labelledby`. */
  titleId?: string;
}) {
  const providers = [
    { id: 'github', ...copy.providers.github, icon: <GitHubIcon size={18} className="text-ink" /> },
    { id: 'google', ...copy.providers.google, icon: <GoogleIcon size={18} /> },
  ];

  return (
    <div className="w-full max-w-[430px] rounded-lg bg-card/85 pt-9 shadow-md backdrop-blur-sm">
      <div className="flex justify-center px-[30px]">
        <Wordmark />
      </div>

      <div className="mt-[23px] flex flex-col gap-[9px] px-[30px]">
        <Title id={titleId} className="text-center text-[28px] leading-[1.5] font-medium text-ink">
          {title}
        </Title>
        <p className="mx-auto max-w-[310px] text-center text-[11px] leading-[1.65] text-muted">
          {subtitle}
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 mx-[30px] flex items-start gap-2 rounded-md bg-warnsoft p-2.5 text-[9px] leading-[1.5] text-warn"
        >
          <CircleXIcon size={15} className="mt-px" />
          {copy.errors[error]}
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
          {copy.passwordNote}
        </p>
      </div>

      <p className="mt-4 px-[30px] text-center text-[8px] leading-[1.5] text-muted">
        {copy.termsLead}
        <Link href="/legal" className="mx-0.5 text-brandink hover:underline">
          {copy.termsLink}
        </Link>
        {copy.termsTail}
      </p>

      <p className="mt-[22px] flex items-center justify-center gap-1.5 border-t border-line pt-[18px] pb-4 text-[9px] leading-[1.5] text-muted">
        <LockKeyholeIcon size={13} className="text-brandink" />
        {copy.autoCreate}
      </p>
    </div>
  );
}
