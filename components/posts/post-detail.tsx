'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { POST_SUMMARY_FEE, type PostAnswerView, type PostView } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatRelative } from '@/i18n/format';
import { AnswerText, CitationChips, CitationDrawer, Typing } from '@/components/chat/message-parts';
import { Markdown } from '@/components/chat/markdown';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { AuthorAvatar, authorName, PostState } from '@/components/posts/post-card';
import './posts.css';

const POLL_MS = 2_500;

/**
 * A post's page (v5 "帖子页"): the question, then each Ree's answer with
 * its citations, 有帮助, copy link, report and 继续问; the round-table
 * summary; for the author their private follow-ups and the trash. While
 * Rees are still answering the page asks again every few seconds.
 */
export function PostDetail({ initial, signedIn, now, loginHref }: { initial: PostView; signedIn: boolean; now: number; loginHref: string }) {
  const { t, locale } = useI18n();
  const p = t.posts.page;
  const c = t.posts.card;
  const toast = useToast();
  const router = useRouter();
  const [post, setPost] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [citation, setCitation] = useState<{ entry: CitationSnapshot; answer: PostAnswerView } | null>(null);
  const mine = post.author.kind !== 'visitor' && post.author.kind !== 'example' && post.author.mine;
  /* Only a post anyone can see takes votes, saves, reports and 继续问; on a trashed, pending or taken-down one they could only fail (O2). */
  const live = post.status === 'published' && !post.deleted;
  const settled = post.status !== 'pending' && post.answerState === 'done' && post.summary?.state !== 'running';

  useEffect(() => {
    if (settled) return;
    const timer = setInterval(() => {
      fetch(`/api/posts/${post.id}`, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? (response.json() as Promise<PostView>) : null))
        .then((next) => next && setPost(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [settled, post.id]);

  const replace = (id: string, change: Partial<PostAnswerView>) => setPost((current) => ({ ...current, answers: current.answers.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)) }));

  const refresh = () =>
    fetch(`/api/posts/${post.id}`)
      .then((response) => (response.ok ? (response.json() as Promise<PostView>) : null))
      .then((next) => next && setPost(next))
      .catch(() => undefined);

  async function call(key: string, url: string, init: RequestInit, onOk: (body: Record<string, unknown>) => void, onError?: (code: string) => string | null) {
    setBusy(key);
    try {
      const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 402) {
        toast(fill(t.posts.composer.insufficient, { needed: formatNumber(Number(body.needed) || 0, locale), balance: formatNumber(Number(body.balance) || 0, locale) }));
        return;
      }
      if (!response.ok) {
        const message = onError?.(String(body.error ?? ''));
        if (message) return toast(message);
        throw new Error(String(response.status));
      }
      onOk(body);
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  const helpful = (entry: PostAnswerView) =>
    call(entry.id, `/api/posts/answers/${entry.id}/helpful`, { method: 'POST', body: JSON.stringify({ on: !entry.voted }) }, (body) => replace(entry.id, { helpful: Number(body.helpful) || 0, voted: body.voted === true }));
  const report = (entry: PostAnswerView) => {
    setConfirm(null);
    return call(entry.id, `/api/posts/answers/${entry.id}/report`, { method: 'POST' }, () => toast(p.reported));
  };
  const followUp = (entry: PostAnswerView) =>
    call(entry.id, `/api/posts/${post.id}/follow-up`, { method: 'POST', body: JSON.stringify({ answerId: entry.id }) }, (body) => router.push(`/chats/${String(body.conversationId)}`));
  /* Each refusal says what happened (O3); a summary already written or being written shows itself. */
  const summarize = () =>
    call('summary', `/api/posts/${post.id}/summary`, { method: 'POST' }, () => void refresh(), (code) => {
      if (code === 'already_summarized' || code === 'summary_running') void refresh();
      return (
        {
          not_enough_answers: p.summaryNotEnough,
          already_summarized: p.summaryAlready,
          summary_running: p.summaryRunning,
          summary_rejected: p.summaryRejected,
          summary_failed: p.summaryFailed,
        } as Record<string, string>
      )[code] ?? null;
    });
  const reportPost = () => {
    setConfirm(null);
    return call('report-post', `/api/posts/${post.id}/report`, { method: 'POST' }, () => toast(p.reportedPost));
  };
  const trash = (trashed: boolean) => call('trash', `/api/posts/${post.id}`, { method: 'PATCH', body: JSON.stringify({ trashed }) }, () => setPost((current) => ({ ...current, deleted: trashed })));
  const save = () => call('save', `/api/posts/${post.id}/save`, { method: 'POST', body: JSON.stringify({ on: !post.saved }) }, () => setPost((current) => ({ ...current, saved: !current.saved })));
  const copy = (anchor?: string) =>
    navigator.clipboard.writeText(`${window.location.origin}/p/${post.id}${anchor ? `#${anchor}` : ''}`).then(() => toast(c.copied), () => toast(t.common.errors.generic));

  const shown = post.answers.filter((entry) => entry.state === 'answered');
  const waiting = post.answers.filter((entry) => entry.state === 'queued' || entry.state === 'answering');
  const nameOf = (reeId: string) => post.answers.find((entry) => entry.reeId === reeId)?.reeName ?? '';
  const category = post.category ? (t.common.categories[post.category as keyof typeof t.common.categories] ?? null) : null;

  return (
    <div className="post-page">
      {post.deleted && (
        <div className="post-state is-unmatched">
          <span>{p.trashedNote}</span>
          <button type="button" className="text-link" disabled={busy === 'trash'} onClick={() => void trash(false)}>
            {p.restore}
          </button>
        </div>
      )}
      <header className="post-page-head">
        <AuthorAvatar author={post.author} />
        <div className="min-w-0">
          <strong>{authorName(t, post.author)}</strong>
          <div className="post-head">
            <span>{formatRelative(post.createdAt, now, locale, t.discover.public.qa.justNow)}</span>
            {category && <span className="tag">{category}</span>}
            {post.author.kind === 'example' && <span className="post-seed">{c.exampleTag}</span>}
          </div>
        </div>
      </header>
      <h2 className="post-page-question">{post.question}</h2>
      {post.detail && <p className="post-page-detail">{post.detail}</p>}
      <div className="post-actions">
        <span className="icon-btn" title={c.helpful}>
          <Icon name="thumbUp" className="" />
          {formatNumber(post.helpful, locale)}
        </span>
        <span className="icon-btn" title={c.answers}>
          <Icon name="chat" className="" />
          {formatNumber(post.answered, locale)}
        </span>
        {signedIn && live && (
          <button type="button" className="icon-btn" aria-pressed={post.saved} disabled={busy === 'save'} title={post.saved ? c.unsave : c.save} aria-label={post.saved ? c.unsave : c.save} onClick={() => void save()}>
            <Icon name="bookmark" className={post.saved ? 'text-blue' : ''} />
          </button>
        )}
        <button type="button" className="icon-btn" title={c.share} aria-label={c.share} onClick={() => void copy()}>
          <Icon name="link" className="" />
        </button>
        {live && !mine && (confirm === 'post' ? (
          <span className="ml-auto inline-flex items-center gap-2 text-[11px] text-muted">
            {p.reportPostConfirm}
            <button type="button" className="text-red hover:underline" disabled={busy === 'report-post'} onClick={() => void reportPost()}>{p.report}</button>
            <button type="button" className="hover:text-blue" onClick={() => setConfirm(null)}>{t.common.actions.cancel}</button>
          </span>
        ) : (
          <button type="button" className="icon-btn ml-auto" onClick={() => setConfirm('post')}>
            <Icon name="info" className="" />
            {p.reportPost}
          </button>
        ))}
        {mine && !post.deleted && (
          <button type="button" className="icon-btn ml-auto" disabled={busy === 'trash'} onClick={() => void trash(true)}>
            <Icon name="trash" className="" />
            {p.trash}
          </button>
        )}
      </div>

      <PostState post={post} />

      {post.followUps.length > 0 && (
        <div className="post-followups">
          <strong>{p.followUps}</strong>
          {post.followUps.map((entry) => (
            <Link key={entry.id} href={`/chats/${entry.id}`}>
              <Icon name="lock" className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{entry.reeName ? `${entry.reeName} · ` : ''}{entry.title}</span>
              {p.open} →
            </Link>
          ))}
        </div>
      )}

      {shown.length > 0 && (
        <div className="post-answers-head">
          <strong>{fill(p.answersHeading, { n: formatNumber(shown.length, locale) })}</strong>
          {post.candidates > 0 && <small>{fill(p.matchedNote, { candidates: formatNumber(post.candidates, locale) })}</small>}
        </div>
      )}

      {post.summary?.state === 'done' ? (
        <article className="post-answer post-summary">
          <div className="post-answer-head">
            <Icon name="sparkle" className="size-4 text-blue" />
            <strong>{p.summaryTitle}</strong>
          </div>
          <div className="answer-text studio-conversation" style={{ background: 'transparent' }}>
            <Markdown
              className="answer-markdown"
              text={post.summary.content}
              citation={() => null}
              source={(marker, key) => {
                const kept = post.summary?.sources.find((entry) => entry.marker === marker);
                return (
                  <span key={key} className="synthesis-source plain">
                    {kept ? `${nameOf(kept.reeId)}${kept.index ? ` ${kept.index}` : ''}` : marker}
                  </span>
                );
              }}
            />
          </div>
        </article>
      ) : post.summary?.state === 'running' ? (
        <div className="post-state is-gathering">
          <i className="spinner" />
          {p.summaryRunning}
        </div>
      ) : (
        mine && shown.length >= 2 && post.answerState === 'done' && live && (
          <div className="post-summary-cta">
            <Icon name="sparkle" className="size-4 text-blue" />
            <span className="min-w-0 flex-1">
              <strong>{p.summaryTitle}</strong>：{post.summaryStale ? (post.summaryRewriteFree ? p.summaryStale : p.summaryStalePaid) : fill(p.summaryHint, { n: shown.length })}
            </span>
            <button type="button" className="btn secondary sm" disabled={busy === 'summary'} onClick={() => void summarize()}>
              {busy === 'summary' ? <i className="spinner" /> : null}
              {post.summaryStale && post.summaryRewriteFree ? p.summaryAgain : fill(p.summaryGo, { fee: POST_SUMMARY_FEE })}
            </button>
          </div>
        )
      )}

      {shown.map((entry) => (
        <article key={entry.id} id={`a-${entry.id}`} className="post-answer scroll-mt-24">
          <div className="post-answer-head">
            <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
            <Link href={`/r/${entry.reeSlug}`}>
              <strong>{entry.reeName}</strong>
            </Link>
            {entry.official && <span className="tag">{c.official}</span>}
            {entry.pinned && <Icon name="pin" className="size-3" />}
            {entry.similarity !== null && <span className="post-match">{fill(p.match, { score: entry.similarity.toFixed(2) })}</span>}
          </div>
          <div className="answer-text studio-conversation" style={{ background: 'transparent' }}>
            <AnswerText text={entry.text} citations={entry.citations} onCitation={(found) => setCitation({ entry: found, answer: entry })} />
            <CitationChips citations={entry.citations} onCitation={(found) => setCitation({ entry: found, answer: entry })} />
          </div>
          <div className="post-answer-foot">
            {!live ? null : signedIn ? (
              <button type="button" className="icon-btn" aria-pressed={entry.voted} disabled={busy === entry.id} onClick={() => void helpful(entry)}>
                <Icon name="thumbUp" className={entry.voted ? 'text-blue' : ''} />
                {c.helpful} {formatNumber(entry.helpful, locale)}
              </button>
            ) : (
              <Link href={loginHref} className="icon-btn" title={p.signInToVote}>
                <Icon name="thumbUp" className="" />
                {c.helpful} {formatNumber(entry.helpful, locale)}
              </Link>
            )}
            <button type="button" className="icon-btn" onClick={() => void copy(`a-${entry.id}`)}>
              <Icon name="link" className="" />
              {c.share}
            </button>
            {!live ? null : confirm === entry.id ? (
              <span className="inline-flex items-center gap-2 text-[11px] text-muted">
                {p.reportConfirm}
                <button type="button" className="text-red hover:underline" disabled={busy === entry.id} onClick={() => void report(entry)}>{p.report}</button>
                <button type="button" className="hover:text-blue" onClick={() => setConfirm(null)}>{t.common.actions.cancel}</button>
              </span>
            ) : (
              <button type="button" className="icon-btn" onClick={() => setConfirm(entry.id)}>
                <Icon name="info" className="" />
                {p.report}
              </button>
            )}
            {mine && live && (
              <button type="button" className="btn secondary sm post-follow" title={p.followUpHint} disabled={busy === entry.id} onClick={() => void followUp(entry)}>
                <Icon name="chat" className="" />
                {fill(p.followUp, { name: entry.reeName })}
              </button>
            )}
          </div>
        </article>
      ))}

      {waiting.map((entry) => (
        <article key={entry.id} className="post-answer is-streaming">
          <div className="post-answer-head">
            <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
            <strong>{entry.reeName}</strong>
            <span className="post-match">{p.answering}</span>
          </div>
          <Typing />
        </article>
      ))}

      {post.answerState === 'done' && post.skipped > 0 && post.answered > 0 && <p className="post-skipped">{fill(p.skipped, { n: formatNumber(post.skipped, locale) })}</p>}

      <CitationDrawer
        citation={citation?.entry ?? null}
        ree={citation ? { id: citation.answer.reeId, name: citation.answer.reeName, avatarBlob: citation.answer.reeAvatar, color: citation.answer.reeColor } : null}
        canOpen={false}
        onClose={() => setCitation(null)}
      />
    </div>
  );
}
