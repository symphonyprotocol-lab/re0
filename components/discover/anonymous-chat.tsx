'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { ANONYMOUS_HISTORY_TURNS, QUESTION_MAX_CHARS } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { ANONYMOUS_CAPACITY_REACHED, ANONYMOUS_NETWORK_LIMIT, ANONYMOUS_QUOTA_EXCEEDED, FINGERPRINT_HEADER, type AnonymousTurn } from '@/lib/domain/anonymous-chat';
import { repliesOf, type AnonymousQuota, type PublicPart, type ReeUIMessage } from '@/lib/domain/chat-message';
import { PUBLIC_QA_ASK_ANCHOR } from '@/lib/domain/public-qa';
import { browserFingerprint } from '@/lib/client/fingerprint';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Avatar, CitationDrawer, Typing } from '@/components/chat/message-parts';
import { AnswerBubble, QaThread } from '@/components/discover/public-qa';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

interface AnonymousRee {
  id: string;
  name: string;
  avatarBlob: string | null;
  color: string;
  sampleQuestions: string[];
}

function textOf(message: ReeUIMessage): string {
  if (message.role === 'user') return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  return repliesOf(message)[0]?.text ?? '';
}

function publicIn(message: ReeUIMessage): PublicPart['status'] | null {
  for (const part of message.parts) if (part.type === 'data-public') return part.data.status;
  return null;
}

/** Each question with the reply that followed it, newest first (the page's own stream order). */
function threadsOf(messages: readonly ReeUIMessage[]): { question: ReeUIMessage; reply: ReeUIMessage | null; index: number }[] {
  const pairs: { question: ReeUIMessage; reply: ReeUIMessage | null; index: number }[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    const next = messages[index + 1];
    pairs.push({ question: message, reply: next?.role === 'assistant' ? next : null, index });
  });
  return pairs.reverse();
}

function quotaIn(message: ReeUIMessage): AnonymousQuota | null {
  for (const part of message.parts) if (part.type === 'data-quota') return part.data;
  return null;
}

/** Questions the Ree answered and its answers, oldest first: the context the server is sent with the next question. */
function historyOf(messages: readonly ReeUIMessage[]): AnonymousTurn[] {
  const turns: AnonymousTurn[] = [];
  messages.forEach((message, index) => {
    const next = messages[index + 1];
    if (message.role !== 'user' || next?.role !== 'assistant') return;
    const reply = repliesOf(next)[0];
    if (!reply?.text || !reply.outcome || reply.outcome.noAnswer || reply.outcome.failed) return;
    turns.push({ role: 'user', content: textOf(message) }, { role: 'assistant', content: reply.text });
  });
  return turns.slice(-ANONYMOUS_HISTORY_TURNS);
}

/** A refusal before any stream started comes back as the JSON body of the error. */
function refusalOf(error: Error): (Partial<AnonymousQuota> & { error?: string }) | null {
  try {
    const body = JSON.parse(error.message) as unknown;
    return body && typeof body === 'object' ? (body as Partial<AnonymousQuota> & { error?: string }) : null;
  } catch {
    return null;
  }
}

const storageKey = (reeId: string) => `re0:anonymous-chat:${reeId}`;

/**
 * Anonymous chat on a free Ree's public page or share page (lib/services/anonymous-chat.ts):
 * a signed-out visitor asks without signing in, up to the day's free
 * questions, and sees how many are left. The transcript lives in this tab's
 * sessionStorage only. Once the day's questions are used, asking opens a
 * dialog that signs them in and brings them back to this page.
 */
export function AnonymousChat({ ree, loginHref, source, followUp }: {
  ree: AnonymousRee;
  /** "我也问一句" on the public Q&A below: a question to put in the box, with a fresh `at` each time. */
  followUp?: { text: string; at: number } | null;
  /** Where the sign-in dialog sends the visitor, coming back to this page. */
  loginHref: string;
  /** `share` on the share page `/s/[slug]`, so its answers count there (share.ts `shareVisitorFor`). */
  source?: 'share';
}) {
  const { t } = useI18n();
  const a = t.discover.public.anonymous;
  const router = useRouter();
  const toast = useToast();
  const [input, setInput] = useState('');
  /* "回答后公开": only a question asked without earlier answered turns can be published (public-qa.ts), so the box offers it until one is answered. */
  const [publish, setPublish] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [quota, setQuota] = useState<AnonymousQuota | null>(null);
  /* Which limit the sign-in dialog explains: the visitor's own, their network's, or the day's capacity. */
  const [limit, setLimit] = useState<'visitor' | 'network' | 'capacity' | null>(null);
  const [citation, setCitation] = useState<CitationSnapshot | null>(null);
  const pendingQuestion = useRef('');
  const publishRef = useRef(false);
  const api = `/api/rees/${ree.id}/anonymous-chat`;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ReeUIMessage>({
        api,
        prepareSendMessagesRequest: async ({ messages }) => ({
          headers: { [FINGERPRINT_HEADER]: await browserFingerprint() },
          body: (() => {
            const history = historyOf(messages.slice(0, -1));
            return { question: pendingQuestion.current, history, ...(source ? { source } : {}), ...(publishRef.current && history.length === 0 ? { publish: true } : {}) };
          })(),
        }),
      }),
    [api, source],
  );

  const { messages, sendMessage, status, setMessages } = useChat<ReeUIMessage>({
    id: `anonymous-${ree.id}`,
    transport,
    onError: (error) => {
      const body = refusalOf(error);
      /* Not JSON: the stream itself broke after it started; what was shown stays. */
      if (!body) return toast(t.common.errors.generic);
      /* Refused before anything was asked: take the question back into the box. */
      setMessages((current) => (current.at(-1)?.role === 'user' ? current.slice(0, -1) : current));
      setInput(pendingQuestion.current);
      const refused = body.error === ANONYMOUS_QUOTA_EXCEEDED ? 'visitor' : body.error === ANONYMOUS_NETWORK_LIMIT ? 'network' : body.error === ANONYMOUS_CAPACITY_REACHED ? 'capacity' : null;
      if (refused) {
        /* The server's own limit: the day's rounds are set in the console, never assumed here. */
        setQuota((current) => ({
          limit: body.limit ?? current?.limit ?? 0,
          remaining: refused === 'visitor' ? 0 : (body.remaining ?? 0),
          blocked: refused === 'visitor' ? (body.blocked ?? null) : refused,
        }));
        setLimit(refused);
        return;
      }
      if (body.error === 'anonymous_unavailable') {
        toast(a.unavailable);
        router.refresh();
        return;
      }
      toast(body.error === 'rate_limited' ? a.rateLimited : t.common.errors.generic);
    },
    onFinish: ({ message }) => {
      const left = quotaIn(message);
      if (left) setQuota(left);
    },
  });
  const busy = status === 'submitted' || status === 'streaming';

  /* This tab's earlier exchange with this Ree, and today's count. */
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey(ree.id));
      if (saved) setMessages(JSON.parse(saved) as ReeUIMessage[]);
    } catch {
      /* storage unavailable: start empty */
    }
    let live = true;
    void browserFingerprint()
      .then((fingerprint) => fetch(api, { headers: { [FINGERPRINT_HEADER]: fingerprint }, cache: 'no-store' }))
      .then(async (response) => {
        if (live && response.ok) setQuota((await response.json()) as AnonymousQuota);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, ree.id, setMessages]);

  useEffect(() => {
    if (busy) return;
    try {
      if (messages.length) sessionStorage.setItem(storageKey(ree.id), JSON.stringify(messages));
      else sessionStorage.removeItem(storageKey(ree.id));
    } catch {
      /* storage full or unavailable: the transcript stays on screen only */
    }
  }, [messages, busy, ree.id]);

  useEffect(() => {
    if (!followUp) return;
    setInput(fill(a.followUpPrefill, { question: followUp.text }));
    const box = inputRef.current;
    if (!box) return;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.focus({ preventScroll: true });
  }, [followUp, a.followUpPrefill]);

  const send = (question = input) => {
    const text = question.trim();
    if (!text || busy) return;
    const stopped = quota?.blocked ?? (quota && quota.remaining <= 0 ? 'visitor' : null);
    if (stopped) {
      setInput(text);
      setLimit(stopped);
      return;
    }
    pendingQuestion.current = text;
    publishRef.current = publish && historyOf(messages).length === 0;
    setInput('');
    void sendMessage({ text });
  };

  const pairs = threadsOf(messages);
  /* Publishable while nothing has been answered yet: an unanswered question is not context for the next one (historyOf). */
  const firstAsked = historyOf(messages).length > 0;
  const asked = messages.some((message) => message.role === 'user');
  return (
    <section className="ree-ask" id={PUBLIC_QA_ASK_ANCHOR} aria-label={a.heading}>
      <div className="overflow-hidden rounded-xl border border-line">
        {!asked && ree.sampleQuestions.length > 0 && (
          <div className="bg-wash p-3">
            <span className="text-[11px] text-muted">{a.starters}</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {ree.sampleQuestions.slice(0, 3).map((question) => (
                <button key={question} type="button" disabled={busy} className="rounded-lg border border-line bg-white px-3 py-2 text-left text-[13px] hover:border-blue hover:text-blue" onClick={() => send(question)}>
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}
        <form
          className={`flex items-end gap-2 bg-white p-2${!asked && ree.sampleQuestions.length > 0 ? ' border-t border-line' : ''}`}
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            ref={inputRef}
            aria-label={a.inputLabel}
            rows={2}
            maxLength={QUESTION_MAX_CHARS}
            disabled={busy}
            value={input}
            placeholder={fill(a.placeholder, { name: ree.name })}
            className="min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] outline-none"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              /* Safari reports the IME's confirming Enter as keyCode 229 with isComposing already false. */
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className="btn btn-sm" aria-label={a.send} disabled={busy || !input.trim()}>
            {busy ? <i className="spinner" /> : <Icon name="send" />}
          </button>
        </form>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        {!firstAsked ? (
          <label className="ree-ask-share">
            <input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} />
            {a.publish}
          </label>
        ) : (
          <span>{a.publishFirstOnly}</span>
        )}
        {quota && (
          <span role="status" className={`rounded-full border px-2.5 py-1 font-mono text-[11px] ${quota.remaining > 0 && !quota.blocked ? 'border-line text-muted' : 'border-[#f3d2cf] bg-[#fdf3f2] text-[#b4372c]'}`}>
            {quota.blocked === 'network' ? a.networkHint : quota.blocked === 'capacity' ? a.capacityHint : fill(a.remaining, { n: quota.remaining, limit: quota.limit })}
          </span>
        )}
      </div>
      <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted">
        <Icon name="shield" className="mt-0.5 size-3.5 flex-none text-green" />
        {a.privacy}
      </p>

      {pairs.length > 0 && (
        <div className="ree-qa-list" aria-label={t.conversations.room.messagesLabel}>
          {pairs.map(({ question, reply, index }) => {
            const outcome = reply ? repliesOf(reply)[0]?.outcome ?? null : null;
            const text = reply ? repliesOf(reply)[0]?.text ?? '' : '';
            const streaming = busy && index === messages.length - 2 + (reply ? 0 : 1);
            const shared = reply ? publicIn(reply) : null;
            return (
              <QaThread
                key={question.id}
                mine
                asker={a.you}
                initials={a.you}
                question={textOf(question)}
                meta={
                  <>
                    <span>· {a.justNow}</span>
                    <span className="ree-qa-private">{shared === 'published' ? a.published : shared === 'pending' ? a.publishPending : shared === 'rejected' ? a.publishRejected : a.onlyYou}</span>
                  </>
                }
                answer={
                  !reply || (streaming && !text) ? (
                    <Typing />
                  ) : outcome?.noAnswer ? (
                    <article className="flex gap-2.5">
                      <Avatar ree={ree} sm />
                      <p className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-[13px] text-muted">
                        {outcome.reason === 'no_sources' ? a.noSources : a.outOfScope}
                        {/* A reply that showed text before declining still counted (anonymous-chat.ts). */}
                        {!text && ` ${a.notCounted}`}
                      </p>
                    </article>
                  ) : (
                    <AnswerBubble ree={{ ...ree, slug: '' }} text={text} citations={outcome?.citations ?? []} onCitation={setCitation}>
                      {outcome?.failed && <p className="answer-failed">{t.chat.failed}</p>}
                    </AnswerBubble>
                  )
                }
              />
            );
          })}
          <div className="text-right">
            <button type="button" className="text-[11px] text-muted hover:text-blue" disabled={busy} onClick={() => setMessages([])}>
              {a.clear}
            </button>
          </div>
        </div>
      )}

      <CitationDrawer citation={citation} ree={ree} canOpen={false} onClose={() => setCitation(null)} />

      <Modal
        open={limit !== null}
        onClose={() => setLimit(null)}
        title={limit === 'network' ? a.networkTitle : limit === 'capacity' ? a.capacityTitle : a.limitTitle}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setLimit(null)}>
              {a.limitLater}
            </button>
            <Link href={loginHref} className="btn">
              {a.limitSignIn}
              <Icon name="arrow" />
            </Link>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <Avatar ree={ree} />
          <p className="text-[13px] leading-relaxed">
            {fill(limit === 'network' ? a.networkBody : limit === 'capacity' ? a.capacityBody : quota?.limit ? a.limitBody : a.limitBodyNoCount, { limit: quota?.limit ?? '', name: ree.name })}
          </p>
        </div>
      </Modal>
    </section>
  );
}
