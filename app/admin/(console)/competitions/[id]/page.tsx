import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { adminCompetitionDetail } from '@/lib/services/competitions';
import { serverMessages } from '@/i18n/server';
import { formatDateTime } from '@/i18n/format';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { DetailSection, Fields, PageHead } from '@/components/admin/list-kit';
import { AuditTable } from '@/components/admin/audit-kit';
import { AdminCompetitionActions } from '@/components/admin/admin-competition-detail';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await requireAdministrator();
  const { t } = await serverMessages();
  const detail = await adminCompetitionDetail((await params).id);
  return { title: detail ? `${detail.competition.title} · ${t.competitions.admin.title}` : t.competitions.admin.detail.notFound };
}

/**
 * `/admin/competitions/[id]`: one competition for the console -- its
 * entries (取消参赛资格), every answer's scores (改分, Q7), every score
 * change so far, and the management log of the console's actions on it.
 */
export default async function AdminCompetitionPage({ params }: Props) {
  await requireAdministrator();
  const [{ t, locale }, { id }] = await Promise.all([serverMessages(), params]);
  const a = t.competitions.admin;
  const d = a.detail;
  const crumbs = [
    { label: t.console.nav.home, href: '/admin/overview' },
    { label: a.title, href: '/admin/competitions' },
  ];
  const detail = await adminCompetitionDetail(id);
  if (!detail) {
    return (
      <ConsolePage>
        <ConsoleTopbar crumbs={[...crumbs, { label: d.notFound }]} />
        <section className="card empty">
          <h1>{d.notFound}</h1>
          <Link href="/admin/competitions" className="btn secondary mt16">
            {a.title}
          </Link>
        </section>
      </ConsolePage>
    );
  }
  const c = detail.competition;
  const when = (value: string | null) => (value ? formatDateTime(value, locale) : d.none);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[...crumbs, { label: c.title }]} />
      <div className="console-body">
        <PageHead
          title={c.title}
          lede={`#${c.slug}`}
          actions={
            <a href={`/competitions/${c.slug}`} target="_blank" rel="noreferrer" className="btn secondary sm">
              {d.viewPage}
            </a>
          }
        />
        <DetailSection title={a.title}>
          <Fields
            items={[
              [d.fields.status, `${t.competitions.status[c.status]}${c.hidden ? ` · ${a.hide}` : ''}`],
              [d.fields.host, <a key="host" href={`/admin/users/${c.hostId}`} className="hover:underline">{c.hostName ?? c.hostId}</a>],
              [d.fields.entries, `${c.entries} / ${c.maxEntries}`],
              [d.fields.deadline, when(c.deadlineAt)],
              [d.fields.reviewEndsAt, when(c.reviewEndsAt)],
              [d.fields.published, when(c.publishedAt)],
              [d.fields.reports, String(c.reports)],
            ]}
          />
        </DetailSection>
        <div className="mt16">
          <AdminCompetitionActions detail={detail} />
        </div>
        <section className="card mt16">
          <div className="p-4">
            <h2 className="text-[15px] font-semibold">{d.auditTitle}</h2>
          </div>
          <AuditTable t={t} locale={locale} rows={detail.audit.map((row) => ({ id: row.id, action: row.action, target: row.target, administrator: row.administrator, createdAt: row.createdAt }))} from={`/admin/competitions/${c.id}`} />
        </section>
      </div>
    </ConsolePage>
  );
}
