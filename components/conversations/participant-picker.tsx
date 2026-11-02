'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CONVERSATION_MAX_REES } from '@/lib/constants';
import type { Candidate, ReeBrief } from '@/lib/services/conversations';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RoleBadge } from '@/components/discover/role-badge';

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
      node.style.top = isBelow ? `${at.bottom - box.top + 10}px` : 'auto';
      node.style.bottom = isBelow ? 'auto' : `${box.bottom - at.top + 10}px`;
      if (list) {
        const fixed = node.getBoundingClientRect().height - list.getBoundingClientRect().height;
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
    <section
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby="room-picker-heading"
      className="absolute right-0 bottom-full left-0 z-30 flex flex-col rounded-2xl border border-line bg-white shadow-xl sm:right-auto sm:w-[400px]"
    >
      <header className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div>
          <h2 id="room-picker-heading" className="text-[14px] font-bold">
            {view === 'manage' ? r.manageTitle : r.scopeTitle}
          </h2>
          <p className="mt-1 text-[11px] text-muted">{view === 'manage' ? (draft ? r.manageDraft : r.manageBody) : r.scopeBody}</p>
        </div>
        <button type="button" className="icon-btn" aria-label={r.close} onClick={() => onClose(true)}>
          <Icon name="close" />
        </button>
      </header>
      {view === 'scope' ? (
        <>
          <div data-picker-list className="min-h-0 flex-1 overflow-y-auto p-2" role="radiogroup" aria-label={r.scopeLabel}>
            {members.length > 1 && (
              <ScopeRow checked={!scope} onClick={() => onScope(null)} icon={<Icon name="users" className="size-5 text-blue" />} title={r.allAnswer} hint={r.allAnswerHint} />
            )}
            {members.map((member) => (
              <ScopeRow
                key={member.id}
                checked={scope === member.id || members.length === 1}
                onClick={() => onScope(member.id)}
                icon={<ReeAvatar avatar={member.avatarBlob} color={member.color} size="sm" />}
                title={member.name}
                badge={member.role}
                hint={fill(r.scopeHint, { n: n(member.price) })}
              />
            ))}
            {members.length === 0 && <p className="p-4 text-center text-[12px] text-muted">{r.noParticipants}</p>}
          </div>
          <footer className="border-t border-line p-2">
            <button type="button" className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-[12px] font-semibold text-blue hover:bg-soft" onClick={onManage}>
              <Icon name="plus" />
              {r.manage}
              <small className="ml-auto font-mono text-muted">
                {members.length}/{CONVERSATION_MAX_REES}
              </small>
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="border-b border-line p-3">
            <label className="flex items-center gap-2 rounded-lg border border-line px-3 focus-within:border-blue">
              <Icon name="search" className="size-4 text-muted" />
              <input
                type="search"
                aria-label={r.pickerSearchLabel}
                placeholder={r.pickerSearch}
                className="h-9 min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                value={q}
                onChange={(event) => setQ(event.target.value)}
              />
            </label>
          </div>
          <div data-picker-list className="min-h-0 flex-1 overflow-y-auto p-2">
            {candidates === null ? (
              <p className="p-4 text-center text-[12px] text-muted">{t.common.actions.loading}</p>
            ) : list.length === 0 ? (
              <p className="p-4 text-center text-[12px] text-muted">{r.noMatch}</p>
            ) : (
              list.map((candidate) => {
                const checked = chosen.some((member) => member.id === candidate.id);
                return (
                  <label key={candidate.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-wash">
                    <ReeAvatar avatar={candidate.avatarBlob} color={candidate.color} size="sm" />
                    <span className="min-w-0 flex-1">
                      <strong className="flex items-center text-[12px]">
                        <span className="truncate">{candidate.name}</span>
                        <RoleBadge role={candidate.role} />
                        {joined.has(candidate.id) && <small className="ml-1.5 text-[10px] font-normal text-green">{r.joined}</small>}
                      </strong>
                      <small className="block truncate text-[10px] text-muted">
                        {fill(r.perAnswer, { n: n(candidate.price) })}
                        {candidate.ownerId === viewerId ? ` · ${r.mine}` : ''}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      aria-label={`${r.participants}: ${candidate.name}`}
                      checked={checked}
                      disabled={!checked && (chosen.length >= CONVERSATION_MAX_REES || !candidate.usable)}
                      onChange={(event) => toggle(candidate, event.target.checked)}
                    />
                  </label>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11px]">
            <span className="text-muted">{fill(r.summary, { n: chosen.length })}</span>
            <strong className="font-mono">{fill(r.upToShort, { n: n(chosen.reduce((sum, member) => sum + member.price, 0)) })}</strong>
          </div>
          <footer className="flex items-center justify-between gap-2 border-t border-line p-3">
            <Link href="/explore" className="flex items-center gap-1.5 text-[12px] text-blue hover:underline">
              <Icon name="compass" />
              {r.discover}
            </Link>
            <button
              type="button"
              className="btn btn-sm"
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
              <Icon name="check" />
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function ScopeRow({ checked, onClick, icon, title, hint, badge }: { checked: boolean; onClick: () => void; icon: ReactNode; title: string; hint: string; badge?: string }) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onClick} className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-wash ${checked ? 'bg-soft' : ''}`}>
      <span className="inline-flex size-8 flex-none items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <strong className="flex items-center text-[12px]">
          <span className="truncate">{title}</span>
          <RoleBadge role={badge} />
        </strong>
        <small className="block truncate text-[10px] text-muted">{hint}</small>
      </span>
      {checked && <Icon name="check" className="size-4 flex-none text-blue" />}
    </button>
  );
}
