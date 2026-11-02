import type { Metadata } from 'next';
import Link from 'next/link';
import { auditEntry } from '@/lib/services/admin-audit';
import { serverMessages } from '@/i18n/server';
import { formatDateTime } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Fields, PageHead } from '@/components/admin/list-kit';
import { ConsoleTopbar } from '@/components/admin/console-topbar';
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
      <>
        <ConsoleTopbar crumbs={[...crumbs, { label: d.notFound }]} />
        <PageHead title={d.notFound} />
        <Link href={back} className="btn-secondary">
          {d.back}
        </Link>
      </>
    );
  }
  const target = auditTargetHref(row.action, row.target);
  return (
    <>
      <ConsoleTopbar crumbs={[...crumbs, { label: actionLabel(t, row.action) }]} />
      <PageHead title={d.title} lede={actionLabel(t, row.action)} />
      <section className="card p-5">
        <h2 className="mb-4 text-[15px] font-bold">{d.record}</h2>
        <Fields
          items={[
            [d.id, <code key="id" className="font-mono text-[12px] break-all">{row.id}</code>],
            [d.time, formatDateTime(row.createdAt, locale)],
            [d.administrator, <span key="admin" className="break-all">{row.administrator ?? a.system}</span>],
            [
              d.action,
              <span key="action">
                {actionLabel(t, row.action)}
                <small className="ml-1.5 font-mono text-[11px] text-muted">{row.action}</small>
              </span>,
            ],
            [
              d.target,
              row.target ? (
                <span key="target" className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-[12px] break-all">{row.target}</code>
                  {target && (
                    <Link href={target} className="text-link text-[12px]">
                      {d.openTarget}
                      <Icon name="arrow" className="size-3.5" />
                    </Link>
                  )}
                </span>
              ) : (
                '—'
              ),
            ],
          ]}
        />
      </section>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {(
          [
            [d.before, row.before],
            [d.after, row.after],
          ] as const
        ).map(([label, value]) => (
          <section key={label} className="card min-w-0 overflow-hidden">
            <h2 className="border-b border-line px-4 py-3 text-[13px] font-bold">{label}</h2>
            <pre className="max-h-[60vh] overflow-auto bg-wash px-4 py-3 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap">{pretty(value)}</pre>
          </section>
        ))}
      </div>
    </>
  );
}
