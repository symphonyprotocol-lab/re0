import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isLoginError, safeReturnTo } from '@/lib/domain/auth';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { LanguageToggle } from '@/components/ui/language-toggle';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.login.title };
}

/** `/login`: Google or GitHub, then back where the visitor was going (prototype `#/login`). */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (await currentUser()) redirect(returnTo);
  const { t } = await serverMessages();
  const error = isLoginError(params.error) ? t.login.errors[params.error] : null;
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-[#eef0ff] via-[#f5f3ff] to-[#e7f1ff] p-12 lg:flex">
        <span className="flex items-center gap-2 text-[17px] font-extrabold">
          <span className="inline-flex size-8 items-center justify-center rounded-lg bg-blue text-white">
            <Icon name="ree" className="size-5" />
          </span>
          {t.common.brand}
        </span>
        <div className="max-w-[460px]">
          <p className="eyebrow">{t.login.eyebrowLeft}</p>
          <h1 className="mt-5 text-[44px] leading-[1.15] font-extrabold tracking-tight">
            {t.login.headline1}
            <br />
            {t.login.headline2a}
            <em className="text-blue not-italic">{t.login.headline2b}</em>
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-muted">{t.login.lede}</p>
          <div className="card mt-10 flex items-center gap-3 p-4 shadow-sm">
            <span className="inline-flex size-11 items-center justify-center rounded-xl border border-[#e0eafa] bg-soft text-blue">
              <Icon name="ree" className="size-6" />
            </span>
            <div>
              <strong className="text-[13px]">{t.login.previewTitle}</strong>
              <p className="text-[12px] text-muted">{t.login.previewBody}</p>
            </div>
          </div>
        </div>
        <span className="font-mono text-[10px] tracking-[0.18em] text-muted">RE0 / YOUR KNOWLEDGE. A NEW VOICE.</span>
      </section>
      <main className="flex items-center justify-center bg-white px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-10 flex items-center justify-between">
            <Link href="/" className="text-link inline-flex items-center gap-1.5 text-[13px]">
              <Icon name="arrow" className="size-4 rotate-180" />
              {t.login.back}
            </Link>
            <LanguageToggle />
          </div>
          <p className="eyebrow">{t.login.eyebrow}</p>
          <h2 className="mt-3 text-[30px] leading-tight font-extrabold">
            {t.login.hello1}
            <br />
            {t.login.hello2}
          </h2>
          <p className="mt-3 text-[13px] text-muted">{t.login.subtitle}</p>
          {error && (
            <p role="alert" className="mt-5 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
              {error}
            </p>
          )}
          <div className="mt-7 flex flex-col gap-3">
            <form action="/api/auth/google/start" method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
              <button type="submit" className="btn-secondary w-full min-h-12">
                <span className="font-extrabold text-[#4285f4]" aria-hidden="true">
                  G
                </span>
                {t.login.google}
              </button>
            </form>
            <form action="/api/auth/github/start" method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
              <button type="submit" className="btn-secondary w-full min-h-12">
                <Icon name="github" />
                {t.login.github}
              </button>
            </form>
          </div>
          <div className="mt-6 flex items-center gap-3 rounded-xl border border-[#dfe9fb] bg-soft px-4 py-3">
            <Icon name="sparkle" className="size-5 text-blue" />
            <div>
              <strong className="font-mono text-[13px]">{t.login.giftAmount}</strong>
              <p className="text-[12px] text-muted">{t.login.giftText}</p>
            </div>
          </div>
          <p className="mt-6 text-[11px] text-muted">
            {t.login.termsBefore}{' '}
            <Link href="/legal/terms" className="text-link">
              {t.login.termsLink}
            </Link>{' '}
            {t.login.termsAnd}{' '}
            <Link href="/legal/privacy" className="text-link">
              {t.login.privacyLink}
            </Link>
            {t.login.termsAfter}
          </p>
          <div className="mt-8 flex justify-between gap-3 text-[12px]">
            <Link href="/explore" className="text-link">
              {t.login.explore}
            </Link>
            <Link href="/admin/login" className="text-link">
              {t.login.admin}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
