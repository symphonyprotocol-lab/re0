'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { CONVERSATION_MAX_REES, SYNTHESIS_ENABLED, SYNTHESIS_MIN_ANSWERS } from '@/lib/constants';
import type { CitationSnapshot, SentenceCheck } from '@/lib/domain/answer';
import {
  repliesOf,
  requestIdOf,
  suggestionsOf,
  SYNTHESIS_PART_ID,
  synthesisOf,
  type InsufficientCreditsBody,
  type ReeReply,
  type ReeUIMessage,
  type SuggestedRee,
  type SynthesisPart,
} from '@/lib/domain/chat-message';
import { ApiError, conversationApi, streamSynthesis, takePending } from '@/lib/client/conversations';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { AnswerText, Avatar, CheckDrawer, CheckLine, CitationChips, CitationDrawer, Feedback, I, Typing, useNavigationHeight } from '@/components/chat/message-parts';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { RoleBadge } from '@/components/discover/role-badge';
import { Composer, type ComposerHandle } from '@/components/conversations/composer';
import { SynthesisBubble, SynthesisButton } from '@/components/conversations/synthesis';
import { useCurrentConversation } from '@/components/conversations/sidebar-history';
import type { Member } from '@/components/conversations/participant-picker';

/** Any Ree that appears in this conversation, present or not, by id: history keeps names (8.2). */
export type ReeDirectory = Record<string, Member>;

function textOf(message: ReeUIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Answers a synthesis can draw on: given, finished and stored. */
function answered(replies: readonly ReeReply[]): ReeReply[] {
  return replies.filter((reply) => reply.outcome && !reply.outcome.noAnswer && !reply.outcome.failed && reply.outcome.messageId && reply.text.trim());
}

function asMember(ree: SuggestedRee): Member {
  return { ...ree, ownerId: '', ownerName: '', queryFee: ree.price, isPublic: true, sampleQuestions: [], usable: true, role: ree.role as Member['role'] };
}

/**
 * `/chats/[id]` (prototype chat-room.js, app.js `messageHTML`): a quiet
 * reading column filling the window under the top bar, the composer docked
 * below it; each question's Rees answer one after another as they stream; a
 * Ree with nothing relevant is one grey line, and when nobody could answer,
 * the public Rees that might know are offered one click away under it.
 * Citations open the drawer from their snapshots; answers can be voted on
 * and copied. A question two or more Rees answered can be synthesized once
 * (Ree 圆桌), and the suggested Rees can be asked all together.
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
  const rt = t.conversations.roundtable;
  const router = useRouter();
  const toast = useToast();
  const [members, setMembers] = useState(initialMembers);
  const [scope, setScope] = useState<string | null>(null);
  /* "核对引用" is off in a conversation until turned on, and stays as set for the next questions. */
  const [verify, setVerify] = useState(false);
  const [checked, setChecked] = useState<{ check: SentenceCheck; reply: ReeReply } | null>(null);
  const [citation, setCitation] = useState<{ entry: CitationSnapshot; ree: Member | null } | null>(null);
  const [insufficient, setInsufficient] = useState<InsufficientCreditsBody | null>(null);
  const [votes, setVotes] = useState<Record<string, 'up' | 'down' | null>>({});
  /* The question whose synthesis is being written, if any. */
  const [synthesizing, setSynthesizing] = useState<string | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  useNavigationHeight(page);
  const pending = useRef<{ question: string; scope: string | readonly string[] | null; verify: boolean }>({ question: '', scope: null, verify: false });
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

  const ask = (question: string, chosenScope: string | readonly string[] | null = scope, checking = verify) => {
    pending.current = { question, scope: chosenScope, verify: checking };
    void sendMessage({ text: question });
  };

  /* A question typed on /talk arrives with the new conversation and is sent once. */
  useEffect(() => {
    if (sentPending.current) return;
    sentPending.current = true;
    const carried = takePending(conversation.id);
    if (!carried) return;
    setScope(carried.scope);
    setVerify(Boolean(carried.verify));
    ask(carried.question, carried.scope, Boolean(carried.verify));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  useEffect(() => {
    const transcript = endRef.current?.parentElement;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  const applyParticipants = async (chosen: Member[]) => {
    if (busy) return toast(r.waitBusy);
    const next = new Set(chosen.map((member) => member.id));
    try {
      await conversationApi.setRees(conversation.id, [...next]);
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
      setMembers((current) => [...current, asMember(ree)]);
      toast(r.suggestionAdded);
      router.refresh();
    } catch (error) {
      toast(error instanceof ApiError && error.code === 'too_many_rees' ? r.full : t.common.errors.generic);
    }
  };

  /**
   * "一起问这 3 个": the suggested Rees join one by one -- only added, so
   * nobody already in the conversation is dropped -- as many as fit, and
   * the question goes to those that are in.
   */
  const askTogether = async (rees: SuggestedRee[], question: string) => {
    if (busy || synthesizing) return toast(r.waitBusy);
    if (!question) return toast(t.common.errors.generic);
    const present = new Set(members.map((member) => member.id));
    let room = Math.max(0, CONVERSATION_MAX_REES - members.length);
    const asked: SuggestedRee[] = [];
    const joined: SuggestedRee[] = [];
    let failure: unknown = null;
    for (const ree of rees) {
      if (present.has(ree.id)) {
        asked.push(ree);
        continue;
      }
      if (room === 0) break;
      try {
        await conversationApi.addRee(conversation.id, ree.id);
      } catch (error) {
        failure = error;
        break;
      }
      room -= 1;
      asked.push(ree);
      joined.push(ree);
    }
    if (joined.length) setMembers((current) => [...current, ...joined.filter((ree) => !current.some((member) => member.id === ree.id)).map(asMember)]);
    if (failure) toast(failure instanceof ApiError && failure.code === 'too_many_rees' ? r.full : failure instanceof ApiError && failure.code === 'ree_unavailable' ? r.unavailable : t.common.errors.generic);
    if (!asked.length) return failure ? undefined : toast(r.full);
    ask(question, asked.map((ree) => ree.id));
  };

  /** Puts a question's synthesis part in place, or takes it out. */
  const putSynthesis = (messageId: string, data: SynthesisPart | null) =>
    setMessages((current) =>
      current.map((message) =>
        message.id !== messageId
          ? message
          : { ...message, parts: [...message.parts.filter((part) => part.type !== 'data-synthesis'), ...(data ? [{ type: 'data-synthesis' as const, id: SYNTHESIS_PART_ID, data }] : [])] },
      ),
    );

  const synthesize = async (message: ReeUIMessage) => {
    if (busy || synthesizing) return toast(r.waitBusy);
    const requestId = requestIdOf(message);
    setSynthesizing(requestId);
    try {
      const final = await streamSynthesis(conversation.id, requestId, (part) => putSynthesis(message.id, part));
      putSynthesis(message.id, final);
      /* The balance in the sidebar moved. */
      if (final.state === 'done') router.refresh();
    } catch (error) {
      putSynthesis(message.id, null);
      if (error instanceof ApiError && error.status === 402) setInsufficient(error.body as unknown as InsufficientCreditsBody);
      else if (error instanceof ApiError && error.code === 'already_synthesized') toast(rt.already);
      else if (error instanceof ApiError && error.code === 'synthesis_running') toast(rt.running);
      else if (error instanceof ApiError && error.code === 'not_enough_answers') toast(rt.notEnough);
      else toast(t.common.errors.generic);
    } finally {
      setSynthesizing(null);
    }
  };

  const voteSynthesis = async (part: SynthesisPart, messageId: string, value: 'up' | 'down') => {
    if (!part.synthesisId) return;
    const current = part.vote;
    const next = current === value ? null : value;
    putSynthesis(messageId, { ...part, vote: next });
    try {
      await conversationApi.voteSynthesis(part.synthesisId, next);
      toast(r.feedbackSaved);
    } catch {
      putSynthesis(messageId, { ...part, vote: current });
      toast(t.common.errors.generic);
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
  const lastIndex = messages.length - 1;

  return (
    <section ref={page} className="chat-room" aria-label={conversation.title}>
      <h1 className="room-sr-only">{conversation.title}</h1>
      <div className="room-messages" id="transcript" role="region" aria-label={r.messagesLabel} tabIndex={0}>
        {messages.length === 0 ? (
          <div className="room-empty">
            <span className="room-empty-avatar">{only ? <Avatar ree={only} /> : <I name="sparkle" />}</span>
            <p className="eyebrow">{r.emptyEyebrow}</p>
            <h2>{only ? fill(r.emptyOne, { name: only.name }) : members.length ? r.emptyMany : r.emptyNone}</h2>
            <p>{only ? only.description : members.length ? r.emptyManyBody : r.emptyNoneBody}</p>
            {members.length > 0 ? (
              <div className="room-starters">
                {(only?.sampleQuestions.length ? only.sampleQuestions : r.starters).slice(0, 3).map((question) => (
                  <button key={question} type="button" onClick={() => composer.current?.fill(question)}>
                    {question}
                    <I name="arrow" />
                  </button>
                ))}
              </div>
            ) : (
              <button type="button" className="btn secondary" onClick={() => composer.current?.manage()} disabled={busy}>
                <I name="plus" />
                {r.chooseCompanions}
              </button>
            )}
          </div>
        ) : (
          <div className="room-thread">
            {messages.map((message, index) => {
              if (message.role === 'user') {
                return (
                  <div key={message.id} className="message user">
                    <div className="user-bubble">{textOf(message)}</div>
                  </div>
                );
              }
              const replies = repliesOf(message);
              const live = busy && index === lastIndex;
              const suggestions = suggestionsOf(message).filter((ree) => !members.some((member) => member.id === ree.id));
              /* The public Rees that might know go under the last Ree that could not answer (prototype `.no-answer` `.flex.mt16`). */
              const lastNoAnswer = replies.map((reply) => Boolean(reply.outcome?.noAnswer)).lastIndexOf(true);
              const question = messages[index - 1]?.role === 'user' ? textOf(messages[index - 1]!) : '';
              const synthesis = synthesisOf(message);
              const answers = answered(replies);
              const canSynthesize = SYNTHESIS_ENABLED && !live && answers.length >= SYNTHESIS_MIN_ANSWERS && (!synthesis || synthesis.state === 'failed');
              const room = CONVERSATION_MAX_REES - members.length;
              const together = suggestions.slice(0, Math.max(0, room));
              return [
                ...replies.map((reply, at) => (
                  <Reply
                    key={`${message.id}:${reply.reeId}`}
                    reply={reply}
                    ree={reeById[reply.reeId] ?? null}
                    streaming={live && !reply.outcome}
                    vote={reply.outcome?.messageId ? (votes[reply.outcome.messageId] !== undefined ? votes[reply.outcome.messageId]! : (reply.outcome.vote ?? null)) : null}
                    onVote={(value, current) => reply.outcome?.messageId && vote(reply.outcome.messageId, value, current)}
                    onCitation={(entry) => setCitation({ entry, ree: reeById[reply.reeId] ?? null })}
                    onCheck={(check) => setChecked({ check, reply })}
                    suggestions={
                      at === lastNoAnswer && suggestions.length > 0 ? (
                        <div className="p-flex mt16">
                          {suggestions.map((ree) => (
                            <button key={ree.id} type="button" className="btn secondary sm" title={fill(r.perAnswer, { n: n(ree.price) })} onClick={() => addSuggested(ree)} disabled={busy}>
                              <I name="plus" />
                              {ree.name}
                            </button>
                          ))}
                          {SYNTHESIS_ENABLED && together.length >= SYNTHESIS_MIN_ANSWERS && question && (
                            <button
                              type="button"
                              className="btn sm"
                              title={`${rt.askTogetherHint} · ${fill(r.upToShort, { n: n(together.reduce((sum, ree) => sum + ree.price, 0)) })}`}
                              onClick={() => askTogether(together, question)}
                              disabled={busy || Boolean(synthesizing)}
                            >
                              <I name="users" />
                              {fill(rt.askTogether, { n: together.length })}
                            </button>
                          )}
                        </div>
                      ) : null
                    }
                  />
                )),
                synthesis ? (
                  <SynthesisBubble
                    key={`${message.id}:synthesis`}
                    part={synthesis}
                    directory={reeById}
                    vote={synthesis.vote}
                    onVote={(value) => voteSynthesis(synthesis, message.id, value)}
                    onSource={(entry, reeId) => setCitation({ entry, ree: reeById[reeId] ?? null })}
                  />
                ) : null,
                canSynthesize ? (
                  <SynthesisButton key={`${message.id}:synthesize`} answers={answers.length} disabled={busy || Boolean(synthesizing)} onClick={() => synthesize(message)} />
                ) : null,
              ];
            })}
          </div>
        )}
        {status === 'submitted' && messages.at(-1)?.role === 'user' && <Typing />}
        <div ref={endRef} />
      </div>

      <div className="room-compose-dock">
        <Composer ref={composer} members={members} scope={scope} verify={verify} onVerify={setVerify} draft={false} busy={busy || Boolean(synthesizing)} viewerId={viewerId} onScope={setScope} onParticipants={applyParticipants} onSend={(question) => ask(question)} />
      </div>

      <CheckDrawer check={checked?.check ?? null} text={checked?.reply.text ?? ''} citations={checked?.reply.outcome?.citations ?? []} onClose={() => setChecked(null)} />

      <CitationDrawer citation={citation?.entry ?? null} ree={citation?.ree ?? null} canOpen={citation?.ree?.ownerId === viewerId} onClose={() => setCitation(null)} />

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
            <Link href="/settings?tab=balance" className="btn">
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
    </section>
  );
}

/**
 * One Ree's part of the answer (prototype app.js `messageHTML`): its head,
 * the grounded text with citations, the sources and the feedback row; a Ree
 * with nothing relevant is one grey `.no-answer` line.
 */
function Reply({
  reply,
  ree,
  streaming,
  vote,
  onVote,
  onCitation,
  onCheck,
  suggestions,
}: {
  reply: ReeReply;
  ree: Member | null;
  streaming: boolean;
  vote: 'up' | 'down' | null;
  onVote: (value: 'up' | 'down', current: 'up' | 'down' | null) => void;
  onCitation: (entry: CitationSnapshot) => void;
  onCheck: (check: SentenceCheck) => void;
  suggestions: ReactNode;
}) {
  const { t, locale } = useI18n();
  const r = t.conversations.room;
  const outcome = reply.outcome;
  const name = ree?.name ?? r.removedRee;

  if (outcome?.noAnswer) {
    return (
      <div className="no-answer" data-no-answer={reply.reeId}>
        {fill(outcome.reason === 'no_sources' ? r.notReady : r.noKnowledge, { name })} {suggestions}
      </div>
    );
  }
  if (streaming && !reply.text) return <Typing />;

  const citations = outcome?.citations ?? [];
  return (
    <article className="message" data-reply={reply.reeId} aria-busy={streaming}>
      <div className="message-head">
        <Avatar ree={ree} sm />
        <strong>{name}</strong>
        <RoleBadge role={ree?.role} />
        <small>{r.grounded}</small>
      </div>
      <AnswerText text={reply.text} citations={citations} failed={outcome?.failed} onCitation={onCitation} checks={reply.check?.checks} onCheck={onCheck} />
      <CitationChips citations={citations} onCitation={onCitation} />
      <CheckLine check={reply.check} text={reply.text} cost={reply.check?.cost ? fill(t.chat.check.cost, { credits: formatNumber(reply.check.cost, locale) }) : undefined} />
      {outcome && !outcome.failed && outcome.messageId && (
        <Feedback text={reply.text} vote={vote} onVote={(value) => onVote(value, vote)} cost={fill(t.chat.cost, { credits: formatNumber(outcome.cost, locale) })} />
      )}
    </article>
  );
}
