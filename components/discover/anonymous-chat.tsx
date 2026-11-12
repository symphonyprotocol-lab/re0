'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { ANONYMOUS_HISTORY_TURNS, ANONYMOUS_ROUNDS_PER_DAY, QUESTION_MAX_CHARS } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { ANONYMOUS_QUOTA_EXCEEDED, FINGERPRINT_HEADER, type AnonymousTurn } from '@/lib/domain/anonymous-chat';
import { repliesOf, type AnonymousQuota, type ReeUIMessage } from '@/lib/domain/chat-message';
import { browserFingerprint } from '@/lib/client/fingerprint';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { AnswerText, Avatar, CitationChips, CitationDrawer, Typing } from '@/components/chat/message-parts';
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
function refusalOf(error: Error): { error?: string; limit?: number } | null {
  try {
    const body = JSON.parse(error.message) as unknown;
    return body && typeof body === 'object' ? (body as { error?: string; limit?: number }) : null;
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
export function AnonymousChat({ ree, loginHref, source }: {
  ree: AnonymousRee;
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
  const [quota, setQuota] = useState<AnonymousQuota | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [citation, setCitation] = useState<CitationSnapshot | null>(null);
  const pendingQuestion = useRef('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const api = `/api/rees/${ree.id}/anonymous-chat`;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ReeUIMessage>({
        api,
        prepareSendMessagesRequest: async ({ messages }) => ({
          headers: { [FINGERPRINT_HEADER]: await browserFingerprint() },
          body: { question: pendingQuestion.current, history: historyOf(messages.slice(0, -1)), ...(source ? { source } : {}) },
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
      if (body.error === ANONYMOUS_QUOTA_EXCEEDED) {
        setQuota({ limit: body.limit ?? ANONYMOUS_ROUNDS_PER_DAY, remaining: 0 });
        setLimitOpen(true);
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
    const box = transcriptRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages]);

  const send = (question = input) => {
    const text = question.trim();
    if (!text || busy) return;
    if (quota && quota.remaining <= 0) {
      setInput(text);
      setLimitOpen(true);
      return;
    }
    pendingQuestion.current = text;
    setInput('');
    void sendMessage({ text });
  };

  return (
    <section className="mt-7 border-t border-line pt-6" aria-label={a.heading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[14px] font-bold">
          <Icon name="chat" className="size-4 text-blue" />
          {a.heading}
        </h2>
        {quota && (
          <span role="status" className={`rounded-full border px-2.5 py-1 font-mono text-[11px] ${quota.remaining > 0 ? 'border-line text-muted' : 'border-[#f3d2cf] bg-[#fdf3f2] text-[#b4372c]'}`}>
            {fill(a.remaining, { n: quota.remaining, limit: quota.limit })}
          </span>
        )}
      </div>
      <p className="mt-1 text-[12px] text-muted">{a.body}</p>

      <div className="mt-3 overflow-hidden rounded-xl border border-line">
        <div ref={transcriptRef} className="max-h-[480px] overflow-y-auto bg-wash p-4" role="region" aria-label={t.conversations.room.messagesLabel} tabIndex={0}>
          {/* The chat pages' answer, citation and typing styles are scoped to `.studio-conversation` (conversations.css). */}
          <div className="studio-conversation flex flex-col gap-4" style={{ background: 'transparent' }}>
            {messages.length === 0 && ree.sampleQuestions.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[11px] text-muted">{a.starters}</span>
                {ree.sampleQuestions.slice(0, 3).map((question) => (
                  <button key={question} type="button" disabled={busy} className="rounded-lg border border-line bg-white px-3 py-2 text-left text-[13px] hover:border-blue hover:text-blue" onClick={() => send(question)}>
                    {question}
                  </button>
                ))}
              </div>
            )}
            {messages.map((message, index) => {
              if (message.role === 'user') {
                return (
                  <div key={message.id} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-md bg-blue px-3.5 py-2 text-[13px] whitespace-pre-wrap text-white">{textOf(message)}</p>
                  </div>
                );
              }
              const reply = repliesOf(message)[0];
              const outcome = reply?.outcome ?? null;
              const text = reply?.text ?? '';
              const streaming = busy && index === messages.length - 1 && !outcome;
              if (streaming && !text) return <Typing key={message.id} />;
              return (
                <article key={message.id} className="flex gap-2.5" aria-busy={streaming}>
                  <Avatar ree={ree} sm />
                  <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-[13px]">
                    {outcome?.noAnswer ? (
                      <p className="text-muted">
                        {outcome.reason === 'no_sources' ? a.noSources : a.outOfScope} {a.notCounted}
                      </p>
                    ) : (
                      <>
                        <AnswerText text={text} citations={outcome?.citations ?? []} failed={outcome?.failed} onCitation={setCitation} />
                        <CitationChips citations={outcome?.citations ?? []} onCitation={setCitation} />
                      </>
                    )}
                  </div>
                </article>
              );
            })}
            {status === 'submitted' && messages.at(-1)?.role === 'user' && <Typing />}
          </div>
        </div>
        <form
          className="flex items-end gap-2 border-t border-line bg-white p-2"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
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
        <span className="flex items-center gap-1.5">
          <Icon name="shield" className="size-3.5 flex-none text-green" />
          {a.privacy}
        </span>
        {messages.length > 0 && (
          <button type="button" className="hover:text-blue" disabled={busy} onClick={() => setMessages([])}>
            {a.clear}
          </button>
        )}
      </div>

      <CitationDrawer citation={citation} ree={ree} canOpen={false} onClose={() => setCitation(null)} />

      <Modal
        open={limitOpen}
        onClose={() => setLimitOpen(false)}
        title={a.limitTitle}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setLimitOpen(false)}>
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
          <p className="text-[13px] leading-relaxed">{fill(a.limitBody, { limit: quota?.limit ?? ANONYMOUS_ROUNDS_PER_DAY, name: ree.name })}</p>
        </div>
      </Modal>
    </section>
  );
}
