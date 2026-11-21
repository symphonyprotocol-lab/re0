'use client';

import { useState } from 'react';
import type { PostView } from '@/lib/domain/post';
import { PostCard } from '@/components/posts/post-card';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import './posts.css';

export interface ReePostPage {
  items: PostView[];
  total: number;
  next: string | null;
}

/**
 * The public posts a Ree answered, as post cards each showing its answer
 * (稿 2: a share page's "大家问过的" and a Ree page's 回答的帖子 -- no chat
 * bubbles). On the Ree page more pages load from `/api/rees/[id]/posts`,
 * and its owner pins or hides its answer under each card, as on the old
 * Q&A list (`PATCH /api/rees/[id]/public-qa/[answerId]`).
 */
export function ReePostList({ reeId, initial, signedIn, owner = false, paged = false, renderedAt }: { reeId: string; initial: ReePostPage; signedIn: boolean; owner?: boolean; paged?: boolean; renderedAt: number }) {
  const { t } = useI18n();
  const q = t.discover.public.qa;
  const toast = useToast();
  const [page, setPage] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function more() {
    if (!page.next || loading) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/rees/${reeId}/posts?before=${page.next}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as ReePostPage;
      setPage((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return { items: [...current.items, ...next.items.filter((item) => !seen.has(item.id))], total: next.total, next: next.next };
      });
    } catch {
      toast(q.loadError);
    } finally {
      setLoading(false);
    }
  }

  /* The Ree's answer on the card: the list shows only this Ree's. */
  async function act(post: PostView, action: 'hide' | 'pin' | 'unpin') {
    const answer = post.answers[0];
    if (!answer) return;
    setBusy(post.id);
    setConfirm(null);
    try {
      const response = await fetch(`/api/rees/${reeId}/public-qa/${answer.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error(String(response.status));
      setPage((current) => {
        if (action === 'hide') return { ...current, total: Math.max(0, current.total - 1), items: current.items.filter((entry) => entry.id !== post.id) };
        const pinnedOf = (entry: PostView) => (action === 'pin' ? entry.id === post.id : entry.id === post.id ? false : Boolean(entry.answers[0]?.pinned));
        const items = current.items.map((entry) => ({ ...entry, answers: entry.answers.map((shown, index) => (index === 0 ? { ...shown, pinned: pinnedOf(entry) } : shown)) }));
        return { ...current, items: action === 'pin' ? [...items.filter((entry) => entry.answers[0]?.pinned), ...items.filter((entry) => !entry.answers[0]?.pinned)] : items };
      });
      toast(action === 'hide' ? q.hidden : action === 'pin' ? q.pinnedDone : q.unpinnedDone);
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  if (page.items.length === 0) return null;
  return (
    <div className="post-feed ree-post-feed" aria-label={q.list}>
      {page.items.map((post) => {
        const pinned = Boolean(post.answers[0]?.pinned);
        return (
          <PostCard
            key={`${post.id}:${pinned}`}
            post={post}
            now={renderedAt}
            signedIn={signedIn}
            footer={
              owner && post.answers[0] ? (
                <div className="ree-post-owner">
                  {pinned && (
                    <span className="mr-auto inline-flex items-center gap-1">
                      <Icon name="pin" className="size-3" />
                      {q.pinned}
                    </span>
                  )}
                  <button type="button" className="icon-btn" disabled={busy === post.id} onClick={() => void act(post, pinned ? 'unpin' : 'pin')}>
                    <Icon name="pin" className="" />
                    {pinned ? q.unpin : q.pin}
                  </button>
                  {confirm === post.id ? (
                    <button type="button" className="icon-btn text-red!" disabled={busy === post.id} onClick={() => void act(post, 'hide')}>
                      {q.hideConfirm}
                    </button>
                  ) : (
                    <button type="button" className="icon-btn" onClick={() => setConfirm(post.id)}>
                      <Icon name="close" className="" />
                      {q.hide}
                    </button>
                  )}
                </div>
              ) : null
            }
          />
        );
      })}
      {paged && page.next && (
        <div className="pt-2 text-center">
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={() => void more()}>
            {loading ? <i className="spinner" /> : null}
            {q.more}
          </button>
        </div>
      )}
    </div>
  );
}
