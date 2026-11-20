'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { QUERY_BASE_FEE } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { POST_QUESTION_MAX, type PostView } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatRelative } from '@/i18n/format';
import { AnswerText, CitationChips, CitationDrawer } from '@/components/chat/message-parts';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import '@/components/posts/posts.css';

/** How often the list is read again while a question is being answered. */
const POLL_MS = 2_500;

interface TryRee {
  id: string;
  name: string;
  avatarBlob: string | null;
  color: string;
  sampleQuestions: string[];
}

/**
 * 试问 (`/rees/[id]/chat`, 稿 2 section 8): the owner asks their own Ree and
 * reads its answers as the post page shows answers -- no chat bubbles. Each
 * question is a private post of source `test` (A2's `/api/rees/[id]/try`):
 * only the owner sees it, it counts nowhere, and it costs the base fee when
 * the Ree answers. The list is read again while an answer is being written;
 * a question opens as its private post, where the owner may follow up.
 * 清空 deletes the finished ones.
 */
export function ReeTry({ ree, readiness, initial }: { ree: TryRee; readiness: { ready: number; processing: number }; initial: PostView[] }) {
  const { t, locale } = useI18n();
  const a = t.posts.tryout;
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(initial);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lacking, setLacking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [citation, setCitation] = useState<CitationSnapshot | null>(null);
  const [token, setToken] = useState(() => crypto.randomUUID());
  const [now, setNow] = useState(() => Date.now());
  const ready = readiness.ready > 0;
  const answering = items.some((item) => item.answerState !== 'done');

  const reload = useCallback(async () => {
    const response = await fetch(`/api/rees/${ree.id}/try`, { headers: { accept: 'application/json' } }).catch(() => null);
    if (!response?.ok) return;
    setItems(((await response.json()) as { items: PostView[] }).items);
    setNow(Date.now());
  }, [ree.id]);

  useEffect(() => {
    if (!answering) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [answering, reload]);

  /* Knowledge still processing: look again until some of it is ready. */
  useEffect(() => {
    if (ready || readiness.processing === 0) return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [ready, readiness.processing, router]);

  async function send() {
    const text = question.trim();
    if (busy || !text || !ready) return;
    setBusy(true);
    setError(null);
    setLacking(false);
    try {
      const response = await fetch(`/api/rees/${ree.id}/try`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: text, clientToken: token }) });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string; balance?: number; needed?: number };
      if (response.ok && body.id) {
        setQuestion('');
        setToken(crypto.randomUUID());
        await reload();
      } else if (body.error === 'insufficient_credits') {
        setLacking(true);
        setError(fill(a.insufficient, { needed: formatNumber(body.needed ?? 0, locale), balance: formatNumber(body.balance ?? 0, locale) }));
      } else if (body.error === 'too_long') {
        setError(fill(t.posts.composer.tooLong, { question: POST_QUESTION_MAX, detail: POST_QUESTION_MAX }));
      } else {
        setError(body.error === 'empty' ? t.posts.composer.empty : t.posts.composer.failed);
      }
    } catch {
      setError(t.posts.composer.failed);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setConfirmClear(false);
    const response = await fetch(`/api/rees/${ree.id}/try`, { method: 'DELETE' }).catch(() => null);
    if (!response?.ok) return toast(t.common.errors.generic);
    toast(a.cleared);
    await reload();
  }

  return (
    <section className="mx-auto w-full max-w-[760px] px-4 pt-6 pb-16 sm:px-6" aria-label={fill(a.heading, { name: ree.name })}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="md" />
          <div className="min-w-0">
            <h1 className="text-[18px] font-bold">{fill(a.heading, { name: ree.name })}</h1>
            <p className="mt-0.5 text-[12px] text-muted">{fill(a.body, { fee: QUERY_BASE_FEE })}</p>
          </div>
        </div>
        {items.length > 0 && (
          confirmClear ? (
            <span className="flex items-center gap-2 text-[12px]">
              {a.clearConfirm}
              <button type="button" className="text-red hover:underline" onClick={() => void clear()}>{a.clear}</button>
              <button type="button" className="hover:text-blue" onClick={() => setConfirmClear(false)}>{t.common.actions.cancel}</button>
            </span>
          ) : (
            <button type="button" className="icon-btn" onClick={() => setConfirmClear(true)}>
              <Icon name="trash" className="" />
              {a.clear}
            </button>
          )
        )}
      </header>

      <div className="post-composer mt-5">
        <span className="grid size-10 place-items-center rounded-full bg-soft text-blue">
          <Icon name="chat" className="size-4" />
        </span>
        <div className="post-form">
          <textarea
            aria-label={fill(a.heading, { name: ree.name })}
            placeholder={fill(a.placeholder, { name: ree.name })}
            value={question}
            maxLength={POST_QUESTION_MAX + 50}
            disabled={!ready}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
            }}
          />
          {ready && ree.sampleQuestions.length > 0 && !question && (
            <div className="ree-pick">
              <span className="post-hint">{a.examples}</span>
              {ree.sampleQuestions.slice(0, 3).map((sample) => (
                <button key={sample} type="button" className="fu-chip ask-chip" onClick={() => setQuestion(sample)}>
                  {sample}
                </button>
              ))}
            </div>
          )}
          {!ready && <p className="post-hint">{readiness.processing ? fill(a.processing, { n: readiness.processing }) : a.notReady}</p>}
          {error && (
            <p className="post-error" role="alert">
              {error}
            </p>
          )}
          {lacking && (
            <p className="post-hint">
              <Link href="/settings?tab=balance" className="text-blue hover:underline">
                {a.topUp} →
              </Link>
            </p>
          )}
          <div className="post-composer-foot">
            <small className="post-cost">{fill(t.posts.composer.privateCost, { total: formatNumber(QUERY_BASE_FEE, locale) })}</small>
            <button type="button" className="btn btn-sm ml-auto" disabled={busy || !ready || !question.trim()} onClick={() => void send()}>
              {busy ? <i className="spinner" /> : <Icon name="lock" className="size-3.5" />}
              {busy ? a.sending : a.send}
            </button>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-8 text-center text-[12px] text-muted">{a.empty}</p>
      ) : (
        <div className="post-feed mt-4" aria-label={a.title}>
          {items.map((item) => {
            const answers = item.answers.filter((entry) => entry.state === 'answered');
            return (
              <article key={item.id} className="post-card ree-try-item" aria-label={item.question}>
                <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" className="size-10!" />
                <div className="min-w-0">
                  <div className="post-head">
                    <strong>{t.posts.card.you}</strong>
                    <span>· {formatRelative(item.createdAt, now, locale, t.discover.public.qa.justNow)}</span>
                  </div>
                  <p className="post-question">
                    <Link href={`/p/${item.id}`}>{item.question}</Link>
                  </p>
                  {answers.map((entry) => (
                    <div key={entry.id} className="post-answer">
                      <div className="post-answer-head">
                        <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
                        <strong>{entry.reeName}</strong>
                        {entry.cost !== null && entry.cost > 0 && <span className="answer-cost">{fill(t.posts.page.answerCost, { n: formatNumber(entry.cost, locale) })}</span>}
                      </div>
                      <div className="answer-text studio-conversation" style={{ background: 'transparent' }}>
                        <AnswerText text={entry.text} citations={entry.citations} onCitation={setCitation} />
                        <CitationChips citations={entry.citations} onCitation={setCitation} />
                      </div>
                    </div>
                  ))}
                  {item.answerState !== 'done' ? (
                    <div className="post-state is-gathering">
                      <i className="spinner" />
                      {a.answering}
                    </div>
                  ) : answers.length === 0 ? (
                    <div className="post-state is-unmatched">{a.noAnswer}</div>
                  ) : null}
                  <div className="post-actions">
                    <Link href={`/p/${item.id}`} className="post-open">
                      {a.open}
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <CitationDrawer citation={citation} ree={ree} canOpen onClose={() => setCitation(null)} />
    </section>
  );
}
