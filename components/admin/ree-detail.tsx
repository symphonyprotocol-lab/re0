/**
 * The console's Ree detail (prototype admin-ree-detail.js): header with the
 * takedown / restore, metric cards, tabs as links, and the overview,
 * sources and management-log tabs. Server components; the takedown and
 * restore dialogs are the shared `ReasonAction`.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { QUERY_BASE_FEE } from '@/lib/constants';
import type { AdminReeDetail, SourceFilter } from '@/lib/services/admin-rees';
import { ADMIN_SOURCE_STATES } from '@/lib/services/admin-rees';
import type { Locale, Messages } from '@/i18n';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { ReasonAction } from '@/components/admin/list-client';
import { Fields, RecordsTable, RoleBadge, Tag, type Crumb } from '@/components/admin/list-kit';

export const VISIBILITY_TONES = { public: 'blue', private: 'grey', moderated: 'orange' } as const;
export const STATE_TONES = { ready: 'green', processing: 'grey', failed: 'red', paused: 'grey' } as const;

export const REE_TABS = ['overview', 'sources', 'statistics', 'audit'] as const;
export type ReeTab = (typeof REE_TABS)[number];

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

export function reeTab(params: Params): ReeTab {
  const tab = first(params.tab);
  return (REE_TABS as readonly string[]).includes(tab) ? (tab as ReeTab) : 'overview';
}

/**
 * Where "back" goes: the list (or a user's Rees tab) the administrator came
 * from, taken only when it is one of those console pages.
 */
export function reeBackPath(params: Params): { href: string; from: string | null } {
  const raw = first(params.from).slice(0, 2000);
  if ((raw === '/admin/rees' || raw.startsWith('/admin/rees?') || raw.startsWith('/admin/users/')) && !raw.includes('\\')) return { href: raw, from: raw };
  return { href: '/admin/rees', from: null };
}

type Extra = Record<string, string | number | null | undefined>;

function withQuery(path: string, params: Extra, from: string | null): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  if (from) query.set('from', from);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** The source list's filter as URL params, defaults left out. */
export function sourceParams(filter: { q: string; status: string; page?: number }): Extra {
  return { sourceQ: filter.q || null, sourceStatus: filter.status !== 'all' ? filter.status : null, sourcePage: filter.page && filter.page > 1 ? filter.page : null };
}

export function reeDetailHref(id: string, from: string | null, tab: ReeTab = 'overview', params: Extra = {}): string {
  return withQuery(`/admin/rees/${id}`, { tab: tab === 'overview' ? null : tab, ...params }, from);
}

export function reeSourceHref(id: string, kid: string, from: string | null, params: Extra = {}): string {
  return withQuery(`/admin/rees/${id}/sources/${kid}`, params, from);
}

/* --------------------------------------------------------------- header */

/** The page head's breadcrumbs alone, for pages whose own header carries the title. */
export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="breadcrumb" className="mb-4 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-muted">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && <Icon name="chevronRight" className="size-3 flex-none text-[#a3a9bb]" />}
          {crumb.href ? (
            <Link href={crumb.href} className="max-w-[220px] truncate hover:text-blue">
              {crumb.label}
            </Link>
          ) : (
            <span className="max-w-[260px] truncate font-semibold text-ink" aria-current="page">
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function ReeHeader({ t, locale, detail, answers }: { t: Messages; locale: Locale; detail: AdminReeDetail; answers: number }) {
  const r = t.consoleRees.ree;
  const { ree, visibility, sources } = detail;
  const n = (value: number) => formatNumber(value, locale);
  const deleted = Boolean(ree.deletedAt);
  const metric = (label: string, value: ReactNode, note: ReactNode, title?: string) => (
    <article className="card min-w-0 px-4 py-3" title={title}>
      <span className="block truncate text-[11px] font-semibold text-muted">{label}</span>
      <strong className="mt-1 block font-mono text-[20px] leading-tight">{value}</strong>
      <small className="mt-0.5 block text-[11px] text-muted">{note}</small>
    </article>
  );
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 text-[22px] font-extrabold tracking-tight break-words">{ree.name}</h1>
              <Tag tone={VISIBILITY_TONES[visibility]}>{t.consoleRees.rees.visibility[visibility]}</Tag>
            </div>
            {ree.description && <p className="mt-1 text-[13px] break-words text-muted">{ree.description}</p>}
          </div>
        </div>
        {!deleted && (
          <div className="flex flex-wrap items-center gap-2">
            {visibility === 'public' && (
              <Link href={`/r/${ree.slug}`} className="btn-secondary btn-sm" target="_blank" rel="noreferrer">
                <Icon name="external" className="size-3.5" />
                {r.publicPage}
              </Link>
            )}
            {visibility === 'public' && (
              <ReasonAction
                endpoint={`/api/admin/rees/${ree.id}/takedown`}
                label={r.takedown.label}
                title={fill(r.takedown.title, { name: ree.name })}
                body={r.takedown.body}
                confirmLabel={r.takedown.confirm}
                danger
                className="btn-danger btn-sm"
              />
            )}
            {visibility === 'moderated' && (
              <ReasonAction
                endpoint={`/api/admin/rees/${ree.id}/restore`}
                label={r.restore.label}
                title={fill(r.restore.title, { name: ree.name })}
                body={r.restore.body}
                confirmLabel={r.restore.confirm}
                className="btn btn-sm"
              />
            )}
          </div>
        )}
      </header>
      {deleted && (
        <p className="mt-4 flex gap-2 rounded-lg border border-line bg-wash px-3 py-2.5 text-[12px] text-muted">
          <Icon name="info" className="mt-0.5 size-4 flex-none" />
          {r.deleted}
        </p>
      )}
      {visibility === 'moderated' && ree.moderatedAt && (
        <div className="mt-4 rounded-lg border border-[#f0dcc2] bg-[#fff7ec] px-3 py-2.5 text-[12px] text-orange">
          <strong className="block">{fill(r.moderated, { time: formatDateTime(ree.moderatedAt, locale) })}</strong>
          {ree.moderatedReason && <span className="mt-0.5 block break-words">{fill(r.moderatedReason, { reason: ree.moderatedReason })}</span>}
        </div>
      )}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metric(r.metrics.answers, n(answers), r.metrics.answersNote)}
        {metric(r.metrics.sources, n(sources.total), r.metrics.sourcesNote)}
        {metric(r.metrics.ready, n(sources.ready), r.metrics.readyNote)}
        {metric(
          r.metrics.price,
          <>
            {n(QUERY_BASE_FEE + ree.queryFee)} <em className="text-[11px] font-normal text-muted not-italic">{r.metrics.priceUnit}</em>
          </>,
          fill(r.metrics.priceNote, { base: n(QUERY_BASE_FEE), fee: n(ree.queryFee) }),
          fill(r.metrics.priceHint, { base: n(QUERY_BASE_FEE) }),
        )}
      </div>
    </>
  );
}

export function ReeTabs({ t, id, from, active }: { t: Messages; id: string; from: string | null; active: ReeTab }) {
  const r = t.consoleRees.ree;
  return (
    <nav aria-label={r.tabsLabel} className="mt-6 mb-4 flex max-w-full gap-1 overflow-x-auto border-b border-line">
      {REE_TABS.map((tab) => (
        <Link
          key={tab}
          href={reeDetailHref(id, from, tab)}
          aria-current={tab === active ? 'page' : undefined}
          className={`-mb-px flex-none border-b-2 px-3 py-2.5 text-[13px] font-semibold whitespace-nowrap transition ${tab === active ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'}`}
        >
          {r.tabs[tab]}
        </Link>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------- overview */

export function ReeOverviewTab({ t, locale, detail, from }: { t: Messages; locale: Locale; detail: AdminReeDetail; from: string | null }) {
  const r = t.consoleRees.ree;
  const { ree, sources } = detail;
  const n = (value: number) => formatNumber(value, locale);
  const category = (t.common.categories as Record<string, string>)[ree.category] ?? ree.category;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className="card p-5">
          <h2 className="mb-4 text-[15px] font-bold">{r.identity.title}</h2>
          <Fields
            items={[
              [r.identity.id, <code key="id" className="font-mono text-[12px] break-all">{ree.id}</code>],
              [r.identity.slug, <code key="slug" className="font-mono text-[12px] break-all">{ree.slug}</code>],
              [r.identity.category, category],
              [
                r.identity.tags,
                ree.tags.length ? (
                  <span key="tags" className="flex flex-wrap gap-1">
                    {ree.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </span>
                ) : (
                  '—'
                ),
              ],
              [r.identity.created, formatDateTime(ree.createdAt, locale)],
              [r.identity.updated, formatDateTime(ree.updatedAt, locale)],
            ]}
          />
        </section>
        <section className="card p-5">
          <h2 className="text-[15px] font-bold">{r.prompt.title}</h2>
          <p className="mt-3 max-h-80 overflow-y-auto rounded-lg bg-wash p-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{ree.systemPrompt || r.prompt.empty}</p>
          <h3 className="mt-4 text-[13px] font-bold">{r.prompt.samples}</h3>
          {ree.sampleQuestions.length ? (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] break-words">
              {ree.sampleQuestions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[12px] text-muted">{r.prompt.noSamples}</p>
          )}
        </section>
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        <section className="card p-5">
          <h2 className="text-[15px] font-bold">{r.owner.title}</h2>
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
            <strong className="min-w-0 break-words">{detail.ownerName}</strong>
            <RoleBadge t={t} role={detail.ownerRole} />
          </div>
          <p className="mt-0.5 text-[12px] break-all text-muted">{detail.ownerEmail}</p>
          <Link href={`/admin/users/${ree.ownerId}`} className="text-link mt-3 text-[12px]">
            {r.owner.view}
            <Icon name="arrow" className="size-3.5" />
          </Link>
        </section>
        <section className="card p-5">
          <h2 className="text-[15px] font-bold">{r.readiness.title}</h2>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(['ready', 'processing', 'failed', 'paused'] as const).map((state) => (
              <Link
                key={state}
                href={reeDetailHref(ree.id, from, 'sources', { sourceStatus: state })}
                className="rounded-lg border border-line px-3 py-2 transition hover:border-[#c4cce0] hover:bg-wash"
              >
                <span className="block text-[11px] text-muted">{r.states[state]}</span>
                <strong className="font-mono text-[16px]">{n(sources[state])}</strong>
              </Link>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------- sources */

export function ReeSourcesTab({
  t,
  locale,
  id,
  from,
  filter,
  data,
}: {
  t: Messages;
  locale: Locale;
  id: string;
  from: string | null;
  filter: SourceFilter;
  data: { items: { id: string; title: string; kind: string; state: keyof typeof STATE_TONES; updatedAt: Date }[]; total: number; page: number; size: number };
}) {
  const s = t.consoleRees.ree.sources;
  const states = t.consoleRees.ree.states;
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  const keep = { q: filter.q, status: filter.status };
  const pageHref = (page: number) => reeDetailHref(id, from, 'sources', sourceParams({ ...keep, page }));
  const filtered = Boolean(filter.q) || filter.status !== 'all';
  const kinds = t.common.kinds as Record<string, string>;
  return (
    <section className="card overflow-hidden">
      {/* A plain GET form: changing the filter starts again at page 1. */}
      <form action={`/admin/rees/${id}`} method="get" className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
        <input type="hidden" name="tab" value="sources" />
        {from && <input type="hidden" name="from" value={from} />}
        <label className="flex min-w-[200px] flex-[1_1_240px] items-center gap-2 rounded-lg border border-line bg-white px-3 focus-within:border-blue">
          <Icon name="search" className="size-4 flex-none text-muted" />
          <input
            name="sourceQ"
            defaultValue={filter.q}
            maxLength={400}
            type="search"
            placeholder={s.search}
            aria-label={s.search}
            className="min-w-0 flex-1 bg-transparent py-2 text-[13px] outline-none"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-muted">
          {s.status}
          <select name="sourceStatus" defaultValue={filter.status} className="max-w-[200px] rounded-lg border border-line bg-white px-2.5 py-2 text-[12px] font-normal text-ink">
            {ADMIN_SOURCE_STATES.map((state) => (
              <option key={state} value={state}>
                {state === 'all' ? s.allStatuses : states[state]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-secondary btn-sm">
          {s.filter}
        </button>
        {filtered && (
          <Link href={reeDetailHref(id, from, 'sources')} className="text-link text-[12px]">
            {s.reset}
          </Link>
        )}
      </form>
      <div className="border-b border-line px-4 py-2.5 text-[12px] text-muted" role="status">
        {fill(s.total, { n: formatNumber(data.total, locale) })}
      </div>
      <RecordsTable
        label={s.region}
        empty={s.empty}
        head={[s.columns.title, s.columns.kind, s.columns.state, s.columns.updated]}
        rows={data.items.map((source) => [
          <Link
            key="title"
            href={reeSourceHref(id, source.id, from, sourceParams({ ...keep, page: data.page }))}
            className="flex max-w-[360px] min-w-0 items-center gap-2 font-semibold hover:text-blue"
          >
            <Icon name="file" className="size-4 flex-none text-muted" />
            <span className="min-w-0 truncate" title={source.title}>
              {source.title}
            </span>
          </Link>,
          <span key="kind" className="whitespace-nowrap">
            {kinds[source.kind] ?? source.kind}
          </span>,
          <Tag key="state" tone={STATE_TONES[source.state]}>
            {states[source.state]}
          </Tag>,
          <span key="updated" className="whitespace-nowrap">
            {formatDateTime(source.updatedAt, locale)}
          </span>,
        ])}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[12px] text-muted">
        <span>{fill(s.page, { page: data.page, pages })}</span>
        <div className="flex gap-2">
          {data.page > 1 ? (
            <Link href={pageHref(data.page - 1)} className="btn-secondary btn-sm">
              {s.previous}
            </Link>
          ) : (
            <button type="button" className="btn-secondary btn-sm" disabled>
              {s.previous}
            </button>
          )}
          {data.page < pages ? (
            <Link href={pageHref(data.page + 1)} className="btn-secondary btn-sm">
              {s.next}
            </Link>
          ) : (
            <button type="button" className="btn-secondary btn-sm" disabled>
              {s.next}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
