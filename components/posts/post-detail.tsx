'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { FOLLOWUP_FOLD_HEAD, FOLLOWUP_FOLD_TAIL, FOLLOWUP_ROUND_ANSWERS, POST_SUMMARY_FEE, POST_TITLE_MAX, type AiAnswerView, type FollowupView, type PaidRequestView, type PostAnswerView, type PostPage, type PostView, type PrivateReeOption } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatRelative } from '@/i18n/format';
import { AnswerText, CitationChips, CitationDrawer, Typing } from '@/components/posts/answer-parts';
import { Markdown } from '@/components/posts/markdown';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { AuthorAvatar, authorName, PostHelpful, PostState, PrivateBadge, QuoteCard } from '@/components/posts/post-card';
import { PostFeed } from '@/components/posts/post-feed';
import { FollowupComposer, type FollowupComposerHandle } from '@/components/posts/followup-composer';
import { AiGuide, AiRound, type AiGuideItem } from '@/components/posts/ai-answer';
import { composeHref } from '@/components/posts/composer';
import { PrivateReePicker } from '@/components/posts/ree-picker';
import './posts.css';

const POLL_MS = 2_500;
/** A round just settled with no Ree may still get its AI answer (written right after): the page keeps asking this long. */
const AI_WAIT_MS = 3 * 60_000;

/**
 * A post's page (v5 "帖子页"): the question, then each Ree's answer with
 * its citations and one row of small actions -- 有帮助, copy link, report,
 * 继续问 and 引用; the round-table summary; then the thread of follow-ups
 * (追问) and the box to ask one. While Rees are still answering the page
 * asks again every few seconds.
 *
 * A private post (私密提问, only ever shown to its author) keeps the same
 * page with its own marks and actions: "私密 · 仅你可见" for the category;
 * 置顶 · 归档 · 重命名 · 转为公开 · 移到回收站 on the post; 有帮助 · 没帮助 ·
 * 复制 · 继续问 and what each answer cost on an answer; no match score (the
 * author chose the Rees), no save, link, quote or report anywhere; and the
 * thread's box can add Rees (加 Ree).
 */
export function PostDetail({ initial, quoting, signedIn, now, loginHref }: { initial: PostView; quoting?: PostPage; signedIn: boolean; now: number; loginHref: string }) {
  const { t, locale } = useI18n();
  const p = t.posts.page;
  const c = t.posts.card;
  const toast = useToast();
  const router = useRouter();
  const [post, setPost] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [citation, setCitation] = useState<{ entry: CitationSnapshot; answer: PostAnswerView } | null>(null);
  const composer = useRef<FollowupComposerHandle>(null);
  const t2 = t.posts.followups;
  /* The thread folds in the middle once it is long, unless a link points into it. */
  const [threadOpen, setThreadOpen] = useState(false);
  const [roundsOpen, setRoundsOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (window.location.hash.startsWith('#f-')) setThreadOpen(true);
  }, []);
  const mine = post.author.kind !== 'visitor' && post.author.kind !== 'example' && post.author.mine;
  const isPrivate = post.visibility === 'private';
  /* 重命名 in place (the text being edited), and 转为公开's confirmation with its 匿名 choice. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<{ anonymous: boolean } | null>(null);
  const q = t.posts.quote;
  /* "引用提问": the composer over this page with the quote; a visitor signs in first and comes back to it. */
  const quoteHref = (answerId?: string) => {
    const target = `/p/${post.id}?compose=public&quote=${post.id}${answerId ? `&qa=${answerId}` : ''}`;
    return signedIn ? target : `/login?returnTo=${encodeURIComponent(target)}`;
  };
  /* Only a post anyone can see takes votes, saves, reports and 继续问; on a trashed, pending or taken-down one they could only fail (O2). */
  const live = post.status === 'published' && !post.deleted;
  /*
   * The asker's AI answer (AI 通用回答) is written right after a round
   * settles with no Ree: while it runs, or for a short while before it
   * appears, the page keeps asking.
   */
  const aiComing = (ai: AiAnswerView | null, quiet: boolean, at: string) => ai?.state === 'running' || (ai === null && quiet && Date.now() - Date.parse(at) < AI_WAIT_MS);
  const settled =
    post.status !== 'pending' &&
    post.answerState === 'done' &&
    post.summary?.state !== 'running' &&
    !post.paidRequests.some((entry) => entry.state === 'answering') &&
    !aiComing(post.aiAnswer, mine && live && post.answered === 0 && post.paidRequests.length === 0 && (post.author.kind === 'user' || post.author.kind === 'hidden'), post.createdAt) &&
    post.followups.every(
      (entry) =>
        entry.status !== 'pending' &&
        entry.answerState === 'done' &&
        !entry.paidRequests.some((request) => request.state === 'answering') &&
        !aiComing(entry.aiAnswer, entry.author.mine && entry.status === 'published' && entry.answers.length === 0 && entry.paidRequests.length === 0 && entry.awaiting === 0, entry.createdAt),
    );
  /* A paid request whose price was refused: the price to confirm again; one the balance could not pay: the top-up link. */
  const [lacking, setLacking] = useState<string | null>(null);

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

  /*
   * The right column (the Rees that answered) and the sidebar's balance are
   * rendered on the server: once the answers, the summary or what the author
   * spent change -- polled, or after an action -- refresh them (the page's own
   * state stays).
   */
  const shownState = `${post.answered}|${post.summary?.state ?? ''}|${post.spent ?? ''}|${post.aiAnswer?.state ?? ''}|${post.paidRequests.map((entry) => entry.state).join(',')}|${post.followups.map((entry) => `${entry.answerState}:${entry.answers.length}:${entry.spent ?? ''}:${entry.aiAnswer?.state ?? ''}`).join(',')}`;
  const seenState = useRef(shownState);
  useEffect(() => {
    if (seenState.current === shownState) return;
    seenState.current = shownState;
    router.refresh();
  }, [shownState, router]);

  /* An answer of the first round or of a follow-up. */
  const replace = (id: string, change: Partial<PostAnswerView>) =>
    setPost((current) => ({
      ...current,
      answers: current.answers.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)),
      followups: current.followups.map((round) => ({ ...round, answers: round.answers.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)) })),
    }));

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
    call(entry.id, `/api/posts/answers/${entry.id}/helpful`, { method: 'POST', body: JSON.stringify({ on: !entry.voted }) }, (body) => {
      const count = Number(body.helpful) || 0;
      const voted = body.voted === true;
      /* A first-round answer's vote is part of the post's total too. */
      if (post.answers.some((other) => other.id === entry.id)) setPost((current) => ({ ...current, helpful: Math.max(0, current.helpful + count - entry.helpful) }));
      /* On a private post 有帮助 and 没帮助 exclude each other: the server took the other mark back. */
      replace(entry.id, voted && entry.unvoted ? { helpful: count, voted, unvoted: false, unhelpful: Math.max(0, entry.unhelpful - 1) } : { helpful: count, voted });
    });
  const unhelpful = (entry: PostAnswerView) =>
    call(entry.id, `/api/posts/answers/${entry.id}/unhelpful`, { method: 'POST', body: JSON.stringify({ on: !entry.unvoted }) }, (body) => {
      const count = Number(body.helpful) || 0;
      if (post.answers.some((other) => other.id === entry.id)) setPost((current) => ({ ...current, helpful: Math.max(0, current.helpful + count - entry.helpful) }));
      replace(entry.id, { unhelpful: Number(body.unhelpful) || 0, unvoted: body.unvoted === true, helpful: count, voted: body.voted === true });
    });
  /* 复制 on a private answer: its text, without the citation markers. */
  const copyAnswer = (entry: PostAnswerView) =>
    navigator.clipboard.writeText(entry.text.replace(/ ?\[\d{1,2}\]/g, '')).then(() => toast(p.answerCopied), () => toast(t.common.errors.generic));
  const update = (key: string, change: { pinned?: boolean; archived?: boolean; title?: string | null }, after?: () => void) =>
    call(key, `/api/posts/${post.id}`, { method: 'PATCH', body: JSON.stringify(change) }, (body) => {
      setPost((current) => ({ ...current, pinned: body.pinned === true, archived: body.archived === true, title: typeof body.title === 'string' ? body.title : null }));
      after?.();
    }, (code) => (code === 'title_too_long' ? fill(p.renameTooLong, { n: POST_TITLE_MAX }) : null));
  const rename = () => {
    const title = (renaming ?? '').trim();
    if (title.length > POST_TITLE_MAX) return toast(fill(p.renameTooLong, { n: POST_TITLE_MAX }));
    return update('rename', { title: title || null }, () => setRenaming(null));
  };
  /* 转为公开: a new public post copying the question and the first round, reviewed; this one stays. Once only. */
  const makePublic = () =>
    call('publish', `/api/posts/${post.id}/publish`, { method: 'POST', body: JSON.stringify({ anonymous: publishing?.anonymous === true }) }, (body) => {
      setPost((current) => ({ ...current, publishedCopyId: String(body.id) }));
      setPublishing(null);
      toast(p.makePublicDone);
    }, (code) => {
      if (code !== 'already') return null;
      void refresh();
      setPublishing(null);
      return p.madePublic;
    });
  const report = (entry: PostAnswerView) => {
    setConfirm(null);
    return call(entry.id, `/api/posts/answers/${entry.id}/report`, { method: 'POST' }, () => toast(p.reported));
  };
  /* 继续问 X: the box at the end of the thread, with X @-mentioned (追问; no longer a private conversation). */
  const followUp = (entry: PostAnswerView) => composer.current?.mention(entry.reeId);
  const deleteRound = (round: FollowupView) => {
    setConfirm(null);
    return call(round.id, `/api/posts/followups/${round.id}`, { method: 'DELETE' }, () => {
      setPost((current) => ({ ...current, followups: current.followups.filter((entry) => entry.id !== round.id) }));
      toast(t2.deleted);
    });
  };
  const reportRound = (round: FollowupView) => {
    setConfirm(null);
    return call(round.id, `/api/posts/followups/${round.id}/report`, { method: 'POST' }, () => toast(t2.reported));
  };
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

  /* The first round's requests (`scope` null) or one follow-up's: each waits for whoever asked. */
  const setRequests = (scope: string | null, change: (entries: PaidRequestView[]) => PaidRequestView[]) =>
    setPost((current) =>
      scope === null
        ? { ...current, paidRequests: change(current.paidRequests) }
        : { ...current, followups: current.followups.map((round) => (round.id === scope ? { ...round, paidRequests: change(round.paidRequests) } : round)) },
    );
  /* A paid Ree answers once whoever asked agrees at the price shown (2026-11-19); a higher price comes back to confirm again. */
  async function agree(entry: PaidRequestView, scope: string | null) {
    setBusy(entry.id);
    try {
      const response = await fetch(`/api/posts/answers/${entry.id}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'agree', price: entry.price }) });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) {
        setLacking(null);
        setRequests(scope, (entries) => entries.map((other) => (other.id === entry.id ? { ...other, state: 'answering' } : other)));
      } else if (response.status === 402) {
        setLacking(entry.id);
        toast(fill(t.posts.composer.insufficient, { needed: formatNumber(Number(body.needed) || 0, locale), balance: formatNumber(Number(body.balance) || 0, locale) }));
      } else if (body.error === 'price_changed') {
        const price = Number(body.price) || entry.price;
        setRequests(scope, (entries) => entries.map((other) => (other.id === entry.id ? { ...other, price } : other)));
        toast(fill(p.paidChanged, { n: formatNumber(price, locale) }));
      } else if (body.error === 'already') {
        /* Agreed in another tab: show where it stands. */
        void refresh();
      } else if (body.error === 'unavailable' || response.status === 404) {
        toast(p.paidUnavailable);
        setRequests(scope, (entries) => entries.filter((other) => other.id !== entry.id));
      } else {
        throw new Error(String(response.status));
      }
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }
  const decline = (entry: PaidRequestView, scope: string | null) =>
    call(entry.id, `/api/posts/answers/${entry.id}/request`, { method: 'POST', body: JSON.stringify({ action: 'decline' }) }, () => setRequests(scope, (entries) => entries.filter((other) => other.id !== entry.id)));

  /* The asker's AI answer of the first round (null) or of one follow-up, changed in place (a vote, a by-hand generation). */
  const setAi = (scope: string | null, next: AiAnswerView) =>
    setPost((current) =>
      scope === null
        ? { ...current, aiAnswer: next }
        : { ...current, followups: current.followups.map((round) => (round.id === scope ? { ...round, aiAnswer: next } : round)) },
    );
  /* "请 Ree 回答": the author's own public post no Ree answered asks one public Ree, at its price. */
  const [requesting, setRequesting] = useState(false);
  const requestRee = (option: PrivateReeOption) => {
    setRequesting(false);
    return call(option.reeId, `/api/posts/${post.id}/ree-request`, { method: 'POST', body: JSON.stringify({ reeId: option.reeId }) }, (body) => {
      toast(fill(body.state === 'awaiting' ? t.posts.ai.requestWaiting : t.posts.ai.requestSent, { name: option.reeName }));
      void refresh();
    }, (code) => (t.posts.ai.requestErrors as Record<string, string>)[code] ?? null);
  };
  /* 换个说法再问 on a public post: the composer over this page, the question prefilled. */
  const askAgainHref = (question: string) => composeHref(`/p/${post.id}`, '', { compose: 'public', ask: question });

  const shown = post.answers.filter((entry) => entry.state === 'answered');
  const waiting = post.answers.filter((entry) => entry.state === 'queued' || entry.state === 'answering');
  const nameOf = (reeId: string) => post.answers.find((entry) => entry.reeId === reeId)?.reeName ?? '';
  const category = post.category ? (t.common.categories[post.category as keyof typeof t.common.categories] ?? null) : null;

  /* Rees one may ask on: the first round's, still taking posts. */
  const askable = new Set(post.followupCandidates.map((entry) => entry.reeId));
  /*
   * 继续问 AI: the author's follow-ups under their AI answer to a post no Ree
   * answered (only they get them). Once a Ree has answered, they fold with
   * the first AI answer, kept; the thread goes on with the public ones.
   */
  const aiRounds = post.followups.filter((entry) => entry.aiOnly);
  const aiRoundsFolded = aiRounds.length > 0 && shown.length > 0;
  const [aiRoundsOpen, setAiRoundsOpen] = useState(false);
  const rounds = aiRoundsFolded ? post.followups.filter((entry) => !entry.aiOnly) : post.followups;
  /* The box asks the AI alone: a public post's author under their AI answer, or a private thread no Ree is in (只问 AI). */
  const aiThread = live && mine && (post.followupAiOnly || (isPrivate && post.answerState === 'done' && post.followupCandidates.length === 0));
  const askAi = aiThread ? () => composer.current?.focus() : undefined;
  const published = rounds.filter((entry) => entry.status === 'published' || entry.status === 'hidden');
  const roundOf = new Map(published.map((entry, index) => [entry.id, index + 1]));
  const foldable = rounds.length > FOLLOWUP_FOLD_HEAD + FOLLOWUP_FOLD_TAIL && !threadOpen;
  const listedRounds: (FollowupView | 'fold')[] = foldable
    ? [...rounds.slice(0, FOLLOWUP_FOLD_HEAD), 'fold', ...rounds.slice(-FOLLOWUP_FOLD_TAIL)]
    : rounds;

  /* One answer, of the first round or of a follow-up: the text, its citations, and one row of small actions alike (继续问 and 引用 included). */
  const answerArticle = (entry: PostAnswerView, open: boolean, round?: FollowupView) => (
    <article key={entry.id} id={`a-${entry.id}`} className={`post-answer scroll-mt-24${round ? ' fu-answer' : ''}`}>
      <div className="post-answer-head">
        <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
        <Link href={`/r/${entry.reeSlug}`}>
          <strong>{entry.reeName}</strong>
        </Link>
        {entry.official && <span className="tag">{c.official}</span>}
        {entry.paid && <span className="tag">{p.paidTag}</span>}
        {entry.pinned && <Icon name="pin" className="size-3" />}
        {entry.similarity !== null && !isPrivate && <span className="post-match">{fill(p.match, { score: entry.similarity.toFixed(2) })}</span>}
      </div>
      <div className="answer-text studio-conversation" style={{ background: 'transparent' }}>
        <AnswerText text={entry.text} citations={entry.citations} onCitation={(found) => setCitation({ entry: found, answer: entry })} />
        <CitationChips citations={entry.citations} onCitation={(found) => setCitation({ entry: found, answer: entry })} />
      </div>
      {isPrivate ? (
        <div className="post-answer-foot">
          {open && (
            <>
              <button type="button" className="icon-btn" aria-pressed={entry.voted} disabled={busy === entry.id} onClick={() => void helpful(entry)}>
                <Icon name="thumbUp" className={entry.voted ? 'text-blue' : ''} />
                {c.helpful}
              </button>
              <button type="button" className="icon-btn" aria-pressed={entry.unvoted} disabled={busy === entry.id} onClick={() => void unhelpful(entry)}>
                <Icon name="thumbDown" className={entry.unvoted ? 'text-blue' : ''} />
                {p.unhelpful}
              </button>
            </>
          )}
          <button type="button" className="icon-btn" onClick={() => void copyAnswer(entry)}>
            <Icon name="copy" className="" />
            {p.copyAnswer}
          </button>
          {open && live && askable.has(entry.reeId) && !post.followupBlocked && (
            <button type="button" className="icon-btn" onClick={() => followUp(entry)}>
              <Icon name="reply" className="" />
              {fill(p.followUp, { name: entry.reeName })}
            </button>
          )}
          {entry.cost !== null && entry.cost > 0 && <span className="answer-cost">{fill(p.answerCost, { n: formatNumber(entry.cost, locale) })}</span>}
        </div>
      ) : (
      <div className="post-answer-foot">
        {!open ? null : signedIn ? (
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
        {!open ? null : confirm === entry.id ? (
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
        {/* 继续问 X: a follow-up under this post, X @-mentioned; anyone signed in, the author included (追问). */}
        {open && signedIn && live && askable.has(entry.reeId) && !post.followupBlocked && (
          <button type="button" className="icon-btn" title={fill(p.followUpHint, { name: entry.reeName })} onClick={() => followUp(entry)}>
            <Icon name="reply" className="" />
            {fill(p.followUp, { name: entry.reeName })}
          </button>
        )}
        {/* 引用: a new post of one's own quoting this answer; not one's own post, and only the first round's answers. */}
        {open && !mine && live && !round && (
          <Link href={quoteHref(entry.id)} className="icon-btn" title={fill(q.quoteAnswerHint, { name: entry.reeName })}>
            <Icon name="quote" className="" />
            {q.quoteAnswer}
          </Link>
        )}
      </div>
      )}
    </article>
  );

  const waitingArticle = (entry: PostAnswerView) => (
    <article key={entry.id} className="post-answer is-streaming">
      <div className="post-answer-head">
        <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
        <strong>{entry.reeName}</strong>
        <span className="post-match">{p.answering}</span>
      </div>
      <Typing />
    </article>
  );

  /* Requests waiting for whoever asked (`scope`: null for the post's author, a follow-up's id for its asker); nobody else sees them. */
  const paidSection = (entries: PaidRequestView[], scope: string | null) => (
    <section className={`post-paid${scope ? ' fu-paid' : ''}`} aria-label={scope ? t2.paidTitle : p.paidTitle}>
      <div className="post-answers-head">
        <strong>{scope ? t2.paidTitle : p.paidTitle}</strong>
        <small>{scope ? t2.paidHint : p.paidHint}</small>
      </div>
      {entries.map((entry) => (
        <article key={entry.id} className={`post-answer post-paid-request${entry.state === 'answering' ? ' is-streaming' : ''}`}>
          <div className="post-answer-head">
            <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
            <Link href={`/r/${entry.reeSlug}`}>
              <strong>{entry.reeName}</strong>
            </Link>
            {entry.ownerName && <span className="text-[11px] text-muted">{fill(p.paidBy, { owner: entry.ownerName })}</span>}
            {entry.similarity !== null && <span className="post-match">{fill(p.match, { score: entry.similarity.toFixed(2) })}</span>}
            <span className="tag">{fill(p.paidPrice, { n: formatNumber(entry.price, locale) })}</span>
          </div>
          {entry.state === 'answering' ? (
            <>
              <span className="text-[12px] text-muted">{p.paidAnswering}</span>
              <Typing />
            </>
          ) : (
            <div className="post-answer-foot">
              {entry.state === 'refunded' && <span className="basis-full text-[12px] text-muted">{p.paidRefunded}</span>}
              {entry.state === 'no_answer' && <span className="basis-full text-[12px] text-muted">{p.paidNoAnswer}</span>}
              {entry.state === 'exhausted' && <span className="basis-full text-[12px] text-muted">{p.paidExhausted}</span>}
              {/* Found no answer, or failed again: refunded, no more tries (each costs a model call). */}
              {(entry.state === 'awaiting' || entry.state === 'refunded') && (
                <button type="button" className="btn btn-sm" disabled={busy === entry.id} onClick={() => void agree(entry, scope)}>
                  {busy === entry.id ? <i className="spinner" /> : null}
                  {fill(entry.state === 'refunded' ? p.paidAgain : p.paidAgree, { n: formatNumber(entry.price, locale) })}
                </button>
              )}
              <button type="button" className="btn-secondary btn-sm" disabled={busy === entry.id} onClick={() => void decline(entry, scope)}>
                {p.paidDecline}
              </button>
              {lacking === entry.id && (
                <Link href="/settings?tab=balance" className="text-[12px] text-blue hover:underline">
                  {p.paidTopUp} →
                </Link>
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );

  const a = t.posts.ai;
  /* The AI answer's guidance under a follow-up: another post (every Ree), or on a private thread 加 Ree / ask again in the box. */
  const followupGuide = (round: FollowupView): AiGuideItem[] =>
    isPrivate
      ? [
          { icon: 'plus', title: a.addRee, body: a.addReeBody, onClick: () => composer.current?.addRee() },
          { icon: 'text', title: a.rephrase, body: a.rephrasePrivateBody, onClick: () => composer.current?.focus() },
        ]
      : [
          { icon: 'text', title: a.postAnew, body: a.postAnewBody, href: askAgainHref(round.question) },
          { icon: 'at', title: a.mention, body: a.mentionFollowupBody, href: '/rees' },
        ];
  /* Under the first round: ask it another way, ask one Ree (请 Ree 回答), or become the Ree; on a private post 加 Ree or ask again in the box. */
  const firstGuide: AiGuideItem[] = isPrivate
    ? [
        { icon: 'plus', title: a.addRee, body: a.addReeBody, onClick: () => composer.current?.addRee() },
        { icon: 'text', title: a.rephrase, body: a.rephrasePrivateBody, onClick: () => composer.current?.focus() },
      ]
    : [
        { icon: 'text', title: a.rephrase, body: a.rephraseBody, href: askAgainHref([post.question, post.detail].filter(Boolean).join('\n')) },
        { icon: 'at', title: a.mention, body: a.mentionBody, onClick: () => setRequesting((current) => !current) },
        { icon: 'plus', title: a.create, body: a.createBody, href: '/rees/new' },
      ];
  const firstAi = post.aiAnswer;

  /* One follow-up: who asked, its round and time, the question (@ in blue), then where it stands and its answers. */
  const roundArticle = (round: FollowupView) => {
    const asker = round.author.mine;
    const who = asker ? t2.you : round.author.poster ? (round.author.name ?? t2.poster) : (round.author.name ?? t2.someone);
    const author = round.author.name ? { kind: 'user' as const, name: round.author.name, avatar: round.author.avatar, mine: asker } : { kind: 'hidden' as const, mine: asker };
    const number = roundOf.get(round.id);
    const shownAnswers = round.answers.filter((entry) => entry.state === 'answered');
    const running = round.answers.filter((entry) => entry.state === 'queued' || entry.state === 'answering');
    const folded = shownAnswers.length > FOLLOWUP_ROUND_ANSWERS && !roundsOpen.has(round.id);
    const open = round.status === 'published';
    const hiddenToMe = round.status === 'hidden' && !asker;
    return (
      <article key={round.id} id={`f-${round.id}`} className={`fu-round scroll-mt-24${round.status === 'rejected' ? ' is-rejected' : ''}${hiddenToMe ? ' is-hidden' : ''}`}>
        {hiddenToMe ? (
          <p className="fu-hidden-note">{t2.hidden}</p>
        ) : (
          <>
            <span className="fu-round-rail" aria-hidden="true" />
            <div className="fu-round-head">
              <AuthorAvatar author={author} className="size-8" />
              <div className="min-w-0">
                <strong>
                  {who}
                  {round.author.poster && !isPrivate && (asker || round.author.name) && <span className="tag ml-1.5">{t2.poster}</span>}
                </strong>
                <span className="fu-round-meta">
                  {number ? `${fill(t2.round, { n: number })} · ` : ''}
                  {formatRelative(round.createdAt, now, locale, t.discover.public.qa.justNow)}
                </span>
              </div>
              {asker ? (
                confirm === round.id ? (
                  <span className="ml-auto inline-flex items-center gap-2 text-[11px] text-muted">
                    {t2.deleteConfirm}
                    <button type="button" className="text-red hover:underline" disabled={busy === round.id} onClick={() => void deleteRound(round)}>{t2.delete}</button>
                    <button type="button" className="hover:text-blue" onClick={() => setConfirm(null)}>{t.common.actions.cancel}</button>
                  </span>
                ) : (
                  <button type="button" className="icon-btn fu-round-tool" onClick={() => setConfirm(round.id)}>
                    <Icon name="trash" className="" />
                    {t2.delete}
                  </button>
                )
              ) : open && (
                confirm === round.id ? (
                  <span className="ml-auto inline-flex items-center gap-2 text-[11px] text-muted">
                    {t2.reportConfirm}
                    <button type="button" className="text-red hover:underline" disabled={busy === round.id} onClick={() => void reportRound(round)}>{t2.report}</button>
                    <button type="button" className="hover:text-blue" onClick={() => setConfirm(null)}>{t.common.actions.cancel}</button>
                  </span>
                ) : (
                  <button type="button" className="icon-btn fu-round-tool" onClick={() => setConfirm(round.id)}>
                    <Icon name="info" className="" />
                    {t2.report}
                  </button>
                )
              )}
            </div>
            <p className="fu-round-q">
              {round.mentions.map((entry) => (
                <span key={entry.reeId} className="fu-at">@{entry.reeName}</span>
              ))}
              {round.question}
            </p>
            {round.status === 'published' && round.answerState === 'done' && (round.mentions.length > 0 || round.candidates > round.skipped) && (
              <p className="fu-round-note">
                {round.mentions.length ? t2.byMention : round.skipped > 0 ? fill(t2.byRelevanceSkipped, { n: round.candidates - round.skipped, skipped: round.skipped }) : fill(t2.byRelevance, { n: round.candidates })}
              </p>
            )}
            <div className="fu-round-answers">
              {round.status === 'pending' && (
                <div className="post-state is-gathering">
                  <i className="spinner" />
                  <span>{t2.pending}</span>
                </div>
              )}
              {round.status === 'rejected' && <div className="post-state is-rejected">{t2.rejected}</div>}
              {round.status === 'hidden' && <div className="post-state is-rejected">{round.hiddenBy === 'admin' ? t2.hiddenAdmin : t2.hiddenReports}</div>}
              {round.status === 'published' && round.answerState !== 'done' && running.length === 0 && (
                <div className="post-state is-gathering">
                  <i className="spinner" />
                  <span>{round.mentions.length ? t2.waitingMention : t2.answering}</span>
                </div>
              )}
              {(folded ? shownAnswers.slice(0, FOLLOWUP_ROUND_ANSWERS) : shownAnswers).map((entry) => answerArticle(entry, open, round))}
              {folded && (
                <button type="button" className="fu-fold" onClick={() => setRoundsOpen((current) => new Set(current).add(round.id))}>
                  <Icon name="chevronDown" className="" />
                  {fill(t2.moreAnswers, { n: formatNumber(shownAnswers.length - FOLLOWUP_ROUND_ANSWERS, locale) })}
                </button>
              )}
              {running.map((entry) => waitingArticle(entry))}
              {/* A paid Ree waits for the asker: they see its card below; anyone else that it is being asked. */}
              {open && round.answerState === 'done' && !asker && round.awaiting > 0 && shownAnswers.length === 0 && running.length === 0 && (
                <div className="post-state is-gathering">
                  <span>{t2.waitingMention}</span>
                </div>
              )}
              {open && round.answerState === 'done' && shownAnswers.length === 0 && running.length === 0 && round.paidRequests.length === 0 && round.awaiting === 0 && (
                /* No Ree answered: its asker gets the AI's general answer (only they see it); everyone else, the line as before. */
                asker && round.aiAnswer && (round.aiAnswer.state === 'answered' || round.aiAnswer.state === 'running') ? (
                  <>
                    <AiRound
                      ai={round.aiOnly ? { ...round.aiAnswer, folded: false } : round.aiAnswer}
                      postId={post.id}
                      followupId={round.id}
                      compact
                      note={<p className="fu-round-note ai-round-note">{isPrivate ? a.followupNotePrivate : round.aiOnly ? a.followupNoteAiOnly : round.mentions.length ? a.followupNoteMentioned : a.followupNote}</p>}
                      onAskAi={askAi}
                      onChange={(next) => setAi(round.id, next)}
                      onRefresh={() => void refresh()}
                    />
                    {/* A 继续问 AI round leaves the ways to a Ree to the first AI answer's guide. */}
                    {round.aiAnswer.state === 'answered' && !round.aiOnly && <AiGuide items={followupGuide(round)} />}
                  </>
                ) : (
                  <>
                    {asker && !round.mentions.length ? (
                      <div className="post-state is-unmatched">
                        <span>{t2.noAnswerMine}</span>
                        <Link href={`/p/${post.id}?compose=public`}>{t2.postAnew} →</Link>
                      </div>
                    ) : (
                      <div className="post-state is-unmatched">{asker ? t2.mentionNoAnswer : t2.noAnswer}</div>
                    )}
                    {asker && round.aiAnswer?.state === 'skipped_balance' && <AiRound ai={round.aiAnswer} postId={post.id} followupId={round.id} onChange={(next) => setAi(round.id, next)} onRefresh={() => void refresh()} />}
                  </>
                )
              )}
              {/* A Ree answered after all: the asker's AI answer folds under the answers. */}
              {asker && round.aiAnswer?.folded && shownAnswers.length > 0 && <AiRound ai={round.aiAnswer} postId={post.id} followupId={round.id} compact onChange={(next) => setAi(round.id, next)} onRefresh={() => void refresh()} />}
              {asker && round.declined.length > 0 && <p className="post-skipped">{fill(t2.declined, { names: round.declined.join('、') })}</p>}
              {asker && round.spent !== null && round.spent > 0 && <p className="post-skipped">{fill(t2.spent, { n: formatNumber(round.spent, locale) })}</p>}
              {asker && open && round.paidRequests.length > 0 && paidSection(round.paidRequests, round.id)}
            </div>
          </>
        )}
      </article>
    );
  };

  /* On the post itself the answer count scrolls to the answers. */
  const answersLink = (
    <a
      href="#answers"
      className="icon-btn"
      title={c.answers}
      aria-label={`${c.answers} ${formatNumber(post.answered, locale)}`}
      onClick={(event) => {
        const target = document.getElementById('answers');
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.history.replaceState(null, '', '#answers');
      }}
    >
      <Icon name="chat" className="" />
      {formatNumber(post.answered, locale)}
    </a>
  );

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
            {isPrivate ? <PrivateBadge /> : category && <span className="tag">{category}</span>}
            {post.author.kind === 'example' && <span className="post-seed">{c.exampleTag}</span>}
          </div>
        </div>
      </header>
      {/* A renamed private post leads with its title; the question it asked follows. */}
      <h2 className="post-page-question">{(isPrivate && post.title) || post.question}</h2>
      {isPrivate && post.title && <p className="post-page-detail">{post.question}</p>}
      {post.detail && <p className="post-page-detail">{post.detail}</p>}
      {post.quote && (
        <div className="mt-3">
          <QuoteCard quote={post.quote} now={now} />
        </div>
      )}
      {isPrivate ? (
        <>
          <div className="post-actions">
            {answersLink}
            {live && (
              <>
                <button type="button" className="icon-btn" aria-pressed={post.pinned} disabled={busy === 'pin'} onClick={() => void update('pin', { pinned: !post.pinned })}>
                  <Icon name="pin" className={post.pinned ? 'text-blue' : ''} />
                  {post.pinned ? p.unpin : p.pin}
                </button>
                <button type="button" className="icon-btn" aria-pressed={post.archived} disabled={busy === 'archive'} onClick={() => void update('archive', { archived: !post.archived })}>
                  <Icon name="archive" className={post.archived ? 'text-blue' : ''} />
                  {post.archived ? p.unarchive : p.archive}
                </button>
                <button type="button" className="icon-btn" aria-expanded={renaming !== null} onClick={() => setRenaming((current) => (current === null ? (post.title ?? post.question).slice(0, POST_TITLE_MAX) : null))}>
                  <Icon name="text" className="" />
                  {p.rename}
                </button>
              </>
            )}
            {post.publishedCopyId ? (
              <Link href={`/p/${post.publishedCopyId}`} className="icon-btn is-make-public ml-auto">
                <Icon name="globe" className="" />
                {p.madePublic} →
              </Link>
            ) : (
              live && (
                <button type="button" className="icon-btn is-make-public ml-auto" aria-expanded={publishing !== null} onClick={() => setPublishing((current) => (current ? null : { anonymous: false }))}>
                  <Icon name="globe" className="" />
                  {p.makePublic}
                </button>
              )
            )}
            {!post.deleted && (
              <button type="button" className={`icon-btn${post.publishedCopyId || live ? '' : ' ml-auto'}`} disabled={busy === 'trash'} onClick={() => void trash(true)}>
                <Icon name="trash" className="" />
                {p.trash}
              </button>
            )}
          </div>
          {renaming !== null && (
            <form
              className="private-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <input type="text" aria-label={p.renameLabel} placeholder={p.renameHint} value={renaming} maxLength={POST_TITLE_MAX} autoFocus onChange={(event) => setRenaming(event.target.value)} />
              <button type="submit" className="btn btn-sm" disabled={busy === 'rename'}>
                {busy === 'rename' ? <i className="spinner" /> : null}
                {p.renameSave}
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setRenaming(null)}>
                {t.common.actions.cancel}
              </button>
            </form>
          )}
          {publishing && (
            <div className="private-publish" role="dialog" aria-label={p.makePublicTitle}>
              <strong>{p.makePublicTitle}</strong>
              <p>{p.makePublicBody}</p>
              <label>
                <input type="checkbox" checked={publishing.anonymous} onChange={(event) => setPublishing({ anonymous: event.target.checked })} />
                {p.makePublicAnonymous}
              </label>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setPublishing(null)}>
                {t.common.actions.cancel}
              </button>
              <button type="button" className="btn btn-sm" disabled={busy === 'publish'} onClick={() => void makePublic()}>
                {busy === 'publish' ? <i className="spinner" /> : <Icon name="globe" className="size-3.5" />}
                {p.makePublicGo}
              </button>
            </div>
          )}
          {post.archived && !post.deleted && <p className="post-skipped">{p.archivedNote}</p>}
        </>
      ) : (
      <div className="post-actions">
        <PostHelpful post={post} signedIn={signedIn} loginHref={loginHref} onChange={(change) => setPost((current) => ({ ...current, ...change }))} />
        {answersLink}
        {signedIn && live && (
          <button type="button" className="icon-btn" aria-pressed={post.saved} disabled={busy === 'save'} title={post.saved ? c.unsave : c.save} aria-label={post.saved ? c.unsave : c.save} onClick={() => void save()}>
            <Icon name="bookmark" className={post.saved ? 'text-blue' : ''} />
          </button>
        )}
        <button type="button" className="icon-btn" title={c.share} aria-label={c.share} onClick={() => void copy()}>
          <Icon name="link" className="" />
        </button>
        {live && !mine && (
          <Link href={quoteHref()} className="icon-btn" title={q.quotePostHint}>
            <Icon name="chat" className="" />
            {q.quotePost}
          </Link>
        )}
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
      )}

      {/* No Ree answered the first round: its author reads the AI's general answer (only they see it) and the ways to one with sources. */}
      {firstAi && shown.length === 0 && (firstAi.state === 'answered' || firstAi.state === 'running') ? (
        <>
          <div className="post-state is-unmatched ai-state">
            <span>
              {isPrivate ? (post.candidates === 0 ? a.stateAiOnly : a.statePrivate) : (
                <>
                  {a.state}
                  <strong>{a.stateStrong}</strong>
                  {a.stateTail}
                </>
              )}
            </span>
          </div>
          <AiRound ai={firstAi} postId={post.id} onAskAi={askAi} onChange={(next) => setAi(null, next)} onRefresh={() => void refresh()} />
          {firstAi.state === 'answered' && live && (
            <AiGuide items={firstGuide}>
              {requesting && <PrivateReePicker title={a.requestTitle} exclude={[]} inline scope="post" onPick={(option) => void requestRee(option)} onClose={() => setRequesting(false)} />}
            </AiGuide>
          )}
        </>
      ) : (
        <>
          <PostState post={post} />
          {firstAi?.state === 'skipped_balance' && shown.length === 0 && <AiRound ai={firstAi} postId={post.id} onChange={(next) => setAi(null, next)} onRefresh={() => void refresh()} />}
        </>
      )}

      {shown.length > 0 && (
        <div className="post-answers-head scroll-mt-24" id="answers">
          <strong>{fill(p.answersHeading, { n: formatNumber(shown.length, locale) })}</strong>
          {isPrivate ? <small>{fill(p.chosenNote, { n: formatNumber(post.answers.length, locale) })}</small> : post.candidates > 0 && <small>{fill(p.matchedNote, { candidates: formatNumber(post.candidates, locale) })}</small>}
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
                /* "[A2]": that answer's second citation, as a chip like an answer's (opens the same drawer); "[A]": the answer as a whole. */
                const kept = post.summary?.sources.find((entry) => entry.marker === marker);
                const answer = kept ? post.answers.find((entry) => entry.reeId === kept.reeId) : undefined;
                const label = kept && nameOf(kept.reeId) ? `${nameOf(kept.reeId)}${kept.index ? ` ${kept.index}` : ''}` : marker;
                if (kept?.citation && answer) {
                  const citation = kept.citation;
                  return (
                    <button key={key} type="button" className="synthesis-source" aria-label={label} onClick={() => setCitation({ entry: citation, answer })}>
                      {label}
                    </button>
                  );
                }
                return (
                  <span key={key} className="synthesis-source plain">
                    {label}
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
              <strong>{p.summaryTitle}</strong>：{post.summaryStale ? (post.summaryRewriteFree ? p.summaryStale : p.summaryStalePaid) : fill(isPrivate ? p.summaryHintPrivate : p.summaryHint, { n: shown.length })}
            </span>
            <button type="button" className="btn-secondary btn-sm" disabled={busy === 'summary'} onClick={() => void summarize()}>
              {busy === 'summary' ? <i className="spinner" /> : null}
              {post.summaryStale && post.summaryRewriteFree ? p.summaryAgain : fill(p.summaryGo, { fee: POST_SUMMARY_FEE })}
            </button>
          </div>
        )
      )}

      {shown.map((entry) => answerArticle(entry, live))}

      {/* A Ree has answered since: the author's AI answer folds to one line under the Rees' answers (kept, not refunded). */}
      {firstAi?.folded && shown.length > 0 && <AiRound ai={firstAi} postId={post.id} onChange={(next) => setAi(null, next)} onRefresh={() => void refresh()} />}
      {aiRoundsFolded &&
        (aiRoundsOpen ? (
          <section className="fu-thread ai-rounds" aria-label={a.aiRoundsTitle}>
            {aiRounds.map((entry) => roundArticle(entry))}
            <button type="button" className="fu-fold ai-folded" aria-expanded onClick={() => setAiRoundsOpen(false)}>
              <Icon name="chevronDown" className="rotate-180" />
              {a.aiRoundsFold}
            </button>
          </section>
        ) : (
          <button type="button" className="fu-fold ai-folded" aria-expanded={false} onClick={() => setAiRoundsOpen(true)}>
            <Icon name="sparkle" className="" />
            {fill(a.aiRoundsFolded, { n: formatNumber(aiRounds.length, locale) })}
          </button>
        ))}

      {waiting.map((entry) => waitingArticle(entry))}

      {mine && post.spent !== null && post.spent > 0 && <p className="post-skipped">{fill(isPrivate ? p.privateSpent : p.spent, { n: formatNumber(post.spent, locale) })}</p>}

      {mine && live && post.paidRequests.length > 0 && paidSection(post.paidRequests, null)}

      {!isPrivate && post.answerState === 'done' && post.skipped > 0 && post.answered > 0 && <p className="post-skipped">{fill(p.skipped, { n: formatNumber(post.skipped, locale) })}</p>}

      {(rounds.length > 0 || (live && (shown.length > 0 || (isPrivate && post.answerState === 'done') || post.followupAiOnly))) && (
        <section className="fu-thread" aria-label={t2.title}>
          {published.length > 0 && (
            <div className="post-answers-head">
              <strong>{fill(t2.heading, { n: formatNumber(published.length, locale) })}</strong>
            </div>
          )}
          {listedRounds.map((entry) =>
            entry === 'fold' ? (
              <button key="fold" type="button" className="fu-fold" onClick={() => setThreadOpen(true)}>
                <Icon name="chevronDown" className="" />
                {fill(t2.more, { n: formatNumber(rounds.length - FOLLOWUP_FOLD_HEAD - FOLLOWUP_FOLD_TAIL, locale) })}
              </button>
            ) : (
              roundArticle(entry)
            ),
          )}
          {live && (shown.length > 0 || (isPrivate && post.answerState === 'done') || post.followupAiOnly) && (
            <FollowupComposer ref={composer} postId={post.id} isPrivate={isPrivate} aiOnly={post.followupAiOnly} candidates={post.followupCandidates} signedIn={signedIn} loginHref={loginHref} blocked={post.followupBlocked} onAsked={() => void refresh()} />
          )}
        </section>
      )}

      {quoting && quoting.items.length > 0 && (
        <section className="post-quotes" aria-label={fill(q.quotedBy, { n: formatNumber(post.quotes, locale) })}>
          <h3>{fill(q.quotedBy, { n: formatNumber(post.quotes, locale) })}</h3>
          <PostFeed tab="latest" quotes={post.id} initial={quoting} now={now} signedIn={signedIn} />
        </section>
      )}

      <CitationDrawer
        citation={citation?.entry ?? null}
        ree={citation ? { id: citation.answer.reeId, name: citation.answer.reeName, avatarBlob: citation.answer.reeAvatar, color: citation.answer.reeColor } : null}
        canOpen={false}
        onClose={() => setCitation(null)}
      />
    </div>
  );
}
