'use client';

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { POST_DETAIL_MAX, POST_MAX_ANSWERS, POST_QUESTION_MAX, type PostQuote, type PostView } from '@/lib/domain/post';
import { QuoteCard } from '@/components/posts/post-card';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { stripLocale } from '@/i18n/paths';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import './posts.css';

/** The private question's text, handed to `/talk` (talk-draft.tsx reads it once, under the same key). */
export const TALK_HANDOFF_KEY = 're0:talk-handoff';
/** The same, for a `/talk` page already open: it fills its box at once (talk-draft.tsx listens). */
export const TALK_HANDOFF_EVENT = 're0:talk-handoff';

/**
 * Leaving the composer window for another page. Closing a `<dialog>` fires
 * its `close` event a task later; that handler drops `?compose=` with a
 * `router.replace` of the current page, and a newer navigation discards an
 * older one -- so closing first and then pushing `/p/<id>` lands back where
 * the user was (review round 2, B1). Instead `leave` marks the exit and
 * navigates; the new address closes the window, and the `close` that
 * follows is swallowed once.
 */
export function composerExit() {
  let leaving = false;
  return {
    leave(navigate: () => void) {
      leaving = true;
      navigate();
    },
    /** The window closed: drop the parameter -- unless it closed because the page is leaving. */
    closed(dropParameter: () => void) {
      if (leaving) {
        leaving = false;
        return;
      }
      dropParameter();
    },
  };
}

/**
 * The current page's address with the composer opened on it: every
 * parameter the page has is kept (`/explore?tab=posts&q=…`), so closing
 * the window returns to exactly that page (review round 2, S7).
 */
export function composeHref(pathname: string, current: URLSearchParams | string, extra: Record<string, string> = {}): string {
  const next = new URLSearchParams(typeof current === 'string' ? current : current.toString());
  next.set('compose', extra.compose ?? 'public');
  for (const [key, value] of Object.entries(extra)) if (key !== 'compose') next.set(key, value);
  return `${pathname}?${next.toString()}`;
}

/** `composeHref` for the page being shown. Reads the address's parameters: render it inside a Suspense boundary (`ComposeLink` does). */
export function useComposeHref(extra: Record<string, string> = {}): string {
  const pathname = usePathname();
  const params = useSearchParams();
  return composeHref(pathname, params, extra);
}

type ComposeLinkProps = { className: string; label: string; children: ReactNode };

function ComposeLinkInner({ className, label, children }: ComposeLinkProps) {
  return (
    <Link href={useComposeHref()} className={className} aria-label={label} title={label} scroll={false}>
      {children}
    </Link>
  );
}

/**
 * The shell's 发帖 link, with the page's parameters kept (S7). Reading them
 * suspends where the address is not known yet (a static render), so the
 * boundary shows the same link opening the composer on the bare page.
 */
export function ComposeLink(props: ComposeLinkProps) {
  return (
    <Suspense
      fallback={
        <Link href="?compose=public" className={props.className} aria-label={props.label} title={props.label} scroll={false}>
          {props.children}
        </Link>
      }
    >
      <ComposeLinkInner {...props} />
    </Suspense>
  );
}

interface Allowance {
  balance: number;
  baseFee: number;
  maxAnswers: number;
  maxCost: number;
}

/** A Ree the post names ("发帖问它"): it answers first. */
export interface Mention {
  id: string;
  name: string;
}

/**
 * The public post form (v5 "发帖"): the question, an optional detail, 匿名发布,
 * the mentioned Ree, and what today's post costs. Publishing opens the
 * post's page, which shows the Rees answering.
 */
export function PublicPostForm({ mention: initialMention = null, quote = null, autoFocus = false, leave }: { mention?: Mention | null; quote?: { postId: string; answerId: string | null } | null; autoFocus?: boolean; leave?: (navigate: () => void) => void }) {
  const { t, locale } = useI18n();
  const c = t.posts.composer;
  const router = useRouter();
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [detail, setDetail] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [mention, setMention] = useState(initialMention);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* "引用提问": the quoted post (and answer) as the card will show it; quoting an answer names its Ree. */
  const [quoted, setQuoted] = useState<PostQuote | 'loading' | 'gone' | null>(quote ? 'loading' : null);
  useEffect(() => {
    if (!quote) return;
    let live = true;
    fetch(`/api/posts/${quote.postId}`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? (response.json() as Promise<PostView>) : null))
      .then((view) => {
        if (!live) return;
        const shown = quote.answerId ? view?.answers.find((entry) => entry.id === quote.answerId && entry.state === 'answered') : null;
        if (!view || view.status !== 'published' || view.deleted || (quote.answerId && !shown)) return setQuoted('gone');
        setQuoted({
          kind: shown ? 'answer' : 'post',
          available: true,
          postId: view.id,
          question: view.question,
          author: view.author,
          createdAt: view.createdAt,
          answer: shown ? { id: shown.id, reeName: shown.reeName, reeSlug: shown.reeSlug, reeAvatar: shown.reeAvatar, reeColor: shown.reeColor, text: shown.text.replace(/ ?\[\d{1,2}\]/g, '').slice(0, 160) } : null,
        });
        if (shown) setMention({ id: shown.reeId, name: shown.reeName });
      })
      .catch(() => live && setQuoted('gone'));
    return () => {
      live = false;
    };
  }, [quote]);
  /* One token per post being written: a second submit of the same one returns the same post (S4). */
  const [token, setToken] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let live = true;
    fetch('/api/posts/allowance', { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? (response.json() as Promise<Allowance>) : null))
      .then((value) => live && value && setAllowance(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function publish() {
    if (busy) return;
    if (!question.trim()) return setError(c.empty);
    if (question.trim().length > POST_QUESTION_MAX || detail.trim().length > POST_DETAIL_MAX) return setError(fill(c.tooLong, { question: POST_QUESTION_MAX, detail: POST_DETAIL_MAX }));
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, detail, anonymous, mentionReeId: mention?.id ?? null, quotePostId: quote?.postId ?? null, quoteAnswerId: quote?.answerId ?? null, clientToken: token }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string; balance?: number; needed?: number };
      if ((response.status === 201 || response.status === 200) && body.id) {
        /* Published: the form stays busy and empty until the post's page opens, so nothing can send it twice. */
        setQuestion('');
        setDetail('');
        setToken(crypto.randomUUID());
        const go = () => router.push(`/p/${body.id}`);
        if (leave) leave(go);
        else go();
        return;
      }
      setBusy(false);
      setError(
        body.error === 'insufficient_credits'
          ? fill(c.insufficient, { needed: formatNumber(body.needed ?? 0, locale), balance: formatNumber(body.balance ?? 0, locale) })
          : body.error === 'quote_unavailable'
            ? t.posts.quote.unavailable
          : body.error === 'daily_limit'
            ? c.dailyLimit
            : body.error === 'too_long'
              ? fill(c.tooLong, { question: POST_QUESTION_MAX, detail: POST_DETAIL_MAX })
              : body.error === 'empty'
                ? c.empty
                : c.failed,
      );
    } catch {
      toast(c.failed);
      setBusy(false);
    }
  }

  return (
    <div className="post-form">
      {quoted && (
        <div className="post-form-quote">
          <span className="post-hint">{t.posts.quote.quoting}</span>
          {quoted === 'loading' ? <p className="post-hint">{t.posts.quote.loading}</p> : <QuoteCard quote={quoted === 'gone' ? { kind: quote?.answerId ? 'answer' : 'post', available: false } : quoted} now={Date.now()} />}
        </div>
      )}
      {mention && (
        <div className="post-mention">
          <Icon name="at" className="size-3.5" />
          {fill(c.mention, { name: mention.name })}
          <button type="button" className="text-link" onClick={() => setMention(null)}>
            {c.removeMention}
          </button>
        </div>
      )}
      <textarea
        aria-label={c.label}
        placeholder={c.placeholder}
        value={question}
        maxLength={POST_QUESTION_MAX + 50}
        autoFocus={autoFocus}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void publish();
        }}
      />
      {showDetail && (
        <textarea className="post-detail" aria-label={c.detail} placeholder={c.detail} value={detail} maxLength={POST_DETAIL_MAX + 50} onChange={(event) => setDetail(event.target.value)} />
      )}
      {error && (
        <p className="post-error" role="alert">
          {error}
        </p>
      )}
      <p className="post-hint">{fill(c.publicHint, { max: POST_MAX_ANSWERS })}</p>
      {/* What posting costs (2026-11-19): nothing; each answer, the most the automatic ones can cost, and a top-up when not even one is covered. */}
      {allowance && (
        <p className="post-hint">
          {fill(c.cost, { max: allowance.maxAnswers, fee: allowance.baseFee, total: allowance.maxCost })}
          {allowance.balance < allowance.baseFee && (
            <>
              {' '}
              <Link href="/settings?tab=balance" className="text-blue hover:underline">
                {fill(c.topUp, { fee: allowance.baseFee })} → {c.topUpGo}
              </Link>
            </>
          )}
        </p>
      )}
      <div className="post-composer-foot">
        {!showDetail && (
          <button type="button" className="icon-btn" onClick={() => setShowDetail(true)}>
            <Icon name="plus" className="size-3.5" />
            {c.addDetail}
          </button>
        )}
        <label>
          <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />
          {c.anonymous}
        </label>
        <button type="button" className="btn btn-sm" disabled={busy || !question.trim() || (allowance !== null && allowance.balance < allowance.baseFee)} onClick={() => void publish()}>
          {busy ? <i className="spinner" /> : null}
          {busy ? c.publishing : c.publish}
        </button>
      </div>
    </div>
  );
}

/** 私密提问: the text goes to `/talk`, where the Rees are picked as in any conversation. */
function PrivateForm({ leave, stay }: { leave: (navigate: () => void) => void; stay: () => void }) {
  const { t } = useI18n();
  const c = t.posts.composer;
  const router = useRouter();
  const pathname = stripLocale(usePathname());
  const [question, setQuestion] = useState('');
  function go() {
    const text = question.trim();
    /* Already on /talk: its box takes the text now; nothing waits in storage for a later visit (O1). */
    if (pathname === '/talk') {
      if (text) window.dispatchEvent(new CustomEvent(TALK_HANDOFF_EVENT, { detail: text }));
      stay();
      return;
    }
    try {
      if (text) sessionStorage.setItem(TALK_HANDOFF_KEY, text);
    } catch {
      /* storage off: /talk opens empty */
    }
    leave(() => router.push('/talk'));
  }
  return (
    <div className="post-form">
      <textarea aria-label={c.private} placeholder={c.placeholder} value={question} onChange={(event) => setQuestion(event.target.value)} />
      <p className="post-hint">{c.privateHint}</p>
      <div className="post-composer-foot">
        <button type="button" className="btn btn-sm ml-auto" onClick={go}>
          {c.privateGo}
          <Icon name="arrow" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * The composer window: `?compose=public` (or `private`, and `&ree=<id>&name=`
 * for 发帖问它) on any workspace page opens it; closing drops the parameter.
 */
function ComposerDialogInner() {
  const { t } = useI18n();
  const c = t.posts.composer;
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const compose = params.get('compose');
  const [tab, setTab] = useState<'public' | 'private'>(compose === 'private' ? 'private' : 'public');
  const dialog = useRef<HTMLDialogElement>(null);
  const open = compose === 'public' || compose === 'private';
  const mentionId = params.get('ree');
  const mention = mentionId ? { id: mentionId, name: params.get('name') ?? '' } : null;
  const quotePostId = params.get('quote');
  const quoteAnswerId = params.get('qa');
  const quote = useMemo(() => (quotePostId ? { postId: quotePostId, answerId: quoteAnswerId } : null), [quotePostId, quoteAnswerId]);
  const exit = useRef(composerExit()).current;

  useEffect(() => {
    if (open) setTab(compose === 'private' ? 'private' : 'public');
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open, compose]);

  function close() {
    const next = new URLSearchParams(params.toString());
    for (const key of ['compose', 'ree', 'name', 'quote', 'qa']) next.delete(key);
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }

  return (
    <dialog ref={dialog} className="post-dialog" aria-label={c.label} onClose={() => exit.closed(() => open && close())} onClick={(event) => event.target === dialog.current && close()}>
      {open && (
        <div className="post-dialog-body">
          <header>
            <div className="cl-tabs" role="tablist" aria-label={c.label}>
              {(['public', 'private'] as const).map((key) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
                  <Icon name={key === 'public' ? 'globe' : 'lock'} className="" />
                  {key === 'public' ? c.public : c.private}
                </button>
              ))}
            </div>
            <button type="button" className="icon-btn" aria-label={c.close} title={c.close} onClick={close}>
              <Icon name="close" className="" />
            </button>
          </header>
          {tab === 'public' ? <PublicPostForm key={`${mention?.id ?? 'none'}:${quotePostId ?? ''}:${quoteAnswerId ?? ''}`} mention={mention} quote={quote} autoFocus leave={exit.leave} /> : <PrivateForm leave={exit.leave} stay={close} />}
        </div>
      )}
    </dialog>
  );
}

export function PostComposerDialog() {
  return (
    <Suspense fallback={null}>
      <ComposerDialogInner />
    </Suspense>
  );
}

/** 首页's box: the form for a signed-in user, a sign-in card for a visitor. */
export function HomeComposer({ signedIn }: { signedIn: boolean }) {
  const { t } = useI18n();
  const c = t.posts.composer;
  if (!signedIn) {
    return (
      <div className="post-composer is-visitor">
        <span className="grid size-10 place-items-center rounded-full bg-soft text-blue">
          <Icon name="chat" className="size-4" />
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <strong className="block text-[13px]">{c.visitorTitle}</strong>
            <small className="text-[11px] text-muted">{c.visitorBody}</small>
          </div>
          <Link href="/login?returnTo=%2F%3Fcompose%3Dpublic" className="btn btn-sm">
            {c.signIn}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="post-composer">
      <span className="grid size-10 place-items-center rounded-full bg-soft text-blue">
        <Icon name="chat" className="size-4" />
      </span>
      <PublicPostForm />
    </div>
  );
}
