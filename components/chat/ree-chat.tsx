'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { repliesOf, type InsufficientCreditsBody, type ReeOutcome, type ReeUIMessage } from '@/lib/domain/chat-message';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { conversationApi } from '@/lib/client/conversations';
import { Icon } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { AnswerText, Avatar, CitationChips, CitationDrawer, Feedback, I, Typing, useNavigationHeight } from '@/components/chat/message-parts';

interface ChatRee {
  id: string;
  name: string;
  avatarBlob: string | null;
  color: string;
  sampleQuestions: string[];
}

/** The one Ree's reply in an assistant message (the test conversation has a single Ree). */
function outcomeOf(message: ReeUIMessage): ReeOutcome | null {
  return repliesOf(message)[0]?.outcome ?? null;
}

function textOf(message: ReeUIMessage): string {
  if (message.role === 'user') return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  return repliesOf(message)[0]?.text ?? '';
}

/**
 * `/rees/[id]/chat` (prototype dot-conversation.js): readiness, a centred
 * transcript, example questions in a popover beside the input, "up to N
 * credits", no-answer cards that say whether knowledge is missing or the
 * question is out of scope -- and that nothing was charged -- and clearing.
 * Answers stream through `useChat`; `[n]` markers open the citation drawer.
 */
export function ReeChat({
  conversationId,
  ree,
  readiness,
  maxCost,
  initialMessages,
}: {
  conversationId: string;
  ree: ChatRee;
  readiness: { ready: number; processing: number };
  maxCost: number;
  initialMessages: ReeUIMessage[];
}) {
  const { t, locale } = useI18n();
  const c = t.chat;
  const router = useRouter();
  const toast = useToast();
  const [input, setInput] = useState('');
  const [citation, setCitation] = useState<CitationSnapshot | null>(null);
  const [insufficient, setInsufficient] = useState<InsufficientCreditsBody | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [examples, setExamples] = useState(false);
  const [votes, setVotes] = useState<Record<string, 'up' | 'down' | null>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const examplesRef = useRef<HTMLDetailsElement>(null);
  const page = useRef<HTMLElement>(null);
  useNavigationHeight(page);
  const pendingQuestion = useRef('');

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ReeUIMessage>({
        api: `/api/chats/${conversationId}/messages`,
        prepareSendMessagesRequest: () => ({ body: { question: pendingQuestion.current } }),
      }),
    [conversationId],
  );

  const { messages, sendMessage, status, setMessages } = useChat<ReeUIMessage>({
    id: conversationId,
    messages: initialMessages,
    transport,
    onError: (error) => {
      /* A refused hold comes back as a 402 JSON body instead of a stream. */
      try {
        const body = JSON.parse(error.message) as Partial<InsufficientCreditsBody>;
        if (body.error === 'insufficient_credits') {
          setInsufficient(body as InsufficientCreditsBody);
          setMessages((current) => current.slice(0, -1));
          setInput(pendingQuestion.current);
          return;
        }
      } catch {
        /* not JSON */
      }
      toast(t.common.errors.generic);
    },
    onFinish: () => router.refresh(),
  });

  const busy = status === 'submitted' || status === 'streaming';
  const ready = readiness.ready > 0;

  useEffect(() => {
    const transcript = endRef.current?.parentElement;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (readiness.processing === 0) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [readiness.processing, router]);

  useEffect(() => {
    const box = inputRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(160, Math.max(52, box.scrollHeight))}px`;
  }, [input]);

  /* Escape or a click outside closes the examples (prototype dot-conversation.js). */
  useEffect(() => {
    if (!examples) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setExamples(false);
    const onPointer = (event: PointerEvent) => {
      if (!examplesRef.current?.contains(event.target as Node)) setExamples(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [examples]);

  /* An example question goes into the box, ready to send (prototype dot-conversation.js `studio-prompt`). */
  const prompt = (question: string) => {
    if (busy) return;
    setInput(question);
    setExamples(false);
    inputRef.current?.focus();
  };

  const send = (question = input) => {
    const text = question.trim();
    if (!text || busy) return;
    pendingQuestion.current = text;
    setInput('');
    setExamples(false);
    void sendMessage({ text });
  };

  const readinessLabel = ready ? c.readiness.ready : readiness.processing ? c.readiness.processing : c.readiness.waiting;
  const n = (value: number) => formatNumber(value, locale);
  const [costBefore, costAfter] = c.upTo.split('{credits}');

  const vote = async (messageId: string, value: 'up' | 'down', current: 'up' | 'down' | null) => {
    const next = current === value ? null : value;
    setVotes((all) => ({ ...all, [messageId]: next }));
    try {
      await conversationApi.vote(messageId, next);
      toast(t.conversations.room.feedbackSaved);
    } catch {
      setVotes((all) => ({ ...all, [messageId]: current }));
      toast(t.common.errors.generic);
    }
  };

  const head = (label: string) => (
    <div className="message-head">
      <Avatar ree={ree} sm />
      <strong>{ree.name}</strong>
      <small>{label}</small>
    </div>
  );

  return (
    <section ref={page} className="work-page dot-test-page studio-conversation" aria-label={`${ree.name} · ${t.reeSetup.tabs.chat}`}>
      <header className="studio-chat-toolbar">
        <div className="studio-chat-identity">
          <Avatar ree={ree} />
          <div>
            <strong>{ree.name}</strong>
            <span>{c.grounded}</span>
          </div>
        </div>
        <div className="studio-chat-actions">
          <span className={`studio-readiness ${ready ? 'ready' : 'waiting'}`}>
            <i />
            {readinessLabel}
          </span>
          <button type="button" className="studio-clear" disabled={!messages.length || busy} onClick={() => setConfirmClear(true)}>
            <I name="trash" />
            {c.clear}
          </button>
        </div>
      </header>
      <div className="chat-area dot-test-chat">
        <div className={`chat-transcript studio-messages ${messages.length ? 'has-messages' : 'is-empty'}`} id="transcript" role="region" aria-label={t.conversations.room.messagesLabel} tabIndex={0}>
          {messages.length === 0 ? (
            <div className="studio-empty">
              <span className="studio-empty-mark">
                <Avatar ree={ree} />
              </span>
              <span className="studio-eyebrow">{c.eyebrow}</span>
              <h1>{ready ? c.empty.readyTitle : readiness.processing ? c.empty.processingTitle : c.empty.waitingTitle}</h1>
              <p>{ready ? c.empty.readyBody : readiness.processing ? c.empty.processingBody : c.empty.waitingBody}</p>
              {ready && ree.sampleQuestions.length > 0 ? (
                <div className="studio-starters">
                  {ree.sampleQuestions.slice(0, 3).map((question, index) => (
                    <button key={question} type="button" onClick={() => prompt(question)}>
                      <span>0{index + 1}</span>
                      <strong>{question}</strong>
                      <I name="arrow" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="studio-empty-assurance">
                  <I name="shield" />
                  {c.empty.assurance}
                </div>
              )}
            </div>
          ) : (
            <div className="studio-thread">
              {messages.map((message, index) => {
                if (message.role === 'user') {
                  return (
                    <div key={message.id} className="message user">
                      <div className="user-bubble">{textOf(message)}</div>
                    </div>
                  );
                }
                const outcome = outcomeOf(message);
                const text = textOf(message);
                const streaming = busy && index === messages.length - 1 && !outcome;
                if (outcome?.noAnswer) {
                  const missing = outcome.reason === 'no_sources';
                  return (
                    <article key={message.id} className="message studio-unanswered">
                      {head(c.boundary)}
                      <div className="studio-unanswered-body">
                        <span className="studio-unanswered-icon">
                          <I name="file" />
                        </span>
                        <div>
                          <h3>{missing ? c.noSourcesTitle : c.outOfScopeTitle}</h3>
                          <p>{missing ? c.noSourcesBody : c.outOfScopeBody}</p>
                          <span className="studio-no-charge">
                            <I name="shield" />
                            {c.noCharge}
                          </span>
                        </div>
                      </div>
                    </article>
                  );
                }
                if (streaming && !text) return <Typing key={message.id} />;
                const citations = outcome?.citations ?? [];
                const messageId = outcome?.messageId;
                const current = messageId ? (votes[messageId] !== undefined ? votes[messageId]! : (outcome?.vote ?? null)) : null;
                return (
                  <article key={message.id} className="message" aria-busy={streaming}>
                    {head(c.answerHead)}
                    <AnswerText text={text} citations={citations} failed={outcome?.failed} onCitation={setCitation} />
                    <CitationChips citations={citations} onCitation={setCitation} />
                    {outcome && !outcome.failed && (
                      <Feedback
                        text={text}
                        vote={current}
                        onVote={messageId ? (value) => vote(messageId, value, current) : undefined}
                        cost={fill(c.cost, { credits: n(outcome.cost) })}
                        title={outcome.model ? fill(c.model, { model: outcome.model }) : undefined}
                      />
                    )}
                  </article>
                );
              })}
              {status === 'submitted' && messages.at(-1)?.role === 'user' && <Typing />}
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className="studio-compose-dock">
          <div className="studio-compose-inner">
            <form
              className="composer studio-composer"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <textarea
                ref={inputRef}
                id="message-input"
                aria-label={c.inputLabel}
                rows={2}
                maxLength={QUESTION_MAX_CHARS}
                required
                disabled={busy}
                value={input}
                placeholder={ready ? c.placeholderReady : c.placeholderWaiting}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="studio-compose-tools">
                <span className="studio-current-dot">
                  <Avatar ree={ree} sm />
                  <span>{ree.name}</span>
                </span>
                <div>
                  {ree.sampleQuestions.length > 0 && (
                    <details ref={examplesRef} className="studio-examples" open={examples}>
                      <summary
                        onClick={(event) => {
                          event.preventDefault();
                          setExamples((value) => !value);
                        }}
                      >
                        <I name="light" />
                        {c.examples}
                        <I name="chevronDown" />
                      </summary>
                      <div className="studio-example-popover">
                        <strong>{c.tryAsking}</strong>
                        {ree.sampleQuestions.slice(0, 3).map((question) => (
                          <button key={question} type="button" onClick={() => prompt(question)}>
                            {question}
                            <I name="arrow" />
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                  <button type="submit" className="btn studio-send" aria-label={c.send} disabled={busy || !input.trim()}>
                    {busy ? <i className="spinner" /> : <I name="send" />}
                  </button>
                </div>
              </div>
            </form>
            <div className="studio-compose-meta">
              <span>
                <I name="shield" />
                <span id="cost-label">
                  {costBefore}
                  <strong>{n(maxCost)}</strong>
                  {costAfter}
                </span>
                <span className="studio-no-answer-note">· {c.noAnswerNote}</span>
              </span>
              <small>{c.keys}</small>
            </div>
            <p className="studio-demo-note">{c.evidenceNote}</p>
          </div>
        </div>
      </div>

      <CitationDrawer citation={citation} ree={ree} canOpen onClose={() => setCitation(null)} />

      <Modal
        open={Boolean(insufficient)}
        onClose={() => setInsufficient(null)}
        title={c.insufficient.title}
        subtitle={c.insufficient.body}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setInsufficient(null)}>
              {t.common.actions.cancel}
            </button>
            <Link href="/settings?tab=balance" className="btn">
              {c.insufficient.topUp}
              <Icon name="arrow" />
            </Link>
          </>
        }
      >
        {insufficient && (
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="flex justify-between rounded-lg bg-wash px-3 py-2.5">
              <span className="text-muted">{c.insufficient.balance}</span>
              <strong className="font-mono">{n(insufficient.balance)} credits</strong>
            </div>
            <div className="flex justify-between rounded-lg bg-wash px-3 py-2.5">
              <span className="text-muted">{c.insufficient.needed}</span>
              <strong className="font-mono">{n(insufficient.needed)} credits</strong>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={confirmClear}
        danger
        title={c.clearTitle}
        body={fill(c.clearBody, { name: ree.name })}
        confirmLabel={c.clear}
        onClose={() => setConfirmClear(false)}
        onConfirm={async () => {
          setConfirmClear(false);
          const response = await fetch(`/api/chats/${conversationId}/messages`, { method: 'DELETE' });
          if (!response.ok) return toast(t.common.errors.generic);
          setMessages([]);
          toast(c.cleared);
          inputRef.current?.focus();
        }}
      />
    </section>
  );
}
