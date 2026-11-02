import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { adminOverview } from '@/lib/services/admin-overview';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, type IconName } from '@/components/ui/icons';
import { PageHead, RecordsTable, Tag } from '@/components/admin/list-kit';
import { ConsoleTopbar } from '@/components/admin/console-topbar';
import { AuditTable } from '@/components/admin/audit-kit';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleRees.overview.title };
}

/** Small amounts keep their cents' fractions: an embedding month can cost $0.0042. */
function usd(value: number, locale: 'zh' | 'en'): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

function StatCard({ label, value, note, icon }: { label: string; value: ReactNode; note: ReactNode; icon: IconName }) {
  return (
    <article className="card min-w-0 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-semibold text-muted">{label}</span>
        <Icon name={icon} className="size-4 flex-none text-blue" />
      </div>
      <strong className="mt-2 block font-mono text-[24px] leading-tight">{value}</strong>
      <small className="mt-1 block truncate text-[11px] text-muted">{note}</small>
    </article>
  );
}

/** `/admin/overview` (2.5 "概览", prototype `adminOverview()`), on live figures. */
export default async function OverviewPage() {
  const { t, locale } = await serverMessages();
  const o = t.consoleRees.overview;
  const data = await adminOverview();
  const n = (value: number) => formatNumber(value, locale);
  const peak = Math.max(1, ...data.trend.map((day) => day.answers));
  const answers = data.trend.reduce((sum, day) => sum + day.answers, 0);
  const attention: { href?: string; count?: number; label: string; icon: IconName }[] = [
    { href: '/admin/verifications', count: data.pending.verifications, label: o.attention.verifications, icon: 'shield' },
    { href: '/admin/models', count: data.pending.reembed, label: o.attention.reembed, icon: 'refresh' },
    { href: '/admin/kyc?status=pending', count: data.pending.kyc, label: o.attention.kyc, icon: 'user' },
    { href: '/admin/payouts', count: data.pending.payouts, label: o.attention.payouts, icon: 'download' },
  ];
  return (
    <>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.console.nav.overview }]} />
      <PageHead
        title={o.title}
        lede={o.lede}
        actions={
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            <Icon name="clock" className="size-3.5" />
            {o.period}
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <StatCard label={o.cards.users} value={n(data.users.total)} note={fill(o.cards.usersNote, { n: n(data.users.disabled) })} icon="user" />
        <StatCard
          label={o.cards.rees}
          value={n(data.rees.total)}
          note={fill(o.cards.reesNote, { public: n(data.rees.public), moderated: n(data.rees.moderated) })}
          icon="ree"
        />
        <StatCard label={o.cards.sources} value={n(data.sources.total)} note={fill(o.cards.sourcesNote, { ready: n(data.sources.ready) })} icon="file" />
        <StatCard label={o.cards.questions} value={n(data.questions30)} note={o.cards.questionsNote} icon="chat" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="card min-w-0 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[16px] font-bold">{o.trend.title}</h2>
              <p className="mt-1 text-[12px] text-muted">{o.trend.lede}</p>
            </div>
            <Tag tone="blue">{o.trend.daily}</Tag>
          </div>
          <div className="mt-5 flex h-40 items-end gap-[2px] sm:gap-1" role="img" aria-label={`${o.trend.legend} · ${fill(o.trend.total, { n: n(answers) })}`}>
            {data.trend.map((day) => (
              <div key={day.day} className="group relative flex h-full min-w-0 flex-1 items-end" title={fill(o.trend.bar, { day: day.day, n: n(day.answers) })}>
                <span
                  className={`block w-full rounded-t-[3px] ${day.answers ? 'bg-blue group-hover:bg-blue-dark' : 'bg-line'}`}
                  style={{ height: day.answers ? `${Math.max(4, (day.answers / peak) * 100)}%` : '2px' }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
            <span>{data.trend[0]?.day.slice(5)}</span>
            <span>{data.trend[data.trend.length - 1]?.day.slice(5)}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
            <span className="flex items-center gap-1.5">
              <i className="inline-block size-2 rounded-full bg-blue" />
              {o.trend.legend}
            </span>
            <span>{answers ? fill(o.trend.total, { n: n(answers) }) : o.trend.empty}</span>
          </div>
        </section>

        <aside className="card min-w-0 p-5">
          <p className="eyebrow">{o.attention.eyebrow}</p>
          <h2 className="mt-1 text-[16px] font-bold">{o.attention.title}</h2>
          <ul className="mt-3 flex flex-col gap-1.5">
            {attention.map((item) => {
              const body = (
                <>
                  <Icon name={item.icon} className="size-4 flex-none text-muted" />
                  <strong className="font-mono text-[15px]">{item.href ? n(item.count ?? 0) : '—'}</strong>
                  <span className="min-w-0 flex-1 text-[12px]">{item.label}</span>
                  {item.href ? <Icon name="chevronRight" className="size-4 flex-none text-muted" /> : <small className="flex-none text-[10px] text-muted">{o.attention.later}</small>}
                </>
              );
              return (
                <li key={item.label}>
                  {item.href ? (
                    <Link href={item.href} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 transition hover:border-[#c4cce0] hover:bg-wash">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-line px-3 py-2.5 opacity-60" aria-disabled="true">
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-line pt-4 min-[420px]:grid-cols-2 lg:grid-cols-1">
            <div className="min-w-0">
              <span className="block text-[11px] font-semibold text-muted">{o.income.earned}</span>
              <strong className="mt-0.5 block font-mono text-[20px]">{n(data.earned30)}</strong>
              <small className="text-[11px] text-muted">{o.income.earnedNote}</small>
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] font-semibold text-muted">{o.income.revenue}</span>
              <strong className="mt-0.5 block font-mono text-[20px]">{usd(data.revenue30.usd, locale)}</strong>
              <small className="text-[11px] text-muted">{fill(o.income.revenueNote, { n: n(data.revenue30.payments) })}</small>
            </div>
          </div>
        </aside>
      </div>

      <section className="card mt-4 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-bold">{o.models.title}</h2>
            <p className="mt-1 text-[12px] text-muted">{fill(o.models.lede, { start: data.month.start, end: data.month.end })}</p>
          </div>
          <Link href="/admin/models" className="text-link text-[12px]">
            {o.models.manage}
            <Icon name="arrow" className="size-3.5" />
          </Link>
        </div>
        <RecordsTable
          label={t.console.list.tableRegion}
          empty={t.console.list.empty}
          head={[o.models.kind, o.models.active, o.models.calls, o.models.cost]}
          rows={data.models.map((row) => [
            <span key="kind" className="font-semibold whitespace-nowrap">
              {t.admin.models.kinds[row.kind]}
            </span>,
            <div key="model" className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="font-mono text-[12px] break-all">{row.active}</code>
                <Tag tone={row.source === 'console' ? 'blue' : 'grey'}>{o.models.sources[row.source]}</Tag>
              </div>
              {row.rows.length > 1 && (
                <ul className="mt-1 text-[11px] text-muted">
                  {row.rows.map((entry) => (
                    <li key={entry.model} className="break-all">
                      {fill(o.models.byModel, { model: entry.model, n: n(entry.calls) })}
                    </li>
                  ))}
                </ul>
              )}
            </div>,
            <span key="calls" className="font-mono">
              {n(row.calls)}
            </span>,
            <div key="cost" className="min-w-0">
              {row.calls === 0 ? (
                <span className="font-mono">{usd(0, locale)}</span>
              ) : row.cost === null ? (
                <span className="font-mono text-muted" title={o.models.noPrice}>
                  —
                </span>
              ) : (
                <span className="font-mono">{usd(row.cost, locale)}</span>
              )}
              {row.unpriced && <small className="block text-[11px] text-orange">{row.cost === null ? o.models.noPrice : `* ${o.models.noPrice}`}</small>}
            </div>,
          ])}
        />
        {data.models.some((row) => row.unpriced) && <p className="border-t border-line px-5 py-3 text-[11px] text-muted">* {o.models.unpriced}</p>}
      </section>

      <section className="card mt-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-4">
          <h2 className="text-[16px] font-bold">{o.recent.title}</h2>
          <Link href="/admin/audit" className="text-link text-[12px]">
            {o.recent.all}
          </Link>
        </div>
        <AuditTable t={t} locale={locale} rows={data.recent} from="/admin/overview" />
      </section>
    </>
  );
}
