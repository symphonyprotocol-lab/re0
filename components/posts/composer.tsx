'use client';

import { Suspense, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { POST_DETAIL_MAX, POST_MAX_ANSWERS, POST_QUESTION_MAX, PRIVATE_POST_MAX_REES, PRIVATE_POST_SUGGESTIONS, type PostQuote, type PostView, type PrivateReeOption } from '@/lib/domain/post';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { QuoteCard } from '@/components/posts/post-card';
import { PrivateReePicker } from '@/components/posts/ree-picker';
import { ImageButton, ImageTray, usePostImages } from '@/components/posts/post-images';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import './posts.css';
import '@/components/ui/tabs.css';

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

/** The link that last opened the composer: where focus goes back when the window closes (`openComposer`). */
let composerOpener: HTMLElement | null = null;

/**
 * A tap on a 发帖 link. iOS raises the keyboard only for a focus() made
 * inside the tap itself, and the window opens a render later (the address
 * changes first). So on a touch screen the tap focuses a hidden text field
 * at once; the window's question box takes the focus, and the keyboard,
 * from it as it opens. A field still holding the focus after a while (the
 * window never opened) lets it go.
 */
function openComposer(event: MouseEvent<HTMLAnchorElement>) {
  composerOpener = event.currentTarget;
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  const field = document.createElement('input');
  field.className = 'composer-keyboard';
  field.tabIndex = -1;
  field.setAttribute('aria-hidden', 'true');
  document.body.append(field);
  field.addEventListener('blur', () => field.remove(), { once: true });
  field.focus({ preventScroll: true });
  setTimeout(() => field.blur(), 2500);
}

function ComposeLinkInner({ className, label, children }: ComposeLinkProps) {
  return (
    <Link href={useComposeHref()} className={className} aria-label={label} title={label} scroll={false} onClick={openComposer}>
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
        <Link href="?compose=public" className={props.className} aria-label={props.label} title={props.label} scroll={false} onClick={openComposer}>
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
 * What a box that names one Ree (向 … 提问 on its share page and Ree page,
 * ree-ask.tsx) adds to either form: a line above the question (the 公开 /
 * 私密 switch), its own placeholder, the question it starts with and is
 * told of as it changes (the draft kept across signing in and switching),
 * and the new post's id before its page opens (the share page's conversion).
 */
export interface FormFrame {
  head?: ReactNode;
  placeholder?: string;
  question?: string;
  onQuestionChange?: (question: string) => void;
  onPublished?: (id: string) => void;
}

/**
 * The public post form (v5 "发帖"): the question, an optional detail, 匿名发布,
 * the mentioned Ree, and what today's post costs. Publishing opens the
 * post's page, which shows the Rees answering. `lockMention`: the box
 * belongs to that Ree, which shows as a chip that cannot be removed.
 */
export function PublicPostForm({ mention: initialMention = null, quote = null, autoFocus = false, leave, lockMention = false, head, placeholder, question: initialQuestion = '', onQuestionChange, onPublished }: { mention?: Mention | null; quote?: { postId: string; answerId: string | null } | null; autoFocus?: boolean; leave?: (navigate: () => void) => void; lockMention?: boolean } & FormFrame) {
  const { t, locale } = useI18n();
  const c = t.posts.composer;
  const router = useRouter();
  const toast = useToast();
  const [question, setQuestion] = useState(initialQuestion);
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
  const images = usePostImages();
  /* "图片上传中…" from an early Cmd/Ctrl+Enter goes once the uploads are done. */
  useEffect(() => {
    if (images.ready) setError((current) => (current === c.imageUploading ? null : current));
  }, [images.ready, c.imageUploading]);

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
    /* Cmd/Ctrl+Enter reaches here with uploads running or failed: say so rather than do nothing. */
    if (!images.ready) return setError(images.uploading ? c.imageUploading : c.imageFailed);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, detail, anonymous, mentionReeId: mention?.id ?? null, quotePostId: quote?.postId ?? null, quoteAnswerId: quote?.answerId ?? null, clientToken: token, images: images.pathnames }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string; balance?: number; needed?: number };
      if ((response.status === 201 || response.status === 200) && body.id) {
        /* Published: the form stays busy and empty until the post's page opens, so nothing can send it twice. */
        setQuestion('');
        setDetail('');
        images.clear();
        setToken(crypto.randomUUID());
        onPublished?.(body.id);
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
                : body.error === 'invalid_images' || body.error === 'too_many_images'
                  ? c.imageInvalid
                  : body.error === 'images_unsupported'
                    ? c.imageUnsupported
                    : c.failed,
      );
    } catch {
      toast(c.failed);
      setBusy(false);
    }
  }

  const write = (value: string) => {
    setQuestion(value);
    onQuestionChange?.(value);
  };

  return (
    <div className="post-form">
      {head}
      {quoted && (
        <div className="post-form-quote">
          <span className="post-hint">{t.posts.quote.quoting}</span>
          {quoted === 'loading' ? <p className="post-hint">{t.posts.quote.loading}</p> : <QuoteCard quote={quoted === 'gone' ? { kind: quote?.answerId ? 'answer' : 'post', available: false } : quoted} now={Date.now()} />}
        </div>
      )}
      {mention && lockMention ? (
        <div className="ree-pick">
          <span className="fu-chip ask-chip">
            <Icon name="at" className="size-3.5" />
            {mention.name}
          </span>
        </div>
      ) : mention && (
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
        placeholder={placeholder ?? c.placeholder}
        value={question}
        maxLength={POST_QUESTION_MAX + 50}
        autoFocus={autoFocus}
        onChange={(event) => write(event.target.value)}
        onPaste={images.onPaste}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void publish();
        }}
      />
      {showDetail && (
        <textarea className="post-detail" aria-label={c.detail} placeholder={c.detail} value={detail} maxLength={POST_DETAIL_MAX + 50} onPaste={images.onPaste} onChange={(event) => setDetail(event.target.value)} />
      )}
      <ImageTray images={images} />
      {error && (
        <p className="post-error" role="alert">
          {error}
        </p>
      )}
      {/* One line under the box (v6); the full sentence is the title of each short one. */}
      <p className="post-hint" title={fill(c.publicHint, { max: POST_MAX_ANSWERS })}>{fill(c.publicHintShort, { max: POST_MAX_ANSWERS })}</p>
      {/* A top-up when not even one answer is covered (2026-11-19). */}
      {allowance && allowance.balance < allowance.baseFee && (
        <p className="post-hint">
          <Link href="/settings?tab=balance" className="text-blue hover:underline">
            {fill(c.topUp, { fee: allowance.baseFee })} → {c.topUpGo}
          </Link>
        </p>
      )}
      <div className="post-composer-foot">
        {/* What posting costs, beside the buttons: nothing; each answer, and the most the automatic ones can cost. */}
        {allowance && (
          <small className="post-cost" title={fill(c.cost, { max: allowance.maxAnswers, fee: allowance.baseFee, total: allowance.maxCost })}>
            {fill(c.costShort, { fee: allowance.baseFee, total: allowance.maxCost })}
          </small>
        )}
        {!showDetail && (
          <button type="button" className="icon-btn" onClick={() => setShowDetail(true)}>
            <Icon name="plus" className="size-3.5" />
            {c.addDetail}
          </button>
        )}
        <ImageButton images={images} disabled={busy} />
        <label>
          <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />
          {c.anonymous}
        </label>
        <button type="button" className="btn btn-sm" disabled={busy || !question.trim() || !images.ready || (allowance !== null && allowance.balance < allowance.baseFee)} onClick={() => void publish()}>
          {busy ? <i className="spinner" /> : null}
          {busy ? c.publishing : c.publish}
        </button>
      </div>
    </div>
  );
}

/** The question that, unchanged this long, asks for suggested Rees. */
const SUGGEST_DELAY_MS = 600;

/** One private question's price at most: every chosen Ree answering. */
export function privateMaxCost(rees: readonly PrivateReeOption[]): number {
  return rees.reduce((sum, entry) => sum + entry.price, 0);
}

/**
 * 私密提问 (design 稿 2): the question, the Rees that answer it -- suggested
 * from the question (up to three, preselected), removable, more with
 * "选 Ree", at most five, each with its price -- and the most it can cost.
 * Sending holds every price shown at once and opens the private post; a
 * price raised meanwhile comes back to confirm again. `reeIds` (a link's
 * `&rees=`) preselects Rees instead of the suggestions; `rees` gives them
 * already resolved.
 */
export function PrivatePostForm({ reeIds = null, rees = null, question: initialQuestion = '', autoFocus = false, leave, head, placeholder, onQuestionChange, onPublished }: { reeIds?: string[] | null; rees?: PrivateReeOption[] | null; autoFocus?: boolean; leave?: (navigate: () => void) => void } & FormFrame) {
  const { t, locale } = useI18n();
  const c = t.posts.composer;
  const router = useRouter();
  const [question, setQuestion] = useState(initialQuestion);
  const [detail, setDetail] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [chosen, setChosen] = useState<PrivateReeOption[]>(rees ?? []);
  /* Once the author removes, adds or brings their own Rees, suggestions no longer replace their list. */
  const [touched, setTouched] = useState(Boolean(rees?.length || reeIds?.length));
  const [suggesting, setSuggesting] = useState(false);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lacking, setLacking] = useState(false);
  /* One token per question being written: a second submit of the same one opens the same post. */
  const [token, setToken] = useState(() => crypto.randomUUID());
  const images = usePostImages();
  /* "图片上传中…" from an early Cmd/Ctrl+Enter goes once the uploads are done. */
  useEffect(() => {
    if (images.ready) setError((current) => (current === c.imageUploading ? null : current));
  }, [images.ready, c.imageUploading]);

  const preset = reeIds?.join(',') ?? '';
  useEffect(() => {
    if (!preset || rees?.length) return;
    let live = true;
    fetch(`/api/posts/private/rees?${new URLSearchParams({ ids: preset })}`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? (response.json() as Promise<{ items: PrivateReeOption[] }>) : null))
      .then((body) => live && body && setChosen(body.items.slice(0, PRIVATE_POST_MAX_REES)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [preset, rees]);

  const text = question.trim();
  useEffect(() => {
    if (touched || !text) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSuggesting(true);
      try {
        const response = await fetch(`/api/posts/private/suggest?${new URLSearchParams({ q: text })}`, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (response.ok) setChosen(((await response.json()) as { items: PrivateReeOption[] }).items.slice(0, PRIVATE_POST_SUGGESTIONS));
      } catch {
        /* aborted by newer text, or offline: the list stays as it was */
      } finally {
        if (!controller.signal.aborted) setSuggesting(false);
      }
    }, SUGGEST_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, touched]);

  const total = privateMaxCost(chosen);
  const full = chosen.length >= PRIVATE_POST_MAX_REES;
  const remove = (reeId: string) => {
    setTouched(true);
    setChosen((current) => current.filter((entry) => entry.reeId !== reeId));
  };
  const add = (option: PrivateReeOption) => {
    setTouched(true);
    setChosen((current) => (current.some((entry) => entry.reeId === option.reeId) || current.length >= PRIVATE_POST_MAX_REES ? current : [...current, option]));
    setPicker(false);
  };

  async function send() {
    if (busy) return;
    if (!text) return setError(c.empty);
    if (text.length > POST_QUESTION_MAX || detail.trim().length > POST_DETAIL_MAX) return setError(fill(c.tooLong, { question: POST_QUESTION_MAX, detail: POST_DETAIL_MAX }));
    if (!images.ready) return setError(images.uploading ? c.imageUploading : c.imageFailed);
    /* No Ree chosen: 只问 AI -- a private post only the AI answers, at the base fee (AI 通用回答). */
    const aiOnly = chosen.length === 0;
    setBusy(true);
    setError(null);
    setLacking(false);
    try {
      const response = await fetch('/api/posts/private', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, detail, reeIds: chosen.map((entry) => entry.reeId), fees: Object.fromEntries(chosen.map((entry) => [entry.reeId, entry.price])), aiOnly, clientToken: token, images: images.pathnames }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string; balance?: number; needed?: number; prices?: { reeId: string; price: number }[] };
      if ((response.status === 201 || response.status === 200) && body.id) {
        /* Asked: the form stays busy until the post's page opens, so nothing is held twice. */
        setToken(crypto.randomUUID());
        onPublished?.(body.id);
        const go = () => router.push(`/p/${body.id}`);
        if (leave) leave(go);
        else go();
        return;
      }
      setBusy(false);
      if (body.error === 'price_changed' && body.prices) {
        /* Nothing was held: the new prices are shown and the author sends again to agree to them. */
        const prices = new Map(body.prices.map((entry) => [entry.reeId, entry.price]));
        setChosen((current) => current.map((entry) => (prices.has(entry.reeId) ? { ...entry, price: prices.get(entry.reeId)!, paid: prices.get(entry.reeId)! > QUERY_BASE_FEE } : entry)));
        return setError(c.priceChanged);
      }
      if (body.error === 'insufficient_credits') setLacking(true);
      setError(
        body.error === 'insufficient_credits'
          ? fill(c.insufficient, { needed: formatNumber(body.needed ?? 0, locale), balance: formatNumber(body.balance ?? 0, locale) })
          : body.error === 'daily_limit'
            ? c.dailyLimit
            : body.error === 'too_long'
              ? fill(c.tooLong, { question: POST_QUESTION_MAX, detail: POST_DETAIL_MAX })
              : body.error === 'empty'
                ? c.empty
                : body.error === 'no_rees'
                  ? c.noRees
                  : body.error === 'too_many_rees'
                    ? fill(c.tooManyRees, { max: PRIVATE_POST_MAX_REES })
                    : body.error === 'ree_unavailable'
                      ? c.reeUnavailable
                      : body.error === 'invalid_images' || body.error === 'too_many_images'
                        ? c.imageInvalid
                        : body.error === 'images_unsupported'
                          ? c.imageUnsupported
                          : c.failed,
      );
    } catch {
      setError(c.failed);
      setBusy(false);
    }
  }

  return (
    <div className="post-form">
      {head}
      <textarea
        aria-label={c.private}
        placeholder={placeholder ?? c.privatePlaceholder}
        value={question}
        maxLength={POST_QUESTION_MAX + 50}
        autoFocus={autoFocus}
        onChange={(event) => {
          setQuestion(event.target.value);
          onQuestionChange?.(event.target.value);
        }}
        onPaste={images.onPaste}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
        }}
      />
      {showDetail && (
        <textarea className="post-detail" aria-label={c.detail} placeholder={c.detail} value={detail} maxLength={POST_DETAIL_MAX + 50} onPaste={images.onPaste} onChange={(event) => setDetail(event.target.value)} />
      )}
      <ImageTray images={images} />
      <div className="ree-pick">
        <span className="post-hint">{chosen.length === 0 ? (suggesting ? c.suggesting : c.noSuggestion) : touched ? c.chosen : c.suggested}</span>
        {chosen.map((entry) => (
          <span key={entry.reeId} className="fu-chip">
            <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" className="size-[18px]!" />
            {entry.reeName}
            <small>{formatNumber(entry.price, locale)}</small>
            <button type="button" aria-label={fill(c.removeRee, { name: entry.reeName })} title={fill(c.removeRee, { name: entry.reeName })} onClick={() => remove(entry.reeId)}>
              <Icon name="close" className="" />
            </button>
          </span>
        ))}
        <button type="button" className="icon-btn chip-btn" data-ree-picker="" aria-expanded={picker} disabled={full} title={full ? fill(c.pickerFull, { max: PRIVATE_POST_MAX_REES }) : undefined} onClick={() => setPicker((current) => !current)}>
          <Icon name="plus" className="" />
          {c.pickRee}
        </button>
      </div>
      {picker && <PrivateReePicker title={c.pickRee} exclude={chosen.map((entry) => entry.reeId)} inline onPick={add} onClose={() => setPicker(false)} />}
      {error && (
        <p className="post-error" role="alert">
          {error}
        </p>
      )}
      {lacking && (
        <p className="post-hint">
          <Link href="/settings?tab=balance" className="text-blue hover:underline">
            {c.topUpGo} →
          </Link>
        </p>
      )}
      <p className="post-hint">{fill(c.privateHint, { max: PRIVATE_POST_MAX_REES })}</p>
      <div className="post-composer-foot">
        <small className="post-cost" title={fill(c.privateCostTitle, { fee: QUERY_BASE_FEE })}>
          {chosen.length === 0 ? fill(t.posts.ai.askAiCost, { fee: formatNumber(QUERY_BASE_FEE, locale) }) : fill(c.privateCost, { total: formatNumber(total, locale) })}
        </small>
        {!showDetail && (
          <button type="button" className="icon-btn" onClick={() => setShowDetail(true)}>
            <Icon name="plus" className="size-3.5" />
            {c.addDetail}
          </button>
        )}
        <ImageButton images={images} disabled={busy} />
        {chosen.length === 0 ? (
          <button type="button" className="btn btn-sm" title={fill(t.posts.ai.askAiHint, { fee: QUERY_BASE_FEE })} disabled={busy || !text || suggesting || !images.ready} onClick={() => void send()}>
            {busy ? <i className="spinner" /> : <Icon name="sparkle" className="size-3.5" />}
            {busy ? c.privateSending : fill(t.posts.ai.askAi, { fee: formatNumber(QUERY_BASE_FEE, locale) })}
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy || !text || !images.ready} onClick={() => void send()}>
            {busy ? <i className="spinner" /> : <Icon name="lock" className="size-3.5" />}
            {busy ? c.privateSending : c.privateSend}
          </button>
        )}
      </div>
      {chosen.length === 0 && text && !suggesting && <p className="post-hint ai-ask-only">{fill(t.posts.ai.askAiHint, { fee: QUERY_BASE_FEE })}</p>}
    </div>
  );
}

/**
 * The composer window: `?compose=public` (or `private`, and `&ree=<id>&name=`
 * for 发帖问它) on any workspace page opens it; closing drops the parameter.
 * The private tab takes `&rees=<id>,<id>` (the Rees to ask, preselected: a
 * share page, a Ree page, 一起问) and `&ask=<text>` (the question, prefilled;
 * the public tab too, for an AI answer's "换个说法再问").
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
  const reesParam = params.get('rees') ?? '';
  const reeIds = useMemo(() => (reesParam ? reesParam.split(',').filter(Boolean).slice(0, PRIVATE_POST_MAX_REES) : null), [reesParam]);
  const ask = params.get('ask') ?? '';

  useEffect(() => {
    if (open) setTab(compose === 'private' ? 'private' : 'public');
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      /*
       * The question box takes the first focus, not the 公开帖子 tab: the
       * form mounted (and React's autoFocus ran) while the window was still
       * closed, so it is marked for showModal's own focusing steps. Going
       * straight there keeps the keyboard a tap raised (`openComposer`).
       */
      element.querySelector('textarea')?.setAttribute('autofocus', '');
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open, compose]);

  /**
   * Closed in place: focus goes back to the 发帖 link that opened it when the
   * browser did not put it back -- the tap focused the keyboard field, or a
   * click left no focus at all -- and it is still on the closed window.
   */
  function closed() {
    exit.closed(() => {
      if (open) close();
      const active = document.activeElement;
      if ((!active || active === document.body || dialog.current?.contains(active)) && composerOpener?.isConnected) composerOpener.focus({ preventScroll: true });
      composerOpener = null;
    });
  }

  function close() {
    const next = new URLSearchParams(params.toString());
    for (const key of ['compose', 'ree', 'name', 'quote', 'qa', 'rees', 'ask']) next.delete(key);
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }

  return (
    <dialog ref={dialog} className="post-dialog" aria-label={c.label} onClose={closed} onClick={(event) => event.target === dialog.current && close()}>
      {open && (
        <div className="post-dialog-body">
          <header>
            <ComposerTabs tab={tab} onChange={setTab} />
            <button type="button" className="icon-btn" aria-label={c.close} title={c.close} onClick={close}>
              <Icon name="close" className="" />
            </button>
          </header>
          {tab === 'public' ? <PublicPostForm key={`${mention?.id ?? 'none'}:${quotePostId ?? ''}:${quoteAnswerId ?? ''}:${ask}`} mention={mention} quote={quote} question={ask} autoFocus leave={exit.leave} /> : <PrivatePostForm key={`${reesParam}:${ask}`} reeIds={reeIds} question={ask} autoFocus leave={exit.leave} />}
        </div>
      )}
    </dialog>
  );
}

/** 公开帖子 / 私密提问: the same two tabs in the 发帖 dialog and in 首页's box. */
function ComposerTabs({ tab, onChange, className = '' }: { tab: 'public' | 'private'; onChange: (tab: 'public' | 'private') => void; className?: string }) {
  const { t } = useI18n();
  const c = t.posts.composer;
  return (
    <div className={`cl-tabs ${className}`.trim()} role="tablist" aria-label={c.label}>
      {(['public', 'private'] as const).map((key) => (
        <button key={key} type="button" role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} onClick={() => onChange(key)}>
          <Icon name={key === 'public' ? 'globe' : 'lock'} className="" />
          {key === 'public' ? c.public : c.private}
        </button>
      ))}
    </div>
  );
}

export function PostComposerDialog() {
  return (
    <Suspense fallback={null}>
      <ComposerDialogInner />
    </Suspense>
  );
}

/**
 * 首页's box: for a signed-in user the dialog's two forms behind the same
 * 公开帖子 / 私密提问 tabs, the question kept across switching; a sign-in
 * card for a visitor.
 */
export function HomeComposer({ signedIn }: { signedIn: boolean }) {
  const { t } = useI18n();
  const c = t.posts.composer;
  const [tab, setTab] = useState<'public' | 'private'>('public');
  const [question, setQuestion] = useState('');
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
          <Link rel="nofollow" href="/login?returnTo=%2F%3Fcompose%3Dpublic" className="btn btn-sm">
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
      {tab === 'public' ? (
        <PublicPostForm key="public" head={<ComposerTabs tab={tab} onChange={setTab} className="composer-tabs" />} question={question} onQuestionChange={setQuestion} />
      ) : (
        <PrivatePostForm key="private" head={<ComposerTabs tab={tab} onChange={setTab} className="composer-tabs" />} question={question} onQuestionChange={setQuestion} />
      )}
    </div>
  );
}
