'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import { completeMention, mentionQuery, questionTargets } from '@/lib/domain/conversation';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { RoleBadge } from '@/components/discover/role-badge';
import { ParticipantPicker, type Member } from '@/components/conversations/participant-picker';

export interface ComposerHandle {
  fill: (text: string) => void;
}

/**
 * The input under a conversation (prototype chat-room.js `composer`): the
 * question, the "who answers" control beside it, the `@` menu of
 * participants, and "最多 N credits" for exactly the Rees this question
 * would go to. A question whose `@` names nobody here cannot be sent.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    members: Member[];
    scope: string | null;
    draft: boolean;
    busy: boolean;
    viewerId: string;
    onScope: (reeId: string | null) => void;
    onParticipants: (chosen: Member[]) => Promise<void> | void;
    onSend: (question: string) => void;
    autoFocus?: boolean;
  }
>(function Composer({ members, scope, draft, busy, viewerId, onScope, onParticipants, onSend, autoFocus }, ref) {
  const { t, locale } = useI18n();
  const r = t.conversations.room;
  const toast = useToast();
  const [input, setInput] = useState('');
  const [picker, setPicker] = useState<'scope' | 'manage' | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    fill: (text: string) => {
      setInput(text);
      box.current?.focus();
    },
  }));

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(150, Math.max(54, node.scrollHeight))}px`;
  }, [input]);

  const targets = questionTargets(members, input, scope);
  const cost = targets.reduce((sum, member) => sum + member.price, 0);
  const typing = mentionQuery(input);
  const mentions = typing !== null && members.length > 1 ? members.filter((member) => member.name.toLocaleLowerCase().includes(typing.toLocaleLowerCase())) : [];
  const selected = members.find((member) => member.id === scope) ?? (members.length === 1 ? members[0] : null);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    if (targets.length === 0) return toast(members.length ? r.unknownMention : r.noParticipants);
    setInput('');
    onSend(text);
  };

  const pick = (name: string) => {
    setInput((value) => completeMention(value, name));
    setMenuIndex(0);
    box.current?.focus();
  };

  return (
    <div className="relative">
      {picker && (
        <ParticipantPicker
          view={picker}
          members={members}
          scope={scope}
          draft={draft}
          viewerId={viewerId}
          onClose={() => setPicker(null)}
          onManage={() => setPicker('manage')}
          onScope={(reeId) => {
            onScope(reeId);
            setPicker(null);
            box.current?.focus();
          }}
          onApply={async (chosen) => {
            await onParticipants(chosen);
            setPicker(null);
            box.current?.focus();
          }}
        />
      )}
      <form
        className="card relative p-3 shadow-sm focus-within:border-blue"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {mentions.length > 0 && (
          <div role="listbox" aria-label={r.mentionMenu} className="absolute bottom-full left-3 z-20 mb-2 w-[min(280px,80vw)] rounded-xl border border-line bg-white p-1.5 shadow-xl">
            {mentions.map((member, index) => (
              <button
                key={member.id}
                type="button"
                role="option"
                aria-selected={index === menuIndex}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-soft ${index === menuIndex ? 'bg-soft text-blue' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(member.name)}
              >
                <ReeAvatar avatar={member.avatarBlob} color={member.color} size="sm" className="!size-6 !rounded-md [&_svg]:!size-3.5" />
                <span className="truncate">{member.name}</span>
                <RoleBadge role={member.role} />
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          id="message-input"
          aria-label={r.inputLabel}
          className="block w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-relaxed outline-none placeholder:text-[#a3a9bb]"
          rows={2}
          maxLength={QUESTION_MAX_CHARS}
          value={input}
          placeholder={members.length ? (draft ? r.placeholderDraft : r.placeholder) : r.placeholderEmpty}
          onChange={(event) => {
            setInput(event.target.value);
            setMenuIndex(0);
          }}
          onKeyDown={(event) => {
            if (mentions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              setMenuIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : mentions.length - 1)) % mentions.length);
              return;
            }
            if (mentions.length && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
              event.preventDefault();
              pick(mentions[Math.min(menuIndex, mentions.length - 1)]!.name);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            data-picker-anchor
            className="flex min-w-0 items-center gap-1.5 rounded-lg bg-wash px-2 py-1.5 text-[11px] text-[#3b4361] hover:bg-soft hover:text-blue disabled:opacity-60"
            aria-label={r.scopeLabel}
            aria-haspopup="dialog"
            aria-expanded={Boolean(picker)}
            disabled={busy}
            onClick={() => {
              if (busy) return toast(r.waitBusy);
              setPicker((open) => (open ? null : members.length ? 'scope' : 'manage'));
            }}
          >
            {selected ? <ReeAvatar avatar={selected.avatarBlob} color={selected.color} size="sm" className="!size-5 !rounded-md [&_svg]:!size-3" /> : <Icon name="users" className="size-4" />}
            <span className="truncate">
              {selected ? selected.name : members.length ? (
                <>
                  {r.allRees} <small className="text-muted">· {members.length}</small>
                </>
              ) : (
                r.chooseRees
              )}
            </span>
            {selected && <RoleBadge role={selected.role} />}
            <Icon name="chevronDown" className="size-3 flex-none" />
          </button>
          <button type="submit" className="btn size-10 min-h-10 flex-none p-0" aria-label={r.send} disabled={busy || !input.trim() || targets.length === 0}>
            {busy ? <Spinner /> : <Icon name="send" />}
          </button>
        </div>
      </form>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <Icon name="shield" className="size-3.5" />
          <span id="cost-label">{fill(r.upTo, { n: formatNumber(cost, locale) })}</span>
          <span className="text-[#a3a9bb]">· {r.noCharge}</span>
        </span>
        <span className="hidden sm:inline">{r.keys}</span>
      </div>
    </div>
  );
});
