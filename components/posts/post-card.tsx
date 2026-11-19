'use client';

import { useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { PostAuthor, PostQuote, PostView } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatRelative } from '@/i18n/format';
import type { Messages } from '@/i18n';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar, UserAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import './posts.css';

export function authorName(t: Messages, author: PostAuthor): string {
  const c = t.posts.card;
  if (author.kind === 'user') return author.mine ? c.you : author.name;
  if (author.kind === 'example') return c.example;
  if (author.kind === 'visitor') return c.visitor;
  return author.mine ? c.you : c.someone;
}

export function AuthorAvatar({ author, className = 'size-10' }: { author: PostAuthor; className?: string }) {
  if (author.kind === 'user') return <UserAvatar avatar={author.avatar} name={author.name} className={className} />;
  if (author.kind === 'example') {
    return (
      <span className={`grid flex-none place-items-center rounded-full bg-soft text-blue ${className}`}>
        <Icon name="sparkle" className="size-4" />
      </span>
    );
  }
  return <UserAvatar name="?" className={className} />;
}

/**
 * What a post quotes ("引用提问"), as a card inside it -- like a quoted
 * tweet: the quoted post's author and question, and the quoted answer when
 * an answer was quoted. The whole card opens the quoted post (at that
 * answer). One level only. Once it can no longer be seen, only a line
 * saying so.
 */
export function QuoteCard({ quote, now }: { quote: PostQuote; now: number }) {
  const { t, locale } = useI18n();
  const q = t.posts.quote;
  if (!quote.available) return <div className="post-quote is-gone">{q.gone}</div>;
  const href = `/p/${quote.postId}${quote.answer ? `#a-${quote.answer.id}` : ''}`;
  return (
    <Link href={href} className="post-quote" aria-label={fill(q.open, { question: quote.question })}>
      <span className="post-quote-head">
        <AuthorAvatar author={quote.author} className="size-5" />
        <strong>{authorName(t, quote.author)}</strong>
        <span>· {formatRelative(quote.createdAt, now, locale, t.discover.public.qa.justNow)}</span>
      </span>
      <span className="post-quote-question">{quote.question}</span>
      {quote.answer && (
        <span className="post-quote-answer">
          <ReeAvatar avatar={quote.answer.reeAvatar} color={quote.answer.reeColor} size="sm" className="size-5!" />
          <span className="min-w-0">
            <strong>{quote.answer.reeName}</strong>
            <span className="block">{quote.answer.text}</span>
          </span>
        </span>
      )}
    </Link>
  );
}

/** Where a post stands, as the card and the page say it (answering, nobody could answer, under review, refused). */
export function PostState({ post }: { post: PostView }) {
  const { t } = useI18n();
  const c = t.posts.card;
  if (post.status === 'rejected') return <div className="post-state is-rejected">{c.rejected}</div>;
  /* Only its author sees a taken-down post: say why. */
  if (post.status === 'hidden') return <div className="post-state is-rejected">{post.hiddenBy === 'reports' ? c.hiddenReports : c.hiddenAdmin}</div>;
  if (post.status === 'pending') return <div className="post-state is-gathering"><i className="spinner" />{c.pending}</div>;
  if (post.answerState !== 'done') {
    return (
      <div className="post-state is-gathering">
        <i className="spinner" />
        {post.answered > 0 ? fill(c.answeringSome, { n: post.answered }) : c.answering}
      </div>
    );
  }
  /* Only the author has paid requests: say they wait for them, not that nobody could answer. */
  if (post.answered === 0 && post.paidRequests.length > 0) return <div className="post-state is-gathering">{fill(t.posts.page.paidWaiting, { n: post.paidRequests.length })}</div>;
  if (post.answered === 0) {
    return (
      <div className="post-state is-unmatched">
        <span>{c.unmatched}</span>
        <Link href="/rees/new">{c.createRee} →</Link>
      </div>
    );
  }
  return null;
}

/**
 * One post in a feed (v5): who asked and when, the question, the Rees that
 * answered and the top answer, cut; or where it stands. The whole card
 * opens the post; save and copy link sit above that.
 */
export function PostCard({ post: initial, now, signedIn }: { post: PostView; now: number; signedIn: boolean }) {
  const { t, locale } = useI18n();
  const c = t.posts.card;
  const toast = useToast();
  const [post, setPost] = useState(initial);
  const [busy, setBusy] = useState(false);
  const top = post.answers[0];
  const href = `/p/${post.id}`;
  const category = post.category ? (t.common.categories[post.category as keyof typeof t.common.categories] ?? null) : null;

  async function toggleSave() {
    setBusy(true);
    try {
      const response = await fetch(`/api/posts/${post.id}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !post.saved }) });
      if (!response.ok) throw new Error(String(response.status));
      setPost((current) => ({ ...current, saved: !current.saved }));
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(`${window.location.origin}${href}`).then(() => toast(c.copied), () => toast(t.common.errors.generic));
  }

  return (
    <article className="post-card" aria-label={post.question}>
      <AuthorAvatar author={post.author} />
      <div className="min-w-0">
        <div className="post-head">
          <strong>{authorName(t, post.author)}</strong>
          <span>· {formatRelative(post.createdAt, now, locale, t.discover.public.qa.justNow)}</span>
          {category && <span className="tag">{category}</span>}
          {post.author.kind === 'example' && <span className="post-seed">{c.exampleTag}</span>}
          {post.deleted && <span className="tag">{c.trashed}</span>}
        </div>
        <p className="post-question">
          <Link href={href}>{post.question}</Link>
        </p>
        {post.quote && (
          <div className="post-quote-slot">
            <QuoteCard quote={post.quote} now={now} />
          </div>
        )}
        {top ? (
          <div className="post-answers-preview">
            <div className="post-answerers">
              <span>{fill(c.answered, { n: formatNumber(post.answered, locale) })}</span>
            </div>
            <div className="post-top-answer">
              <ReeAvatar avatar={top.reeAvatar} color={top.reeColor} size="sm" className="size-[26px]!" />
              <div className="min-w-0">
                <strong>{top.reeName}</strong>
                {top.official && <span className="tag ml-1.5">{c.official}</span>}
                <p>{top.text.replace(/ ?\[\d{1,2}\]/g, '')}</p>
              </div>
            </div>
          </div>
        ) : (
          <PostState post={post} />
        )}
        <div className="post-actions">
          <span className="icon-btn" title={c.helpful}>
            <Icon name="thumbUp" className="" />
            {formatNumber(post.helpful, locale)}
          </span>
          <span className="icon-btn" title={c.answers}>
            <Icon name="chat" className="" />
            {formatNumber(post.answered, locale)}
          </span>
          {signedIn && (
            <button type="button" className="icon-btn" aria-pressed={post.saved} disabled={busy} title={post.saved ? c.unsave : c.save} aria-label={post.saved ? c.unsave : c.save} onClick={() => void toggleSave()}>
              <Icon name="bookmark" className={post.saved ? 'text-blue' : ''} />
            </button>
          )}
          <button type="button" className="icon-btn" title={c.share} aria-label={c.share} onClick={() => void copyLink()}>
            <Icon name="link" className="" />
          </button>
          {post.answered > 0 && (
            <Link href={href} className="post-open">
              {c.viewAll}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
