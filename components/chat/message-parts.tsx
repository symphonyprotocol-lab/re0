'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useEffect, type ReactNode, type RefObject } from 'react';
import { locatorLabel, type CitationSnapshot } from '@/lib/domain/answer';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { KIND_ICONS } from '@/components/knowledge/kind-icons';
import { Markdown } from '@/components/chat/markdown';
import { Icon, type IconName } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import '@/components/conversations/conversations.css';

/*
 * The pieces every conversation page draws the prototype's way (app.js
 * `messageHTML`, `citationModal`), styled by
 * components/conversations/conversations.css.
 */

/** An icon sized by the stylesheet, 18px when no rule sizes it (the prototype's `I()`). */
export function I({ name }: { name: IconName }) {
  return <Icon name={name} className="" width={18} height={18} />;
}

/** A Ree's `.dot-avatar`, its color as the prototype's modifier class. */
export function Avatar({ ree, sm = false }: { ree: { avatarBlob?: string | null; color?: string | null } | null; sm?: boolean }) {
  const color = ree?.color && ree.color !== 'default' ? ` ${ree.color}` : '';
  return <ReeAvatar avatar={ree?.avatarBlob} color={ree?.color} size="sm" className={`dot-avatar${color}${sm ? ' sm' : ''}`} />;
}

/** The three dots while a Ree is still looking for its answer (prototype `.typing`). */
export function Typing() {
  return (
    <div className="typing" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

/**
 * The top bar's height as `--navigation-height` on the page, which sizes the
 * chat to the window under it (prototype app.js sets it on `.app-main`).
 */
export function useNavigationHeight(page: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>('[data-topbar]');
    const root = page.current;
    if (!root) return;
    const measure = () => root.style.setProperty('--navigation-height', `${bar ? bar.getBoundingClientRect().height : 0}px`);
    measure();
    if (!bar) return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [page]);
}

/** An answer's text: Markdown, its `[n]` markers as citation buttons. */
export function AnswerText({ text, citations, failed, onCitation, children }: { text: string; citations: CitationSnapshot[]; failed?: boolean; onCitation: (entry: CitationSnapshot) => void; children?: ReactNode }) {
  const { t } = useI18n();
  const byIndex = new Map(citations.map((entry) => [entry.index, entry]));
  return (
    <div className="answer-text">
      {text && (
        <Markdown
          className="answer-markdown"
          text={text}
          citation={(index, key) => {
            const entry = byIndex.get(index);
            return entry ? (
              <button key={key} type="button" className="citation" onClick={() => onCitation(entry)} aria-label={fill(t.chat.citation, { n: index })}>
                {index}
              </button>
            ) : (
              <sup key={key} className="mono">
                [{index}]
              </sup>
            );
          }}
        />
      )}
      {children}
      {failed && <p className="answer-failed">{t.chat.failed}</p>}
    </div>
  );
}

export function CitationChips({ citations, onCitation }: { citations: CitationSnapshot[]; onCitation: (entry: CitationSnapshot) => void }) {
  const { locale } = useI18n();
  if (!citations.length) return null;
  return (
    <div className="citation-chips">
      {citations.map((entry) => {
        const where = locatorLabel(entry.locator, locale);
        return (
          <button key={entry.index} type="button" className="citation-chip" onClick={() => onCitation(entry)}>
            <I name={KIND_ICONS[entry.kind]} />
            <span>
              {entry.index} · {entry.title}
              {where && ` · ${where}`}
            </span>
            <I name="external" />
          </button>
        );
      })}
    </div>
  );
}

/** 有用 / 没用 / 复制回答 and what the answer cost (prototype `.message-feedback`). */
export function Feedback({ text, vote, onVote, cost, title }: { text: string; vote?: 'up' | 'down' | null; onVote?: (value: 'up' | 'down') => void; cost: string; title?: string }) {
  const { t } = useI18n();
  const r = t.conversations.room;
  const toast = useToast();
  return (
    <div className="message-feedback">
      {onVote && (
        <>
          <button type="button" className="icon-btn" aria-label={r.helpful} title={r.helpful} aria-pressed={vote === 'up'} onClick={() => onVote('up')}>
            <I name="thumbUp" />
          </button>
          <button type="button" className="icon-btn" aria-label={r.notHelpful} title={r.notHelpful} aria-pressed={vote === 'down'} onClick={() => onVote('down')}>
            <I name="thumbDown" />
          </button>
        </>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label={r.copy}
        title={r.copy}
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          toast(t.common.actions.copied);
        }}
      >
        <I name="copy" />
      </button>
      <small title={title}>{cost}</small>
    </div>
  );
}

/**
 * 「答案，从这里来。」: the cited passage as it was when answered, its kind and
 * place, and the Ree it came from; the owner can open the source itself.
 */
export function CitationDrawer({
  citation,
  ree,
  canOpen,
  onClose,
}: {
  citation: CitationSnapshot | null;
  ree: { id: string; name: string; avatarBlob?: string | null; color?: string | null } | null;
  canOpen: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const d = t.chat.drawer;
  const toast = useToast();
  const where = citation ? locatorLabel(citation.locator, locale) : '';
  return (
    <Modal
      open={Boolean(citation)}
      onClose={onClose}
      variant="drawer"
      title={d.title}
      subtitle={citation?.title}
      footer={
        citation && (
          <div className="conv-citation conv-citation-actions">
            {canOpen && ree && (
              <Link className="btn secondary" href={`/rees/${ree.id}/knowledge/${citation.knowledgeId}${citation.locator.time !== undefined ? `?t=${Math.floor(citation.locator.time)}` : ''}`}>
                <I name="external" />
                {d.open}
              </Link>
            )}
            <button
              type="button"
              className="btn secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(`${citation.title}${where ? ` · ${where}` : ''}\n${citation.excerpt}`);
                toast(t.common.actions.copied);
              }}
            >
              <I name="copy" />
              {d.copy}
            </button>
          </div>
        )
      }
    >
      {citation && (
        <div className="conv-citation">
          <div className="source-meta">
            <I name={KIND_ICONS[citation.kind]} />
            {t.common.kinds[citation.kind]}
            {where && (
              <>
                <span>·</span>
                {where}
              </>
            )}
          </div>
          <div className="citation-preview">{citation.excerpt}</div>
          <div className="info-strip mt24">
            <I name="info" />
            <span>{d.note}</span>
          </div>
          <div className="p-flex mt24">
            <Avatar ree={ree} sm />
            <span className="small muted" style={{ fontSize: 10 }}>
              {ree?.name ?? t.conversations.room.removedRee} · {fill(d.source, { n: citation.index })}
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
