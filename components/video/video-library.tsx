'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { VIDEO_EXPORT_CREDITS, VIDEO_PAGE_SIZES, VIDEO_SCRIPT_CREDITS } from '@/lib/constants';
import { pageNumbers } from '@/lib/domain/list';
import type { VideoListItem } from '@/lib/services/video';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { DotAvatar, PIcon } from '@/components/rees/proto-icon';
import '@/components/rees/ree-pages.css';
import './video-pages.css';

/**
 * `/videos` (prototype suite.js `videoLibrary`): one card per Ree -- a poster
 * in its template, the script's state and the way into its editor -- then the
 * pricing strip. The search and the pager (not in the prototype, which lists
 * every Ree on one page) show only once the Rees outgrow the first page.
 */
export function VideoLibrary({ result, q }: { result: { items: VideoListItem[]; total: number; page: number; size: number }; q: string }) {
  const { t, locale } = useI18n();
  const l = t.video.library;
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState(q);
  const hrefFor = (changes: Record<string, string | number>) => {
    const next = new URLSearchParams();
    const merged = { q, page: result.page, size: result.size, ...changes };
    if (merged.q) next.set('q', String(merged.q));
    if (Number(merged.size) !== VIDEO_PAGE_SIZES[0]) next.set('size', String(merged.size));
    if (Number(merged.page) > 1) next.set('page', String(merged.page));
    return next.size ? `${pathname}?${next}` : pathname;
  };
  const pages = Math.max(1, Math.ceil(result.total / result.size));
  const large = q !== '' || result.total > VIDEO_PAGE_SIZES[0];
  const pageLink = (page: number, label: string, children: ReactNode) =>
    page < 1 || page > pages ? (
      <span className="is-disabled" aria-disabled="true">
        {children}
      </span>
    ) : (
      <Link href={hrefFor({ page })} aria-label={label}>
        {children}
      </Link>
    );
  return (
    <main className="page video-library-page">
      <div className="page-head">
        <div>
          <p className="eyebrow section-kicker">YOUR KNOWLEDGE, CONNECTED</p>
          <h1>{l.title}</h1>
          <p>{l.lede}</p>
        </div>
        {large && (
          <form
            role="search"
            className="search-small"
            onSubmit={(event) => {
              event.preventDefault();
              router.push(hrefFor({ q: search.trim(), page: 1 }));
            }}
          >
            <PIcon name="search" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={l.search} aria-label={l.search} maxLength={200} />
            <button type="submit" aria-label={t.common.actions.confirm}>
              <PIcon name="arrow" />
            </button>
          </form>
        )}
      </div>
      {result.items.length > 0 && (
        <div className="video-library">
          {result.items.map((item) => {
            const href = `/rees/${item.reeId}/video`;
            return (
              <article key={item.reeId} className="card video-library-card">
                <Link className={`video-library-poster template-${item.template}`} href={href}>
                  <DotAvatar avatar={item.avatarBlob} color={item.color} />
                  <h2>{item.name}</h2>
                  <span>
                    <PIcon name="play" /> 00:15
                  </span>
                </Link>
                <div className="between">
                  <div>
                    <strong>{item.name}</strong>
                    <p>
                      {item.generated ? l.ready : l.waiting}
                      {item.exportsCount > 0 && ` · ${fill(l.exports, { n: formatNumber(item.exportsCount, locale) })}`}
                    </p>
                  </div>
                  <Link href={href} className="text-link">
                    {l.edit}
                    <PIcon name="arrow" />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {result.items.length === 0 && (
        <div className="card empty">
          <PIcon name="film" />
          <h3>{q ? l.noMatch : l.empty}</h3>
          {!q && (
            <Link href="/rees/new" className="btn">
              {t.rees.firstCreate}
            </Link>
          )}
        </div>
      )}
      {pages > 1 && (
        <div className="discovery-results-footer">
          <span>{fill(l.total, { n: formatNumber(result.total, locale) })}</span>
          <nav className="discovery-pagination" aria-label={t.rees.pager.bottom}>
            {pageLink(result.page - 1, t.common.pager.previous, <PIcon name="chevron" />)}
            {pageNumbers(result.page, pages).map((value, index) =>
              value === null ? (
                <span key={`gap-${index}`} className="pagination-ellipsis">
                  …
                </span>
              ) : value === result.page ? (
                <span key={value} className="is-current" aria-current="page">
                  {value}
                </span>
              ) : (
                <Link key={value} href={hrefFor({ page: value })} aria-label={fill(t.rees.pager.page, { n: value })}>
                  {value}
                </Link>
              ),
            )}
            {pageLink(result.page + 1, t.common.pager.next, <PIcon name="chevron" />)}
          </nav>
        </div>
      )}
      <div className="info-strip mt24">
        <PIcon name="info" />
        <span>{fill(l.pricing, { script: formatNumber(VIDEO_SCRIPT_CREDITS, locale), export: formatNumber(VIDEO_EXPORT_CREDITS, locale) })}</span>
      </div>
    </main>
  );
}
