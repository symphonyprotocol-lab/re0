import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { redirect } from 'next/navigation';
import { csvHref, listHref, verificationsView, LIST_DEFAULTS } from '@/lib/domain/admin-lists';
import { listVerifications } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ExportButton, PageJump } from '@/components/admin/list-client';
import { pageNumbers, RoleBadge, Tag } from '@/components/admin/list-kit';
import { CI } from '@/components/admin/console-icon';
import { VerificationFilters, VerificationList } from '@/components/admin/verification-decision';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { VerificationStatusTag } from '@/components/admin/user-detail-roles';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.verifications.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The queue opens on pending, so its URL leaves `status=pending` out. */
const DEFAULTS = { ...LIST_DEFAULTS, status: 'pending' };

/**
 * `/admin/verifications` (prototype role-pages.js `list()`): pending first and
 * oldest first, every other view newest first; the filters live in the URL.
 */
export default async function VerificationsPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const v = t.consoleUsers.verifications;
  const l = t.console.list;
  const view = verificationsView(await searchParams);
  const data = await listVerifications(view);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/verifications', current, changes, DEFAULTS);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const back = encodeURIComponent(href({}));
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  const from = data.total ? (data.page - 1) * data.size + 1 : 0;
  const to = Math.min(data.page * data.size, data.total);
  const [before, after] = v.total.split('{total}');
  const cards: { label: string; value: string; href: string; active: boolean }[] = [
    { label: v.cards.all, value: n(data.counts.all ?? 0), href: href({ q: '', status: 'all' }), active: view.status === 'all' },
    { label: v.cards.pending, value: n(data.counts.pending ?? 0), href: href({ status: 'pending' }), active: view.status === 'pending' },
    { label: v.cards.approved, value: n(data.counts.approved ?? 0), href: href({ status: 'approved' }), active: view.status === 'approved' },
    { label: v.cards.rejected, value: n(data.counts.rejected ?? 0), href: href({ status: 'rejected' }), active: view.status === 'rejected' },
  ];
  /* Closed requests are rare (only a role change closes one): their card shows once there are any. */
  if ((data.counts.closed ?? 0) > 0 || view.status === 'closed') {
    cards.push({ label: v.cards.closed, value: n(data.counts.closed ?? 0), href: href({ status: 'closed' }), active: view.status === 'closed' });
  }
  const step = (target: number, label: string) =>
    target < 1 || target > pages ? (
      <span className="is-disabled" aria-disabled="true">
        <CI name="chevron" />
      </span>
    ) : (
      <Link href={href({ page: target })} className="record-page-link" aria-label={label}>
        <CI name="chevron" />
      </Link>
    );
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: v.title }]} />
      <VerificationList>
        <div className="role-page-heading">
          <h1>{v.title}</h1>
          <p>{v.lede}</p>
        </div>
        <div className="record-summary">
          {cards.map((card) => (
            <Link key={card.label} href={card.href} className={`record-summary-item ${card.active ? 'is-filtered' : ''}`}>
              <span>{card.label}</span>
              <strong className="mono">{card.value}</strong>
            </Link>
          ))}
        </div>
        <section className="card record-table">
          <VerificationFilters
            q={view.q}
            status={view.status}
            size={view.size}
            resetHref={view.q || view.status !== 'pending' ? listHref('/admin/verifications', { size: view.size }, {}, DEFAULTS) : null}
          />
          <div className="record-results" role="status" aria-live="polite">
            <span>
              {before}
              <strong>{n(data.total)}</strong>
              {fill(after ?? '', { from: n(from), to: n(to) })}
            </span>
            <small>{l.note}</small>
            <ExportButton href={csvHref('/api/admin/verifications', view, DEFAULTS)} />
          </div>
          <div className="table-wrap" role="region" aria-label={v.tableLabel} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {[v.columns.applicant, v.columns.statement, v.columns.snapshot, v.columns.status, v.columns.action].map((head) => (
                    <th key={head}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr>
                    <td className="table-empty" colSpan={5}>
                      <strong>{v.empty}</strong>
                      <p>{v.emptyHint}</p>
                    </td>
                  </tr>
                ) : (
                  data.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong className="record-clip" title={row.name}>
                          {row.name}
                        </strong>
                        <RoleBadge t={t} role={row.role} />
                        <small className="cell-subline record-clip" title={row.email}>
                          {row.email}
                        </small>
                        <small className="cell-subline mono">{row.id}</small>
                      </td>
                      <td>
                        <span className="role-statement-excerpt" title={row.statement}>
                          {row.statement}
                        </span>
                        <small>{fill(v.links, { n: row.links.length })}</small>
                      </td>
                      <td>
                        <Tag tone={row.passed === 5 ? 'green' : 'orange'} dot={false}>
                          {fill(v.passed, { n: row.passed })}
                        </Tag>
                      </td>
                      <td>
                        <VerificationStatusTag t={t} status={row.status} />
                        <small className="cell-subline">{formatDateTime(row.createdAt, locale)}</small>
                        {row.closedByRoleChange && <small className="cell-subline">{v.closedByRole}</small>}
                      </td>
                      <td>
                        <Link href={`/admin/verifications/${row.id}?from=${back}`} className="btn secondary sm">
                          {row.status === 'pending' ? v.review : v.view}
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="admin-ree-pagination record-pagination role-list-pager">
            <span>{fill(l.page, { page: data.page, pages })}</span>
            <nav className="admin-ree-pages" aria-label={v.pagination}>
              {step(data.page - 1, l.previous)}
              {pageNumbers(data.page, pages).map((value, index) =>
                value === null ? (
                  <span key={`gap-${index}`} className="pagination-ellipsis">
                    …
                  </span>
                ) : value === data.page ? (
                  <span key={value} className="is-current" aria-current="page">
                    {value}
                  </span>
                ) : (
                  <Link key={value} href={href({ page: value })} className="record-page-link" aria-label={fill(l.pageLabel, { page: value })}>
                    {value}
                  </Link>
                ),
              )}
              {step(data.page + 1, l.next)}
            </nav>
            <PageJump page={data.page} pages={pages} formId="role-review-jump" />
          </div>
        </section>
      </VerificationList>
    </ConsolePage>
  );
}
