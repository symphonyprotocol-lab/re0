'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONVERSATION_MAX_REES } from '@/lib/constants';
import type { Candidate, ReeBrief } from '@/lib/services/conversations';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { RoleBadge } from '@/components/discover/role-badge';
import { Avatar, I } from '@/components/chat/message-parts';

export type Member = ReeBrief & { price: number };

/**
 * The popover beside the composer (prototype chat-room.js `paintPicker`):
 * "scope" picks who answers this one question -- all Rees, or only one,
 * which never removes the others -- and "manage" changes who is in the
 * conversation, up to five, from the user's own Rees and public ones. It
 * opens above or below the selector, wherever there is more room, and sizes
 * its list to fit (prototype chat-room.js `paintPicker`).
 */
export function ParticipantPicker({
  view,
  members,
  scope,
  draft,
  viewerId,
  onScope,
  onManage,
  onApply,
  onClose,
}: {
  view: 'scope' | 'manage';
  members: Member[];
  scope: string | null;
  draft: boolean;
  viewerId: string;
  onScope: (reeId: string | null) => void;
  onManage: () => void;
  onApply: (chosen: Member[]) => Promise<void> | void;
  /** `focusBack`: Escape or 关闭, so focus returns to the selector; false for a click elsewhere. */
  onClose: (focusBack: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const r = t.conversations.room;
  const n = (value: number) => formatNumber(value, locale);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Member[]>(members);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose(true);
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!panel.current?.contains(target) && !target.closest('[data-picker-anchor]')) onClose(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (view !== 'manage') return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ q, include: members.map((member) => member.id).join(',') });
      const response = await fetch(`/api/chats/candidates?${params}`, { signal: controller.signal }).catch(() => null);
      if (response?.ok) setCandidates(((await response.json()) as { items: Candidate[] }).items);
    }, q ? 200 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, view, members]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('input[type=search], [role=radio]')?.focus();
  }, [view]);

  /* Above the selector or below it, whichever side has more room under the top bar; the list takes what is left. */
  useLayoutEffect(() => {
    const place = () => {
      const node = panel.current;
      const wrap = node?.parentElement;
      const selector = wrap?.querySelector<HTMLElement>('[data-picker-anchor]');
      const list = node?.querySelector<HTMLElement>('[data-picker-list]');
      if (!node || !wrap || !selector) return;
      const box = wrap.getBoundingClientRect();
      const at = selector.getBoundingClientRect();
      const barBottom = document.querySelector('[data-topbar]')?.getBoundingClientRect().bottom ?? 0;
      const above = at.top - barBottom - 14;
      const below = (window.visualViewport?.height ?? window.innerHeight) - at.bottom - 14;
      const isBelow = below > above;
      node.classList.toggle('is-below', isBelow);
      node.style.top = isBelow ? `${at.bottom - box.top + 10}px` : 'auto';
      node.style.bottom = isBelow ? 'auto' : `${box.bottom - at.top + 10}px`;
      if (list) {
        const fixed = node.getBoundingClientRect().height - list.getBoundingClientRect().height;
        list.style.minHeight = '0';
        list.style.maxHeight = `${Math.max(40, Math.min(view === 'manage' ? 250 : 260, Math.max(above, below) - fixed))}px`;
      }
    };
    place();
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [view]);

  const joined = new Set(members.map((member) => member.id));
  const list = [...(candidates ?? [])].sort((a, b) => Number(joined.has(b.id)) - Number(joined.has(a.id)));
  const toggle = (candidate: Member, on: boolean) =>
    setChosen((current) => (on ? (current.length >= CONVERSATION_MAX_REES || current.some((m) => m.id === candidate.id) ? current : [...current, candidate]) : current.filter((m) => m.id !== candidate.id)));

  return (
    <section ref={panel} role="dialog" aria-modal="false" aria-labelledby="room-picker-heading" className="room-picker">
      <header>
        <div>
          <h2 id="room-picker-heading">{view === 'manage' ? r.manageTitle : r.scopeTitle}</h2>
          <p>{view === 'manage' ? (draft ? r.manageDraft : r.manageBody) : r.scopeBody}</p>
        </div>
        <button type="button" className="icon-btn" aria-label={r.close} onClick={() => onClose(true)}>
          <I name="close" />
        </button>
      </header>
      {view === 'scope' ? (
        <>
          <div data-picker-list className="room-scope-list" role="radiogroup" aria-label={r.scopeLabel}>
            {members.length > 1 && (
              <button type="button" role="radio" aria-checked={!scope} onClick={() => onScope(null)}>
                <I name="users" />
                <span>
                  <strong>{r.allAnswer}</strong>
                  <small>{r.allAnswerHint}</small>
                </span>
                {!scope && <I name="check" />}
              </button>
            )}
            {members.map((member) => {
              const checked = scope === member.id || members.length === 1;
              return (
                <button key={member.id} type="button" role="radio" aria-checked={checked} onClick={() => onScope(member.id)}>
                  <Avatar ree={member} sm />
                  <span>
                    <strong>{member.name}</strong>
                    <RoleBadge role={member.role} />
                    <small>{fill(r.scopeHint, { n: n(member.price) })}</small>
                  </span>
                  {checked && <I name="check" />}
                </button>
              );
            })}
            {members.length === 0 && <p className="room-picker-empty">{r.noParticipants}</p>}
          </div>
          <footer>
            <button type="button" className="room-picker-manage" onClick={onManage}>
              <I name="plus" />
              {r.manage}
              <small>
                {members.length}/{CONVERSATION_MAX_REES}
              </small>
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="room-picker-search">
            <I name="search" />
            <input type="search" aria-label={r.pickerSearchLabel} placeholder={r.pickerSearch} value={q} onChange={(event) => setQ(event.target.value)} />
          </div>
          <div data-picker-list className="room-picker-list">
            {candidates === null ? (
              <p className="room-picker-empty">{t.common.actions.loading}</p>
            ) : list.length === 0 ? (
              <p className="room-picker-empty">{r.noMatch}</p>
            ) : (
              list.map((candidate) => {
                const checked = chosen.some((member) => member.id === candidate.id);
                return (
                  <label key={candidate.id} className="room-picker-row">
                    <Avatar ree={candidate} sm />
                    <span>
                      <strong>
                        {candidate.name}
                        <RoleBadge role={candidate.role} />
                        {joined.has(candidate.id) && <small>{r.joined}</small>}
                      </strong>
                      <small>
                        {fill(r.perAnswer, { n: n(candidate.price) })}
                        {candidate.ownerId === viewerId ? ` · ${r.mine}` : ''}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      aria-label={`${r.participantLabel}${candidate.name}`}
                      checked={checked}
                      disabled={!checked && (chosen.length >= CONVERSATION_MAX_REES || !candidate.usable)}
                      onChange={(event) => toggle(candidate, event.target.checked)}
                    />
                  </label>
                );
              })
            )}
          </div>
          <div className="room-picker-summary">
            <span>{fill(r.summary, { n: chosen.length })}</span>
            <strong>{fill(r.upToShort, { n: n(chosen.reduce((sum, member) => sum + member.price, 0)) })}</strong>
          </div>
          <footer>
            <Link href="/explore">
              <I name="compass" />
              {r.discover}
            </Link>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onApply(chosen);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {r.done}
              <I name="check" />
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
