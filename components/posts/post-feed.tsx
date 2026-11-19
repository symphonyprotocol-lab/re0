'use client';

import { useState, type ReactNode } from 'react';
import type { FeedTab, PostPage } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { useToast } from '@/components/ui/toast';
import { PostCard } from '@/components/posts/post-card';
import './posts.css';

/**
 * A feed of posts: the first page from the server, more on request
 * (`/api/posts?tab=&cursor=&q=`). `empty` stands in when there is none.
 */
export function PostFeed({ tab, q = null, initial, now, signedIn, empty }: { tab: FeedTab; q?: string | null; initial: PostPage; now: number; signedIn: boolean; empty?: ReactNode }) {
  const { t } = useI18n();
  const h = t.posts.home;
  const toast = useToast();
  const [page, setPage] = useState(initial);
  const [loading, setLoading] = useState(false);

  async function more() {
    if (!page.next || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ tab, cursor: page.next });
      if (q) params.set('q', q);
      const response = await fetch(`/api/posts?${params}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as PostPage;
      setPage((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return { items: [...current.items, ...next.items.filter((item) => !seen.has(item.id))], next: next.next };
      });
    } catch {
      toast(h.loadError);
    } finally {
      setLoading(false);
    }
  }

  if (page.items.length === 0) return <>{empty ?? null}</>;
  return (
    <div className="post-feed">
      {page.items.map((post) => (
        <PostCard key={post.id} post={post} now={now} signedIn={signedIn} />
      ))}
      {page.next && (
        <div className="py-4 text-center">
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={() => void more()}>
            {loading ? <i className="spinner" /> : null}
            {h.more}
          </button>
        </div>
      )}
    </div>
  );
}
