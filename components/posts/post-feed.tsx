'use client';

import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { FeedTab, PostPage } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { useLoadOnScroll } from '@/components/ui/use-load-on-scroll';
import { PostCard } from '@/components/posts/post-card';
import './posts.css';

/**
 * A feed of posts: the first page from the server, more as it scrolls
 * (`/api/posts?tab=&cursor=&q=`). `empty` stands in when there is none.
 * A new tab or search is a new feed (the page keys it), so the cursor and
 * the observer start again with it.
 */
export function PostFeed({ tab, q = null, quotes = null, initial, now, signedIn, empty }: { tab: FeedTab; q?: string | null; quotes?: string | null; initial: PostPage; now: number; signedIn: boolean; empty?: ReactNode }) {
  const { t } = useI18n();
  const h = t.posts.home;
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
      const params = new URLSearchParams({ tab, cursor });
      if (q) params.set('q', q);
      if (quotes) params.set('quotes', quotes);
      const response = await fetch(`/api/posts?${params}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as PostPage;
      setPage((current) => {
        if (current.next !== cursor) return current;
        const seen = new Set(current.items.map((item) => item.id));
        return { items: [...current.items, ...next.items.filter((item) => !seen.has(item.id))], next: next.next };
      });
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [page.next, tab, q, quotes]);
  const { sentinel, observing } = useLoadOnScroll<HTMLDivElement>(more, Boolean(page.next) && !loading && !failed);

  if (page.items.length === 0) return <>{empty ?? null}</>;
  return (
    <div className="post-feed">
      {page.items.map((post) => (
        <PostCard key={post.id} post={post} now={now} signedIn={signedIn} />
      ))}
      <FeedFooter
        sentinel={sentinel}
        more={Boolean(page.next)}
        loading={loading}
        failed={failed}
        observing={observing}
        onMore={() => void more()}
        labels={{ more: h.more, loading: h.loading, failed: h.loadError, end: initial.next ? h.end : null }}
      />
    </div>
  );
}

/**
 * The foot of a post list that loads as it scrolls (explore-view.tsx's
 * results footer): the sentinel itself, a spinner while a page loads, a
 * retry when one failed, a "load more" button where nothing observes it,
 * and a line at the end of a list that grew.
 */
export function FeedFooter({ sentinel, more, loading, failed, observing, onMore, labels }: {
  sentinel: RefObject<HTMLDivElement | null>;
  more: boolean;
  loading: boolean;
  failed: boolean;
  observing: boolean;
  onMore: () => void;
  labels: { more: string; loading: string; failed: string; end: string | null };
}) {
  const { t } = useI18n();
  return (
    <div ref={sentinel} className="post-feed-footer">
      {more ? (
        failed ? (
          <p role="alert">
            {labels.failed}
            <button type="button" className="btn-secondary btn-sm" onClick={onMore}>
              {t.common.actions.retry}
            </button>
          </p>
        ) : loading ? (
          <p role="status">
            <span className="post-feed-spinner" aria-hidden="true" />
            {labels.loading}
          </p>
        ) : (
          !observing && (
            <button type="button" className="btn-secondary btn-sm" onClick={onMore}>
              {labels.more}
            </button>
          )
        )
      ) : (
        labels.end && <p>{labels.end}</p>
      )}
    </div>
  );
}
