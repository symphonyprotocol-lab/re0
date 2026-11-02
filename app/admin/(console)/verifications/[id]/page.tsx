import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { param } from '@/lib/domain/list';
import { verificationDetail } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Fields, PageHead, RoleBadge } from '@/components/admin/list-kit';
import { RequirementChecks, VerificationStatusTag } from '@/components/admin/user-detail-roles';
import { VerificationDecision } from '@/components/admin/verification-decision';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';

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
    <>
      <PageHead
        crumbs={[
          { label: t.console.nav.home, href: '/admin/overview' },
          { label: from.startsWith('/admin/users') ? t.console.nav.users : v.title, href: from },
          { label: user.name },
        ]}
        title={d.title}
        lede={
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all">
              {user.name} · {user.email}
            </span>
            <RoleBadge t={t} role={user.role} showNormal />
          </span>
        }
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="card min-w-0 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[15px] font-bold">{d.application}</h2>
              <VerificationStatusTag t={t} status={request.status} />
            </div>
            <p className="mt-3 text-[13px] leading-relaxed break-words whitespace-pre-line">{request.statement}</p>
            <div className="mt-4 flex min-w-0 flex-col gap-1.5">
              {request.links.length === 0 ? (
                <span className="text-[12px] text-muted">{d.noLinks}</span>
              ) : (
                request.links.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="text-link min-w-0 text-[12px] break-all">
                    <Icon name="external" className="size-3.5 flex-none" />
                    {url}
                  </a>
                ))
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12px]">
              <span className="text-muted">{fill(d.submitted, { time: time(request.createdAt) })}</span>
              <Link href={`/admin/users/${user.id}?tab=roles&from=${back}`} className="text-link text-[12px]">
                {d.userLink}
                <Icon name="arrow" className="size-3.5" />
              </Link>
            </div>
          </section>

          <section className="card min-w-0 p-5">
            <h2 className="text-[15px] font-bold">{d.rees}</h2>
            {rees.length === 0 ? (
              <p className="mt-3 text-[13px] text-muted">{d.noRees}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {rees.map((ree) => (
                  <li key={ree.id}>
                    <Link href={`/admin/rees/${ree.id}?from=${back}`} className="flex min-w-0 items-center gap-3 py-2.5 hover:text-blue">
                      <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-[13px]">{ree.name}</strong>
                        <small className="block text-[11px] text-muted">{fill(d.readySources, { n: formatNumber(ree.readySources, locale) })}</small>
                      </span>
                      <RoleBadge t={t} role={user.role} />
                      <Icon name="chevronRight" className="size-4 flex-none text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card min-w-0 p-5">
            <h2 className="text-[15px] font-bold">{d.decision}</h2>
            {request.status === 'pending' ? (
              <>
                <p className="mt-2 mb-4 text-[13px] leading-relaxed text-muted">{d.pendingBody}</p>
                {user.disabled && <p className="mb-4 rounded-lg bg-[#fff7ec] px-3 py-2 text-[12px] text-orange">{d.disabled}</p>}
                <VerificationDecision id={request.id} />
              </>
            ) : (
              <div className="mt-4">
                {request.status === 'closed' && <p className="mb-4 rounded-lg bg-wash px-3 py-2 text-[12px] leading-relaxed text-muted">{d.closed}</p>}
                <Fields
                  items={[
                    [d.reviewer, data.reviewer ?? '—'],
                    [d.decidedAt, time(request.decidedAt)],
                    [d.reason, request.rejectedReason ? <span key="reason" className="whitespace-pre-line">{request.rejectedReason}</span> : '—'],
                    [d.currentRole, <RoleBadge key="role" t={t} role={user.role} showNormal />],
                  ]}
                />
              </div>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <section className="card min-w-0 p-5">
            <h2 className="text-[15px] font-bold">{d.snapshot}</h2>
            <div className="mt-2">
              <RequirementChecks t={t} locale={locale} metrics={request.metrics} />
            </div>
          </section>
          <details className="card group min-w-0 p-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[15px] font-bold">
              {d.current}
              <Icon name="chevronDown" className="size-4 text-muted transition group-open:rotate-180" />
            </summary>
            <div className="mt-2">
              <RequirementChecks t={t} locale={locale} metrics={current} />
            </div>
          </details>
          <p className="text-[11px] leading-relaxed text-muted">{t.consoleUsers.detail.roles.note}</p>
        </aside>
      </div>
    </>
  );
}
