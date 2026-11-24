'use client';

import { useCallback, useRef, useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatRelative } from '@/i18n/format';
import { channelHref } from '@/lib/domain/hashtags';
import type { ChannelPage } from '@/lib/services/channels';
import { useLoadOnScroll } from '@/components/ui/use-load-on-scroll';
import { FeedFooter } from '@/components/posts/post-feed';
import { Icon } from '@/components/ui/icons';
import './posts.css';

/**
 * 首页's 频道 tab (`/?tab=channels&q=`): a search box over the names, then
 * the channels with a visible post, busiest first -- the first page from
 * the server, more as it scrolls (`/api/channels?q=&cursor=`), as the post
 * feed does. A new search is a new list (the page keys it).
 */
export function ChannelList({ q, initial, now }: { q: string | null; initial: ChannelPage; now: number }) {
  const { t, locale } = useI18n();
  const c = t.posts.channels;
  const [page, setPage] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  const more = useCallback(async () => {
    const cursor = page.next;
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ cursor });
      if (q) params.set('q', q);
      const response = await fetch(`/api/channels?${params}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as ChannelPage;
      setPage((current) => {
        if (current.next !== cursor) return current;
        const seen = new Set(current.items.map((item) => item.name));
        return { items: [...current.items, ...next.items.filter((item) => !seen.has(item.name))], next: next.next };
      });
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [page.next, q]);
  const { sentinel, observing } = useLoadOnScroll<HTMLDivElement>(more, Boolean(page.next) && !loading && !failed);

  return (
    <div className="channel-tab">
      <form action="/" role="search" className="channel-search" aria-label={c.search}>
        <input type="hidden" name="tab" value="channels" />
        <Icon name="search" className="size-4" />
        <input name="q" type="search" defaultValue={q ?? ''} placeholder={c.search} aria-label={c.search} maxLength={64} className="min-w-0 flex-1 bg-transparent outline-none" />
      </form>
      {q ? (
        <div className="xsearch-head">
          <p>{fill(c.searchResults, { q })}</p>
          <Link href="/?tab=channels" className="text-link">
            {c.searchClear}
          </Link>
        </div>
      ) : (
        <p className="channel-hint">{c.hint}</p>
      )}
      {page.items.length === 0 ? (
        <p className="px-[18px] py-10 text-center text-[13px] text-muted">{q ? fill(c.noResults, { q }) : c.empty}</p>
      ) : (
        <>
          <ul className="channel-list">
            {page.items.map((item) => (
              <li key={item.name}>
                <Link href={channelHref(item.name)} className="channel-row">
                  <span className="channel-mark" aria-hidden="true">
                    #
                  </span>
                  <span className="min-w-0">
                    <strong>{item.name}</strong>
                    <small>
                      {fill(c.posts, { n: formatNumber(item.posts, locale) })}
                      {item.lastPostAt && <> · {fill(c.active, { time: formatRelative(item.lastPostAt, now, locale, t.discover.public.qa.justNow) })}</>}
                    </small>
                  </span>
                  <Icon name="arrow" className="size-3.5 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
          <FeedFooter
            sentinel={sentinel}
            more={Boolean(page.next)}
            loading={loading}
            failed={failed}
            observing={observing}
            onMore={() => void more()}
            labels={{ more: c.more, loading: c.loading, failed: c.loadError, end: initial.next ? c.end : null }}
          />
        </>
      )}
    </div>
  );
}
