import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { auditEntry } from '@/lib/services/admin-audit';
import { serverMessages } from '@/i18n/server';
import { formatDateTime } from '@/i18n/format';
import { DetailSection, Fields, PageHead } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { actionLabel, auditTargetHref } from '@/components/admin/audit-kit';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleRees.audit.detail.title };
}

/** Back to the console page the entry was opened from (the log, the overview, a Ree's log), else the log. */
function backPath(raw: string | string[] | undefined): string {
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  return value.startsWith('/admin/') && !value.includes('\\') && value.length <= 2000 ? value : '/admin/audit';
}

function pretty(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/** `/admin/audit/[id]` (prototype admin-records.js `detail()`): the entry, and its before / after side by side. */
export default async function AuditEntryPage({ params, searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const a = t.consoleRees.audit;
  const d = a.detail;
  const id = (await params).id;
  const back = backPath((await searchParams).from);
  const row = UUID.test(id) ? await auditEntry(id) : null;
  /* The way back is the page the entry was opened from, named as that page. */
  const crumbs = [
    { label: t.console.nav.home, href: '/admin/overview' },
    {
      label: back.startsWith('/admin/overview') ? t.console.nav.overview : back.startsWith('/admin/rees/') ? t.consoleRees.ree.tabs.audit : a.title,
      href: back.startsWith('/admin/overview') || back.startsWith('/admin/rees/') || back.startsWith('/admin/audit') ? back : '/admin/audit',
    },
  ];
  if (!row) {
    return (
      <ConsolePage>
        <ConsoleTopbar crumbs={[...crumbs, { label: d.notFound }]} />
        <section className="card empty">
          <h1>{d.notFound}</h1>
          <Link href={back} className="btn secondary mt16">
            {d.back}
          </Link>
        </section>
      </ConsolePage>
    );
  }
  const target = auditTargetHref(row.action, row.target);
  const name = row.administrator ?? a.system;
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[...crumbs, { label: name }]} />
      <div className="admin-record-detail">
        <PageHead title={d.title} lede={name} />
        <DetailSection title={d.record}>
          <Fields
            items={[
              [d.id, row.id],
              [d.time, formatDateTime(row.createdAt, locale)],
              [d.administrator, name],
              [d.action, `${actionLabel(t, row.action)} · ${row.action}`],
              [
                d.target,
                row.target ? (
                  target ? (
                    <Link key="target" href={target} className="text-link" title={d.openTarget}>
                      {row.target}
                    </Link>
                  ) : (
                    row.target
                  )
                ) : (
                  '—'
                ),
              ],
            ]}
          />
        </DetailSection>
        <div className="record-diff-grid">
          {(
            [
              [d.before, row.before],
              [d.after, row.after],
            ] as const
          ).map(([label, value]) => (
            <DetailSection key={label} title={label}>
              <pre>{pretty(value)}</pre>
            </DetailSection>
          ))}
        </div>
      </div>
    </ConsolePage>
  );
}
