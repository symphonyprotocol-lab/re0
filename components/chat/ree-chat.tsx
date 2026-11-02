'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import { locatorLabel, type CitationSnapshot } from '@/lib/domain/answer';
import type { InsufficientCreditsBody, ReeOutcome, ReeUIMessage } from '@/lib/domain/chat-message';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { Markdown } from '@/components/chat/markdown';

interface ChatRee {
  id: string;
  name: string;
  avatarBlob: string | null;
  color: string;
  sampleQuestions: string[];
}

function outcomeOf(message: ReeUIMessage): ReeOutcome | null {
  for (const part of message.parts) if (part.type === 'data-outcome') return part.data;
  return null;
}

function textOf(message: ReeUIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
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
    endRef.current?.scrollIntoView({ block: 'end' });
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

  useEffect(() => {
    if (!examples) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setExamples(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [examples]);

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

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-108px)] w-full max-w-[860px] flex-col px-4 md:px-8">
      <header className="sticky top-[108px] z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 bg-bg/95 px-4 py-4 backdrop-blur md:-mx-8 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <ReeAvatar avatar={ree.avatarBlob} color={ree.color} />
          <div className="min-w-0">
            <strong className="block truncate text-[14px]">{ree.name}</strong>
            <span className="text-[11px] text-muted">{c.grounded}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              ready ? 'border-[#cfe9de] bg-[#f1faf6] text-green' : 'border-line bg-white text-muted'
            }`}
          >
            <i className={`size-1.5 rounded-full ${ready ? 'bg-green' : readiness.processing ? 'bg-blue' : 'bg-[#a3a9bb]'}`} />
            {readinessLabel}
          </span>
          <button type="button" className="btn-secondary btn-sm" disabled={!messages.length || busy} onClick={() => setConfirmClear(true)}>
            <Icon name="trash" className="size-3.5" />
            {c.clear}
          </button>
        </div>
      </header>

      <div className="flex-1 pb-6" role="region" aria-label={c.inputLabel} tabIndex={0}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-center">
            <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" />
            <span className="eyebrow mt-6">{c.eyebrow}</span>
            <h1 className="mt-3 text-[26px] font-extrabold tracking-tight">
              {ready ? c.empty.readyTitle : readiness.processing ? c.empty.processingTitle : c.empty.waitingTitle}
            </h1>
            <p className="mt-3 max-w-[460px] text-[13px] text-muted">
              {ready ? c.empty.readyBody : readiness.processing ? c.empty.processingBody : c.empty.waitingBody}
            </p>
            {ready && ree.sampleQuestions.length > 0 ? (
              <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
                {ree.sampleQuestions.slice(0, 3).map((question, index) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => {
                      setInput(question);
                      inputRef.current?.focus();
                    }}
                    className="card flex min-h-[110px] flex-col justify-between p-4 text-left hover:border-blue"
                  >
                    <span className="font-mono text-[10px] text-muted">0{index + 1}</span>
                    <strong className="text-[12px] leading-snug">{question}</strong>
                    <Icon name="arrow" className="size-3.5 self-end text-muted" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-6 flex items-center gap-1.5 text-[12px] text-muted">
                <Icon name="shield" className="size-4 text-green" />
                {c.empty.assurance}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5 pt-2">
            {messages.map((message, index) => {
              if (message.role === 'user') {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-blue px-4 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-white">{textOf(message)}</div>
                  </div>
                );
              }
              const outcome = outcomeOf(message);
              const text = textOf(message);
              const streaming = busy && index === messages.length - 1 && !outcome;
              if (outcome?.noAnswer) {
                const missing = outcome.reason === 'no_sources';
                return (
                  <article key={message.id} className="card p-5">
                    <div className="flex items-center gap-2">
                      <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                      <strong className="text-[13px]">{ree.name}</strong>
                      <small className="ml-auto text-[11px] text-muted">{c.boundary}</small>
                    </div>
                    <div className="mt-4 flex gap-3 rounded-xl border border-line bg-wash p-4">
                      <span className="inline-flex size-9 flex-none items-center justify-center rounded-lg bg-white text-muted">
                        <Icon name="file" />
                      </span>
                      <div>
                        <h3 className="text-[14px] font-bold">{missing ? c.noSourcesTitle : c.outOfScopeTitle}</h3>
                        <p className="mt-1 text-[12px] text-muted">{missing ? c.noSourcesBody : c.outOfScopeBody}</p>
                        <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-green">
                          <Icon name="shield" className="size-3.5" />
                          {c.noCharge}
                        </span>
                      </div>
                    </div>
                  </article>
                );
              }
              const citations = outcome?.citations ?? [];
              const byIndex = new Map(citations.map((entry) => [entry.index, entry]));
              return (
                <article key={message.id} className="card p-5">
                  <div className="flex items-center gap-2">
                    <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                    <strong className="text-[13px]">{ree.name}</strong>
                    <small className="ml-auto text-[11px] text-muted">{c.answerHead}</small>
                  </div>
                  <div className="mt-3 text-[13px] leading-relaxed">
                    {text ? (
                      <Markdown
                        text={text}
                        citation={(n, key) => {
                          const entry = byIndex.get(n);
                          return entry ? (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setCitation(entry)}
                              aria-label={fill(c.citation, { n })}
                              className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded-md bg-soft px-1 align-middle font-mono text-[10px] font-bold text-blue hover:bg-blue hover:text-white"
                            >
                              {n}
                            </button>
                          ) : (
                            <sup key={key} className="font-mono text-[10px] text-muted">
                              [{n}]
                            </sup>
                          );
                        }}
                      />
                    ) : streaming ? (
                      <span className="flex items-center gap-2 text-[12px] text-muted">
                        <Spinner className="size-3.5" />
                        {c.thinking}
                      </span>
                    ) : null}
                    {outcome?.failed && <p className="mt-2 text-[12px] text-red">{c.failed}</p>}
                  </div>
                  {citations.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {citations.map((entry) => (
                        <button
                          key={entry.index}
                          type="button"
                          onClick={() => setCitation(entry)}
                          className="flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-wash px-2.5 py-1.5 text-left text-[11px] hover:border-blue hover:text-blue"
                        >
                          <Icon name={entry.kind === 'text' ? 'text' : 'file'} className="size-3.5 flex-none" />
                          <span className="truncate">
                            {entry.index} · {entry.title}
                            {locatorLabel(entry.locator, locale) && ` · ${locatorLabel(entry.locator, locale)}`}
                          </span>
                          <Icon name="external" className="size-3 flex-none" />
                        </button>
                      ))}
                    </div>
                  )}
                  {outcome && !outcome.failed && (
                    <div className="mt-3 flex items-center gap-1 border-t border-line pt-3">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={c.copyAnswer}
                        title={c.copyAnswer}
                        onClick={async () => {
                          await navigator.clipboard.writeText(text);
                          toast(t.common.actions.copied);
                        }}
                      >
                        <Icon name="copy" className="size-3.5" />
                      </button>
                      <small className="text-[11px] text-muted" title={outcome.model ? fill(c.model, { model: outcome.model }) : undefined}>
                        {fill(c.cost, { credits: n(outcome.cost) })}
                        {outcome.model && <span className="ml-1.5 font-mono text-[10px] text-[#a3a9bb]">· {outcome.model}</span>}
                      </small>
                    </div>
                  )}
                </article>
              );
            })}
            <div ref={endRef} className="scroll-mb-48" />
          </div>
        )}
      </div>

      <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-bg via-bg to-bg/0 px-4 pt-4 pb-4 md:-mx-8 md:px-8">
        <form
          className="card relative p-3 shadow-sm focus-within:border-blue"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            ref={inputRef}
            aria-label={c.inputLabel}
            className="block w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-relaxed outline-none placeholder:text-[#a3a9bb]"
            rows={2}
            maxLength={QUESTION_MAX_CHARS}
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
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 rounded-lg bg-wash px-2 py-1 text-[11px] text-muted">
              <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" className="!size-5 !rounded-md [&_svg]:!size-3" />
              <span className="truncate">{ree.name}</span>
            </span>
            <div className="relative flex items-center gap-2">
              {ree.sampleQuestions.length > 0 && (
                <>
                  <button type="button" className="btn-ghost" aria-expanded={examples} onClick={() => setExamples((value) => !value)}>
                    <Icon name="light" className="size-3.5" />
                    {c.examples}
                    <Icon name="chevronDown" className="size-3" />
                  </button>
                  {examples && (
                    <div className="absolute right-0 bottom-full z-20 mb-2 w-[min(320px,80vw)] rounded-xl border border-line bg-white p-3 shadow-xl">
                      <strong className="text-[11px] text-muted">{c.tryAsking}</strong>
                      <div className="mt-2 flex flex-col gap-1">
                        {ree.sampleQuestions.slice(0, 3).map((question) => (
                          <button
                            key={question}
                            type="button"
                            className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[12px] hover:bg-soft hover:text-blue"
                            onClick={() => {
                              setInput(question);
                              setExamples(false);
                              inputRef.current?.focus();
                            }}
                          >
                            {question}
                            <Icon name="arrow" className="size-3 flex-none" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              <button type="submit" className="btn size-10 min-h-10 p-0" aria-label={c.send} disabled={busy || !input.trim()}>
                {busy ? <Spinner /> : <Icon name="send" />}
              </button>
            </div>
          </div>
        </form>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <Icon name="shield" className="size-3.5" />
            {fill(c.upTo, { credits: n(maxCost) })}
            <span className="text-[#a3a9bb]">· {c.noAnswerNote}</span>
          </span>
          <span className="hidden sm:inline">{c.keys}</span>
        </div>
      </div>

      <Modal open={Boolean(citation)} onClose={() => setCitation(null)} variant="drawer" title={c.drawer.title} subtitle={citation?.title}>
        {citation && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <Icon name={citation.kind === 'text' ? 'text' : 'file'} className="size-3.5" />
              {t.common.kinds[citation.kind]}
              {locatorLabel(citation.locator, locale) && <span>· {locatorLabel(citation.locator, locale)}</span>}
            </div>
            <blockquote className="rounded-xl border border-line bg-wash p-4 text-[13px] leading-relaxed whitespace-pre-wrap">{citation.excerpt}</blockquote>
            <p className="flex gap-2 rounded-lg bg-soft px-3 py-2.5 text-[11px] text-[#3b4361]">
              <Icon name="info" className="mt-0.5 size-3.5 flex-none text-blue" />
              {c.drawer.note}
            </p>
            <div className="flex items-center gap-2 text-[11px] text-muted">
              <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
              {ree.name} · {fill(c.drawer.source, { n: citation.index })}
            </div>
            <button
              type="button"
              className="btn-secondary w-fit"
              onClick={async () => {
                await navigator.clipboard.writeText(`${citation.title} · ${locatorLabel(citation.locator, locale)}\n${citation.excerpt}`);
                toast(t.common.actions.copied);
              }}
            >
              <Icon name="copy" />
              {c.drawer.copy}
            </button>
          </div>
        )}
      </Modal>

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
            <Link href="/settings?tab=billing" className="btn">
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
    </main>
  );
}
