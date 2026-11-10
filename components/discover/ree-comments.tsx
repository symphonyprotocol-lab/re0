'use client';

import { useRef, useState, type FormEvent } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Icon } from '@/components/ui/icons';
import { UserAvatar } from '@/components/ui/ree-avatar';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import {
  REE_COMMENT_MAX_LENGTH,
  REE_COMMENTS_ANCHOR,
  reeCommentContent,
  type ReeComment,
  type ReeCommentPage,
} from '@/lib/domain/ree-comment';

type Issue = 'loadError' | 'publishError' | 'invalid' | 'expired' | 'unavailable' | 'rateLimited' | 'removeError';

function commentTime(value: string, now: number, locale: 'zh' | 'en', justNow: string) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes === 0) return justNow;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 60) return relative.format(-minutes, 'minute');
  if (minutes < 1_440) return relative.format(-Math.floor(minutes / 60), 'hour');
  if (minutes < 10_080) return relative.format(-Math.floor(minutes / 1_440), 'day');
  return formatDateTime(value, locale);
}

export function ReeComments({ reeId, initial, signedIn, loginHref, renderedAt }: {
  reeId: string;
  initial: ReeCommentPage;
  signedIn: boolean;
  loginHref: string;
  renderedAt: number;
}) {
  const { t, locale } = useI18n();
  const c = t.discover.public.comments;
  const [page, setPage] = useState(initial);
  const [now, setNow] = useState(renderedAt);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<'post' | 'load' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [posted, setPosted] = useState(false);
  const retry = useRef<{ id: string; content: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const content = reeCommentContent(draft);
  const endpoint = `/api/rees/${reeId}/comments`;
  const count = formatNumber(page.total, locale);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !signedIn || !content) return;
    setPending('post');
    setPosted(false);
    setIssue(null);
    try {
      const attempt = retry.current?.content === content ? retry.current : { id: crypto.randomUUID(), content };
      retry.current = attempt;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(attempt),
      });
      if (!response.ok) {
        if (response.status === 409) retry.current = null;
        setIssue(response.status === 401 ? 'expired' : response.status === 404 ? 'unavailable'
          : response.status === 422 ? 'invalid' : response.status === 429 ? 'rateLimited' : 'publishError');
        return;
      }
      const { comment } = await response.json() as { comment: ReeComment };
      setPage(current => current.items.some(item => item.id === comment.id) ? current : {
        ...current,
        items: [comment, ...current.items],
        total: current.total + 1,
      });
      retry.current = null;
      setNow(Date.now());
      setDraft('');
      setPosted(true);
      input.current?.focus({ preventScroll: true });
    } catch {
      setIssue('publishError');
    } finally {
      setPending(null);
    }
  }

  async function remove(id: string) {
    if (removing) return;
    setRemoving(id);
    setIssue(null);
    try {
      const response = await fetch(`${endpoint}/${id}`, { method: 'DELETE' });
      /* Already gone counts as done. */
      if (!response.ok && response.status !== 404) {
        setIssue(response.status === 401 ? 'expired' : 'removeError');
        return;
      }
      setPage(current => current.items.some(item => item.id === id)
        ? { ...current, items: current.items.filter(item => item.id !== id), total: Math.max(0, current.total - 1) }
        : current);
    } catch {
      setIssue('removeError');
    } finally {
      setRemoving(null);
    }
  }

  async function loadMore() {
    if (!page.next || pending) return;
    setPending('load');
    setIssue(null);
    try {
      const response = await fetch(`${endpoint}?before=${encodeURIComponent(page.next)}`);
      if (!response.ok) {
        setIssue(response.status === 404 ? 'unavailable' : 'loadError');
        return;
      }
      const older = await response.json() as ReeCommentPage;
      setPage(current => ({ ...older, items: [...current.items, ...older.items] }));
      setNow(Date.now());
    } catch {
      setIssue('loadError');
    } finally {
      setPending(null);
    }
  }

  return (
    <section id={REE_COMMENTS_ANCHOR} aria-labelledby="ree-comments-heading" className="card min-w-0 scroll-mt-24 p-5 sm:p-7 lg:col-start-1 lg:row-start-2">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <h2 id="ree-comments-heading" className="flex items-center gap-2 text-[16px] font-bold">
            <Icon name="chat" className="size-4 text-blue" />
            {c.heading}
          </h2>
          <span className="min-w-6 rounded-full bg-soft px-2 py-0.5 text-center text-[11px] font-semibold text-blue tabular-nums" aria-live="polite">
            <span aria-hidden="true">{count}</span>
            <span className="sr-only">{fill(c.count, { n: count })}</span>
          </span>
        </div>
        <p className="mt-1 text-[12px] text-muted">{c.description}</p>
      </header>

      {signedIn ? (
        <form onSubmit={publish}>
          <label className="field-label" htmlFor="ree-comment-content">{c.label}</label>
          <textarea
            id="ree-comment-content"
            ref={input}
            className="input block min-h-[84px] resize-y bg-wash"
            rows={3}
            maxLength={REE_COMMENT_MAX_LENGTH}
            placeholder={c.placeholder}
            aria-describedby="ree-comment-visibility ree-comment-length"
            readOnly={pending === 'post'}
            value={draft}
            onChange={event => {
              setDraft(event.target.value);
              setPosted(false);
            }}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p id="ree-comment-visibility" className="text-[11px] text-muted">{c.visibility}</p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span id="ree-comment-length" className="text-[11px] text-muted tabular-nums">{draft.length} / {REE_COMMENT_MAX_LENGTH}</span>
              <button className="btn btn-sm" type="submit" disabled={Boolean(pending) || !content}>
                {pending === 'post' ? c.publishing : c.publish}
              </button>
            </div>
          </div>
          <div role="status" className="text-[12px] text-green">{posted && <p className="mt-2">{c.published}</p>}</div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-wash px-4 py-3">
          <div>
            <p className="text-[13px] font-semibold">{c.signInHeading}</p>
            <p className="text-[12px] text-muted">{c.signInHint}</p>
          </div>
          <Link href={loginHref} className="btn-secondary btn-sm text-blue">
            {c.signIn}
            <Icon name="arrow" className="size-3.5" />
          </Link>
        </div>
      )}

      {issue && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <p role="alert" className="text-red">{fill(c[issue], { max: REE_COMMENT_MAX_LENGTH })}</p>
          {issue === 'expired' && <Link href={loginHref} className="text-link">{c.signIn}</Link>}
        </div>
      )}

      {page.items.length > 0 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-2 pb-2 text-[11px]">
            <h3 id="ree-comment-list-heading" className="font-semibold">{c.list}</h3>
            <span className="text-muted">{c.newestFirst}</span>
          </div>
          <ul aria-labelledby="ree-comment-list-heading">
            {page.items.map(comment => (
              <li key={comment.id} className="flex items-start gap-3 border-t border-line py-3 last:pb-0">
                <UserAvatar name={comment.authorName} avatar={comment.authorAvatar} className="size-8" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <strong className="text-[12px] font-semibold [overflow-wrap:anywhere]">{comment.authorName}</strong>
                    <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt, locale)} className="text-[11px] text-muted">
                      {commentTime(comment.createdAt, now, locale, c.justNow)}
                    </time>
                    {comment.canDelete && (
                      <button
                        type="button"
                        className="ml-auto text-[11px] text-muted hover:text-red disabled:opacity-60"
                        aria-label={c.removeLabel}
                        disabled={removing !== null}
                        onClick={() => remove(comment.id)}
                      >
                        {removing === comment.id ? c.removing : c.remove}
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.content}</p>
                </div>
              </li>
            ))}
          </ul>
          {page.next && (
            <button type="button" className="btn-secondary btn-sm mt-4" onClick={loadMore} disabled={Boolean(pending)}>
              {pending === 'load' ? c.loading : c.more}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-col items-center border-t border-line pt-5 text-center">
          <span className="mb-2 grid size-9 place-items-center rounded-lg bg-soft text-blue"><Icon name="chat" /></span>
          <p className="text-[13px] font-semibold">{c.emptyTitle}</p>
          <p className="mt-0.5 text-[12px] text-muted">{c.emptyBody}</p>
        </div>
      )}
    </section>
  );
}
