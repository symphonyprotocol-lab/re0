'use client';

import { useEffect, useRef, useState } from 'react';
import type { PrivateReeOption } from '@/lib/domain/post';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { ReeAvatar } from '@/components/ui/ree-avatar';

/**
 * The Ree search of a private question (选 Ree in the composer, 加 Ree in
 * its thread): Rees the viewer may ask privately, matching what they type
 * (`/api/posts/private/rees`), each with what one answer costs them. Rees
 * already chosen are left out. Escape or a click outside closes it.
 */
export function PrivateReePicker({ title, exclude, inline = false, onPick, onClose }: { title: string; exclude: readonly string[]; inline?: boolean; onPick: (option: PrivateReeOption) => void; onClose: () => void }) {
  const { t, locale } = useI18n();
  const c = t.posts.composer;
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PrivateReeOption[] | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/posts/private/rees?${new URLSearchParams({ q })}`, { signal: controller.signal }).catch(() => null);
      if (response?.ok) setItems(((await response.json()) as { items: PrivateReeOption[] }).items);
      else if (response) setItems([]);
    }, q ? 250 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!panel.current?.contains(target) && !target.closest('[data-ree-picker]')) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  const shown = (items ?? []).filter((entry) => !exclude.includes(entry.reeId));
  return (
    <div ref={panel} className={`fu-picker private-picker${inline ? ' is-inline' : ''}`} role="dialog" aria-label={title}>
      <p>{title}</p>
      <input type="search" aria-label={c.pickerSearch} placeholder={c.pickerSearch} value={q} autoFocus onChange={(event) => setQ(event.target.value)} />
      <div className="private-picker-list" role="listbox" aria-label={title}>
        {items === null ? (
          <p className="px-2 py-2 text-[11px] text-muted"><i className="spinner" /></p>
        ) : shown.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-muted">{c.pickerEmpty}</p>
        ) : (
          shown.map((entry) => (
            <button key={entry.reeId} type="button" role="option" aria-selected={false} className="fu-pick" onClick={() => onPick(entry)}>
              <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
              <span className="min-w-0">
                <strong>{entry.reeName}</strong>
                <small>{fill(c.reePrice, { n: formatNumber(entry.price, locale) })}</small>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
