'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { autoTitle } from '@/lib/domain/conversation';
import { ApiError, conversationApi, stashPending } from '@/lib/client/conversations';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { Composer, type ComposerHandle } from '@/components/conversations/composer';
import type { Member } from '@/components/conversations/participant-picker';

/**
 * `/talk` (prototype experience.js `newConversationPage`): a draft with its
 * own participants (up to five), example questions and the cost of the
 * question as typed. Nothing is stored until the first question is sent:
 * then the conversation is created with these Rees and the question goes
 * with it to the conversation's page, which asks it.
 */
export function TalkDraft({ initialMembers, viewerId }: { initialMembers: Member[]; viewerId: string }) {
  const { t } = useI18n();
  const c = t.conversations;
  const router = useRouter();
  const toast = useToast();
  const [members, setMembers] = useState(initialMembers);
  const [scope, setScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const composer = useRef<ComposerHandle>(null);

  const send = async (question: string) => {
    setBusy(true);
    try {
      const { id } = await conversationApi.create(
        members.map((member) => member.id),
        autoTitle(question),
      );
      stashPending(id, { question, scope });
      router.push(`/chats/${id}`);
    } catch (error) {
      setBusy(false);
      composer.current?.fill(question);
      toast(error instanceof ApiError && error.code === 'ree_unavailable' ? c.room.unavailable : t.common.errors.generic);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-64px)] w-full max-w-[760px] flex-col justify-center px-4 py-10 md:px-8">
      <header className="text-center">
        <span className="eyebrow">{c.talk.eyebrow}</span>
        <h1 className="mt-3 text-[30px] font-extrabold tracking-tight">{c.talk.title}</h1>
        <p className="mt-2 text-[13px] text-muted">{c.talk.body}</p>
      </header>
      <div className="mt-8">
        <Composer
          ref={composer}
          members={members}
          scope={scope}
          draft
          busy={busy}
          viewerId={viewerId}
          autoFocus
          onScope={setScope}
          onParticipants={(chosen) => {
            setMembers(chosen);
            if (scope && !chosen.some((member) => member.id === scope)) setScope(null);
          }}
          onSend={send}
        />
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-[12px]">
        <span className="text-muted">{c.talk.tryAsking}</span>
        {[...new Set([...members.flatMap((member) => member.sampleQuestions), ...c.talk.prompts])].slice(0, 4).map((prompt) => (
          <button key={prompt} type="button" className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 hover:border-blue hover:text-blue" onClick={() => composer.current?.fill(prompt)} disabled={busy}>
            <Icon name="sparkle" className="size-3.5" />
            <span className="max-w-[260px] truncate">{prompt}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
