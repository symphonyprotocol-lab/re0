import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { ADMIN_PUBLICATION_VIEWS as VIEWS, adminPublications, publicUrl, type AdminPublicationView } from '@/lib/services/workspace-publish';
import { serverMessages } from '@/i18n/server';
import { fill, formatBytes, formatDateTime } from '@/i18n/format';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { OpenLink, PageHead, Person, RecordsTable, Subline, Tag } from '@/components/admin/list-kit';
import { AdminPublicationActions } from '@/components/files/publish-ui';
import '@/components/files/publish.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.publish.admin.title };
}

/**
 * `/admin/publications`: files users published as originals
 * (docs/design/agent-workspace-p4.md §2.8). Opens on Reported while anything
 * is reported. A takedown revokes for good and blocklists the bytes; restore
 * lifts a suspension reports caused; freezing stops an account's publishing.
 */
export default async function AdminPublicationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdministrator();
  const [{ t, locale }, params] = await Promise.all([serverMessages(), searchParams]);
  const a = t.publish.admin;
  const q = params.q?.slice(0, 200) ?? '';
  const asked = VIEWS.includes(params.view as AdminPublicationView) ? (params.view as AdminPublicationView) : null;
  const reported = asked ? null : await adminPublications('reported', q);
  const view: AdminPublicationView = asked ?? (reported && reported.length > 0 ? 'reported' : 'live');
  const rows = view === 'reported' && reported ? reported : await adminPublications(view, q);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: a.title }]} />
      <div className="console-body">
        <PageHead title={a.title} lede={a.lede} />
        <section className="card">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <nav className="flex gap-2" aria-label={a.title}>
              {VIEWS.map((key) => (
                <Link key={key} href={`/admin/publications?view=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}`} className={`btn sm ${view === key ? '' : 'ghost'}`} aria-current={view === key ? 'page' : undefined}>
                  {a.views[key]}
                </Link>
              ))}
            </nav>
            <form action="/admin/publications" className="ml-auto flex gap-2">
              <input type="hidden" name="view" value={view} />
              <input name="q" defaultValue={q} placeholder={a.search} aria-label={a.search} className="input sm" />
            </form>
          </div>
          <RecordsTable
            actions
            label={a.title}
            empty={a.empty}
            head={[a.file, a.owner, a.reports, a.published, a.actions]}
            rows={rows.map((row) => [
              <span key="file" className="block max-w-[360px] whitespace-normal">
                <strong>{row.title}</strong>
                <Subline className="mono">
                  {row.file_name} · {formatBytes(row.size)} · {row.sha256.slice(0, 12)}…
                </Subline>
                {!row.revoked && <OpenLink href={publicUrl(row.public_id)}>{a.open}</OpenLink>}
                {row.revokeReason && <Subline>{a.revokedBy[row.revokeReason]}</Subline>}
              </span>,
              <span key="owner" className="block">
                <Person name={row.owner.name} email={row.owner.email} />
                {row.frozen && <Tag tone="orange">{a.frozen}</Tag>}
                {row.takedowns > 0 && <Subline>{fill(a.takedowns, { n: row.takedowns })}</Subline>}
              </span>,
              <span key="reports" className="block">
                <span className="mono">{row.reports}</span>
                {row.reasons.length > 0 && <Subline>{row.reasons.map((reason) => t.publish.report.reasons[reason as keyof typeof t.publish.report.reasons] ?? reason).join('、')}</Subline>}
                {row.suspendedAt && <Tag tone="orange">{t.publish.card.suspended}</Tag>}
              </span>,
              formatDateTime(row.created_at, locale),
              <AdminPublicationActions key="act" id={row.id} title={row.title} ownerId={row.owner.id} suspended={row.suspended} revoked={row.revoked} frozen={row.frozen} />,
            ])}
          />
        </section>
      </div>
    </ConsolePage>
  );
}
