'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { autoTitle } from '@/lib/domain/conversation';
import { ApiError, conversationApi, stashPending } from '@/lib/client/conversations';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { Composer, type ComposerHandle } from '@/components/conversations/composer';
import type { Member } from '@/components/conversations/participant-picker';

/** The `/talk` draft kept in this tab's session storage, per user. */
interface Draft {
  question: string;
  members: Member[];
  scope: string | null;
}

const draftKey = (viewerId: string) => `re0:talk-draft:${viewerId}`;

function readDraft(viewerId: string): Draft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(viewerId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function writeDraft(viewerId: string, draft: Draft | null): void {
  try {
    if (draft) sessionStorage.setItem(draftKey(viewerId), JSON.stringify(draft));
    else sessionStorage.removeItem(draftKey(viewerId));
  } catch {
    /* storage off: the draft lives only on this page */
  }
}

/**
 * `/talk` (prototype experience.js `newConversationPage`): a draft with its
 * own participants (up to five), example questions and the cost of the
 * question as typed. Nothing is stored until the first question is sent:
 * then the conversation is created with these Rees and the question goes
 * with it to the conversation's page, which asks it.
 *
 * The draft -- question, chosen Rees and who answers -- survives leaving
 * the page for this browser tab (prototype chat-room.js `chatDrafts`); the
 * sidebar's 新建对话 (`fresh`) and a successful start clear it.
 */
export function TalkDraft({ initialMembers, viewerId, fresh }: { initialMembers: Member[]; viewerId: string; fresh: boolean }) {
  const { t } = useI18n();
  const c = t.conversations;
  const router = useRouter();
  const toast = useToast();
  const [members, setMembers] = useState(initialMembers);
  const [scope, setScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const draft = useRef<Draft>({ question: '', members: initialMembers, scope: null });
  const restored = useRef(false);

  const keep = (patch: Partial<Draft>) => {
    draft.current = { ...draft.current, ...patch };
    writeDraft(viewerId, draft.current);
  };

  /* Restored after hydration (storage is the browser's); 新建对话 starts over and drops `?new=1` from the address. */
  useEffect(() => {
    if (fresh) {
      restored.current = true;
      writeDraft(viewerId, null);
      draft.current = { question: '', members: initialMembers, scope: null };
      setMembers(initialMembers);
      setScope(null);
      composer.current?.fill('');
      router.replace('/talk', { scroll: false });
      return;
    }
    if (restored.current) return;
    restored.current = true;
    const saved = readDraft(viewerId);
    if (!saved) return;
    draft.current = { question: saved.question ?? '', members: Array.isArray(saved.members) ? saved.members : initialMembers, scope: saved.scope ?? null };
    setMembers(draft.current.members);
    setScope(draft.current.scope);
    if (draft.current.question) composer.current?.fill(draft.current.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, viewerId]);

  const send = async (question: string) => {
    setBusy(true);
    try {
      const { id } = await conversationApi.create(
        members.map((member) => member.id),
        autoTitle(question),
      );
      stashPending(id, { question, scope });
      writeDraft(viewerId, null);
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
          onScope={(reeId) => {
            setScope(reeId);
            keep({ scope: reeId });
          }}
          onParticipants={(chosen) => {
            const nextScope = scope && chosen.some((member) => member.id === scope) ? scope : null;
            setMembers(chosen);
            setScope(nextScope);
            keep({ members: chosen, scope: nextScope });
          }}
          onInput={(question) => keep({ question })}
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
