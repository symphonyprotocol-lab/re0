'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { repliesOf, type ReeUIMessage } from '@/lib/domain/chat-message';
import { PUBLIC_QA_ASK_ANCHOR } from '@/lib/domain/public-qa';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Avatar, CitationDrawer, Typing } from '@/components/chat/message-parts';
import { AnswerBubble, QaThread, type QaRee } from '@/components/discover/public-qa';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';

type Shared = 'published' | 'pending' | 'rejected' | 'failed';

function textOf(message: ReeUIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The JSON body of a refusal before any stream started. */
function refusalOf(error: Error): { error?: string } | null {
  try {
    const body = JSON.parse(error.message) as unknown;
    return body && typeof body === 'object' ? (body as { error?: string }) : null;
  } catch {
    return null;
  }
}

/**
 * The Ree page's question box for a signed-in viewer: the first question
 * starts a conversation with just this Ree (it shows in the sidebar like
 * any other), later ones continue it, each answered here and charged as in
 * a conversation. With "回答后公开" ticked, the first answer is published
 * to the page's public Q&A once it passes review.
 */
export function SignedInAsk({ ree, price, sampleQuestions, followUp }: {
  ree: QaRee;
  /** What one answer costs this viewer. */
  price: number;
  sampleQuestions: string[];
  followUp?: { text: string; at: number } | null;
}) {
  const { t, locale } = useI18n();
  const a = t.discover.public.anonymous;
  const q = t.discover.public.qa;
  const router = useRouter();
  const toast = useToast();
  const [input, setInput] = useState('');
  const [publish, setPublish] = useState(false);
  const [shared, setShared] = useState<Shared | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [citation, setCitation] = useState<CitationSnapshot | null>(null);
  const conversationRef = useRef<string | null>(null);
  const pendingQuestion = useRef('');
  const publishRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ReeUIMessage>({
        api: '/api/chats',
        prepareSendMessagesRequest: async () => {
          let id = conversationRef.current;
          if (!id) {
            const response = await fetch('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reeIds: [ree.id], title: pendingQuestion.current.slice(0, 80) }) });
            if (!response.ok) throw new Error(await response.text());
            id = ((await response.json()) as { id: string }).id;
            conversationRef.current = id;
            setConversationId(id);
          }
          return { api: `/api/chats/${id}/messages`, body: { question: pendingQuestion.current, scope: [ree.id], requestId: crypto.randomUUID() } };
        },
      }),
    [ree.id],
  );

  const { messages, sendMessage, status, setMessages } = useChat<ReeUIMessage>({
    id: `ree-ask-${ree.id}`,
    transport,
    onError: (error) => {
      const body = refusalOf(error);
      if (!body?.error) return toast(t.common.errors.generic);
      setMessages((current) => (current.at(-1)?.role === 'user' ? current.slice(0, -1) : current));
      setInput(pendingQuestion.current);
      toast(body.error === 'insufficient_credits' ? q.insufficient : body.error === 'rate_limited' ? a.rateLimited : t.common.errors.generic);
    },
    onFinish: ({ message }) => {
      if (!publishRef.current) return;
      publishRef.current = false;
      const outcome = repliesOf(message)[0]?.outcome;
      if (!outcome?.messageId || outcome.noAnswer || outcome.failed) return setShared('failed');
      setShared('pending');
      void fetch(`/api/rees/${ree.id}/public-qa`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: outcome.messageId }) })
        .then(async (response) => {
          if (!response.ok) return setShared('failed');
          setShared(((await response.json()) as { status: Shared }).status);
          router.refresh();
        })
        .catch(() => setShared('failed'));
    },
  });
  const busy = status === 'submitted' || status === 'streaming';
  const firstAsked = messages.some((message) => message.role === 'user');

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
    pendingQuestion.current = text;
    publishRef.current = publish && !firstAsked;
    setInput('');
    void sendMessage({ text });
  };

  const pairs: { question: ReeUIMessage; reply: ReeUIMessage | null; index: number }[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    const next = messages[index + 1];
    pairs.push({ question: message, reply: next?.role === 'assistant' ? next : null, index });
  });
  pairs.reverse();

  return (
    <section className="ree-ask" id={PUBLIC_QA_ASK_ANCHOR} aria-label={q.ask}>
      <div className="overflow-hidden rounded-xl border border-line">
        {!firstAsked && sampleQuestions.length > 0 && (
          <div className="bg-wash p-3">
            <span className="text-[11px] text-muted">{a.starters}</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {sampleQuestions.slice(0, 3).map((question) => (
                <button key={question} type="button" disabled={busy} className="rounded-lg border border-line bg-white px-3 py-2 text-left text-[13px] hover:border-blue hover:text-blue" onClick={() => send(question)}>
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}
        <form
          className={`flex items-end gap-2 bg-white p-2${!firstAsked && sampleQuestions.length > 0 ? ' border-t border-line' : ''}`}
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
            {q.publishSignedIn}
          </label>
        ) : (
          <span>{a.publishFirstOnly}</span>
        )}
        <span className="font-mono">{fill(q.price, { n: formatNumber(price, locale) })}</span>
      </div>

      {pairs.length > 0 && (
        <div className="ree-qa-list" aria-label={t.conversations.room.messagesLabel}>
          {pairs.map(({ question, reply, index }) => {
            const first = index === 0;
            const outcome = reply ? repliesOf(reply)[0]?.outcome ?? null : null;
            const text = reply ? repliesOf(reply)[0]?.text ?? '' : '';
            const streaming = busy && index === messages.length - 2 + (reply ? 0 : 1);
            const state = first && shared ? shared : null;
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
                    <span className="ree-qa-private">{state === 'published' ? a.published : state === 'pending' ? a.publishPending : state === 'rejected' ? a.publishRejected : a.onlyYou}</span>
                  </>
                }
                answer={
                  !reply || (streaming && !text) ? (
                    <Typing />
                  ) : outcome?.noAnswer ? (
                    <article className="flex gap-2.5">
                      <Avatar ree={ree} sm />
                      <p className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-[13px] text-muted">{outcome.reason === 'no_sources' ? a.noSources : a.outOfScope}</p>
                    </article>
                  ) : (
                    <AnswerBubble ree={ree} text={text} citations={outcome?.citations ?? []} onCitation={setCitation}>
                      {outcome?.failed && <p className="answer-failed">{t.chat.failed}</p>}
                    </AnswerBubble>
                  )
                }
              />
            );
          })}
          {conversationId && (
            <div className="text-right">
              <Link href={`/chats/${conversationId}`} className="inline-flex items-center gap-1 text-[12px] text-blue hover:underline">
                {q.continueInChat}
                <Icon name="chevronRight" className="size-3" />
              </Link>
            </div>
          )}
        </div>
      )}
      <CitationDrawer citation={citation} ree={ree} canOpen={false} onClose={() => setCitation(null)} />
    </section>
  );
}
