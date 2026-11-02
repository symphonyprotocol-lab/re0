'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { CONVERSATION_MAX_REES } from '@/lib/constants';
import { locatorLabel, type CitationSnapshot } from '@/lib/domain/answer';
import { repliesOf, suggestionsOf, type InsufficientCreditsBody, type ReeReply, type ReeUIMessage, type SuggestedRee } from '@/lib/domain/chat-message';
import { ApiError, conversationApi, takePending } from '@/lib/client/conversations';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { KIND_ICONS } from '@/components/knowledge/kind-icons';
import { Markdown } from '@/components/chat/markdown';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { RoleBadge } from '@/components/discover/role-badge';
import { Composer, type ComposerHandle } from '@/components/conversations/composer';
import { useCurrentConversation } from '@/components/conversations/sidebar-history';
import type { Member } from '@/components/conversations/participant-picker';

/** Any Ree that appears in this conversation, present or not, by id: history keeps names (8.2). */
export type ReeDirectory = Record<string, Member>;

function textOf(message: ReeUIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * `/chats/[id]` (prototype chat-room.js, app.js `messageHTML`): a centred
 * transcript; each question's Rees answer in their own bubbles, side by
 * side as they stream; a Ree with nothing relevant is one grey line (a
 * card when it was the only one asked), and when nobody could answer, the
 * public Rees that might know are offered one click away. Citations open
 * the drawer from their snapshots; answers can be voted on and copied.
 */
export function ChatRoom({
  conversation,
  members: initialMembers,
  directory,
  initialMessages,
  viewerId,
}: {
  conversation: { id: string; title: string; pinned: boolean; archived: boolean; updatedAt: string };
  members: Member[];
  directory: ReeDirectory;
  initialMessages: ReeUIMessage[];
  viewerId: string;
}) {
  const { t, locale } = useI18n();
  const r = t.conversations.room;
  const router = useRouter();
  const toast = useToast();
  const [members, setMembers] = useState(initialMembers);
  const [scope, setScope] = useState<string | null>(null);
  const [citation, setCitation] = useState<{ entry: CitationSnapshot; ree: Member | null } | null>(null);
  const [insufficient, setInsufficient] = useState<InsufficientCreditsBody | null>(null);
  const [votes, setVotes] = useState<Record<string, 'up' | 'down' | null>>({});
  const composer = useRef<ComposerHandle>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ question: string; scope: string | null }>({ question: '', scope: null });
  const sentPending = useRef(false);

  useEffect(() => setMembers(initialMembers), [initialMembers]);
  useCurrentConversation({ id: conversation.id, title: conversation.title, pinned: conversation.pinned, archived: conversation.archived, updatedAt: conversation.updatedAt });

  const reeById = useMemo(() => {
    const map: ReeDirectory = { ...directory };
    for (const member of members) map[member.id] = member;
    return map;
  }, [directory, members]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ReeUIMessage>({
        api: `/api/chats/${conversation.id}/messages`,
        prepareSendMessagesRequest: () => ({ body: pending.current }),
      }),
    [conversation.id],
  );

  const { messages, sendMessage, status, setMessages } = useChat<ReeUIMessage>({
    id: conversation.id,
    messages: initialMessages,
    transport,
    onError: (error) => {
      try {
        const body = JSON.parse(error.message) as Partial<InsufficientCreditsBody> & { error?: string };
        setMessages((current) => current.slice(0, -1));
        composer.current?.fill(pending.current.question);
        if (body.error === 'insufficient_credits') return setInsufficient(body as InsufficientCreditsBody);
        if (body.error === 'unknown_mention') return toast(r.unknownMention);
        if (body.error === 'no_participants') return toast(r.noParticipants);
      } catch {
        /* not JSON */
      }
      toast(t.common.errors.generic);
    },
    onFinish: ({ message }) => {
      const replies = repliesOf(message);
      if (replies.length > 1 && replies.every((reply) => reply.outcome?.noAnswer)) toast(r.noAnswerToast);
      router.refresh();
    },
  });
  const busy = status === 'submitted' || status === 'streaming';

  const ask = (question: string, chosenScope = scope) => {
    pending.current = { question, scope: chosenScope };
    void sendMessage({ text: question });
  };

  /* A question typed on /talk arrives with the new conversation and is sent once. */
  useEffect(() => {
    if (sentPending.current) return;
    sentPending.current = true;
    const carried = takePending(conversation.id);
    if (!carried) return;
    setScope(carried.scope);
    ask(carried.question, carried.scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const applyParticipants = async (chosen: Member[]) => {
    if (busy) return toast(r.waitBusy);
    const next = new Set(chosen.map((member) => member.id));
    const current = new Set(members.map((member) => member.id));
    try {
      for (const member of members) if (!next.has(member.id)) await conversationApi.removeRee(conversation.id, member.id);
      for (const member of chosen) if (!current.has(member.id)) await conversationApi.addRee(conversation.id, member.id);
      setMembers(chosen);
      if (scope && !next.has(scope)) setScope(null);
      toast(r.updated);
    } catch (error) {
      toast(error instanceof ApiError && error.code === 'too_many_rees' ? r.full : error instanceof ApiError && error.code === 'ree_unavailable' ? r.unavailable : t.common.errors.generic);
    }
    router.refresh();
  };

  const addSuggested = async (ree: SuggestedRee) => {
    if (members.length >= CONVERSATION_MAX_REES) return toast(r.full);
    try {
      await conversationApi.addRee(conversation.id, ree.id);
      setMembers((current) => [
        ...current,
        { ...ree, ownerId: '', ownerName: '', queryFee: ree.price, isPublic: true, sampleQuestions: [], usable: true, role: ree.role as Member['role'] },
      ]);
      toast(r.suggestionAdded);
      router.refresh();
    } catch (error) {
      toast(error instanceof ApiError && error.code === 'too_many_rees' ? r.full : t.common.errors.generic);
    }
  };

  const vote = async (messageId: string, value: 'up' | 'down', current: 'up' | 'down' | null) => {
    const next = current === value ? null : value;
    setVotes((all) => ({ ...all, [messageId]: next }));
    try {
      await conversationApi.vote(messageId, next);
      toast(r.feedbackSaved);
    } catch {
      setVotes((all) => ({ ...all, [messageId]: current }));
      toast(t.common.errors.generic);
    }
  };

  const n = (value: number) => formatNumber(value, locale);
  const only = members.length === 1 ? members[0]! : null;

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-108px)] w-full max-w-[860px] flex-col px-4 md:px-8">
      <div className="flex-1 pb-6" role="region" aria-label={r.inputLabel} tabIndex={0}>
        <h1 className="sr-only">{conversation.title}</h1>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-2xl border border-line bg-white text-blue">
              {only ? <ReeAvatar avatar={only.avatarBlob} color={only.color} size="lg" /> : <Icon name={members.length ? 'users' : 'sparkle'} className="size-6" />}
            </span>
            <span className="eyebrow mt-6">{r.emptyEyebrow}</span>
            <h2 className="mt-3 text-[26px] font-extrabold tracking-tight">{only ? fill(r.emptyOne, { name: only.name }) : members.length ? r.emptyMany : r.emptyNone}</h2>
            <p className="mt-3 max-w-[460px] text-[13px] text-muted">{only ? only.description : members.length ? r.emptyManyBody : r.emptyNoneBody}</p>
            {members.length > 0 && (
              <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
                {(only?.sampleQuestions.length ? only.sampleQuestions : r.starters).slice(0, 3).map((question) => (
                  <button key={question} type="button" onClick={() => composer.current?.fill(question)} className="card flex items-center justify-between gap-3 p-4 text-left text-[12px] hover:border-blue">
                    <strong className="leading-snug">{question}</strong>
                    <Icon name="arrow" className="size-3.5 flex-none text-muted" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5 pt-4">
            {messages.map((message, index) => {
              if (message.role === 'user') {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-blue px-4 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-white">{textOf(message)}</div>
                  </div>
                );
              }
              const replies = repliesOf(message);
              const live = busy && index === messages.length - 1;
              const suggestions = suggestionsOf(message).filter((ree) => !members.some((member) => member.id === ree.id));
              return (
                <div key={message.id} className="flex flex-col gap-3">
                  {replies.map((reply) => (
                    <Reply
                      key={reply.reeId}
                      reply={reply}
                      ree={reeById[reply.reeId] ?? null}
                      single={replies.length === 1}
                      streaming={live && !reply.outcome}
                      vote={reply.outcome?.messageId ? (votes[reply.outcome.messageId] !== undefined ? votes[reply.outcome.messageId]! : (reply.outcome.vote ?? null)) : null}
                      onVote={(value, current) => reply.outcome?.messageId && vote(reply.outcome.messageId, value, current)}
                      onCitation={(entry) => setCitation({ entry, ree: reeById[reply.reeId] ?? null })}
                    />
                  ))}
                  {suggestions.length > 0 && (
                    <div className="rounded-xl border border-dashed border-line bg-white/60 p-3">
                      <strong className="flex items-center gap-1.5 text-[12px]">
                        <Icon name="compass" className="size-4 text-blue" />
                        {r.suggestions}
                      </strong>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {suggestions.map((ree) => (
                          <button key={ree.id} type="button" className="btn-secondary btn-sm" onClick={() => addSuggested(ree)} disabled={busy}>
                            <Icon name="plus" className="size-3.5" />
                            <span className="max-w-[180px] truncate">{ree.name}</span>
                            <RoleBadge role={ree.role} />
                            <small className="font-mono text-muted">{n(ree.price)}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {status === 'submitted' && messages.at(-1)?.role === 'user' && (
              <span className="flex items-center gap-2 text-[12px] text-muted">
                <Spinner className="size-3.5" />
                {t.chat.thinking}
              </span>
            )}
            <div ref={endRef} className="scroll-mb-48" />
          </div>
        )}
      </div>

      <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-bg via-bg to-bg/0 px-4 pt-4 pb-4 md:-mx-8 md:px-8">
        <Composer ref={composer} members={members} scope={scope} draft={false} busy={busy} viewerId={viewerId} onScope={setScope} onParticipants={applyParticipants} onSend={(question) => ask(question)} />
      </div>

      <Modal open={Boolean(citation)} onClose={() => setCitation(null)} variant="drawer" title={t.chat.drawer.title} subtitle={citation?.entry.title}>
        {citation && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <Icon name={KIND_ICONS[citation.entry.kind]} className="size-3.5" />
              {t.common.kinds[citation.entry.kind]}
              {locatorLabel(citation.entry.locator, locale) && <span>· {locatorLabel(citation.entry.locator, locale)}</span>}
            </div>
            <blockquote className="rounded-xl border border-line bg-wash p-4 text-[13px] leading-relaxed whitespace-pre-wrap">{citation.entry.excerpt}</blockquote>
            <p className="flex gap-2 rounded-lg bg-soft px-3 py-2.5 text-[11px] text-[#3b4361]">
              <Icon name="info" className="mt-0.5 size-3.5 flex-none text-blue" />
              {t.chat.drawer.note}
            </p>
            <div className="flex items-center gap-2 text-[11px] text-muted">
              <ReeAvatar avatar={citation.ree?.avatarBlob} color={citation.ree?.color} size="sm" />
              {citation.ree?.name ?? r.removedRee} · {fill(t.chat.drawer.source, { n: citation.entry.index })}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary w-fit"
                onClick={async () => {
                  await navigator.clipboard.writeText(`${citation.entry.title} · ${locatorLabel(citation.entry.locator, locale)}\n${citation.entry.excerpt}`);
                  toast(t.common.actions.copied);
                }}
              >
                <Icon name="copy" />
                {t.chat.drawer.copy}
              </button>
              {/* Only the owner can open the source itself; anyone else sees the snapshot. */}
              {citation.ree?.ownerId === viewerId && (
                <Link
                  className="btn-secondary w-fit"
                  href={`/rees/${citation.ree.id}/knowledge/${citation.entry.knowledgeId}${citation.entry.locator.time !== undefined ? `?t=${Math.floor(citation.entry.locator.time)}` : ''}`}
                >
                  <Icon name="external" />
                  {t.chat.drawer.open}
                </Link>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(insufficient)}
        onClose={() => setInsufficient(null)}
        title={t.chat.insufficient.title}
        subtitle={t.chat.insufficient.body}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setInsufficient(null)}>
              {t.common.actions.cancel}
            </button>
            <Link href="/settings?tab=billing" className="btn">
              {t.chat.insufficient.topUp}
              <Icon name="arrow" />
            </Link>
          </>
        }
      >
        {insufficient && (
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="flex justify-between rounded-lg bg-wash px-3 py-2.5">
              <span className="text-muted">{t.chat.insufficient.balance}</span>
              <strong className="font-mono">{n(insufficient.balance)} credits</strong>
            </div>
            <div className="flex justify-between rounded-lg bg-wash px-3 py-2.5">
              <span className="text-muted">{t.chat.insufficient.needed}</span>
              <strong className="font-mono">{n(insufficient.needed)} credits</strong>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}

function Reply({
  reply,
  ree,
  single,
  streaming,
  vote,
  onVote,
  onCitation,
}: {
  reply: ReeReply;
  ree: Member | null;
  single: boolean;
  streaming: boolean;
  vote: 'up' | 'down' | null;
  onVote: (value: 'up' | 'down', current: 'up' | 'down' | null) => void;
  onCitation: (entry: CitationSnapshot) => void;
}) {
  const { t, locale } = useI18n();
  const r = t.conversations.room;
  const toast = useToast();
  const outcome = reply.outcome;
  const name = ree?.name ?? r.removedRee;
  const head = (
    <div className="flex min-w-0 items-center gap-2">
      <ReeAvatar avatar={ree?.avatarBlob} color={ree?.color} size="sm" />
      <strong className="truncate text-[13px]">{name}</strong>
      <RoleBadge role={ree?.role} />
    </div>
  );

  if (outcome?.noAnswer && !single) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-line bg-wash px-3 py-2 text-[12px] text-muted" data-no-answer={reply.reeId}>
        <ReeAvatar avatar={ree?.avatarBlob} color={ree?.color} size="sm" className="!size-6 !rounded-md [&_svg]:!size-3.5" />
        {fill(outcome.reason === 'no_sources' ? r.notReady : r.noKnowledge, { name })}
      </p>
    );
  }
  if (outcome?.noAnswer) {
    const missing = outcome.reason === 'no_sources';
    return (
      <article className="card p-5" data-no-answer={reply.reeId}>
        <div className="flex items-center gap-2">
          {head}
          <small className="ml-auto flex-none text-[11px] text-muted">{t.chat.boundary}</small>
        </div>
        <div className="mt-4 flex gap-3 rounded-xl border border-line bg-wash p-4">
          <span className="inline-flex size-9 flex-none items-center justify-center rounded-lg bg-white text-muted">
            <Icon name="file" />
          </span>
          <div>
            <h3 className="text-[14px] font-bold">{missing ? t.chat.noSourcesTitle : t.chat.outOfScopeTitle}</h3>
            <p className="mt-1 text-[12px] text-muted">{missing ? t.chat.noSourcesBody : t.chat.outOfScopeBody}</p>
            <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-green">
              <Icon name="shield" className="size-3.5" />
              {t.chat.noCharge}
            </span>
          </div>
        </div>
      </article>
    );
  }

  const citations = outcome?.citations ?? [];
  const byIndex = new Map(citations.map((entry) => [entry.index, entry]));
  return (
    <article className="card p-5" data-reply={reply.reeId} aria-busy={streaming}>
      <div className="flex items-center gap-2">
        {head}
        <small className="ml-auto flex-none text-[11px] text-muted">{r.grounded}</small>
      </div>
      <div className="mt-3 text-[13px] leading-relaxed">
        {reply.text ? (
          <Markdown
            text={reply.text}
            citation={(index, key) => {
              const entry = byIndex.get(index);
              return entry ? (
                <button
                  key={key}
                  type="button"
                  onClick={() => onCitation(entry)}
                  aria-label={fill(t.chat.citation, { n: index })}
                  className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded-md bg-soft px-1 align-middle font-mono text-[10px] font-bold text-blue hover:bg-blue hover:text-white"
                >
                  {index}
                </button>
              ) : (
                <sup key={key} className="font-mono text-[10px] text-muted">
                  [{index}]
                </sup>
              );
            }}
          />
        ) : streaming ? (
          <span className="flex items-center gap-2 text-[12px] text-muted">
            <Spinner className="size-3.5" />
            {t.chat.thinking}
          </span>
        ) : null}
        {outcome?.failed && <p className="mt-2 text-[12px] text-red">{t.chat.failed}</p>}
      </div>
      {citations.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {citations.map((entry) => (
            <button
              key={entry.index}
              type="button"
              onClick={() => onCitation(entry)}
              className="flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-wash px-2.5 py-1.5 text-left text-[11px] hover:border-blue hover:text-blue"
            >
              <Icon name={KIND_ICONS[entry.kind]} className="size-3.5 flex-none" />
              <span className="truncate">
                {entry.index} · {entry.title}
                {locatorLabel(entry.locator, locale) && ` · ${locatorLabel(entry.locator, locale)}`}
              </span>
              <Icon name="external" className="size-3 flex-none" />
            </button>
          ))}
        </div>
      )}
      {outcome && !outcome.failed && outcome.messageId && (
        <div className="mt-3 flex items-center gap-1 border-t border-line pt-3">
          <button type="button" className={`icon-btn ${vote === 'up' ? '!bg-soft !text-blue' : ''}`} aria-label={r.helpful} title={r.helpful} aria-pressed={vote === 'up'} onClick={() => onVote('up', vote)}>
            <Icon name="thumbUp" className="size-3.5" />
          </button>
          <button type="button" className={`icon-btn ${vote === 'down' ? '!bg-soft !text-blue' : ''}`} aria-label={r.notHelpful} title={r.notHelpful} aria-pressed={vote === 'down'} onClick={() => onVote('down', vote)}>
            <Icon name="thumbDown" className="size-3.5" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={r.copy}
            title={r.copy}
            onClick={async () => {
              await navigator.clipboard.writeText(reply.text);
              toast(t.common.actions.copied);
            }}
          >
            <Icon name="copy" className="size-3.5" />
          </button>
          <small className="ml-1 text-[11px] text-muted">
            {fill(t.chat.cost, { credits: formatNumber(outcome.cost, locale) })}
          </small>
        </div>
      )}
    </article>
  );
}
