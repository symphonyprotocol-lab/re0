'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import { completeMention, mentionQuery, questionTargets } from '@/lib/domain/conversation';
import { useI18n } from '@/i18n/client';
import { formatNumber } from '@/i18n/format';
import { useToast } from '@/components/ui/toast';
import { RoleBadge } from '@/components/discover/role-badge';
import { Avatar, I } from '@/components/chat/message-parts';
import { ParticipantPicker, type Member } from '@/components/conversations/participant-picker';

export interface ComposerHandle {
  fill: (text: string) => void;
  /** Opens 管理参与者 (the empty conversation's "选择知识伙伴"). */
  manage: () => void;
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
    /** Every change to the text, as the person types or picks (the `/talk` draft keeps it). */
    onInput?: (text: string) => void;
    autoFocus?: boolean;
  }
>(function Composer({ members, scope, draft, busy, viewerId, onScope, onParticipants, onSend, onInput, autoFocus }, ref) {
  const { t, locale } = useI18n();
  const r = t.conversations.room;
  const toast = useToast();
  const [input, setInput] = useState('');
  const [picker, setPicker] = useState<'scope' | 'manage' | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  /* Escape closes the `@` menu until the text changes again (prototype app.js). */
  const [menuClosed, setMenuClosed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);

  const change = (text: string) => {
    setInput(text);
    setMenuIndex(0);
    setMenuClosed(false);
    onInput?.(text);
  };

  useImperativeHandle(ref, () => ({
    fill: (text: string) => {
      change(text);
      box.current?.focus();
    },
    manage: () => {
      if (busy) return toast(r.waitBusy);
      setPicker('manage');
    },
  }));

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    /* Grows with the text as it is typed; empty, the stylesheet's height (prototype chat-room.js grows it on input only). */
    node.style.height = '';
    if (!input) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(150, Math.max(54, node.scrollHeight))}px`;
  }, [input]);

  const targets = questionTargets(members, input, scope);
  const cost = targets.reduce((sum, member) => sum + member.price, 0);
  const typing = mentionQuery(input);
  const mentions = typing !== null && !menuClosed && members.length > 1 ? members.filter((member) => member.name.toLocaleLowerCase().includes(typing.toLocaleLowerCase())) : [];
  const selected = members.find((member) => member.id === scope) ?? (members.length === 1 ? members[0] : null);
  const [costBefore, costAfter] = r.upTo.split('{n}');

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    if (targets.length === 0) return toast(members.length ? r.unknownMention : r.noParticipants);
    change('');
    onSend(text);
  };

  const pick = (name: string) => {
    change(completeMention(input, name));
    box.current?.focus();
  };

  /* Escape and 关闭 hand focus back to the selector; a click elsewhere leaves it where it went (prototype chat-room.js `closePicker`). */
  const closePicker = (focusBack: boolean) => {
    setPicker(null);
    if (focusBack) anchor.current?.focus();
  };

  return (
    <div className="room-input-wrap">
      {picker && (
        <ParticipantPicker
          view={picker}
          members={members}
          scope={scope}
          draft={draft}
          viewerId={viewerId}
          onClose={closePicker}
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
        className="composer room-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {mentions.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label={r.mentionMenu}>
            {mentions.map((member, index) => (
              <button
                key={member.id}
                type="button"
                role="option"
                aria-selected={index === menuIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(member.name)}
              >
                <Avatar ree={member} sm />
                {member.name}
                <RoleBadge role={member.role} />
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          id="message-input"
          aria-label={r.inputLabel}
          rows={2}
          maxLength={QUESTION_MAX_CHARS}
          value={input}
          placeholder={members.length ? (draft ? r.placeholderDraft : r.placeholder) : r.placeholderEmpty}
          disabled={busy}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            /* An IME composing (pinyin and the like) uses Enter and Tab for itself. */
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            if (mentions.length && event.key === 'Escape') {
              event.preventDefault();
              setMenuClosed(true);
              return;
            }
            if (mentions.length && !composing && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              setMenuIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : mentions.length - 1)) % mentions.length);
              return;
            }
            if (mentions.length && !composing && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
              event.preventDefault();
              pick(mentions[Math.min(menuIndex, mentions.length - 1)]!.name);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !composing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="room-compose-tools">
          <div className="room-dot-tools">
            <button
              ref={anchor}
              type="button"
              data-picker-anchor
              className="room-scope-control"
              aria-label={r.scopeLabel}
              aria-haspopup="dialog"
              aria-expanded={Boolean(picker)}
              disabled={busy}
              onClick={() => {
                if (busy) return toast(r.waitBusy);
                if (picker) return closePicker(true);
                setPicker(members.length ? 'scope' : 'manage');
              }}
            >
              {selected ? <Avatar ree={selected} sm /> : <I name="users" />}
              <span>
                {selected ? (
                  selected.name
                ) : members.length ? (
                  <>
                    {r.allRees} <small>· {members.length}</small>
                  </>
                ) : (
                  r.chooseRees
                )}
              </span>
              {selected && <RoleBadge role={selected.role} />}
              <I name="chevronDown" />
            </button>
          </div>
          <button type="submit" className="btn room-send" aria-label={r.send} disabled={busy || !input.trim() || targets.length === 0}>
            {busy ? <i className="spinner" /> : <I name="send" />}
          </button>
        </div>
      </form>
      <div className="room-compose-meta">
        <span>
          <I name="shield" />
          <span id="cost-label">
            {costBefore}
            <strong>{formatNumber(cost, locale)}</strong>
            {costAfter}
          </span>
          <span>· {r.noCharge}</span>
        </span>
        <small>{r.keys}</small>
      </div>
      <p className="room-demo-note">{r.traceNote}</p>
    </div>
  );
});
