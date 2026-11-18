'use client';

import { useState, type ReactNode } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { CitationSnapshot } from '@/lib/domain/answer';
import type { PublicQa, PublicQaPage } from '@/lib/domain/public-qa';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatRelative } from '@/i18n/format';
import { AnswerText, Avatar, CitationChips, CitationDrawer } from '@/components/chat/message-parts';
import { Icon } from '@/components/ui/icons';
import { UserAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import './feed.css';

export interface QaRee {
  id: string;
  slug: string;
  name: string;
  avatarBlob: string | null;
  color: string;
}

/**
 * One question and its answer as the Ree page shows it (the design's
 * `.ree-qa`): who asked and when above, the question bubble and the Ree's
 * answer bubble in the chat pages' style, actions below.
 */
export function QaThread({ id, asker, initials = '?', meta, question, answer, footer, mine = false }: {
  id?: string;
  asker: string;
  /** What the round avatar shows: "?" for someone else, the viewer's own word for "you". */
  initials?: string;
  meta: ReactNode;
  question: string;
  answer: ReactNode;
  footer?: ReactNode;
  mine?: boolean;
}) {
  return (
    <article id={id} className={`scroll-mt-24 rounded-xl border border-line bg-wash p-4${mine ? ' ree-qa-mine' : ''}`}>
      <header className="ree-qa-meta">
        <UserAvatar name={initials} className="size-7" />
        <strong>{asker}</strong>
        {meta}
      </header>
      {/* The chat pages' answer, citation and typing styles are scoped to `.studio-conversation` (conversations.css). */}
      <div className="studio-conversation flex flex-col gap-3" style={{ background: 'transparent' }}>
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-blue px-3.5 py-2 text-[13px] whitespace-pre-wrap text-white">{question}</p>
        </div>
        {answer}
      </div>
      {footer}
    </article>
  );
}

/** The Ree's answer bubble: avatar and white bubble, the text with its citation numbers, the source chips. */
export function AnswerBubble({ ree, text, citations, onCitation, children }: {
  ree: QaRee;
  text: string;
  citations: CitationSnapshot[];
  onCitation: (entry: CitationSnapshot) => void;
  children?: ReactNode;
}) {
  return (
    <article className="flex gap-2.5">
      <Avatar ree={ree} sm />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-[13px]">
        <AnswerText text={text} citations={citations} onCitation={onCitation} />
        {children}
        <CitationChips citations={citations} onCitation={onCitation} />
      </div>
    </article>
  );
}

export const qaAnchor = (id: string) => `qa-${id}`;

/**
 * The Ree page's public Q&A (lib/services/public-qa.ts): the pinned answer,
 * then the newest, ten at a time. Anyone may expand an answer, copy its
 * link or report it; signed in, mark it helpful; the owner pins and hides.
 */
export function PublicQaList({ ree, initial, signedIn, owner, loginHref, renderedAt, onFollowUp }: {
  ree: QaRee;
  initial: PublicQaPage;
  signedIn: boolean;
  owner: boolean;
  loginHref: string;
  renderedAt: number;
  /** "我也问一句": put a question about this one into the box above. */
  onFollowUp: (question: string) => void;
}) {
  const { t, locale } = useI18n();
  const q = t.discover.public.qa;
  const toast = useToast();
  const [page, setPage] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; kind: 'report' | 'hide' } | null>(null);
  const [citation, setCitation] = useState<CitationSnapshot | null>(null);
  const endpoint = `/api/rees/${ree.id}/public-qa`;

  const replace = (id: string, change: Partial<PublicQa>) =>
    setPage((current) => ({ ...current, items: current.items.map((item) => (item.id === id ? { ...item, ...change } : item)) }));

  async function more() {
    if (!page.next || loading) return;
    setLoading(true);
    try {
      const response = await fetch(`${endpoint}?before=${page.next}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as PublicQaPage;
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

  async function expand(item: PublicQa) {
    setBusy(item.id);
    try {
      const response = await fetch(`${endpoint}/${item.id}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const { item: whole } = (await response.json()) as { item: PublicQa };
      replace(item.id, { answer: whole.answer, truncated: false });
    } catch {
      toast(q.loadError);
    } finally {
      setBusy(null);
    }
  }

  async function helpful(item: PublicQa) {
    setBusy(item.id);
    try {
      const response = await fetch(`${endpoint}/${item.id}/helpful`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !item.voted }) });
      if (!response.ok) throw new Error(String(response.status));
      replace(item.id, (await response.json()) as { helpful: number; voted: boolean });
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  async function copyLink(item: PublicQa) {
    const url = `${window.location.origin}/r/${ree.slug}#${qaAnchor(item.id)}`;
    await navigator.clipboard.writeText(url).then(() => toast(t.common.actions.copied), () => toast(t.common.errors.generic));
  }

  async function report(item: PublicQa) {
    setBusy(item.id);
    setConfirm(null);
    try {
      const response = await fetch(`${endpoint}/${item.id}/report`, { method: 'POST' });
      if (!response.ok) throw new Error(String(response.status));
      toast(q.reported);
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  async function act(item: PublicQa, action: 'hide' | 'pin' | 'unpin') {
    setBusy(item.id);
    setConfirm(null);
    try {
      const response = await fetch(`${endpoint}/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error(String(response.status));
      setPage((current) => {
        if (action === 'hide') return { ...current, total: Math.max(0, current.total - 1), items: current.items.filter((entry) => entry.id !== item.id) };
        const items = current.items.map((entry) => ({ ...entry, pinned: action === 'pin' ? entry.id === item.id : entry.id === item.id ? false : entry.pinned }));
        return { ...current, items: action === 'pin' ? [...items.filter((entry) => entry.pinned), ...items.filter((entry) => !entry.pinned)] : items };
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
    <div className="ree-qa-list" aria-label={q.list}>
      {page.items.map((item) => {
        const asker = item.author ?? (item.asker === 'user' ? q.someUser : q.visitor);
        const confirming = confirm?.id === item.id ? confirm.kind : null;
        return (
          <QaThread
            key={item.id}
            id={qaAnchor(item.id)}
            asker={asker}
            question={item.question}
            meta={
              <>
                <span>· {formatRelative(item.publishedAt, renderedAt, locale, q.justNow)}</span>
                {item.pinned && (
                  <span className="tag">
                    <Icon name="pin" className="size-3" />
                    {q.pinned}
                  </span>
                )}
                <span className="ree-qa-flag">
                  {confirming === 'report' ? (
                    <>
                      {q.reportConfirm}
                      <button type="button" className="text-red hover:underline" disabled={busy === item.id} onClick={() => void report(item)}>{q.report}</button>
                      <button type="button" className="hover:text-blue" onClick={() => setConfirm(null)}>{t.common.actions.cancel}</button>
                    </>
                  ) : (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-blue" onClick={() => setConfirm({ id: item.id, kind: 'report' })}>
                      <Icon name="info" />
                      {q.report}
                    </button>
                  )}
                </span>
              </>
            }
            answer={
              <AnswerBubble ree={ree} text={item.answer} citations={item.citations} onCitation={setCitation}>
                {item.truncated && (
                  <button type="button" className="ree-qa-more" disabled={busy === item.id} onClick={() => void expand(item)}>
                    {q.expand}
                  </button>
                )}
              </AnswerBubble>
            }
            footer={
              <div className="ree-qa-foot">
                {signedIn ? (
                  <button type="button" className="icon-btn" aria-pressed={item.voted} disabled={busy === item.id} onClick={() => void helpful(item)}>
                    <Icon name="thumbUp" />
                    {fill(q.helpful, { n: formatNumber(item.helpful, locale) })}
                  </button>
                ) : (
                  <Link href={loginHref} className="icon-btn" title={q.helpfulSignIn}>
                    <Icon name="thumbUp" />
                    {fill(q.helpful, { n: formatNumber(item.helpful, locale) })}
                  </Link>
                )}
                <button type="button" className="icon-btn ree-qa-follow" onClick={() => onFollowUp(item.question)}>
                  <Icon name="chat" />
                  {q.followUp}
                </button>
                <button type="button" className="icon-btn" onClick={() => void copyLink(item)}>
                  <Icon name="link" />
                  {q.copyLink}
                </button>
                <Link href={`/p/${item.postId}`} className="icon-btn">
                  <Icon name="arrow" />
                  {t.posts.rees.viewPost}
                </Link>
                {owner && (
                  <span className="ml-auto flex items-center gap-0.5">
                    <button type="button" className="icon-btn" disabled={busy === item.id} onClick={() => void act(item, item.pinned ? 'unpin' : 'pin')}>
                      <Icon name="pin" />
                      {item.pinned ? q.unpin : q.pin}
                    </button>
                    {confirming === 'hide' ? (
                      <button type="button" className="icon-btn text-red!" disabled={busy === item.id} onClick={() => void act(item, 'hide')}>
                        {q.hideConfirm}
                      </button>
                    ) : (
                      <button type="button" className="icon-btn" onClick={() => setConfirm({ id: item.id, kind: 'hide' })}>
                        <Icon name="close" />
                        {q.hide}
                      </button>
                    )}
                  </span>
                )}
              </div>
            }
          />
        );
      })}
      {page.next && (
        <div className="pt-2 text-center">
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={() => void more()}>
            {loading ? <i className="spinner" /> : null}
            {q.more}
          </button>
        </div>
      )}
      <CitationDrawer citation={citation} ree={ree} canOpen={false} onClose={() => setCitation(null)} />
    </div>
  );
}
