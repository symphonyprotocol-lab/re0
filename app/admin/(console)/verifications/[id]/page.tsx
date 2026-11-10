import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { param } from '@/lib/domain/list';
import { verificationDetail } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { RoleBadge } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { DotAvatar, RoleChecks, VerificationStatusTag } from '@/components/admin/user-detail-roles';
import { VerificationDecision } from '@/components/admin/verification-decision';
import { CI } from '@/components/admin/console-icon';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.verifications.detail.title };
}

/** The way back: the queue (with its filters) or the user page that linked here. */
function backTo(raw: string): string {
  return /^\/admin\/(verifications|users)(?:[/?]|$)/.test(raw) ? raw : '/admin/verifications';
}

/**
 * `/admin/verifications/[id]` (prototype role-pages.js `reviewPage`): the
 * statement and links, the user's public Rees, the decision, and the
 * threshold as submitted beside the figures today.
 */
export default async function VerificationReviewPage({ params, searchParams }: Props) {
  await requireAdministrator();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const query = await searchParams;
  const { t, locale } = await serverMessages();
  const data = await verificationDetail(id);
  if (!data) notFound();
  const v = t.consoleUsers.verifications;
  const d = v.detail;
  const { request, user, rees, current } = data;
  const from = backTo(param(query, 'from'));
  const self = `/admin/verifications/${id}${from !== '/admin/verifications' ? `?from=${encodeURIComponent(from)}` : ''}`;
  const back = encodeURIComponent(self);
  const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
  return (
    <ConsolePage>
      <ConsoleTopbar
        crumbs={[
          { label: t.console.nav.home, href: '/admin/overview' },
          { label: from.startsWith('/admin/users') ? t.console.nav.users : v.title, href: from },
          { label: user.name },
        ]}
      />
      <div className="role-review-page">
        <div className="role-page-heading">
          <h1>{d.title}</h1>
          <p>
            {user.name} · {user.email}
          </p>
        </div>
        <div className="role-review-grid">
          <div>
            <section className="card role-panel">
              <div className="between">
                <h2>{d.application}</h2>
                <VerificationStatusTag t={t} status={request.status} />
              </div>
              <p className="role-pre">{request.statement}</p>
              <div className="role-external-links">
                {request.links.length === 0 ? (
                  <span className="muted">{d.noLinks}</span>
                ) : (
                  request.links.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                      <CI name="external" />
                      {url}
                    </a>
                  ))
                )}
              </div>
              <p className="role-footnote">{fill(d.submitted, { time: time(request.createdAt) })}</p>
              <Link href={`/admin/users/${user.id}?tab=roles&from=${back}`} className="text-link">
                {d.userLink}
              </Link>
            </section>

            <section className="card role-panel">
              <h2>{d.rees}</h2>
              {rees.length === 0 ? (
                <p className="muted">{d.noRees}</p>
              ) : (
                rees.map((ree) => (
                  <Link key={ree.id} href={`/admin/rees/${ree.id}?from=${back}`} className="role-ree-link">
                    <DotAvatar avatar={ree.avatarBlob} color={ree.color} />
                    <span>
                      <strong>{ree.name}</strong>
                      <small>{fill(d.readySources, { n: formatNumber(ree.readySources, locale) })}</small>
                    </span>
                    <RoleBadge t={t} role={user.role} />
                    <CI name="arrow" />
                  </Link>
                ))
              )}
            </section>

            <section className="card role-panel">
              <h2>{d.decision}</h2>
              {request.status === 'pending' ? (
                <>
                  <p>{d.pendingBody}</p>
                  {user.disabled && <p className="role-state-note">{d.disabled}</p>}
                  <VerificationDecision id={request.id} name={user.name} />
                </>
              ) : (
                <>
                  {request.status === 'closed' && <p className="role-state-note">{d.closed}</p>}
                  <p>{fill(d.reviewedBy, { who: data.reviewer ?? '—', time: time(request.decidedAt) })}</p>
                  {request.rejectedReason && (
                    <div className="role-feedback">
                      <p>{request.rejectedReason}</p>
                    </div>
                  )}
                  <p>
                    {d.currentRole}
                    <RoleBadge t={t} role={user.role} showNormal />
                  </p>
                </>
              )}
            </section>
          </div>

          <aside>
            <section className="card role-panel">
              <h2>{d.snapshot}</h2>
              <RoleChecks t={t} locale={locale} metrics={request.metrics} />
            </section>
            <details className="card role-panel">
              <summary>{d.current}</summary>
              <RoleChecks t={t} locale={locale} metrics={current} />
            </details>
            <p className="role-footnote">{t.consoleUsers.detail.roles.note}</p>
          </aside>
        </div>
      </div>
    </ConsolePage>
  );
}
