'use client';

import { useState, type ReactNode } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { AI_ANSWER_FEE, type AiAnswerView } from '@/lib/domain/post';
import { Markdown } from '@/components/posts/markdown';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, type IconName } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import './posts.css';
import { Pending } from '@/components/posts/pending';

/*
 * AI 通用回答 (design draft 1, approved 2026-11-20): what the asker -- and
 * only the asker -- sees when no Ree answered a round. Never mistaken for a
 * Ree's answer: a dashed grey card with a sparkle mark instead of an avatar,
 * "无出处 · 仅供参考" and "仅你可见", no citations, and a note saying what it
 * is; then the ways to an answer with sources.
 */

/**
 * The card itself: the answer, its note, and 有帮助 · 没帮助 · 复制 with what
 * it cost. `onAskAi`: 继续问 AI, where the box below asks the AI alone (a
 * public post no Ree answered, or a private thread no Ree is in).
 */
export function AiAnswerCard({ ai, compact = false, onChange, onAskAi }: { ai: AiAnswerView; compact?: boolean; onChange: (next: AiAnswerView) => void; onAskAi?: () => void }) {
  const { t, locale } = useI18n();
  const a = t.posts.ai;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function vote(choice: 'helpful' | 'unhelpful') {
    const next = ai.vote === choice ? null : choice;
    setBusy(true);
    try {
      const response = await fetch(`/api/posts/ai-answers/${ai.id}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vote: next }) });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { vote: AiAnswerView['vote'] };
      onChange({ ...ai, vote: body.vote ?? null });
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(false);
    }
  }
  const copy = () => navigator.clipboard.writeText(ai.text).then(() => toast(a.copied), () => toast(t.common.errors.generic));
  return (
    <article id={ai.id ? `ai-${ai.id}` : undefined} className={`post-answer ai-answer scroll-mt-24${compact ? ' is-compact' : ''}`}>
      <div className="post-answer-head">
        <span className="ai-mark" aria-hidden="true">
          <Icon name="sparkle" className="" />
        </span>
        <strong>{a.title}</strong>
        <span className="ai-tag">{a.noSource}</span>
        <span className="ai-tag is-private">
          <Icon name="lock" className="" />
          {a.onlyYou}
        </span>
      </div>
      <div className="answer-text studio-conversation" style={{ background: 'transparent' }}>
        <Markdown className="answer-markdown" text={ai.text} citation={() => null} />
      </div>
      <p className="ai-note">{a.note}</p>
      <div className="post-answer-foot">
        <button type="button" className="icon-btn" aria-pressed={ai.vote === 'helpful'} disabled={busy} onClick={() => void vote('helpful')}>
          <Icon name="thumbUp" className={ai.vote === 'helpful' ? 'text-blue' : ''} />
          {a.helpful}
        </button>
        <button type="button" className="icon-btn" aria-pressed={ai.vote === 'unhelpful'} disabled={busy} onClick={() => void vote('unhelpful')}>
          <Icon name="thumbDown" className={ai.vote === 'unhelpful' ? 'text-blue' : ''} />
          {a.unhelpful}
        </button>
        <button type="button" className="icon-btn" onClick={() => void copy()}>
          <Icon name="copy" className="" />
          {a.copy}
        </button>
        {onAskAi && (
          <button type="button" className="icon-btn" onClick={onAskAi}>
            <Icon name="reply" className="" />
            {a.askMore}
          </button>
        )}
        {ai.cost > 0 && <span className="answer-cost">{fill(a.cost, { n: formatNumber(ai.cost, locale) })}</span>}
      </div>
    </article>
  );
}

/**
 * The AI answer of one round as it stands for its asker: being written; the
 * card; one line to unfold once a Ree has answered; or, skipped for a short
 * balance, the top-up and "生成 AI 回答 · 20 credits" (once). `note`: the
 * line above the card. `postId` and `followupId` name the round for the
 * by-hand generation; `onRefresh` asks the page again after it; `onAskAi`
 * puts 继续问 AI on the card.
 */
export function AiRound({ ai, postId, followupId = null, note, compact = false, onChange, onRefresh, onAskAi }: { ai: AiAnswerView; postId: string; followupId?: string | null; note?: ReactNode; compact?: boolean; onChange: (next: AiAnswerView) => void; onRefresh: () => void; onAskAi?: () => void }) {
  const { t, locale } = useI18n();
  const a = t.posts.ai;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fee = formatNumber(AI_ANSWER_FEE, locale);

  async function generate() {
    setBusy(true);
    try {
      const response = await fetch(`/api/posts/${postId}/ai-answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ followupId }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string; balance?: number; needed?: number };
      if (response.ok) {
        onChange({ ...ai, state: 'running', retry: false });
        return onRefresh();
      }
      if (response.status === 402) {
        return toast(fill(t.posts.composer.insufficient, { needed: formatNumber(Number(body.needed) || 0, locale), balance: formatNumber(Number(body.balance) || 0, locale) }));
      }
      if (body.error === 'already' || body.error === 'answered') return onRefresh();
      throw new Error(String(response.status));
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  if (ai.state === 'running') {
    return (
      <div className="post-state is-gathering">
        <Pending label={a.running} />
      </div>
    );
  }
  if (ai.state === 'skipped_balance') {
    return (
      <div className="post-state is-unmatched ai-state">
        <span>{fill(a.skipped, { fee })}</span>
        <Link href="/settings?tab=balance">{a.topUp} →</Link>
        {ai.retry && (
          <button type="button" className="btn-secondary btn-sm" title={a.generateOnce} disabled={busy} onClick={() => void generate()}>
            {busy ? <i className="spinner" /> : <Icon name="sparkle" className="size-3.5" />}
            {fill(a.generate, { fee })}
          </button>
        )}
      </div>
    );
  }
  if (ai.state !== 'answered') return null;
  if (ai.folded && !open) {
    return (
      <button type="button" className="fu-fold ai-folded" aria-expanded={false} onClick={() => setOpen(true)}>
        <Icon name="sparkle" className="" />
        {a.folded}
      </button>
    );
  }
  return (
    <>
      {note}
      <AiAnswerCard ai={ai} compact={compact} onChange={onChange} onAskAi={ai.folded ? undefined : onAskAi} />
      {ai.folded && (
        <button type="button" className="fu-fold ai-folded" aria-expanded onClick={() => setOpen(false)}>
          <Icon name="chevronDown" className="rotate-180" />
          {a.fold}
        </button>
      )}
    </>
  );
}

export interface AiGuideItem {
  icon: IconName;
  title: string;
  body: string;
  href?: string;
  onClick?: () => void;
}

/** 想要有出处的回答？ -- the ways from a general answer to one with sources. */
export function AiGuide({ items, children }: { items: AiGuideItem[]; children?: ReactNode }) {
  const { t } = useI18n();
  const a = t.posts.ai;
  return (
    <section className="ai-guide" aria-label={a.guideTitle}>
      <h4>{a.guideTitle}</h4>
      <div className="ai-guide-items">
        {items.map((item) => {
          const inner = (
            <>
              <Icon name={item.icon} className="" />
              <span>
                <strong>{item.title}</strong>
                <small>{item.body}</small>
              </span>
            </>
          );
          return item.href ? (
            <Link key={item.title} href={item.href} className="ai-guide-item" scroll={false}>
              {inner}
            </Link>
          ) : (
            <button key={item.title} type="button" className="ai-guide-item" data-ree-picker="" onClick={item.onClick}>
              {inner}
            </button>
          );
        })}
      </div>
      {children}
    </section>
  );
}

/** The asker's own feed card: their AI answer's first lines, greyed, marked as not a Ree's -- in place of "暂时没有 Ree 能回答". */
export function AiPreview({ ai }: { ai: AiAnswerView }) {
  const { t } = useI18n();
  const a = t.posts.ai;
  if (ai.state !== 'answered' && ai.state !== 'skipped_balance') return null;
  return (
    <div className="post-answers-preview ai-preview">
      <div className="post-answerers">
        <span>
          <Icon name="sparkle" className="" />
          {ai.state === 'answered' ? a.preview : a.previewSkipped}
        </span>
      </div>
      {ai.state === 'answered' && (
        <div className="post-top-answer">
          <span className="ai-mark is-small" aria-hidden="true">
            <Icon name="sparkle" className="" />
          </span>
          <div className="min-w-0">
            <p>{ai.text}</p>
          </div>
        </div>
      )}
    </div>
  );
}
