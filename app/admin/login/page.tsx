import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { totpProvisioningUri } from '@/lib/domain/totp';
import { currentAdministrator } from '@/lib/http/admin';
import { bootstrapChallenge, hasAdministrator } from '@/lib/services/admin';
import { enrolmentChallenge } from '@/lib/services/admin-administrators';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { AdminBootstrapForm, AdminEnrolForm, AdminLoginForm } from '@/components/admin/admin-auth-forms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.admin.console };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/admin/login`: on an empty installation the first visitor registers the
 * owner (password + TOTP); from then on it only signs in (2.5). An invited
 * administrator's link (`?invite=…`) opens their enrolment instead; a link
 * that is invalid or expired says so above the sign-in form.
 */
export default async function AdminLoginPage({ searchParams }: Props) {
  const raw = (await searchParams).invite;
  const invite = typeof raw === 'string' ? raw.slice(0, 4096) : '';
  if (!invite && (await currentAdministrator())) redirect('/admin/overview');
  const { t } = await serverMessages();
  const empty = !(await hasAdministrator());
  const challenge = empty ? await bootstrapChallenge() : null;
  const qr = challenge
    ? await QRCode.toDataURL(totpProvisioningUri({ secret: challenge.secret, account: 'owner', issuer: 'RE0 Console' }), { margin: 1, width: 168 })
    : null;
  const enrolment = !empty && invite ? await enrolmentChallenge(invite) : null;
  const enrolmentQr = enrolment
    ? await QRCode.toDataURL(totpProvisioningUri({ secret: enrolment.secret, account: enrolment.email, issuer: 'RE0 Console' }), { margin: 1, width: 168 })
    : null;
  const invalidInvite = !empty && Boolean(invite) && !enrolment;
  if (invalidInvite && (await currentAdministrator())) redirect('/admin/overview');
  const title = empty ? t.admin.setup.title : enrolment ? t.consoleRees.enrol.title : t.admin.login.title;
  const lede = empty ? t.admin.setup.lede : enrolment ? t.consoleRees.enrol.lede : t.admin.login.lede;
  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg px-4 py-8">
      <div className="flex w-full max-w-[440px] items-center justify-between">
        <span className="flex items-center gap-2 font-extrabold">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-ink text-white">
            <Icon name="ree" className="size-4" />
          </span>
          {t.common.brand}
        </span>
        <LanguageToggle />
      </div>
      <section className="card mt-10 w-full max-w-[440px] p-6 shadow-sm sm:p-8">
        <span className="inline-flex size-11 items-center justify-center rounded-xl bg-soft text-blue">
          <Icon name="shield" className="size-6" />
        </span>
        <p className="eyebrow mt-5">{t.admin.eyebrow}</p>
        <h1 className="mt-2 text-[24px] font-extrabold">{title}</h1>
        <p className="mt-2 text-[13px] text-muted">{lede}</p>
        {invalidInvite && (
          <p role="alert" className="mt-4 flex gap-2 rounded-lg border border-[#f0dcc2] bg-[#fff7ec] px-3 py-2.5 text-[12px] text-orange">
            <Icon name="info" className="mt-0.5 size-4 flex-none" />
            {t.consoleRees.enrol.invalid}
          </p>
        )}
        {challenge && qr ? (
          <AdminBootstrapForm sealedSecret={challenge.sealed} secret={challenge.secret} qr={qr} />
        ) : enrolment && enrolmentQr ? (
          <AdminEnrolForm token={invite} name={enrolment.name} email={enrolment.email} sealedSecret={enrolment.sealedSecret} secret={enrolment.secret} qr={enrolmentQr} />
        ) : (
          <AdminLoginForm />
        )}
        <p className="mt-6 flex items-center gap-2 text-[11px] text-muted">
          <Icon name="lock" className="size-3.5" />
          {t.admin.login.separation}
        </p>
        <div className="mt-4 text-[12px]">
          <Link href="/login" className="text-link">
            {t.admin.login.userLogin}
          </Link>
        </div>
      </section>
    </main>
  );
}
