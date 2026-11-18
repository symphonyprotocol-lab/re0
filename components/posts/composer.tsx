'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { POST_DETAIL_MAX, POST_FREE_PER_DAY, POST_MAX_ANSWERS, POST_QUESTION_MAX } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import './posts.css';

/** The private question's text, handed to `/talk` (talk-draft.tsx reads it once, under the same key). */
export const TALK_HANDOFF_KEY = 're0:talk-handoff';

interface Allowance {
  freeLeft: number;
  fee: number;
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
export function PublicPostForm({ mention: initialMention = null, autoFocus = false, onPosted }: { mention?: Mention | null; autoFocus?: boolean; onPosted?: () => void }) {
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
        body: JSON.stringify({ question, detail, anonymous, mentionReeId: mention?.id ?? null }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string; balance?: number; needed?: number };
      if (response.status === 201 && body.id) {
        onPosted?.();
        router.push(`/p/${body.id}`);
        return;
      }
      setError(
        body.error === 'insufficient_credits'
          ? fill(c.insufficient, { needed: formatNumber(body.needed ?? 0, locale), balance: formatNumber(body.balance ?? 0, locale) })
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="post-form">
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
        {allowance && (
          <span className="post-quota">
            {allowance.freeLeft > 0 ? fill(c.freeLeft, { n: allowance.freeLeft, total: POST_FREE_PER_DAY }) : fill(c.paid, { fee: allowance.fee })}
          </span>
        )}
        <button type="button" className="btn btn-sm" disabled={busy || !question.trim()} onClick={() => void publish()}>
          {busy ? <i className="spinner" /> : null}
          {busy ? c.publishing : c.publish}
        </button>
      </div>
    </div>
  );
}

/** 私密提问: the text goes to `/talk`, where the Rees are picked as in any conversation. */
function PrivateForm({ onGo }: { onGo: () => void }) {
  const { t } = useI18n();
  const c = t.posts.composer;
  const router = useRouter();
  const [question, setQuestion] = useState('');
  function go() {
    try {
      if (question.trim()) sessionStorage.setItem(TALK_HANDOFF_KEY, question.trim());
    } catch {
      /* storage off: /talk opens empty */
    }
    onGo();
    router.push('/talk');
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

  useEffect(() => {
    if (open) setTab(compose === 'private' ? 'private' : 'public');
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open, compose]);

  function close() {
    const next = new URLSearchParams(params.toString());
    for (const key of ['compose', 'ree', 'name']) next.delete(key);
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }

  return (
    <dialog ref={dialog} className="post-dialog" aria-label={c.label} onClose={() => open && close()} onClick={(event) => event.target === dialog.current && close()}>
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
          {tab === 'public' ? <PublicPostForm key={mention?.id ?? 'none'} mention={mention} autoFocus onPosted={() => dialog.current?.close()} /> : <PrivateForm onGo={() => dialog.current?.close()} />}
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
            <small className="text-[11px] text-muted">{fill(c.visitorBody, { n: POST_FREE_PER_DAY })}</small>
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
