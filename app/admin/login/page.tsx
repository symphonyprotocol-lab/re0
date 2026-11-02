import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { totpProvisioningUri } from '@/lib/domain/totp';
import { currentAdministrator } from '@/lib/http/admin';
import { ADMIN_HOME, safeAdminNext } from '@/lib/http/admin-next';
import { bootstrapChallenge, hasAdministrator } from '@/lib/services/admin';
import { enrolmentChallenge } from '@/lib/services/admin-administrators';
import { serverMessages } from '@/i18n/server';
import { fill } from '@/i18n/format';
import { ADMIN_LOCKOUT_MS, ADMIN_MAX_FAILED_ATTEMPTS } from '@/lib/constants';
import { CI } from '@/components/admin/console-icon';
import { ConsoleWordmark } from '@/components/admin/console-shell';
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
 * that is invalid or expired says so above the sign-in form. A signed-out
 * deep link arrives with `?next=`, where sign-in then returns. Drawn as the
 * prototype's `adminLogin` (suite.css `.admin-login-*`).
 */
export default async function AdminLoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const raw = params.invite;
  const invite = typeof raw === 'string' ? raw.slice(0, 4096) : '';
  const next = safeAdminNext(params.next) ?? ADMIN_HOME;
  if (!invite && (await currentAdministrator())) redirect(next);
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
  if (invalidInvite && (await currentAdministrator())) redirect(next);
  const title = empty ? t.admin.setup.title : enrolment ? t.consoleRees.enrol.title : t.admin.login.title;
  const lede = empty ? t.admin.setup.lede : enrolment ? t.consoleRees.enrol.lede : t.admin.login.lede;
  return (
    <main id="main" tabIndex={-1} className="admin-login-page">
      <div className="admin-login-top">
        <ConsoleWordmark label={t.common.brand} />
        <Link href="/" className="text-link">
          {t.admin.backToSite}
          <CI name="external" />
        </Link>
      </div>
      <section className="admin-login-card">
        <div className="admin-lock">
          <CI name="shield" />
        </div>
        <p className="eyebrow">{t.admin.eyebrow}</p>
        <h1>{title}</h1>
        <p>{lede}</p>
        {challenge && qr ? (
          <AdminBootstrapForm sealedSecret={challenge.sealed} secret={challenge.secret} qr={qr} />
        ) : enrolment && enrolmentQr ? (
          <AdminEnrolForm token={invite} name={enrolment.name} email={enrolment.email} sealedSecret={enrolment.sealedSecret} secret={enrolment.secret} qr={enrolmentQr} />
        ) : (
          <AdminLoginForm next={next} notice={invalidInvite ? t.consoleRees.enrol.invalid : undefined} />
        )}
        {!challenge && !enrolment && (
          <div className="admin-demo-credentials">
            <div>
              <strong>{t.admin.login.helpTitle}</strong>
              <p>{t.admin.login.help}</p>
            </div>
          </div>
        )}
        <p className="admin-auth-separation">
          <CI name="lock" />
          {t.admin.login.separation}
        </p>
        <div className="between admin-login-bottom">
          <Link href="/login" className="text-link">
            {t.admin.login.userLogin}
          </Link>
          {enrolment && (
            <Link href="/admin/login" className="text-link">
              {t.admin.login.existing}
            </Link>
          )}
        </div>
      </section>
      <p className="admin-login-caption">{fill(t.admin.login.caption, { attempts: ADMIN_MAX_FAILED_ATTEMPTS, minutes: ADMIN_LOCKOUT_MS / 60000 })}</p>
    </main>
  );
}
