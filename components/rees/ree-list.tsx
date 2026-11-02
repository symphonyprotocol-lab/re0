'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { REE_PAGE_SIZES } from '@/lib/constants';
import type { ListResult } from '@/lib/domain/list';
import type { ReeListItem, ReeSort, ReeVisibility } from '@/lib/services/rees';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Pager } from '@/components/ui/pager';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { PlayIntroButton, VideoPlaceholder, VideoPoster } from '@/components/video/video-cover';
import type { IntroProps } from '@/lib/domain/video';

interface Query {
  q: string;
  visibility: ReeVisibility;
  sort: ReeSort;
  size: number;
  page: number;
  view: 'cards' | 'list';
}

const SORT_PARAMS: Record<ReeSort, { sort?: string; order?: string }> = {
  default: {},
  name_asc: { sort: 'name', order: 'asc' },
  name_desc: { sort: 'name', order: 'desc' },
  sources_desc: { sort: 'sources', order: 'desc' },
  sources_asc: { sort: 'sources', order: 'asc' },
  answers_desc: { sort: 'answers', order: 'desc' },
  answers_asc: { sort: 'answers', order: 'asc' },
};

/**
 * `/rees`: the server filters, sorts and pages; this only writes the choice
 * into the URL (so refresh and back/forward restore it). Changing a filter,
 * the sort or the page size goes back to page 1; an out-of-range page is
 * pulled back by the server.
 */
export function ReeList({
  result,
  totals,
  query,
  videos = {},
}: {
  result: ListResult<ReeListItem>;
  totals: { rees: number; public: number; private: number; sources: number; answers: number };
  query: Query;
  /** Step 7: introductions by Ree id; a Ree with one gets its opening still and a play button. */
  videos?: Record<string, IntroProps>;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(query.q);
  useEffect(() => setQ(query.q), [query.q]);
  const n = (value: number) => formatNumber(value, locale);

  const go = (changes: Partial<Query>) => {
    const next = { ...query, ...changes };
    const params = new URLSearchParams();
    if (next.q) params.set('q', next.q);
    if (next.visibility !== 'all') params.set('visibility', next.visibility);
    const sort = SORT_PARAMS[next.sort];
    if (sort.sort) params.set('sort', sort.sort);
    if (sort.order) params.set('order', sort.order);
    if (next.view === 'list') params.set('view', 'list');
    if (next.size !== REE_PAGE_SIZES[0]) params.set('size', String(next.size));
    if (next.page > 1) params.set('page', String(next.page));
    const search = params.toString();
    start(() => router.push(search ? `${pathname}?${search}` : pathname, { scroll: false }));
  };

  const from = result.total ? (result.page - 1) * result.size + 1 : 0;
  const to = Math.min(result.page * result.size, result.total);
  const filtered = Boolean(query.q) || query.visibility !== 'all';

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-8 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{t.rees.eyebrow}</p>
          <h1 className="mt-2 flex items-baseline gap-2 text-[28px] font-extrabold tracking-tight">
            {t.rees.title}
            <span className="font-mono text-[14px] font-medium text-muted">{n(totals.rees)}</span>
          </h1>
          <p className="mt-2 text-[13px] text-muted">{t.rees.lede}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Step 7: the video studio (prototype `#/videos`) is reached from here. */}
          <Link href="/videos" className="btn-secondary">
            <Icon name="film" />
            {t.video.library.entry}
          </Link>
          <Link href="/rees/new" className="btn">
            <Icon name="plus" />
            {t.rees.create}
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          [t.rees.stats.sources, n(totals.sources), t.rees.stats.sourcesUnit, t.rees.stats.sourcesHint],
          [t.rees.stats.answers, n(totals.answers), t.rees.stats.answersUnit, t.rees.stats.answersHint],
          [t.rees.stats.public, n(totals.public), t.rees.stats.publicUnit, fill(t.rees.stats.publicHint, { private: n(totals.private) })],
        ].map(([label, value, unit, hint]) => (
          <div key={label} className="card p-5">
            <p className="text-[12px] font-semibold text-muted">{label}</p>
            <p className="mt-2 flex items-baseline gap-1">
              <strong className="font-mono text-[26px] font-semibold">{value}</strong>
              <span className="text-[11px] text-muted">{unit}</span>
            </p>
            <p className="mt-1 text-[11px] text-muted">{hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-1 overflow-x-auto" role="tablist">
          {(['all', 'public', 'private'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={query.visibility === value}
              onClick={() => go({ visibility: value, page: 1 })}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap ${
                query.visibility === value ? 'bg-soft text-blue' : 'text-muted hover:text-ink'
              }`}
            >
              {t.rees.filters[value]}
            </button>
          ))}
        </div>
        <form
          className="flex w-full items-center gap-2 lg:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            go({ q: q.trim(), page: 1 });
          }}
        >
          <label className="relative min-w-0 flex-1 lg:w-[320px]">
            <span className="sr-only">{t.rees.searchLabel}</span>
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#a3a9bb]" />
            <input className="input pl-9" type="search" value={q} placeholder={t.rees.search} onChange={(event) => setQ(event.target.value)} />
          </label>
          <button type="submit" className="btn-secondary" aria-label={t.rees.searchLabel}>
            <Icon name="arrow" />
          </button>
        </form>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted">
        <span>{result.total ? fill(t.rees.total, { total: n(result.total), from, to }) : t.rees.totalEmpty}</span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            {t.rees.sortLabel}
            <select className="rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-ink" value={query.sort} onChange={(event) => go({ sort: event.target.value as ReeSort, page: 1 })}>
              {(Object.keys(SORT_PARAMS) as ReeSort[]).map((value) => (
                <option key={value} value={value}>
                  {t.rees.sorts[value]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex rounded-lg border border-line bg-white p-0.5" role="group" aria-label={t.rees.views.label}>
            {(['cards', 'list'] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-pressed={query.view === view}
                onClick={() => go({ view })}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-semibold ${query.view === view ? 'bg-soft text-blue' : 'text-muted'}`}
              >
                <Icon name={view} className="size-3.5" />
                {t.rees.views[view]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={`mt-4 transition-opacity ${pending ? 'opacity-60' : ''}`}>
        {result.items.length === 0 ? (
          <div className="card flex flex-col items-center gap-3 px-4 py-14 text-center">
            <ReeAvatar size="lg" />
            <strong className="text-[15px]">{filtered ? t.rees.emptyTitle : t.rees.firstTitle}</strong>
            <p className="max-w-[380px] text-[12px] text-muted">{filtered ? t.rees.emptyBody : t.rees.firstBody}</p>
            {filtered ? (
              <button type="button" className="btn-secondary btn-sm" onClick={() => go({ q: '', visibility: 'all', page: 1 })}>
                {t.common.actions.clear}
              </button>
            ) : (
              <Link href="/rees/new" className="btn btn-sm">
                <Icon name="plus" />
                {t.rees.create}
              </Link>
            )}
          </div>
        ) : query.view === 'cards' ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {result.items.map((ree) => (
              <li key={ree.id} className="card flex flex-col overflow-hidden">
                {videos[ree.id] ? (
                  <div className="relative border-b border-line">
                    <Link href={`/rees/${ree.id}/settings`} className="block" aria-label={ree.name}>
                      <VideoPoster ree={ree} video={videos[ree.id]!} />
                    </Link>
                    <span className="tag absolute top-3 left-3 bg-white">
                      <Icon name={ree.isPublic ? 'globe' : 'lock'} className="size-3" />
                      {ree.isPublic ? t.common.visibility.public : t.common.visibility.private}
                    </span>
                    <PlayIntroButton video={videos[ree.id]!} name={ree.name} href={`/rees/${ree.id}/video`} linkLabel={t.video.dialog.studio} className="absolute top-3 right-3" />
                  </div>
                ) : (
                  /* The same "暂无视频介绍" placeholder as explore (prototype discovery-video.js). */
                  <Link href={`/rees/${ree.id}/settings`} className="relative block border-b border-line" aria-label={ree.name}>
                    <VideoPlaceholder ree={ree} />
                    <span className="tag absolute top-3 right-3 bg-white">
                      <Icon name={ree.isPublic ? 'globe' : 'lock'} className="size-3" />
                      {ree.isPublic ? t.common.visibility.public : t.common.visibility.private}
                    </span>
                  </Link>
                )}
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <p className="line-clamp-2 min-h-[2.6em] text-[12px] text-muted" title={ree.description}>
                    {ree.description || '—'}
                  </p>
                  <div className="flex flex-wrap gap-3 text-[11px] text-muted">
                    <Link href={`/rees/${ree.id}/knowledge`} className="flex items-center gap-1 hover:text-blue">
                      <Icon name="file" className="size-3.5" />
                      {fill(t.rees.sourcesShort, { count: n(ree.sources) })}
                    </Link>
                    <span className="flex items-center gap-1">
                      <Icon name="chat" className="size-3.5" />
                      {fill(t.rees.answersShort, { count: n(ree.answers) })}
                    </span>
                  </div>
                  <div className="mt-auto flex flex-wrap justify-between gap-2">
                    <span className="flex flex-wrap gap-3">
                      <Link href={`/rees/${ree.id}/chat`} className="text-link text-[12px]">
                        <Icon name="chat" className="size-3.5" />
                        {t.rees.chat}
                      </Link>
                      <Link href={`/rees/${ree.id}/video`} className="text-link text-[12px]">
                        <Icon name="film" className="size-3.5" />
                        {t.video.tab}
                      </Link>
                    </span>
                    <Link href={`/rees/${ree.id}/settings`} className="btn-secondary btn-sm">
                      {t.rees.open}
                      <Icon name="arrow" className="size-3.5" />
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full table-fixed text-left text-[12px]">
              <thead className="hidden border-b border-line bg-wash text-[11px] text-muted md:table-header-group">
                <tr>
                  <th className="px-4 py-3 font-semibold">{t.rees.columns.name}</th>
                  <th className="w-[110px] px-3 py-3 font-semibold">{t.rees.columns.visibility}</th>
                  <th className="w-[120px] px-3 py-3 font-semibold">{t.rees.columns.sources}</th>
                  <th className="w-[110px] px-3 py-3 font-semibold">{t.rees.columns.answers}</th>
                  <th className="w-[250px] px-3 py-3 font-semibold">{t.rees.columns.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.items.map((ree) => (
                  <tr key={ree.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 md:table-row md:px-0 md:py-0">
                    <td className="w-full min-w-0 md:w-auto md:px-4 md:py-3">
                      <Link href={`/rees/${ree.id}/settings`} className="flex min-w-0 items-center gap-3">
                        <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                        <span className="min-w-0">
                          <strong className="block truncate text-[13px] hover:text-blue" title={ree.name}>
                            {ree.name}
                          </strong>
                          <span className="block truncate text-muted" title={ree.description}>
                            {ree.description || '—'}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="md:px-3">
                      <span className="tag">
                        <Icon name={ree.isPublic ? 'globe' : 'lock'} className="size-3" />
                        {ree.isPublic ? t.common.visibility.public : t.common.visibility.private}
                      </span>
                    </td>
                    <td className="md:px-3">
                      <strong className="font-mono">{n(ree.sources)}</strong>
                      <span className="ml-1 text-muted md:ml-0 md:block">{fill(t.rees.readyCount, { ready: n(ree.readySources) })}</span>
                    </td>
                    <td className="font-mono md:px-3">{n(ree.answers)}</td>
                    <td className="ml-auto md:ml-0 md:px-3">
                      <div className="flex gap-1">
                        <Link href={`/rees/${ree.id}/knowledge`} className="btn-ghost">
                          {t.rees.manageKnowledge}
                        </Link>
                        <Link href={`/rees/${ree.id}/video`} className="btn-ghost">
                          {t.video.tab}
                        </Link>
                        <Link href={`/rees/${ree.id}/chat`} className="btn-ghost">
                          {t.rees.chat}
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {result.total > 0 && (
        <div className="mt-5">
          <Pager page={result.page} size={result.size} total={result.total} sizes={REE_PAGE_SIZES} onPage={(page) => go({ page })} onSize={(size) => go({ size, page: 1 })} />
        </div>
      )}
    </main>
  );
}
