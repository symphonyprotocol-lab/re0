'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { VIDEO_PAGE_SIZES } from '@/lib/constants';
import type { VideoListItem } from '@/lib/services/video';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Pager } from '@/components/ui/pager';
import { PlayIntroButton, VideoPlaceholder, VideoPoster } from '@/components/video/video-cover';

/** The `/videos` grid: cover (opening still or placeholder), state, exports, play and edit. */
export function VideoLibrary({ result, q }: { result: { items: VideoListItem[]; total: number; page: number; size: number }; q: string }) {
  const { t, locale } = useI18n();
  const l = t.video.library;
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState(q);
  const go = (changes: Record<string, string | number>) => {
    const next = new URLSearchParams();
    const merged = { q, page: result.page, size: result.size, ...changes };
    if (merged.q) next.set('q', String(merged.q));
    if (Number(merged.size) !== VIDEO_PAGE_SIZES[0]) next.set('size', String(merged.size));
    if (Number(merged.page) > 1) next.set('page', String(merged.page));
    router.push(next.size ? `${pathname}?${next}` : pathname);
  };
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">FIFTEEN SECONDS, ONE COMPANION</p>
          <h1 className="mt-1 text-[24px] font-extrabold tracking-tight sm:text-[28px]">{l.title}</h1>
          <p className="mt-1 text-[13px] text-muted">{l.lede}</p>
        </div>
        <form
          role="search"
          className="flex w-full max-w-[320px] items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            go({ q: search.trim(), page: 1 });
          }}
        >
          <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={l.search} aria-label={l.search} maxLength={200} />
          <button type="submit" className="icon-btn border border-line bg-white" aria-label={t.common.actions.confirm}>
            <Icon name="search" />
          </button>
        </form>
      </header>
      {result.items.length === 0 ? (
        <section className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
          <Icon name="film" className="size-8 text-blue" />
          <h2 className="text-[16px] font-bold">{q ? l.noMatch : l.empty}</h2>
          {!q && <p className="text-[12px] text-muted">{l.emptyBody}</p>}
          {!q && (
            <Link href="/rees/new" className="btn btn-sm">
              <Icon name="plus" />
              {t.rees.create}
            </Link>
          )}
        </section>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {result.items.map((item) => {
            const href = `/rees/${item.reeId}/video`;
            return (
              <li key={item.reeId} className="card flex min-w-0 flex-col overflow-hidden">
                <div className="relative border-b border-line">
                  <Link href={href} className="block" aria-label={`${l.edit}: ${item.name}`}>
                    {item.props ? <VideoPoster ree={item} video={item.props} /> : <VideoPlaceholder ree={item} />}
                  </Link>
                  {item.props && <PlayIntroButton video={item.props} name={item.name} href={href} linkLabel={t.video.dialog.studio} className="absolute top-3 right-3" />}
                </div>
                <div className="flex flex-1 items-end justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <strong className="block truncate text-[14px]">{item.name}</strong>
                    <p className="mt-1 text-[12px] text-muted">{item.generated ? l.ready : l.waiting}</p>
                    {item.exportsCount > 0 && <p className="mt-0.5 text-[11px] text-muted">{fill(l.exports, { n: formatNumber(item.exportsCount, locale) })}</p>}
                  </div>
                  <Link href={href} className="text-link flex-none text-[12px]">
                    {l.edit}
                    <Icon name="arrow" className="size-3.5" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {result.total > 0 && <Pager page={result.page} size={result.size} total={result.total} sizes={VIDEO_PAGE_SIZES} onPage={(page) => go({ page })} onSize={(size) => go({ size, page: 1 })} />}
    </div>
  );
}
